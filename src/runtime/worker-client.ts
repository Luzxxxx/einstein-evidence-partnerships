import { ParentToWorkerMessageSchema, WorkerToParentMessageSchema,
  type ParentToWorkerMessage, type WorkerToParentMessage } from '../contracts/ipc.js';
import { DiagnosticCodeSchema } from '../contracts/events.js';
import { UuidSchema } from '../contracts/primitives.js';
import type { PermitClient } from '../model/gateway-runner.js';

/** Fixed codes only; transport errors and abort reasons never enter model or IPC diagnostics. */
export class WorkerPermitError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WorkerPermitError'; }
}

type Request = {
  requestId: string;
  promise: Promise<{ id: string }>;
  resolve: (permit: { id: string }) => void;
  reject: (error: WorkerPermitError) => void;
  state: 'pending' | 'granted' | 'released' | 'rejected';
  sendConfirmed: boolean;
  detach: () => void;
  decision?: 'granted' | 'denied';
  denialCode?: string;
  permit?: Readonly<{ id: string }>;
  failure?: string;
  releasePromise?: Promise<void>;
};

/** One worker's transport adapter. The parent alone creates and accounts for permits.
 * Request history remains until worker exit so duplicates and late grants cannot reopen work.
 * Cancellation rejects work immediately; an authenticated late grant is returned over IPC.
 */
export class WorkerPermitClient implements PermitClient {
  readonly #runId: string;
  readonly #send: (message: WorkerToParentMessage) => void | Promise<void>;
  readonly #signal: AbortSignal;
  readonly #requests = new Map<string, Request>();
  readonly #permits = new Map<string, Request>();
  readonly #onAbort = () => this.stop('PERMIT_ABORTED');
  #connected = true;
  #stopped?: string;

  constructor(options: { runId: string; send: (message: WorkerToParentMessage) => void | Promise<void>; signal: AbortSignal }) {
    if (!UuidSchema.safeParse(options.runId).success || typeof options.send !== 'function'
      || !(options.signal instanceof AbortSignal)) throw new WorkerPermitError('IPC_INVALID');
    this.#runId = options.runId;
    this.#send = options.send;
    this.#signal = options.signal;
    if (this.#signal.aborted) this.stop('PERMIT_ABORTED');
    else this.#signal.addEventListener('abort', this.#onAbort, { once: true });
  }

  acquire(requestId: string, signal: AbortSignal): Promise<{ id: string }> {
    if (this.#stopped) return Promise.reject(new WorkerPermitError(this.#stopped));
    if (!UuidSchema.safeParse(requestId).success || !(signal instanceof AbortSignal))
      return Promise.reject(new WorkerPermitError('IPC_INVALID'));
    if (signal.aborted) return Promise.reject(new WorkerPermitError('PERMIT_ABORTED'));
    const previous = this.#requests.get(requestId);
    if (previous) {
      if (previous.state === 'released') return Promise.reject(new WorkerPermitError('REQUEST_ALREADY_RELEASED'));
      return previous.promise;
    }

    let resolve!: Request['resolve']; let reject!: Request['reject'];
    const promise = new Promise<{ id: string }>((yes, no) => { resolve = yes; reject = no; });
    const request: Request = { requestId, promise, resolve, reject, state: 'pending', sendConfirmed: false, detach: () => {} };
    const onAbort = () => this.#reject(request, 'PERMIT_ABORTED');
    request.detach = () => signal.removeEventListener('abort', onAbort);
    this.#requests.set(requestId, request);
    signal.addEventListener('abort', onAbort, { once: true });
    // Register before calling send: an in-memory transport may synchronously deliver the grant.
    void this.#transmit({ v: 1, kind: 'permit.request', runId: this.#runId, requestId }).then(() => {
      request.sendConfirmed = true;
      this.#activate(request);
    }, () => this.stop('IPC_SEND_FAILED'));
    return promise;
  }

  release(permitId: string): Promise<void> {
    if (!UuidSchema.safeParse(permitId).success) return Promise.reject(new WorkerPermitError('IPC_INVALID'));
    const request = this.#permits.get(permitId);
    if (!request) return Promise.reject(new WorkerPermitError('PERMIT_UNKNOWN'));
    if (request.releasePromise) return request.releasePromise;
    if (!this.#connected) return Promise.reject(new WorkerPermitError('IPC_DISCONNECTED'));

    let resolve!: () => void; let reject!: (error: WorkerPermitError) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    request.releasePromise = promise;
    // Mark before transport reentry. Parent capacity is still held until this send succeeds.
    if (request.state === 'granted') request.state = 'released';
    void this.#transmit({ v: 1, kind: 'permit.release', runId: this.#runId, permitId }).then(resolve, () => {
      this.stop('IPC_SEND_FAILED');
      reject(new WorkerPermitError('IPC_SEND_FAILED'));
    });
    return promise;
  }

  receive(message: ParentToWorkerMessage): void {
    // Once the channel is gone, only parent confirmed-exit reclamation can free capacity.
    if (!this.#connected) return;
    const parsed = ParentToWorkerMessageSchema.safeParse(message);
    if (!parsed.success) this.#protocolFailure('IPC_INVALID');
    const received = parsed.data;
    if (received.runId !== this.#runId) this.#protocolFailure('IPC_RUN_MISMATCH');
    if (received.kind === 'cancel') { this.stop(received.reason); return; }
    if (received.kind !== 'permit.granted' && received.kind !== 'permit.denied') this.#protocolFailure('IPC_INVALID');
    const request = this.#requests.get(received.requestId);
    if (!request) this.#protocolFailure('PERMIT_REQUEST_UNKNOWN');

    if (received.kind === 'permit.denied') {
      if (request.decision === 'granted' || (request.decision === 'denied' && request.denialCode !== received.code))
        this.#protocolFailure('PERMIT_CONFLICT');
      request.decision = 'denied'; request.denialCode = received.code;
      this.#reject(request, received.code);
      return;
    }

    const owner = this.#permits.get(received.permitId);
    if (request.decision === 'denied' || (request.permit && request.permit.id !== received.permitId)
      || (owner && owner !== request)) this.#protocolFailure('PERMIT_CONFLICT');
    request.decision = 'granted';
    if (!request.permit) {
      request.permit = Object.freeze({ id: received.permitId });
      this.#permits.set(received.permitId, request);
    }
    if (request.state === 'rejected') this.#returnUnused(request);
    else this.#activate(request);
  }

  disconnect(): void {
    this.#connected = false;
    this.stop('IPC_DISCONNECTED');
  }

  stop(code = 'WORKER_STOPPED'): void {
    if (this.#stopped) return;
    this.#stopped = DiagnosticCodeSchema.safeParse(code).success ? code : 'WORKER_STOPPED';
    this.#signal.removeEventListener('abort', this.#onAbort);
    for (const request of this.#requests.values()) this.#reject(request, this.#stopped);
  }

  #activate(request: Request): void {
    if (request.state !== 'pending' || !request.sendConfirmed || !request.permit) return;
    if (this.#stopped) { this.#reject(request, this.#stopped); return; }
    request.state = 'granted'; request.detach(); request.resolve(request.permit);
  }

  #reject(request: Request, code: string): void {
    if (request.state !== 'pending') return;
    request.state = 'rejected'; request.failure = code; request.detach();
    request.reject(new WorkerPermitError(code));
    this.#returnUnused(request);
  }

  #returnUnused(request: Request): void {
    if (!request.permit || !this.#connected) return;
    // receive() is synchronous; observe this rejection here and stop other pending work.
    void this.release(request.permit.id).catch(() => this.stop('IPC_SEND_FAILED'));
  }

  #protocolFailure(code: string): never {
    this.stop(code);
    throw new WorkerPermitError(code);
  }

  #transmit(message: WorkerToParentMessage): Promise<void> {
    if (!this.#connected) return Promise.reject(new WorkerPermitError('IPC_DISCONNECTED'));
    const parsed = WorkerToParentMessageSchema.safeParse(message);
    if (!parsed.success || parsed.data.runId !== this.#runId) return Promise.reject(new WorkerPermitError('IPC_INVALID'));
    try {
      return Promise.resolve(this.#send(parsed.data)).catch(() => { throw new WorkerPermitError('IPC_SEND_FAILED'); });
    } catch {
      return Promise.reject(new WorkerPermitError('IPC_SEND_FAILED'));
    }
  }
}
