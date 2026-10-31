import { DEFAULT_LIMITS, LimitsSchema, type Limits } from '../contracts/config.js';
import { RunInputSchema, RunRecordSchema, type RunInput, type RunRecord, type RunOutcome, type ReviewExpectation } from '../contracts/domain.js';
import { StoredEventSchema } from '../contracts/events.js';
import { WorkerToParentMessageSchema, type WorkerToParentMessage, type TypedArtifact } from '../contracts/ipc.js';
import { transitionRun } from '../contracts/state.js';
import { hashRunInput, hashArtifact } from '../evidence/hashing.js';
import { canonicalizeArtifact } from '../contracts/canonical.js';
import { buildReviewSnapshot, type ResearchContext, type ReviewSnapshot } from '../runtime/orchestrator.js';
import { loadSnapshot } from '../data/snapshot.js';
import { buildIndex, retrieveWithTrace } from '../retrieval/index.js';
import { evaluatePublication } from '../publishing/gate.js';
import { PublicationReceipts } from '../publishing/receipts.js';
import type { WorkerEvent } from '../contracts/events.js';
import { deepFreeze } from '../data/records.js';
import { RunStore } from '../storage/run-store.js';
import { PermitManager, PermitError } from './permits.js';
import { ProcessHost, type WorkerHandle, type ExitEvidence, type CleanupResult } from './process-host.js';
import { performance } from 'node:perf_hooks';
import { deadlineTimer, type DeadlineTimer } from './deadline.js';

type Callbacks = { onMessage: (runId: string, message: WorkerToParentMessage) => void;
  onExit: (runId: string, evidence: ExitEvidence) => void; onFault: (runId: string, code: string) => void };
type Host = { start(input: RunInput, snapshotPath: string, limits: Limits): WorkerHandle };
type Options = { store: RunStore; snapshotPath: string; runnerMode: 'offline_fixture' | 'live'; limits?: Limits;
  workerPath?: string; workerArgs?: string[]; createHost?: (callbacks: Callbacks) => Host; now?: () => number; monotonicNow?: () => number };
type StopIntent = Readonly<{ kind: 'failed' | 'cancelled' | 'insufficient'; code: string; outcome?: RunOutcome }>;
type Active = { handle?: WorkerHandle; timer?: DeadlineTimer; finishing: boolean; ready: boolean; artifacts: TypedArtifact[];
  deadlineMono: number; deadlineAt: number; intent?: StopIntent; earlyCleanup?: Promise<CleanupResult | undefined>;
  publicationPending?: boolean; publicationCommitting?: boolean; receipts: PublicationReceipts; reviewSnapshot?: ReviewSnapshot; actor?: ReviewExpectation['actor'] };
const terminal = new Set(['approved', 'failed', 'cancelled', 'insufficient']);
export class SchedulerError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'SchedulerError'; }
}

/** Parent-only controller. No model, Agent, publishing gate or HTTP implementation. */
export class Scheduler {
  readonly permits: PermitManager;
  readonly #store: RunStore;
  readonly #limits: Limits;
  readonly #host: Host;
  readonly #snapshotPath: string;
  readonly #mode: Options['runnerMode'];
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  readonly #publicationContext: (input:RunInput)=>Promise<ResearchContext>;
  readonly #origins = new Map<string, number>();
  readonly #active = new Map<string, Active>();
  readonly #queue = new Map<string, { timer: DeadlineTimer; deadlineMono: number }>();
  readonly #queuedStops = new Set<string>();
  readonly #creating = new Set<string>();
  readonly #requestTimers = new Map<string, { runId: string; timer: DeadlineTimer }>();
  readonly #requests = new Map<string, { runId: string; state: 'pending' | 'granted' | 'released' | 'denied'; permitId?: string }>();
  readonly #problems: { code: string; runId?: string }[] = [];
  readonly #cleanups: CleanupResult[] = [];
  #tail: Promise<void> = Promise.resolve();
  #hold = false;
  #shutdown = false;
  #emergency: Promise<void> | undefined;
  #controlFailure: unknown;
  constructor(options: Options & { publicationContext?: (input:RunInput)=>Promise<ResearchContext> }) {
    this.#store = options.store; this.#limits = Object.freeze(LimitsSchema.parse(options.limits ?? DEFAULT_LIMITS));
    this.#snapshotPath = options.snapshotPath; this.#mode = options.runnerMode; this.#now = options.now ?? Date.now;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#publicationContext=options.publicationContext??(async input=>{const snapshot=await loadSnapshot(this.#snapshotPath,input.datasetCommit);return{snapshot,...retrieveWithTrace(input,buildIndex(snapshot))};});
    if (!['live', 'offline_fixture'].includes(this.#mode)) throw new SchedulerError('INVALID_RUNNER_MODE');
    this.permits = new PermitManager({ limits: this.#limits, now: this.#now, monotonicNow: this.#monotonicNow });
    const callbacks: Callbacks = {
      onMessage: (id, msg) => {
        const parsed = WorkerToParentMessageSchema.safeParse(msg);
        const active = this.#active.get(id);
        const factualReceipt = Boolean(parsed.success && parsed.data.runId === id && active && !active.intent && !active.finishing
          && !this.#expired(id, active) && ['ready', 'event', 'artifact','review.dispatch'].includes(parsed.data.kind));
        if (parsed.success && parsed.data.runId === id && parsed.data.kind === 'outcome') {
          const outcome = deepFreeze(parsed.data.typedOutcome);
          if(outcome.kind==='reviewed'){
            if(active&&!active.intent&&!active.finishing&&!active.publicationPending&&!terminal.has(this.#store.getRun(id)?.status??'')){
              active.publicationPending=true;
              this.permits.stopRun(id,'REVIEWED_AWAITING_PARENT_GATE');
              this.#background(()=>this.#publish(id,outcome));return;
            }
          }else if(this.#reserveStop(id,outcome.kind,`WORKER_${outcome.kind.toUpperCase()}`,outcome))return;
        }
        this.#background(() => this.#message(id, msg, factualReceipt));
      },
      onExit: (id, evidence) => {
        const active = this.#active.get(id); if (!active || active.finishing || active.intent || active.publicationPending) return;
        this.#background(async () => {
        await this.#event(id, 'supervisor', 'worker.exited', { kind: 'worker', pid: evidence.pid,
          exitCode: evidence.exitCode, signal: ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(evidence.signal ?? '') ? evidence.signal : null });
        });
        this.#reserveStop(id, 'failed', evidence.exitCode === 0 ? 'WORKER_MISSING_OUTCOME' : 'WORKER_CRASHED');
      },
      onFault: (id, code) => { this.#reserveStop(id, 'failed', code); },
    };
    if (options.createHost) this.#host = options.createHost(callbacks);
    else {
      if (!options.workerPath) throw new SchedulerError('WORKER_PATH_REQUIRED');
      this.#host = new ProcessHost({ workerPath: options.workerPath, workerArgs: options.workerArgs, ...callbacks });
    }
  }
  get safetyHold(): boolean { return this.#hold || this.#store.safetyHold; }
  get diagnostics() { return deepFreeze(structuredClone(this.#problems)); }
  get cleanupEvidence() { return Object.freeze([...this.#cleanups]); }
  getRun(runId: string) { return this.#store.getRun(runId); }
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => {}, error => {
      if (!(error instanceof SchedulerError)) { this.#controlFailure ??= error;
        this.#hold = true; this.#problems.push({ code: 'CONTROL_OR_STORAGE_FAILED' }); this.#emergencyCleanup(); }
    });
    return result;
  }
  #background(operation: () => Promise<unknown>) { void this.#serial(operation).catch(() => {}); }
  #clock() { const now = this.#now(); if (!Number.isSafeInteger(now)) throw new Error('INVALID_CLOCK'); return now; }
  #mono() { const now = this.#monotonicNow(); if (!Number.isFinite(now)) throw new Error('INVALID_MONOTONIC_CLOCK'); return now; }
  #timer(deadlineAt: number, deadlineMonotonicAt: number, action: () => void): DeadlineTimer {
    return deadlineTimer({ deadlineAt, deadlineMonotonicAt, now: () => this.#clock(), monotonicNow: () => this.#mono(), action });
  }
  #expired(runId: string, active: Active) {
    return this.#mono() >= active.deadlineMono || this.#clock() >= active.deadlineAt;
  }
  #permitExpired(runId: string, permitId: string) {
    const timing = this.permits.timing(runId, permitId);
    return this.#clock() >= timing.expiresAt || this.#mono() >= timing.expiresMonotonicAt;
  }
  // Volatile intent + OS stopping must remain runnable while fsync/rename awaits.
  // All persisted events/state still pass through the one serialized parent writer.
  #reserveStop(runId: string, kind: StopIntent['kind'], code: string, outcome?: RunOutcome): boolean {
    const active = this.#active.get(runId);
    if (!active || active.finishing || active.intent || active.publicationCommitting) return false;
    if (this.#expired(runId, active)) { kind = 'failed'; code = 'RUN_TIMEOUT'; outcome = undefined; }
    active.intent = Object.freeze({ kind, code, ...(outcome ? { outcome } : {}) });
    active.timer?.cancel();
    for (const [id, item] of this.#requestTimers) if (item.runId === runId) { item.timer.cancel(); this.#requestTimers.delete(id); }
    if (this.permits.snapshot().runs.some(r => r.runId === runId)) this.permits.stopRun(runId, code);
    if (active.handle) active.earlyCleanup = active.handle.terminate(code).then(result => {
      if (!result.confirmed) { this.#hold = true; this.#problems.push({ runId, code: 'CLEANUP_UNCONFIRMED' }); }
      return result;
    }, () => { this.#hold = true; this.#problems.push({ runId, code: 'CLEANUP_UNCONFIRMED' }); return undefined; });
    this.#background(() => this.#finish(runId, kind, code, outcome)); return true;
  }
  async #event(runId: string, source: string, type: string, payload: unknown, worker?: unknown) {
    const record = this.#store.getRun(runId); if (!record) throw new SchedulerError('RUN_NOT_FOUND');
    const now = this.#clock();
    const event = StoredEventSchema.parse({ ...(worker as object | undefined), runId, source, type, payload,
      schemaVersion: 1, seq: record.lastSeq + 1, at: new Date(now).toISOString(),
      elapsedMs: Math.max(0, this.#origins.has(runId) ? this.#mono() - this.#origins.get(runId)! : now - Date.parse(record.admittedAt ?? record.createdAt)) });
    return this.#store.appendEvent(event);
  }
  #ignored(runId: string, code: string) {
    return this.#event(runId, 'supervisor', 'event.ignored', { kind: 'ignored_ref', reasonCode: code });
  }
  submit(raw: RunInput): Promise<RunRecord> {
    let input: RunInput;
    try { input = deepFreeze(RunInputSchema.parse(raw)); } catch { return Promise.reject(new SchedulerError('INVALID_RUN_INPUT')); }
    return this.#serial(async () => {
      if (this.#shutdown) throw new SchedulerError('SCHEDULER_CLOSED');
      if (this.safetyHold) throw new SchedulerError('RUN_SAFETY_HOLD');
      if (this.#store.getRun(input.runId)) throw new SchedulerError('RUN_EXISTS');
      if (this.#active.size >= this.#limits.maxActiveRuns && this.#queue.size >= this.#limits.maxQueuedRuns)
        throw new SchedulerError('RUN_QUEUE_FULL');
      const createdMono = this.#mono();
      const record = RunRecordSchema.parse({ runId: input.runId, input, inputHash: hashRunInput(input), runnerMode: this.#mode,
        status: 'queued', createdAt: new Date(this.#clock()).toISOString(), revisionCount: 0, cleanupState: 'not_started', lastSeq: 0 });
      this.#creating.add(input.runId);
      try { await this.#store.createRun(record); } finally { this.#creating.delete(input.runId); }
      this.#origins.set(input.runId, createdMono);
      if (this.#queuedStops.has(input.runId)) {
        await this.#queuedFinish(input.runId, 'cancelled', 'USER_CANCELLED'); return this.#store.getRun(input.runId)!;
      }
      if (this.safetyHold || this.#shutdown) {
        await this.#queuedFinish(input.runId, this.#shutdown ? 'cancelled' : 'failed', this.#shutdown ? 'SCHEDULER_CLOSED' : 'RUN_SAFETY_HOLD');
        return this.#store.getRun(input.runId)!;
      }
      if (this.#active.size < this.#limits.maxActiveRuns) await this.#admit(input.runId);
      else {
        const deadline = Date.parse(record.createdAt) + this.#limits.queueTimeoutMs;
        const deadlineMono = createdMono + this.#limits.queueTimeoutMs;
        this.#queue.set(input.runId, { deadlineMono, timer: this.#timer(deadline, deadlineMono,
          () => this.#background(() => this.#queuedFinish(input.runId, 'failed', 'QUEUE_TIMEOUT'))) });
      }
      return this.#store.getRun(input.runId)!;
    });
  }
  async #admit(runId: string) {
    const current = this.#store.getRun(runId)!;
    const admitted = this.#clock(), deadline = admitted + this.#limits.runTimeoutMs;
    const deadlineMono = this.#mono() + this.#limits.runTimeoutMs; this.#origins.set(runId, this.#mono());
    const changed = transitionRun(current, { action: 'start', runId, seq: current.lastSeq + 1 });
    if (changed.kind !== 'changed') throw new Error('ADMISSION_TRANSITION');
    const record = RunRecordSchema.parse({ ...changed.state, admittedAt: new Date(admitted).toISOString(), deadlineAt: new Date(deadline).toISOString() });
    // Register admitting ownership before the first persistence await, so cancel
    // can reserve a zero-spawn stop while the admitted record is being confirmed.
    const active: Active = { finishing: false, ready: false, artifacts: [], deadlineMono, deadlineAt: deadline, receipts:new PublicationReceipts(runId) };
    this.#active.set(runId, active);
    active.timer = this.#timer(deadline, deadlineMono, () => { this.#reserveStop(runId, 'failed', 'RUN_TIMEOUT'); });
    await this.#event(runId, 'supervisor', 'run.status', { kind: 'run_status', status: 'researching', reasonCodes: ['ADMITTED'] });
    await this.#store.saveRecord(record);
    if (active.intent || this.#shutdown) { await this.#finish(runId, 'cancelled', 'SCHEDULER_CLOSED'); return; }
    if (this.safetyHold) { await this.#finish(runId, 'failed', 'RUN_SAFETY_HOLD'); return; }
    if (this.#expired(runId, active)) { await this.#finish(runId, 'failed', 'RUN_TIMEOUT'); return; }
    this.permits.registerRun(runId, deadline, deadlineMono);
    try {
      active.handle = this.#host.start(record.input, this.#snapshotPath, this.#limits);
      // Rejection is observed even when a worker never reaches ready.
      void active.handle.ready.catch(() => this.#background(() => this.#finish(runId, 'failed', 'WORKER_NOT_READY')));
      if (active.handle.pid) await this.#event(runId, 'supervisor', 'worker.spawned', { kind: 'worker', pid: active.handle.pid });
    } catch { await this.#finish(runId, 'failed', 'WORKER_SPAWN_FAILED'); }
  }
  async #pump() {
    while (!this.#shutdown && !this.safetyHold && this.#queue.size && this.#active.size < this.#limits.maxActiveRuns) {
      const [id, pending] = this.#queue.entries().next().value!; pending.timer.cancel(); this.#queue.delete(id);
      const queued = this.#store.getRun(id)!;
      if (this.#queuedStops.has(id)) await this.#queuedFinish(id, 'cancelled', 'USER_CANCELLED');
      else if (this.#mono() >= pending.deadlineMono || this.#clock() >= Date.parse(queued.createdAt) + this.#limits.queueTimeoutMs) await this.#queuedFinish(id, 'failed', 'QUEUE_TIMEOUT');
      else await this.#admit(id);
    }
  }
  async #queuedFinish(runId: string, kind: 'cancelled' | 'failed', code: string) {
    const current = this.#store.getRun(runId); if (!current || terminal.has(current.status) || this.#active.has(runId)) return;
    this.#queue.get(runId)?.timer.cancel(); this.#queue.delete(runId); this.#queuedStops.delete(runId);
    const result = transitionRun(current, { runId, seq: current.lastSeq + 1, action: kind === 'cancelled' ? 'cancel' : 'fail', ...(kind === 'failed' ? { reason: code } : {}) });
    await this.#event(runId, 'supervisor', 'run.status', { kind: 'run_status', status: kind, reasonCodes: [code] });
    await this.#store.commitOutcome({ runId, kind, reasonCodes: [code] }, result.state);
  }
  cancel(runId: string): Promise<RunRecord> {
    if (this.#queue.has(runId) || this.#creating.has(runId)) this.#queuedStops.add(runId);
    this.#reserveStop(runId, 'cancelled', 'USER_CANCELLED');
    return this.#serial(async () => {
      const record = this.#store.getRun(runId); if (!record) throw new SchedulerError('RUN_NOT_FOUND');
      if (!terminal.has(record.status)) {
        if (this.#active.has(runId)) await this.#finish(runId, 'cancelled', 'USER_CANCELLED');
        else await this.#queuedFinish(runId, 'cancelled', 'USER_CANCELLED');
      }
      return this.#store.getRun(runId)!;
    });
  }
  async #message(runId: string, raw: unknown, factualReceipt = false) {
    const record = this.#store.getRun(runId); if (!record) return;
    const parsed = WorkerToParentMessageSchema.safeParse(raw);
    if (!parsed.success || parsed.data.runId !== runId) { await this.#ignored(runId, 'INVALID_WORKER_BINDING'); return; }
    const active = this.#active.get(runId), msg = parsed.data;
    if (!active || active.finishing || (!factualReceipt && active.intent) || terminal.has(record.status)) { await this.#ignored(runId, 'LATE_WORKER_MESSAGE'); return; }
    if (!factualReceipt && this.#expired(runId, active)) { await this.#finish(runId, 'failed', 'RUN_TIMEOUT'); return; }
    if (msg.kind === 'ready') {
      if (active.ready) { await this.#ignored(runId, 'DUPLICATE_READY'); return; }
      active.ready = true;
      if (active.handle?.pid) await this.#event(runId, 'supervisor', 'worker.ready', { kind: 'worker', pid: active.handle.pid });
    } else if (msg.kind === 'permit.request') {
      const prior = this.#requests.get(msg.requestId);
      if (prior) {
        if (prior.runId !== runId || prior.state === 'released' || prior.state === 'denied') {
          const code = prior.runId !== runId ? 'REQUEST_RUN_MISMATCH' : prior.state === 'released' ? 'REQUEST_ALREADY_RELEASED' : 'REQUEST_ALREADY_DENIED';
          await this.#event(runId, 'supervisor', 'permit.denied', { kind: 'permit', requestId: msg.requestId, code });
          active.handle?.send({ v: 1, kind: 'permit.denied', runId, requestId: msg.requestId, code });
        } else if (prior.state === 'granted') {
          if (this.#permitExpired(runId, prior.permitId!)) await this.#finish(runId, 'failed', 'REQUEST_TIMEOUT');
          else active.handle?.send({ v: 1, kind: 'permit.granted', runId, requestId: msg.requestId, permitId: prior.permitId! });
        }
        return; // Pending duplicates share one eventual response, reservation and timer.
      }
      const route: { runId: string; state: 'pending' | 'granted' | 'released' | 'denied'; permitId?: string } = { runId, state: 'pending' };
      this.#requests.set(msg.requestId, route);
      // Never await a permit in the serialized control queue: releases/cancel must remain runnable.
      void this.permits.acquire(runId, msg.requestId).then(permit => this.#background(async () => {
        if (this.#active.get(runId) !== active || active.finishing || active.intent || this.safetyHold) return;
        if (this.#permitExpired(runId, permit.id)) { await this.#finish(runId, 'failed', 'REQUEST_TIMEOUT'); return; }
        await this.#event(runId, 'supervisor', 'permit.granted', { kind: 'permit', requestId: msg.requestId, permitId: permit.id });
        if (active.finishing || active.intent || this.safetyHold) return;
        if (this.#permitExpired(runId, permit.id)) { await this.#finish(runId, 'failed', 'REQUEST_TIMEOUT'); return; }
        route.state = 'granted'; route.permitId = permit.id;
        if (!active.handle?.send({ v: 1, kind: 'permit.granted', runId, requestId: msg.requestId, permitId: permit.id })) {
          await this.#finish(runId, 'failed', 'IPC_SEND_FAILED'); return;
        }
        const timing = this.permits.timing(runId, permit.id);
        if (!this.#requestTimers.has(permit.id)) this.#requestTimers.set(permit.id, { runId,
          timer: this.#timer(timing.expiresAt, timing.expiresMonotonicAt, () => { this.#reserveStop(runId, 'failed', 'REQUEST_TIMEOUT'); }) });
      }), error => this.#background(async () => {
        if (this.#active.get(runId) !== active || active.finishing || active.intent) return;
        const code = error instanceof PermitError ? error.code : 'PERMIT_FAILED';
        route.state = 'denied';
        await this.#event(runId, 'supervisor', 'permit.denied', { kind: 'permit', requestId: msg.requestId, code });
        active.handle?.send({ v: 1, kind: 'permit.denied', runId, requestId: msg.requestId, code });
      }));
    } else if (msg.kind === 'permit.release') {
      try {
        const route = [...this.#requests.values()].find(r => r.runId === runId && r.permitId === msg.permitId);
        if (route?.state === 'granted' && this.#permitExpired(runId, msg.permitId)) { await this.#finish(runId, 'failed', 'REQUEST_TIMEOUT'); return; }
        if (this.permits.release(runId, msg.permitId)) {
          for (const request of this.#requests.values()) if (request.runId === runId && request.permitId === msg.permitId) request.state = 'released';
          this.#requestTimers.get(msg.permitId)?.timer.cancel(); this.#requestTimers.delete(msg.permitId);
          await this.#event(runId, 'supervisor', 'permit.released', { kind: 'permit', permitId: msg.permitId });
        }
      } catch { await this.#ignored(runId, 'PERMIT_RELEASE_REJECTED'); }
    } else if (msg.kind === 'event') {
      await this.#event(runId, msg.nativeOrAppEvent.source, msg.nativeOrAppEvent.type, msg.nativeOrAppEvent.payload, msg.nativeOrAppEvent);
      try {
        active.receipts.accept(msg.nativeOrAppEvent,active.artifacts);
        if(msg.nativeOrAppEvent.type==='review.completed')await this.#reviewCompleted(runId,msg.nativeOrAppEvent);
      }catch{this.#reserveStop(runId,'failed','INVALID_RUNTIME_RECEIPT');}
    } else if(msg.kind==='review.dispatch'){
      try{
        const current=this.#store.getRun(runId)!;
        const draft=[...active.artifacts].reverse().find(a=>a.kind==='proposal_draft'),counter=[...active.artifacts].reverse().find(a=>a.kind==='counter_report');
        if(draft?.kind!=='proposal_draft'||counter?.kind!=='counter_report'||!active.receipts.hasArtifact(draft)||!active.receipts.hasArtifact(counter))throw Error('REVIEW_PREREQUISITES');
        const context=await this.#publicationContext(current.input);
        if(!factualReceipt&&(active.intent||this.#expired(runId,active)))return;
        const snapshot=buildReviewSnapshot({...context,input:current.input,draft:draft.artifact,counter:counter.artifact});
        if(canonicalizeArtifact(snapshot.target)!==canonicalizeArtifact(msg.expectation.target)||hashArtifact(snapshot)!==msg.snapshotHash)throw Error('REVIEW_DISPATCH_SNAPSHOT_MISMATCH');
        active.receipts.dispatch(msg.expectation);
        const changed=transitionRun(current,{runId,seq:current.lastSeq+1,action:'begin_review',expectation:msg.expectation});
        if(changed.kind!=='changed')throw Error('REVIEW_DISPATCH_STATE');
        await this.#event(runId,'supervisor','run.status',{kind:'run_status',status:'reviewing',reasonCodes:['REVIEW_DISPATCH_VERIFIED']});
        await this.#store.saveRecord({...changed.state,lastSeq:this.#store.getRun(runId)!.lastSeq});
        active.reviewSnapshot=snapshot;active.actor=msg.expectation.actor;
      }catch{this.#reserveStop(runId,'failed','REVIEW_DISPATCH_REJECTED');}
    } else if (msg.kind === 'artifact') active.artifacts.push(deepFreeze(msg.typedArtifact));
    else if (msg.kind === 'outcome') {
      if (msg.typedOutcome.kind === 'reviewed') await this.#finish(runId, 'failed', 'UNTRUSTED_REVIEWED_OUTCOME');
      else await this.#finish(runId, msg.typedOutcome.kind, `WORKER_${msg.typedOutcome.kind.toUpperCase()}`, msg.typedOutcome);
    }
  }
  async #reviewCompleted(runId:string,event:WorkerEvent){
    const active=this.#active.get(runId)!;if(event.payload.kind!=='review_ref')throw Error('REVIEW_RECEIPT');
    const ref=event.payload.reviewRef;
    const review=active.artifacts.find(a=>a.kind==='critic_review'&&a.artifact.hash===ref.hash);
    if(review?.kind!=='critic_review')throw Error('REVIEW_ARTIFACT_MISSING');
    const actor=active.receipts.actorForReview(review.artifact.hash);if(!actor||!active.actor)throw Error('REVIEW_ACTOR_MISSING');
    const {runId:_run,loopId:_loop,...reviewActor}=actor;
    const current=this.#store.getRun(runId)!;
    const changed=transitionRun(current,{runId,seq:current.lastSeq+1,action:'review_result',actor:reviewActor,review:review.artifact});
    if(changed.kind!=='changed')throw Error('REVIEW_RESULT_REJECTED');
    // A review cannot create a terminal outcome before worker cleanup. Preserve
    // insufficient intent for finalization, without reopening any terminal Run.
    if(changed.state.status==='insufficient')return;
    await this.#store.saveRecord({...changed.state,lastSeq:current.lastSeq});
  }
  async #publish(runId:string,outcome:RunOutcome){
    const active=this.#active.get(runId);if(!active||active.finishing)return;
    const stop=()=>this.#active.get(runId)?.intent;
    let intent=stop();if(intent){await this.#finish(runId,intent.kind,intent.code,intent.outcome);return;}
    const deny=async(code:string)=>{await this.#finish(runId,'failed',code);};
    if(outcome.kind!=='reviewed'||!active.actor||!active.reviewSnapshot)return deny('PUBLICATION_PROVENANCE_MISSING');
    if(!active.receipts.hasCurrentArtifact({kind:'proposal_draft',artifact:outcome.draft})||!active.receipts.hasCurrentArtifact({kind:'counter_report',artifact:outcome.counter})
      ||!active.receipts.hasCurrentArtifact({kind:'critic_review',artifact:outcome.review}))return deny('PUBLICATION_ARTIFACT_NOT_CURRENT');
    if(this.#expired(runId,active))return deny('RUN_TIMEOUT');
    let confirmed=!active.handle;
    if(active.handle){
      active.earlyCleanup??=active.handle.terminate('PUBLICATION_CLEANUP').then(r=>r,()=>undefined);
      const cleanup=await active.earlyCleanup;if(cleanup)this.#cleanups.push(cleanup);confirmed=cleanup?.confirmed??false;
    }
    intent=stop();if(intent){await this.#finish(runId,intent.kind,intent.code,intent.outcome);return;}
    if(!confirmed){this.#hold=true;this.#problems.push({runId,code:'CLEANUP_UNCONFIRMED'});return deny('CLEANUP_UNCONFIRMED');}
    if(this.#expired(runId,active))return deny('RUN_TIMEOUT');
    this.permits.reclaimRun(runId);
    for(const [id,item]of this.#requestTimers)if(item.runId===runId){item.timer.cancel();this.#requestTimers.delete(id);}
    await this.#event(runId,'supervisor','cleanup.completed',{kind:'cleanup',confirmed:true});
    let current=this.#store.getRun(runId)!;
    await this.#store.saveRecord({...current,cleanupState:'confirmed'});
    // Load again immediately before gate: immutable historical bytes are not a
    // claim that the on-disk source has remained unchanged.
    const context=await this.#publicationContext(current.input);current=this.#store.getRun(runId)!;
    intent=stop();if(intent){await this.#finish(runId,intent.kind,intent.code,intent.outcome);return;}
    const snapshot=buildReviewSnapshot({...context,input:current.input,draft:outcome.draft,counter:outcome.counter});
    if(hashArtifact(snapshot)!==hashArtifact(active.reviewSnapshot))return deny('PUBLICATION_SNAPSHOT_CHANGED');
    const decision=evaluatePublication({run:current,draft:outcome.draft,counter:outcome.counter,review:outcome.review,pool:context.pool,evidence:context.evidence,
      evidenceSnapshotHash:snapshot.evidenceSnapshotHash,snapshot:context.snapshot,actor:active.actor,now:new Date(this.#clock()).toISOString()});
    if(!decision.allowed){this.#problems.push({runId,code:'PUBLICATION_GATE_DENIED'});return deny('PUBLICATION_GATE_DENIED');}
    try{
      await this.#store.commitPublication({run:current,outcome,artifacts:active.artifacts,pool:context.pool,evidence:[...context.evidence],snapshot:context.snapshot,
        actor:active.actor,reviewSnapshot:snapshot},()=>{
          if(active.intent||this.#expired(runId,active)||this.safetyHold)return false;
          active.publicationCommitting=true;return true;
        });
    }catch(error){
      if(error&&typeof error==='object'&&'code'in error&&error.code==='PUBLICATION_CANCELLED_BEFORE_COMMIT'){
        intent=stop();if(intent)await this.#finish(runId,intent.kind,intent.code,intent.outcome);else await deny('RUN_TIMEOUT');return;
      }
      throw error;
    }
    active.finishing=true;active.timer?.cancel();this.#active.delete(runId);await this.#pump();
  }
  async #finish(runId: string, kind: 'failed' | 'cancelled' | 'insufficient', code: string, outcome?: RunOutcome) {
    const active = this.#active.get(runId); if (!active || active.finishing) return;
    if (active.intent) { ({ kind, code, outcome } = active.intent); }
    else active.intent = Object.freeze({ kind, code, ...(outcome ? { outcome } : {}) });
    active.finishing = true; active.timer?.cancel();
    for (const [id, timer] of this.#requestTimers) if (timer.runId === runId) { timer.timer.cancel(); this.#requestTimers.delete(id); }
    const registered = this.permits.snapshot().runs.some(r => r.runId === runId);
    if (registered) this.permits.stopRun(runId, code);
    let confirmed = !active.handle;
    if (active.handle) {
      try { const cleanup = await (active.earlyCleanup ?? active.handle.terminate(code));
        if (cleanup) this.#cleanups.push(cleanup); confirmed = cleanup?.confirmed ?? false; }
      catch { confirmed = false; }
    }
    if (confirmed && registered) this.permits.reclaimRun(runId);
    if (!confirmed) { this.#hold = true; this.#problems.push({ runId, code: 'CLEANUP_UNCONFIRMED' }); }
    await this.#event(runId, 'supervisor', confirmed ? 'cleanup.completed' : 'cleanup.failed', confirmed
      ? { kind: 'cleanup', confirmed: true } : { kind: 'cleanup', confirmed: false, code: 'CLEANUP_UNCONFIRMED' });
    const current = this.#store.getRun(runId)!;
    const result = transitionRun(current, { runId, seq: current.lastSeq + 1,
      action: kind === 'cancelled' ? 'cancel' : kind === 'insufficient' ? 'insufficient' : 'fail', ...(kind === 'cancelled' ? {} : { reason: code }) });
    await this.#event(runId, 'supervisor', 'run.status', { kind: 'run_status', status: kind, reasonCodes: [code] });
    await this.#store.commitOutcome(outcome ?? { runId, kind, reasonCodes: [code] },
      { ...result.state, cleanupState: confirmed ? 'confirmed' : 'unconfirmed' }, active.artifacts);
    if (confirmed) this.#active.delete(runId);
    await this.#pump();
  }
  #emergencyCleanup() {
    if (this.#emergency) return;
    this.#emergency = (async () => {
      for (const pending of this.#queue.values()) pending.timer.cancel();
      for (const { timer } of this.#requestTimers.values()) timer.cancel();
      await Promise.all([...this.#active].map(async ([id, active]) => {
        active.timer?.cancel(); active.finishing = true;
        if (this.permits.snapshot().runs.some(r => r.runId === id)) this.permits.stopRun(id, 'STORAGE_SAFETY_HOLD');
        if (active.handle) try {
          const cleanup = await active.handle.terminate('STORAGE_SAFETY_HOLD'); this.#cleanups.push(cleanup);
          if (cleanup.confirmed) this.permits.reclaimRun(id);
        } catch { this.#problems.push({ runId: id, code: 'EMERGENCY_CLEANUP_UNCONFIRMED' }); }
      }));
    })();
  }
  async drain() { let tail; do { tail = this.#tail; await tail; await Promise.resolve(); } while (tail !== this.#tail); }
  async waitForIdle(timeoutMs = 20_000) {
    const until = Date.now() + timeoutMs;
    do { await this.drain(); if (!this.#active.size && !this.#queue.size) return;
      if (this.safetyHold) throw new SchedulerError('RUN_SAFETY_HOLD');
      await new Promise(r => setTimeout(r, 10));
    } while (Date.now() < until);
    throw new SchedulerError('WAIT_TIMEOUT');
  }
  async close() {
    this.#shutdown = true;
    for (const id of this.#queue.keys()) this.#queuedStops.add(id);
    for (const id of this.#active.keys()) this.#reserveStop(id, 'cancelled', 'SCHEDULER_CLOSED');
    try {
      await this.#serial(async () => {
        this.#shutdown = true;
        if (this.#store.safetyHold) { this.#emergencyCleanup(); return; }
        for (const id of [...this.#queue.keys()]) await this.#queuedFinish(id, 'cancelled', 'SCHEDULER_CLOSED');
        for (const id of [...this.#active.keys()]) await this.#finish(id, 'cancelled', 'SCHEDULER_CLOSED');
      });
    } finally { await this.#emergency; this.permits.dispose(); await this.drain(); }
    if (this.#controlFailure) throw this.#controlFailure;
  }
}
