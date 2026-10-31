import { mkdir, lstat, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RunRecordSchema, RunOutcomeSchema, CandidatePoolSchema, EvidenceSnapshotSchema, ReviewActorSchema,
  type RunRecord, type RunOutcome, type ReviewExpectation } from '../contracts/domain.js';
import { StoredEventSchema, type StoredEvent } from '../contracts/events.js';
import { TypedArtifactSchema, type TypedArtifact } from '../contracts/ipc.js';
import { UuidSchema } from '../contracts/primitives.js';
import { hashRunInput, hashEvidenceSnapshot, hashArtifact } from '../evidence/hashing.js';
import { canonicalizeArtifact } from '../contracts/canonical.js';
import { JsonValueSchema } from '../contracts/primitives.js';
import { transitionRun } from '../contracts/state.js';
import { evaluatePublication } from '../publishing/gate.js';
import { renderApprovedDraft } from '../publishing/render.js';
import { loadSnapshot, type DatasetSnapshot } from '../data/snapshot.js';
import type { EvidenceSnapshot } from '../evidence/store.js';
import { buildReviewSnapshot } from '../runtime/orchestrator.js';
import { PublicationReceipts } from '../publishing/receipts.js';
import { WorkerEventSchema } from '../contracts/events.js';
import { deepFreeze } from '../data/records.js';
import { HISTORICAL_RECOVERY_FOLDER, HISTORICAL_RECOVERY_SCOPE, HistoricalRecoveryAuthorizationSchema,
  verifyHistoricalRecoveryAuthorization, createHistoricalRecoveryResolution, verifyHistoricalRecoveryResolution,
  type HistoricalRecoveryAuthorization, type HistoricalRecoveryResolution } from './historical-recovery.js';

const terminalStatuses = new Set(['failed', 'cancelled', 'insufficient', 'approved']);
const MAX_EVENT_BYTES = 1024 * 1024;
const recordEnvelope = z.strictObject({ schemaVersion: z.literal(1), record: RunRecordSchema });
const publicationEnvelope = z.strictObject({ format: z.literal('canonical-json-draft-v1'), mode: z.enum(['research','adversarial']),
  runnerMode: z.enum(['live','offline_fixture']), renderedDraft: z.string(), renderedHash: z.string().regex(/^[a-f0-9]{64}$/),
  formalProposal: JsonValueSchema.nullable(), committedAt: z.string(),
  proof: z.strictObject({ reviewedRecord: RunRecordSchema, pool: CandidatePoolSchema, evidence: EvidenceSnapshotSchema,
    actor: ReviewActorSchema, reviewSnapshot: JsonValueSchema }) });
const terminalEnvelope = z.strictObject({ schemaVersion: z.literal(1), record: RunRecordSchema,
  outcome: RunOutcomeSchema, artifacts: z.array(TypedArtifactSchema), eventCount: z.int().nonnegative(), publication: publicationEnvelope.optional() });
type TerminalBundle = z.infer<typeof terminalEnvelope>;
type Diagnostic = Readonly<{ code: string; runId?: string; file?: string; stage?: string; ioCode?: string }>;
type Options = { now?: () => number; fault?: (point: string) => void | Promise<void>;
  publicationSnapshot?: () => Promise<DatasetSnapshot>; historicalRecovery?: unknown };
type Entry = { record: RunRecord; events: StoredEvent[]; terminal?: TerminalBundle };

export class StoreError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'StoreError'; }
}
function fail(code: string): never { throw new StoreError(code); }
const cloneFrozen = <T>(value: T): T => deepFreeze(structuredClone(value));
const equal = (a: unknown, b: unknown) => canonicalizeArtifact(a) === canonicalizeArtifact(b);

/** Every existing path component must be an ordinary directory, never a junction. */
async function directory(path: string, create: boolean): Promise<void> {
  const root = parse(path).root;
  let cursor = root;
  for (const piece of relative(root, path).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, piece);
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('STORE_PATH');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      await mkdir(cursor);
    }
  }
}
async function ordinaryFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) fail('STORE_PATH');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function readText(path: string): Promise<string | undefined> {
  if (!await ordinaryFile(path)) return undefined;
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
}
function validRecord(value: unknown, allowApproved = false): RunRecord {
  const record = RunRecordSchema.parse(value);
  if (record.inputHash !== hashRunInput(record.input)) fail('INPUT_HASH');
  if (!allowApproved && (record.status === 'approved' || record.publishedDraftHash)) fail('PUBLISHING_UNAVAILABLE');
  return record;
}

/** Parent-owned local store. It never authenticates worker results or grants publication. */
export class RunStore {
  private readonly entries = new Map<string, Entry>();
  private readonly problems: Diagnostic[] = [];
  private readonly resolvedProblems = new Set<Diagnostic>();
  private readonly recoveryAuthorization?: HistoricalRecoveryAuthorization;
  private recoveryResolution?: HistoricalRecoveryResolution;
  private closed = false;
  private closing = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly nonce = randomUUID();
  private ownsLock = false;
  private constructor(private readonly root: string, private readonly options: Options) {
    const policy=HistoricalRecoveryAuthorizationSchema.safeParse(options.historicalRecovery);
    if(policy.success)this.recoveryAuthorization=cloneFrozen(policy.data);
  }

  static async open(root: string, options: Options = {}): Promise<RunStore> {
    if (!isAbsolute(root)) fail('STORE_PATH');
    const store = new RunStore(resolve(root), options);
    await directory(store.root, true);
    const lockPath = join(store.root, 'writer.lock');
    let handle;
    try {
      handle = await open(lockPath, 'wx');
      store.ownsLock = true;
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: store.nonce,
        createdAt: new Date((options.now ?? Date.now)()).toISOString() }) + '\n');
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('STORE_LOCKED');
      throw error;
    } finally { await handle?.close(); }
    try { await store.recover(); return store; }
    catch (error) { await store.close(); throw error; }
  }
  get safetyHold(): boolean { return this.problems.some(p=>!this.resolvedProblems.has(p)) || this.closed; }
  get diagnostics(): readonly Diagnostic[] { return cloneFrozen(this.problems); }
  get unresolvedDiagnostics(): readonly Diagnostic[] { return cloneFrozen(this.problems.filter(p=>!this.resolvedProblems.has(p))); }
  get historicalResolutions(): readonly HistoricalRecoveryResolution[] { return cloneFrozen(this.recoveryResolution?[this.recoveryResolution]:[]); }
  getRun(runId: string): RunRecord | undefined { return this.entries.get(runId)?.record; }
  getPublication(runId: string) { return this.entries.get(runId)?.terminal?.publication; }
  /** Read-only, deeply frozen parent-committed envelope. Never exposes pending worker artifacts. */
  getTerminal(runId: string) { return this.entries.get(runId)?.terminal; }
  listRuns(): readonly RunRecord[] { return Object.freeze([...this.entries.values()].map(e => e.record)); }
  eventsAfter(runId: string, seq: number): readonly StoredEvent[] {
    if (!Number.isSafeInteger(seq) || seq < 0) fail('EVENT_SEQUENCE');
    return Object.freeze((this.entries.get(runId)?.events ?? []).filter(e => e.seq > seq));
  }
  private problem(code: string, runId?: string, file?: string, detail?: Pick<Diagnostic,'stage'|'ioCode'>): void {
    this.problems.push(Object.freeze({ code, ...(runId ? { runId } : {}), ...(file ? { file } : {}), ...detail }));
  }
  private write<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing) return Promise.reject(new StoreError('STORE_CLOSED'));
    const result = this.tail.then(async () => {
      if (this.safetyHold) fail('STORE_SAFETY_HOLD');
      return operation();
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  private entry(runId: string): Entry {
    UuidSchema.parse(runId);
    return this.entries.get(runId) ?? fail('RUN_NOT_FOUND');
  }
  private async atomic(runId: string, name: string, content: string, operation: string, beforeCommit?: () => boolean): Promise<void> {
    const folder = join(this.root, runId), target = join(folder, name);
    const pending = join(folder, `${name}.${randomUUID()}.tmp`);
    let handle, stage = 'prepare';
    try {
      await directory(folder, false); await ordinaryFile(target);
      stage = 'open';
      await this.options.fault?.(`${operation}:beforeWrite`);
      handle = await open(pending, 'wx');
      stage = 'write';
      await handle.writeFile(content, 'utf8');
      stage = 'sync';
      await this.options.fault?.(`${operation}:beforeSync`);
      await handle.sync(); await handle.close(); handle = undefined;
      stage = 'rename';
      await this.options.fault?.(`${operation}:beforeRename`);
      if (beforeCommit && !beforeCommit()) fail('PUBLICATION_CANCELLED_BEFORE_COMMIT');
      await rename(pending, target);
      // No post-rename injected failure: rename is this store's commit point.
    } catch (error) {
      const rawCode = (error as NodeJS.ErrnoException | undefined)?.code;
      const ioCode = rawCode && ['EPERM','EACCES','EBUSY','ENOSPC','EIO','ENOENT','EXDEV','EEXIST','EMFILE','ENFILE'].includes(rawCode) ? rawCode : 'UNKNOWN';
      if (!(error instanceof StoreError && error.code === 'PUBLICATION_CANCELLED_BEFORE_COMMIT')) this.problem('STORE_WRITE_FAILED', runId, name, {stage,ioCode});
      throw error;
    } finally { await handle?.close();
      if (beforeCommit) try { await unlink(pending); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.problem('STORE_WRITE_FAILED',runId,name); } }
  }
  createRun(value: RunRecord): Promise<RunRecord> {
    let record: RunRecord;
    try { record = cloneFrozen(validRecord(value)); }
    catch (error) { return Promise.reject(error); }
    return this.write(async () => {
      if (this.entries.has(record.runId)) fail('RUN_EXISTS');
      if (record.status !== 'queued' || record.cleanupState !== 'not_started' || record.lastSeq !== 0
        || record.admittedAt || record.deadlineAt) fail('INVALID_INITIAL_RUN');
      try { await mkdir(join(this.root, record.runId)); }
      catch (error) { this.problem('STORE_WRITE_FAILED', record.runId); throw error; }
      await this.atomic(record.runId, 'record.json', JSON.stringify({ schemaVersion: 1, record }) + '\n', 'record');
      this.entries.set(record.runId, { record, events: [] }); return record;
    });
  }
  private checkRecord(current: RunRecord, next: RunRecord, eventCount: number): void {
    if (next.lastSeq !== eventCount) fail('RECORD_SEQUENCE');
    for (const key of ['runId', 'input', 'inputHash', 'runnerMode', 'createdAt'] as const)
      if (!equal(current[key], next[key])) fail('RUN_IDENTITY');
    if (current.admittedAt && (next.admittedAt !== current.admittedAt || next.deadlineAt !== current.deadlineAt)) fail('RUN_DEADLINE_IMMUTABLE');
    if (terminalStatuses.has(current.status)) {
      const before = { ...current, lastSeq: next.lastSeq, cleanupState: next.cleanupState };
      if (!equal(before, next)) fail('RUN_TERMINAL');
      if (current.cleanupState === 'confirmed' && next.cleanupState !== 'confirmed') fail('CLEANUP_IMMUTABLE');
    }
  }
  saveRecord(value: RunRecord): Promise<RunRecord> {
    let record: RunRecord;
    try { record = cloneFrozen(validRecord(value)); }
    catch (error) { return Promise.reject(error); }
    return this.write(async () => {
      const entry = this.entry(record.runId);
      this.checkRecord(entry.record, record, entry.events.length);
      if (terminalStatuses.has(record.status) && !entry.terminal) fail('USE_COMMIT_OUTCOME');
      if (entry.terminal) {
        const bundle = cloneFrozen({ ...entry.terminal, record, eventCount: entry.events.length });
        await this.atomic(record.runId, 'terminal.json', JSON.stringify(bundle) + '\n', 'terminal');
        entry.terminal = bundle;
      } else {
        const allowed: Record<string, string[]> = { queued: ['queued', 'researching'], researching: ['researching', 'reviewing'],
          reviewing: ['reviewing', 'revising'], revising: ['revising', 'reviewing'] };
        if (!allowed[entry.record.status]?.includes(record.status)) fail('RUN_TRANSITION');
        await this.atomic(record.runId, 'record.json', JSON.stringify({ schemaVersion: 1, record }) + '\n', 'record');
      }
      entry.record = record; return record;
    });
  }
  appendEvent(value: StoredEvent): Promise<StoredEvent> {
    let event: StoredEvent;
    try { event = cloneFrozen(StoredEventSchema.parse(value)); }
    catch (error) { return Promise.reject(error); }
    return this.write(async () => {
      const entry = this.entry(event.runId);
      if (event.seq !== entry.events.length + 1) fail('EVENT_SEQUENCE');
      const line = JSON.stringify(event) + '\n';
      if (Buffer.byteLength(line) > MAX_EVENT_BYTES) fail('EVENT_TOO_LARGE');
      const events = [...entry.events, event];
      await this.atomic(event.runId, 'events.jsonl', events.map(e => JSON.stringify(e) + '\n').join(''), 'events');
      entry.events = events;
      entry.record = cloneFrozen({ ...entry.record, lastSeq: event.seq });
      return event;
    });
  }
  commitOutcome(value: RunOutcome, nextRecord: RunRecord, artifacts: readonly TypedArtifact[] = []): Promise<void> {
    let outcome: RunOutcome, record: RunRecord, parsedArtifacts: readonly TypedArtifact[];
    try {
      outcome = cloneFrozen(RunOutcomeSchema.parse(value));
      if (outcome.kind === 'reviewed') fail('PUBLISHING_UNAVAILABLE');
      record = cloneFrozen(validRecord(nextRecord));
      parsedArtifacts = cloneFrozen(artifacts.map(a => TypedArtifactSchema.parse(a)));
    } catch (error) { return Promise.reject(error); }
    return this.write(async () => {
      const entry = this.entry(outcome.runId);
      if (record.runId !== outcome.runId || record.status !== outcome.kind) fail('OUTCOME_RECORD');
      this.checkRecord(entry.record, record, entry.events.length);
      if (parsedArtifacts.some(a => a.artifact.runId !== record.runId)) fail('ARTIFACT_RUN');
      const bundle = cloneFrozen({ schemaVersion: 1 as const, record, outcome, artifacts: [...parsedArtifacts], eventCount: entry.events.length });
      if (entry.terminal) {
        if (equal(entry.terminal, bundle)) return;
        fail('RUN_TERMINAL');
      }
      await this.atomic(record.runId, 'terminal.json', JSON.stringify(bundle) + '\n', 'terminal');
      entry.terminal = bundle; entry.record = record;
    });
  }
  /** Parent-only path. Qualification is always reevaluated here; raw approved
   * records remain forbidden in create/save/commitOutcome. One atomic envelope
   * commits status, exact content, source proof and artifacts together. */
  commitPublication(value: { outcome: RunOutcome; run: RunRecord; artifacts: readonly TypedArtifact[];
    pool: z.infer<typeof CandidatePoolSchema>; evidence: EvidenceSnapshot;
    snapshot: DatasetSnapshot; actor: ReviewExpectation['actor']; reviewSnapshot: unknown }, reserveCommit: () => boolean): Promise<void> {
    const outcome = cloneFrozen(RunOutcomeSchema.parse(value.outcome));
    const run = cloneFrozen(RunRecordSchema.parse(value.run));
    const artifacts = cloneFrozen(value.artifacts.map(a=>TypedArtifactSchema.parse(a)));
    const pool = cloneFrozen(CandidatePoolSchema.parse(value.pool)), evidence = cloneFrozen(EvidenceSnapshotSchema.parse(value.evidence));
    const actor = cloneFrozen(ReviewActorSchema.parse(value.actor)); const reviewSnapshot = JsonValueSchema.parse(value.reviewSnapshot);
    return this.write(async()=>{
      if (outcome.kind !== 'reviewed') fail('PUBLICATION_REVIEW_REQUIRED');
      const entry=this.entry(outcome.runId); if(entry.terminal) fail('RUN_TERMINAL');
      this.checkRecord(entry.record,run,entry.events.length);
      if(!equal(entry.record,run)) fail('PUBLICATION_RECORD_NOT_CURRENT');
      const committedAt=new Date((this.options.now??Date.now)()).toISOString();
      const decision=evaluatePublication({run,draft:outcome.draft,counter:outcome.counter,review:outcome.review,pool,evidence,
        evidenceSnapshotHash:hashEvidenceSnapshot(evidence),snapshot:value.snapshot,actor,now:committedAt});
      if(!decision.allowed) fail('PUBLICATION_GATE_DENIED');
      if(!equal(reviewSnapshot,buildReviewSnapshot({input:run.input,snapshot:value.snapshot,pool,evidence,draft:outcome.draft,counter:outcome.counter})))fail('PUBLICATION_LOAD_PROOF_INVALID');
      for(const [kind,artifact] of [['proposal_draft',outcome.draft],['counter_report',outcome.counter],['critic_review',outcome.review]] as const)
        if(!artifacts.some(a=>a.kind===kind&&equal(a.artifact,artifact))) fail('PUBLICATION_ARTIFACT_MISSING');
      if(artifacts.some(a=>a.artifact.runId!==run.runId)) fail('ARTIFACT_RUN');
      // Transition's sequence consumes a control acknowledgement, not a fabricated
      // persisted event; archived lastSeq remains the actual event count.
      const next=transitionRun(run,{runId:run.runId,seq:run.lastSeq+1,action:'publication_committed',reviewId:outcome.review.id,reviewHash:outcome.review.hash,draftHash:outcome.draft.draftHash});
      if(next.kind!=='changed') fail('PUBLICATION_TRANSITION_DENIED');
      const record=RunRecordSchema.parse({...next.state,lastSeq:run.lastSeq});
      const renderedDraft=renderApprovedDraft(outcome.draft);
      const formalProposal=run.input.mode==='research'&&run.runnerMode==='live'?{
        id:`proposal_${run.runId}`,pairKey:`${outcome.draft.pair.companyId}:${outcome.draft.pair.researcherId}`,runId:run.runId,mode:'research',
        draft:outcome.draft,reviewId:outcome.review.id,reviewHash:outcome.review.hash,committedAt}:null;
      const publication=publicationEnvelope.parse({format:'canonical-json-draft-v1',mode:run.input.mode,runnerMode:run.runnerMode,
        renderedDraft,renderedHash:hashArtifact({renderedDraft}),formalProposal,committedAt,
        proof:{reviewedRecord:run,pool,evidence,actor,reviewSnapshot}});
      const bundle=cloneFrozen(terminalEnvelope.parse({schemaVersion:1,record,outcome,artifacts,eventCount:entry.events.length,publication}));
      await this.atomic(run.runId,'terminal.json',JSON.stringify(bundle)+'\n','terminal',reserveCommit);
      entry.terminal=bundle;entry.record=cloneFrozen(record);
    });
  }
  private async recover(): Promise<void> {
    for (const name of (await readdir(this.root)).sort()) {
      if (name === 'writer.lock') continue;
      if (name === HISTORICAL_RECOVERY_FOLDER) continue;
      if (!UuidSchema.safeParse(name).success) { this.problem('UNKNOWN_STORE_ENTRY', undefined, name); continue; }
      const folder = join(this.root, name);
      try {
        await directory(folder, false);
        const raw = await readText(join(folder, 'record.json'));
        if (!raw) { this.problem('MISSING_RECORD', name); continue; }
        let record = validRecord(recordEnvelope.parse(JSON.parse(raw)).record);
        if (record.runId !== name || terminalStatuses.has(record.status)) fail('INVALID_BASE_RECORD');
        const events: StoredEvent[] = [];
        const log = await readText(join(folder, 'events.jsonl'));
        let validLog = true;
        if (log !== undefined) {
          const lines = log.split('\n');
          if (lines.at(-1) === '') lines.pop();
          else { lines.pop(); validLog = false; this.problem('TRUNCATED_EVENT_TAIL', name); }
          for (const line of lines) {
            try {
              if (Buffer.byteLength(line) > MAX_EVENT_BYTES) fail('EVENT_TOO_LARGE');
              const event = StoredEventSchema.parse(JSON.parse(line));
              if (event.runId !== name || event.seq !== events.length + 1) fail('EVENT_SEQUENCE');
              events.push(cloneFrozen(event));
            } catch { validLog = false; this.problem('INVALID_EVENT_LOG', name); break; }
          }
        }
        if (record.lastSeq > events.length) { validLog = false; this.problem('MISSING_CONFIRMED_EVENTS', name); }
        record = cloneFrozen({ ...record, lastSeq: events.length });
        const entry: Entry = { record, events }; this.entries.set(name, entry);
        const terminalRaw = await readText(join(folder, 'terminal.json'));
        if (terminalRaw !== undefined) {
          const bundle = terminalEnvelope.parse(JSON.parse(terminalRaw));
          const end = validRecord(bundle.record,Boolean(bundle.publication));
          const outcome = bundle.outcome;
          if (!validLog || outcome.runId !== name || end.runId !== name
            || end.status !== (outcome.kind==='reviewed'?'approved':outcome.kind) || bundle.eventCount > events.length || end.lastSeq !== bundle.eventCount
            || bundle.artifacts.some(a => a.artifact.runId !== name)) fail('INVALID_TERMINAL_BUNDLE');
          this.checkRecord(record, { ...end, lastSeq: events.length }, events.length);
          if(outcome.kind==='reviewed'){
            const p=bundle.publication;if(!p)fail('MISSING_PUBLICATION_PROOF');
            const snapshot=this.options.publicationSnapshot?await this.options.publicationSnapshot():await loadSnapshot(resolve('reference/einstein-matchmaker-data'),end.input.datasetCommit);
            const decision=evaluatePublication({run:p.proof.reviewedRecord,draft:outcome.draft,counter:outcome.counter,review:outcome.review,
              pool:p.proof.pool,evidence:p.proof.evidence,evidenceSnapshotHash:hashEvidenceSnapshot(p.proof.evidence),snapshot,actor:p.proof.actor,now:p.committedAt});
            const expected=transitionRun(p.proof.reviewedRecord,{runId:name,seq:p.proof.reviewedRecord.lastSeq+1,action:'publication_committed',reviewId:outcome.review.id,reviewHash:outcome.review.hash,draftHash:outcome.draft.draftHash});
            if(!decision.allowed||expected.kind!=='changed'||!equal({...expected.state,lastSeq:bundle.eventCount},end)
              ||p.renderedDraft!==renderApprovedDraft(outcome.draft)||p.renderedHash!==hashArtifact({renderedDraft:p.renderedDraft})
              ||p.mode!==end.input.mode||p.runnerMode!==end.runnerMode)fail('INVALID_PUBLICATION_PROOF');
            if(!equal(p.proof.reviewSnapshot,buildReviewSnapshot({input:end.input,snapshot,pool:p.proof.pool,evidence:p.proof.evidence,draft:outcome.draft,counter:outcome.counter})))fail('INVALID_PUBLICATION_LOAD_PROOF');
            for(const [kind,artifact]of [['proposal_draft',outcome.draft],['counter_report',outcome.counter],['critic_review',outcome.review]] as const)
              if(!bundle.artifacts.some(a=>a.kind===kind&&equal(a.artifact,artifact)))fail('MISSING_PUBLICATION_ARTIFACT');
            // Archived actor metadata must be backed by the native/application
            // task sequence; comparing three matching metadata copies is insufficient.
            const receipts=new PublicationReceipts(name);
            for(const archived of events.slice(0,bundle.eventCount)){
              const {schemaVersion:_v,seq:_s,at:_at,elapsedMs:_ms,...rawEvent}=archived;
              const parsed=WorkerEventSchema.safeParse(rawEvent);if(!parsed.success)continue;const e=parsed.data;
              if(e.type==='task.started'&&e.role==='critic'){
                const reviewed=bundle.artifacts.find(a=>a.kind==='critic_review'&&a.artifact.version===e.attempt);
                if(reviewed?.kind!=='critic_review')fail('MISSING_REVIEW_HISTORY');
                receipts.dispatch({actor:{role:'critic',agentId:e.agentId,taskId:e.taskId,contextId:e.contextId,attempt:e.attempt},reviewVersion:e.attempt,target:reviewed.artifact.target});
              }
              receipts.accept(e,bundle.artifacts);
            }
            const proven=receipts.actorForReview(outcome.review.hash);
            if(!receipts.hasCurrentArtifact({kind:'proposal_draft',artifact:outcome.draft})||!receipts.hasCurrentArtifact({kind:'counter_report',artifact:outcome.counter})
              ||!receipts.hasCurrentArtifact({kind:'critic_review',artifact:outcome.review}))fail('UNPROVEN_PUBLICATION_ARTIFACTS');
            if(!proven)fail('UNPROVEN_PUBLICATION_ACTOR');const {runId:_run,loopId:_loop,...actor}=proven;
            if(!equal(actor,p.proof.actor))fail('PUBLICATION_ACTOR_HISTORY_MISMATCH');
            const formal=p.formalProposal;
            const expectedFormal=end.input.mode==='research'&&end.runnerMode==='live'?{id:`proposal_${name}`,pairKey:`${outcome.draft.pair.companyId}:${outcome.draft.pair.researcherId}`,runId:name,mode:'research',draft:outcome.draft,reviewId:outcome.review.id,reviewHash:outcome.review.hash,committedAt:p.committedAt}:null;
            if(!equal(formal,expectedFormal))fail('INVALID_FORMAL_PUBLICATION');
          }else if(bundle.publication)fail('UNEXPECTED_PUBLICATION');
          entry.terminal = cloneFrozen(bundle);
          entry.record = cloneFrozen({ ...end, lastSeq: events.length });
          if (['pending', 'unconfirmed'].includes(end.cleanupState)) this.problem('UNCONFIRMED_CLEANUP', name);
        } else this.problem('UNFINISHED_RUN', name);
        for (const file of await readdir(folder)) {
          if (!['record.json', 'events.jsonl', 'terminal.json'].includes(file)) this.problem('UNCONFIRMED_STORE_FILE', name, file);
        }
      } catch { this.problem('INVALID_RUN_STORAGE', name); }
    }
    await this.recoverHistoricalResolution();
  }

  private recoveryProblems(): Diagnostic[] {
    return this.problems.filter(p=>p.code==='UNCONFIRMED_CLEANUP'&&p.runId===HISTORICAL_RECOVERY_SCOPE.runId);
  }
  private async recoveryFiles():Promise<string[]> {
    const folder=join(this.root,HISTORICAL_RECOVERY_FOLDER);
    try { await directory(folder,false); return (await readdir(folder)).sort(); }
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}
  }
  private applyRecoveryResolution(resolution:HistoricalRecoveryResolution):void {
    // Preserve every diagnostic and historical Run byte; only this exact dated
    // risk decision changes one diagnostic's infrastructure admission effect.
    for(const problem of this.recoveryProblems())this.resolvedProblems.add(problem);
    this.recoveryResolution=resolution;
  }
  private async recoverHistoricalResolution():Promise<void> {
    const folder=join(this.root,HISTORICAL_RECOVERY_FOLDER),name=HISTORICAL_RECOVERY_SCOPE.runId+'.resolution.json';
    try {
      const files=await this.recoveryFiles();if(!files.length)return;
      if(files.length!==1||files[0]!==name){this.problem('HISTORICAL_RECOVERY_INCOMPLETE',HISTORICAL_RECOVERY_SCOPE.runId,HISTORICAL_RECOVERY_FOLDER);return;}
      if(!this.recoveryAuthorization){this.problem('HISTORICAL_RECOVERY_UNAUTHORIZED',HISTORICAL_RECOVERY_SCOPE.runId,HISTORICAL_RECOVERY_FOLDER);return;}
      const a=await verifyHistoricalRecoveryAuthorization(this.recoveryAuthorization,this.root,(this.options.now??Date.now)(),false);
      const resolution=verifyHistoricalRecoveryResolution(JSON.parse((await readText(join(folder,name)))??''),a);
      if(this.recoveryProblems().length!==1)fail('RECOVERY_DIAGNOSTIC_BINDING');
      this.applyRecoveryResolution(resolution);
    } catch { this.problem('HISTORICAL_RECOVERY_INVALID',HISTORICAL_RECOVERY_SCOPE.runId,HISTORICAL_RECOVERY_FOLDER); }
  }
  /** Explicit parent-only maintenance path. No PermitManager is accepted or
   * touched: archival reservation disposition never decrements a fresh manager.
   * The original Run terminal/cleanup/event bytes are immutable throughout. */
  applyHistoricalRecovery():Promise<HistoricalRecoveryResolution> {
    if(this.closed||this.closing)return Promise.reject(new StoreError('STORE_CLOSED'));
    const operation=this.tail.then(async()=>{
      if(!this.recoveryAuthorization)fail('RECOVERY_AUTHORIZATION');
      const a=await verifyHistoricalRecoveryAuthorization(this.recoveryAuthorization,this.root,(this.options.now??Date.now)(),!this.recoveryResolution);
      if(this.recoveryResolution){
        // Idempotent only while the durable decision and all bound bytes still
        // match. An unrelated current hold is never bypassed by replay.
        const expected=a.runId+'.resolution.json',files=await this.recoveryFiles();
        if(files.length!==1||files[0]!==expected)fail('RECOVERY_INCOMPLETE');
        const current=verifyHistoricalRecoveryResolution(JSON.parse((await readText(join(this.root,HISTORICAL_RECOVERY_FOLDER,expected)))??''),a);
        if(!equal(current,this.recoveryResolution))fail('RECOVERY_RESOLUTION_BINDING');
        if(this.unresolvedDiagnostics.length)fail('RECOVERY_OTHER_HOLD');return current;
      }
      const matching=this.recoveryProblems();
      if(matching.length!==1||this.problems.some(p=>!matching.includes(p)))fail('RECOVERY_OTHER_HOLD');
      const folder=join(this.root,HISTORICAL_RECOVERY_FOLDER),name=a.runId+'.resolution.json';
      if((await this.recoveryFiles()).length)fail('RECOVERY_INCOMPLETE');
      let handle;
      try {
        await directory(folder,true);await this.options.fault?.('recovery:beforeWrite');
        const pending=join(folder,a.runId+'.pending');handle=await open(pending,'wx');
        const resolution=createHistoricalRecoveryResolution(a,(this.options.now??Date.now)());
        await handle.writeFile(JSON.stringify(resolution)+'\n','utf8');await this.options.fault?.('recovery:beforeSync');
        await handle.sync();await handle.close();handle=undefined;await this.options.fault?.('recovery:beforeRename');
        // Recheck immediately before the sole durable commit point. Single
        // store writer ownership prevents a second maintenance writer.
        await verifyHistoricalRecoveryAuthorization(a,this.root,(this.options.now??Date.now)(),true);
        await rename(pending,join(folder,name));
        await this.options.fault?.('recovery:afterRename');
        this.applyRecoveryResolution(resolution);return resolution;
      } catch(error){this.problem('HISTORICAL_RECOVERY_WRITE_FAILED',a.runId,HISTORICAL_RECOVERY_FOLDER);throw error;}
      finally {await handle?.close();}
    }).catch(error=>{
      this.problem('HISTORICAL_RECOVERY_VALIDATION_FAILED',HISTORICAL_RECOVERY_SCOPE.runId,HISTORICAL_RECOVERY_FOLDER);
      throw error;
    });
    this.tail=operation.then(()=>{},()=>{});return operation;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    await this.tail;
    if (this.ownsLock) {
      const path = join(this.root, 'writer.lock');
      try {
        const lock = JSON.parse((await readText(path)) ?? '{}');
        if (lock.nonce !== this.nonce) fail('STORE_LOCK_OWNERSHIP');
        await unlink(path); this.ownsLock = false;
      } catch (error) { this.problem('STORE_LOCK_OWNERSHIP'); this.closed = true; throw error; }
    }
    this.closed = true;
  }
}
