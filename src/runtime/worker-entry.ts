import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ParentToWorkerMessageSchema, WorkerToParentMessageSchema, type ParentToWorkerMessage, type WorkerToParentMessage } from '../contracts/ipc.js';
import type { RunOutcome } from '../contracts/domain.js';
import type { WorkerEvent } from '../contracts/events.js';
import { UuidSchema } from '../contracts/primitives.js';
import { executeRun, type ExecuteOptions } from './orchestrator.js';
import { WorkerPermitClient } from './worker-client.js';
import type { TaskIdentity } from '../model/gateway-runner.js';
import { textRef } from './observer.js';
import { hashArtifact } from '../evidence/hashing.js';

type Start = Extract<ParentToWorkerMessage, { kind: 'start' }>;
type Options = {
  /** Trusted harness injection only; no module path or function from IPC/RunInput. */
  configure?: (context: { start: Start; signal: AbortSignal; permitClient: WorkerPermitClient }) => ExecuteOptions | Promise<ExecuteOptions>;
  beforeSend?: (message: WorkerToParentMessage, signal: AbortSignal) => Promise<void>;
};
const ProbeAnswer = z.strictObject({ runId: UuidSchema, receiptId: UuidSchema, challengeId: z.string().regex(/^C\d{3}-CH[1-9]\d?$/) });
function safeCode(error: unknown, fallback: string) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.message : undefined;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code) ? code : fallback;
}

/** Single-Run isolated bootstrap. Parent owns admission, deadlines, permits and all Run writes. */
export function startWorker(options: Options = {}): void {
  process.env.MOZAIK_API_KEY = ''; // explicit disable; never pair/read cached cloud credentials
  const controller = new AbortController(), signal = controller.signal;
  let start: Start | undefined, client: WorkerPermitClient | undefined, closing = false, connected = Boolean(process.connected), tail = Promise.resolve();
  let pendingOutcome: RunOutcome | undefined, pendingExitCode = 0, exiting = false;
  const diagnostic: { native: unknown[]; requests: unknown[] } = { native: [], requests: [] };
  let mode: ExecuteOptions['runnerMode'] = options.configure ? 'offline_fixture' : 'live';
  const isProbe = process.argv.includes('--adapter-probe');
  const exit = async (code: number, outcome?: RunOutcome) => {
    if (exiting) return; exiting = true;
    connected = false; client?.stop('WORKER_STOPPED');
    const line = JSON.stringify({ task6Worker: true, runnerMode: mode, runId: start?.runId, kind: outcome?.kind,
      ...(isProbe ? { diagnostic } : {}) });
    // Bounded stdout proof is diagnostic only, never an application artifact or publishing authority.
    const safeLine = Buffer.byteLength(line) <= 14000 ? line : JSON.stringify({ task6Worker: true, runId: start?.runId, code: 'DIAGNOSTIC_OUTPUT_LIMIT' });
    await new Promise<void>(done => { process.stdout.write(safeLine + '\n', () => done()); });
    if (process.connected) process.disconnect();
    process.exit(code);
  };
  function enqueue(raw: WorkerToParentMessage, final = false): Promise<void> {
    const message = WorkerToParentMessageSchema.parse(raw);
    // These are observations already accepted before stop, not permission for
    // another model request or a late artifact. Drain them before the outcome
    // so an immediate answer failure cannot erase its own diagnostic evidence.
    const observedTerminal = message.kind === 'event' && ['task.failed', 'model.answer',
      'model.request.completed', 'model.request.failed', 'model.usage'].includes(message.nativeOrAppEvent.type);
    const control = final || message.kind === 'permit.release' || observedTerminal;
    const operation = tail.then(async () => {
      if (!connected || !process.connected || !process.send) throw Error('IPC_DISCONNECTED');
      if (signal.aborted && !control) throw Error('WORKER_STOPPED');
      if (!control) await options.beforeSend?.(message, signal);
      if (signal.aborted && !control) throw Error('WORKER_STOPPED');
      await new Promise<void>((done, failed) => { process.send!(message, error => error ? failed(Error('IPC_SEND_FAILED')) : done()); });
    });
    tail = operation.catch(error => { if (!closing) void fail(safeCode(error, 'IPC_SEND_FAILED')); });
    return operation;
  }
  function emit(event: WorkerEvent) { if (!start || signal.aborted || closing) return;
    void enqueue({ v: 1, runId: start.runId, kind: 'event', nativeOrAppEvent: event }).catch(() => {}); }
  async function fail(code: string, kind: 'failed' | 'cancelled' = 'failed') {
    if (closing) return; closing = true;
    controller.abort(); client?.stop(code);
    const outcome: RunOutcome | undefined = start ? { runId: start.runId, kind, reasonCodes: [code] } : undefined;
    pendingOutcome = outcome; pendingExitCode = kind === 'cancelled' ? 0 : 1;
    if (!outcome || !connected) { await exit(pendingExitCode, outcome); return; }
    try { await enqueue({ v: 1, runId: start!.runId, kind: 'outcome', typedOutcome: outcome }, true); }
    catch { await exit(pendingExitCode, outcome); return; }
    await tail;
    // Keep the registered root identity alive until parent cleanup has scanned
    // descendants and sends cancel. An outcome is not permission to exit early.
  }
  async function parentStop(code: string, disconnected = false) {
    controller.abort(); client?.stop(code);
    if (!closing) await fail(code, disconnected ? 'failed' : 'cancelled');
    await tail; await exit(disconnected ? 1 : pendingExitCode, pendingOutcome);
  }
  async function begin(value: Start) {
    if (start) { await fail('DUPLICATE_START'); return; }
    const marker = process.argv.indexOf('--supervisor-run-id');
    if (marker < 0 || process.argv[marker + 1] !== value.runId) { await fail('WORKER_RUN_MARKER_MISMATCH'); return; }
    start = value;
    client = new WorkerPermitClient({ runId: start.runId, signal, send: message => enqueue(message) });
    try {
      await enqueue({ v: 1, kind: 'ready', runId: start.runId });
      const configured: ExecuteOptions = options.configure ? await options.configure({ start, signal, permitClient: client }) : {
        runnerMode: 'live', adapterProbe: isProbe,
        gateway: { baseURL: process.env.EINSTEIN_GATEWAY_BASE_URL ?? '', apiKey: process.env.EINSTEIN_GATEWAY_API_KEY ?? '', model: process.env.EINSTEIN_GATEWAY_MODEL ?? '' }
      };
      mode = configured.runnerMode;
      const native = configured.onNative, trace = configured.onTrace, artifact = configured.onArtifact;
      const outcome = await executeRun(start, emit, client, { ...configured, signal,
        onReviewDispatch: item => { configured.onReviewDispatch?.(item);
          if (!signal.aborted && !closing) void enqueue({ v: 1, runId: start!.runId, kind: 'review.dispatch', expectation: item.expectation, snapshotHash: hashArtifact(item.snapshot) }).catch(() => {}); },
        onArtifact: item => { artifact?.(item); if (!signal.aborted && !closing) void enqueue({ v: 1, runId: start!.runId, kind: 'artifact', typedArtifact: item }).catch(() => {}); },
        onTrace: item => { trace?.(item); if (isProbe) diagnostic.requests.push(item); },
        onNative: (event, actor) => {
          native?.(event, actor); if (!isProbe) return;
          const p = event.payload as Record<string, any>, identity: TaskIdentity = { ...actor };
          if (event.type === 'function_call.started') diagnostic.native.push({ type: event.type, actor: identity, callId: p.call.callId, toolName: p.call.name, argumentsHash: textRef(p.call.args).hash });
          if (event.type === 'function_call.completed') {
            const output = JSON.parse(p.output.text);
            diagnostic.native.push({ type: event.type, actor: identity, callId: p.callId, outputHash: textRef(p.output.text).hash,
              receipt: { ok: output.ok, runId: output.runId, receiptId: output.receiptId, poolHash: output.poolHash,
                evidenceSnapshotHash: output.evidenceSnapshotHash, challengeId: output.data?.challenge?.id } });
          }
          if (event.type === 'inference.started') for (const item of p.context.getItems()) if (item.type === 'function_call_output') {
            const output = JSON.parse(item.output.text);
            diagnostic.native.push({ type: 'context.tool_result', actor: identity, callId: item.callId,
              outputHash: textRef(item.output.text).hash, receiptId: output.receiptId });
          }
          if (event.type === 'model.answer') diagnostic.native.push({ type: event.type, actor: identity, answer: ProbeAnswer.parse(JSON.parse(p.answer.content.text)) });
        }
      });
      if (closing || signal.aborted) return;
      await enqueue({ v: 1, runId: start.runId, kind: 'outcome', typedOutcome: outcome });
      if (closing || signal.aborted) return;
      pendingOutcome = outcome; pendingExitCode = 0; closing = true;
      await tail; controller.abort(); client.stop('WORKER_OUTCOME_SENT');
      // Await the parent's identity-safe cleanup handshake over the live IPC.
    } catch (error) { await fail(safeCode(error, 'WORKER_EXECUTION_FAILED')); }
  }
  process.on('message', raw => {
    const parsed = ParentToWorkerMessageSchema.safeParse(raw);
    if (!parsed.success) { void fail('IPC_INVALID'); return; }
    const message = parsed.data;
    if (message.kind === 'cancel' && start && message.runId === start.runId) { void parentStop(message.reason); return; }
    if (closing) return;
    if (message.kind === 'start') { void begin(message).catch(() => fail('WORKER_EXECUTION_FAILED')); return; }
    if (!start || message.runId !== start.runId) { void fail('IPC_RUN_MISMATCH'); return; }
    try { client?.receive(message); } catch (error) { void fail(safeCode(error, 'IPC_INVALID')); }
  });
  process.once('disconnect', () => { connected = false; client?.disconnect(); void parentStop('PARENT_DISCONNECTED', true); });
  process.on('unhandledRejection', () => { void fail('WORKER_UNHANDLED_REJECTION'); });
  process.on('uncaughtException', () => { void fail('WORKER_UNCAUGHT_EXCEPTION'); });
  if (!connected) void fail('IPC_DISCONNECTED');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startWorker();
