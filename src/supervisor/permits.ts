import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DEFAULT_LIMITS, LimitsSchema, type Limits } from '../contracts/config.js';
import { UuidSchema } from '../contracts/primitives.js';
import { deadlineTimer, type DeadlineTimer } from './deadline.js';

/** Parent-owned capability metadata, matching the approved Permit contract. */
export type Permit = Readonly<{ id: string; runId: string; requestId: string; grantedAt: string; expiresAt: string }>;
export class PermitError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'PermitError'; }
}
type Request = {
  runId: string; requestId: string; state: 'pending' | 'granted' | 'released' | 'rejected';
  promise: Promise<Permit>; resolve: (permit: Permit) => void; reject: (error: PermitError) => void;
  permit?: Permit; expiresMono?: number; timer?: DeadlineTimer;
};
type Run = { runId: string; deadlineAt: number; deadlineMono: number; attempts: number; stopped?: string; pending: Set<Request>; timer?: DeadlineTimer };

/**
 * One parent owns all reservations. Mutations and grant decisions are synchronous
 * (there is no await between checking a limit and reserving a slot).
 * Expiration/cancellation denies more work but NEVER implies that an old request
 * has finished. Active slots remain until authenticated release or confirmed-exit
 * reclamation by the process supervisor.
 */
export class PermitManager {
  readonly #limits: Limits;
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  readonly #runs = new Map<string, Run>();
  readonly #requests = new Map<string, Request>();
  readonly #permits = new Map<string, Request>();
  readonly #active = new Set<Request>();
  readonly #queue: Request[] = [];
  #disposed = false;

  constructor(options: { limits?: Limits; now?: () => number; monotonicNow?: () => number } = {}) {
    this.#limits = Object.freeze(LimitsSchema.parse(options.limits ?? DEFAULT_LIMITS));
    this.#now = options.now ?? Date.now;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  registerRun(runId: string, deadlineAt: number, admissionDeadlineMonotonicAt?: number): void {
    this.#assertOpen(); UuidSchema.parse(runId);
    if (this.#runs.has(runId)) throw new PermitError('RUN_ALREADY_REGISTERED');
    const time = this.#time(), mono = this.#mono();
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt > 8_640_000_000_000_000)
      throw new PermitError('INVALID_RUN_DEADLINE');
    if (deadlineAt <= time) throw new PermitError('RUN_DEADLINE_EXCEEDED');
    // Subtract the integer wall clocks before adding the fractional monotonic
    // origin; mixing an epoch-sized sum into that conversion loses precision.
    const wallDelta = deadlineAt - time;
    if (admissionDeadlineMonotonicAt === undefined
      && (!Number.isSafeInteger(wallDelta) || wallDelta > this.#limits.runTimeoutMs))
      throw new PermitError('INVALID_RUN_DEADLINE');
    const deadlineMono = admissionDeadlineMonotonicAt ?? mono + wallDelta;
    // Compare absolute monotonic instants. Subtracting them can round an exact
    // legal bound above the cap; the next representable instant still fails.
    if (!Number.isFinite(deadlineMono) || deadlineMono > mono + this.#limits.runTimeoutMs)
      throw new PermitError('INVALID_RUN_DEADLINE');
    if (deadlineMono <= mono) throw new PermitError('RUN_DEADLINE_EXCEEDED');
    const run: Run = { runId, deadlineAt, deadlineMono, attempts: 0, pending: new Set() };
    this.#runs.set(runId, run);
    run.timer = this.#timer(deadlineAt, deadlineMono, () => this.stopRun(runId, 'RUN_DEADLINE_EXCEEDED'));
  }

  /** Parent-only timing metadata; it is not serialized into Permit or worker IPC. */
  timing(runId: string, permitId: string): Readonly<{ expiresAt: number; expiresMonotonicAt: number }> {
    UuidSchema.parse(runId); UuidSchema.parse(permitId);
    const request = this.#permits.get(permitId);
    if (!request) throw new PermitError('PERMIT_UNKNOWN');
    if (request.runId !== runId) throw new PermitError('PERMIT_RUN_MISMATCH');
    return Object.freeze({ expiresAt: Date.parse(request.permit!.expiresAt), expiresMonotonicAt: request.expiresMono! });
  }

  acquire(runId: string, requestId: string): Promise<Permit> {
    try {
      this.#assertOpen(); UuidSchema.parse(runId); UuidSchema.parse(requestId);
      const existing = this.#requests.get(requestId);
      if (existing && existing.runId !== runId) throw new PermitError('REQUEST_RUN_MISMATCH');
      const run = this.#getRun(runId);
      this.#expireRuns();
      if (run.stopped) throw new PermitError(run.stopped);
      // Includes pending, granted and released requests. A repeated request never
      // receives a new identity, reservation or attempt after its original release.
      if (existing) return existing.promise;
      if (run.attempts >= this.#limits.maxModelRequests) throw new PermitError('RUN_REQUEST_LIMIT');
      let resolve!: Request['resolve'], reject!: Request['reject'];
      const promise = new Promise<Permit>((yes, no) => { resolve = yes; reject = no; });
      const request: Request = { runId, requestId, state: 'pending', promise, resolve, reject };
      this.#requests.set(requestId, request); run.pending.add(request); this.#queue.push(request);
      this.#drain(); return promise;
    } catch (error) { return Promise.reject(error); }
  }

  release(runId: string, permitId: string): boolean {
    UuidSchema.parse(runId); UuidSchema.parse(permitId);
    const request = this.#permits.get(permitId);
    if (!request) throw new PermitError('PERMIT_UNKNOWN');
    if (request.runId !== runId) throw new PermitError('PERMIT_RUN_MISMATCH');
    if (request.state !== 'granted') return false;
    request.timer?.cancel(); request.timer = undefined; request.state = 'released'; this.#active.delete(request);
    this.#drain(); return true;
  }

  stopRun(runId: string, code = 'RUN_CANCELLED'): void {
    const run = this.#getRun(runId);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code)) throw new PermitError('INVALID_STOP_CODE');
    if (run.stopped) return;
    run.stopped = code; run.timer?.cancel(); run.timer = undefined;
    for (const request of [...run.pending]) this.#rejectPending(run, request, code);
    // In-flight requests deliberately retain their timers and capacity.
  }

  /** Trusted caller MUST have confirmed worker exit/cleanup before invoking. */
  reclaimRun(runId: string): void {
    this.stopRun(runId, 'WORKER_EXITED');
    for (const request of this.#active) if (request.runId === runId) {
      request.timer?.cancel(); request.timer = undefined; request.state = 'released'; this.#active.delete(request);
    }
    this.#drain();
  }

  snapshot() {
    return Object.freeze({ inFlight: this.#active.size, runs: Object.freeze([...this.#runs.values()].map(run =>
      Object.freeze({ runId: run.runId, attempts: run.attempts,
        inFlight: [...this.#active].filter(request => request.runId === run.runId).length,
        pending: run.pending.size, stopped: Boolean(run.stopped), stopCode: run.stopped ?? null }))) });
  }

  /** Teardown rejects waiting requests; it does not pretend active work exited. */
  dispose(): void {
    if (this.#disposed) return;
    for (const run of this.#runs.values()) {
      this.stopRun(run.runId, 'MANAGER_DISPOSED'); run.timer?.cancel();
    }
    for (const request of this.#active) request.timer?.cancel();
    this.#disposed = true;
  }

  #assertOpen() { if (this.#disposed) throw new PermitError('MANAGER_DISPOSED'); }
  #time() {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || Math.abs(now) > 8_640_000_000_000_000) throw new PermitError('INVALID_CLOCK');
    return now;
  }
  #mono() {
    const now = this.#monotonicNow();
    if (!Number.isFinite(now) || Math.abs(now) > Number.MAX_SAFE_INTEGER) throw new PermitError('INVALID_MONOTONIC_CLOCK');
    return now;
  }
  #getRun(runId: string) {
    UuidSchema.parse(runId); const run = this.#runs.get(runId);
    if (!run) throw new PermitError('RUN_UNKNOWN'); return run;
  }
  #timer(deadline: number, deadlineMono: number, action: () => void): DeadlineTimer {
    return deadlineTimer({ deadlineAt: deadline, deadlineMonotonicAt: deadlineMono,
      now: () => this.#time(), monotonicNow: () => this.#mono(),
      action: () => { if (!this.#disposed) action(); } });
  }
  #expireRuns() {
    const time = this.#time(), mono = this.#mono();
    for (const run of this.#runs.values()) if (!run.stopped && (time >= run.deadlineAt || mono >= run.deadlineMono))
      this.stopRun(run.runId, 'RUN_DEADLINE_EXCEEDED');
    for (const request of this.#active) if (request.permit && (time >= Date.parse(request.permit.expiresAt) || mono >= request.expiresMono!))
      this.stopRun(request.runId, 'REQUEST_TIMEOUT');
  }
  #rejectPending(run: Run, request: Request, code: string) {
    if (request.state !== 'pending') return;
    request.state = 'rejected'; run.pending.delete(request); request.reject(new PermitError(code));
  }
  #drain() {
    if (this.#disposed) return;
    this.#expireRuns();
    while (this.#active.size < this.#limits.maxConcurrentModelRequests && this.#queue.length) {
      const request = this.#queue.shift()!; if (request.state !== 'pending') continue;
      const run = this.#getRun(request.runId);
      if (run.stopped) { this.#rejectPending(run, request, run.stopped); continue; }
      if (run.attempts >= this.#limits.maxModelRequests) { this.#rejectPending(run, request, 'RUN_REQUEST_LIMIT'); continue; }
      const time = this.#time(), mono = this.#mono();
      if (time >= run.deadlineAt || mono >= run.deadlineMono) { this.stopRun(run.runId, 'RUN_DEADLINE_EXCEEDED'); continue; }
      const expiresMono = Math.min(mono + this.#limits.requestTimeoutMs, run.deadlineMono);
      const expiresAt = Math.min(time + this.#limits.requestTimeoutMs, run.deadlineAt, time + run.deadlineMono - mono);
      const permit: Permit = Object.freeze({ id: randomUUID(), runId: run.runId, requestId: request.requestId,
        grantedAt: new Date(time).toISOString(), expiresAt: new Date(expiresAt).toISOString() });
      request.permit = permit; request.expiresMono = expiresMono; request.state = 'granted'; run.pending.delete(request);
      run.attempts++; this.#active.add(request); this.#permits.set(permit.id, request);
      request.timer = this.#timer(Date.parse(permit.expiresAt), expiresMono, () => this.stopRun(run.runId,
        expiresMono === run.deadlineMono ? 'RUN_DEADLINE_EXCEEDED' : 'REQUEST_TIMEOUT'));
      request.resolve(permit);
    }
  }
}
