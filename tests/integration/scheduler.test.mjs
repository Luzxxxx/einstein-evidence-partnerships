import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { Scheduler } from '../../dist/server/supervisor/scheduler.js';
import { RunStore } from '../../dist/server/storage/run-store.js';
import { DEFAULT_LIMITS } from '../../dist/server/contracts/config.js';
import { DATASET_COMMIT } from '../../dist/server/contracts/primitives.js';

const input = () => ({ runId: randomUUID(), companyId: 'C001', challengeId: 'C001-CH1', datasetCommit: DATASET_COMMIT,
  promptVersion: 'offline-fixture', configVersion: 'task5', mode: 'research' });
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 3000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error('Condition timeout'); await delay(10); } }
// Deterministic transport double ONLY; real Windows workers are verified separately.
class ControlledHost {
  constructor(callbacks, confirmed = true) { this.callbacks = callbacks; this.confirmed = confirmed; this.handles = []; }
  start(i) {
    let close; const closed = new Promise(r => { close = r; });
    const h = { runId: i.runId, pid: 900000 + this.handles.length, ready: new Promise(() => {}), identity: Promise.resolve(null), closed,
      messages: [], send: msg => { h.messages.push(msg); return true; }, inspectDescendants: async () => [],
      terminate: async () => { const evidence = { runId: i.runId, pid: h.pid, exitCode: 0, signal: null, exitObserved: true, closeObserved: true };
        close(evidence); this.callbacks.onExit?.(i.runId, evidence); return { confirmed: this.confirmed, reason: this.confirmed ? 'TEST_DOUBLE_CONFIRMED' : 'TEST_DOUBLE_UNCONFIRMED', evidence }; } };
    this.handles.push(h); return h;
  }
  emit(id, message) { this.callbacks.onMessage(id, message); }
}
async function setup(t, overrides = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'einstein task5 调度 '));
  const store = await RunStore.open(root, options.storeOptions);
  let host;
  const scheduler = new Scheduler({ store, snapshotPath: resolve('reference/einstein-matchmaker-data'),
    limits: { ...DEFAULT_LIMITS, ...overrides }, runnerMode: 'offline_fixture', now: options.now, monotonicNow: options.monotonicNow,
    createHost: callbacks => { host = new ControlledHost(callbacks, options.confirmed ?? true); return host; } });
  t.after(async () => { try { await scheduler.close(); } catch { assert.equal(scheduler.safetyHold, true); }
    await store.close(); const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir())) && absolute.includes('einstein task5 调度 ')); await rm(absolute, { recursive: true, force: true }); });
  return { root, store, scheduler, get host() { return host; } };
}
const outcome = (runId, kind = 'insufficient') => ({ v: 1, kind: 'outcome', runId,
  typedOutcome: { runId, kind, reasonCodes: ['OFFLINE_FIXTURE_ONLY'] } });

test('default admission is one plus three; queue cancellation has zero spawn and zero permits', async t => {
  const x = await setup(t); const runs = [];
  for (let n = 0; n < 4; n++) runs.push(await x.scheduler.submit(input()));
  assert.equal(x.host.handles.length, 1); assert.deepEqual(runs.map(r => r.status), ['researching', 'queued', 'queued', 'queued']);
  await assert.rejects(x.scheduler.submit(input()), e => e.code === 'RUN_QUEUE_FULL');
  const canceled = await x.scheduler.cancel(runs[1].runId);
  assert.equal(canceled.status, 'cancelled'); assert.equal(canceled.cleanupState, 'not_started');
  assert.equal(x.host.handles.length, 1);
  assert.equal(x.scheduler.permits.snapshot().runs.some(r => r.runId === runs[1].runId), false);
  assert.equal(x.store.getRun(runs[0].runId).runnerMode, 'offline_fixture');
});

test('queue timeout is independent and expires before spawn', async t => {
  const x = await setup(t, { queueTimeoutMs: 90, runTimeoutMs: 2000, requestTimeoutMs: 1000 });
  await x.scheduler.submit(input()); const q = await x.scheduler.submit(input());
  await until(() => x.store.getRun(q.runId).status === 'failed');
  assert.equal(x.host.handles.length, 1);
  assert.ok(x.store.eventsAfter(q.runId, 0).some(e => e.type === 'run.status' && e.payload.reasonCodes.includes('QUEUE_TIMEOUT')));
});

test('Run deadline starts at admission and includes never-ready startup', async t => {
  const x = await setup(t, { runTimeoutMs: 100, requestTimeoutMs: 70 });
  const a = await x.scheduler.submit(input());
  assert.equal(Date.parse(a.deadlineAt) - Date.parse(a.admittedAt), 100);
  await until(() => x.store.getRun(a.runId).status === 'failed');
  assert.equal(x.store.getRun(a.runId).cleanupState, 'confirmed');
  assert.ok(x.store.eventsAfter(a.runId, 0).some(e => e.type === 'run.status' && e.payload.reasonCodes.includes('RUN_TIMEOUT')));
});

test('parent serial terminal arbitration makes cancellation and completion irreversible in either order', async t => {
  const x = await setup(t); const a = await x.scheduler.submit(input());
  const cancellation = x.scheduler.cancel(a.runId); x.host.emit(a.runId, outcome(a.runId));
  await cancellation; await x.scheduler.drain(); assert.equal(x.store.getRun(a.runId).status, 'cancelled');
  const b = await x.scheduler.submit(input()); x.host.emit(b.runId, outcome(b.runId));
  await x.scheduler.cancel(b.runId); await x.scheduler.drain(); assert.equal(x.store.getRun(b.runId).status, 'insufficient');
  x.host.emit(a.runId, outcome(a.runId, 'failed')); await x.scheduler.drain(); assert.equal(x.store.getRun(a.runId).status, 'cancelled');
});

test('unconfirmed cleanup enters global safety hold and never admits the next queued worker', async t => {
  const x = await setup(t, {}, { confirmed: false }); const a = await x.scheduler.submit(input()); const q = await x.scheduler.submit(input());
  await x.scheduler.cancel(a.runId);
  assert.equal(x.scheduler.safetyHold, true); assert.equal(x.store.getRun(a.runId).cleanupState, 'unconfirmed');
  assert.equal(x.store.getRun(q.runId).status, 'queued'); assert.equal(x.host.handles.length, 1);
  await assert.rejects(x.scheduler.submit(input()), e => e.code === 'RUN_SAFETY_HOLD');
});

test('worker transport binding rejects cross-Run messages and late permit requests', async t => {
  const x = await setup(t); const a = await x.scheduler.submit(input()); const q = await x.scheduler.submit(input());
  x.host.emit(a.runId, outcome(q.runId)); await x.scheduler.drain();
  assert.equal(x.store.getRun(q.runId).status, 'queued');
  assert.notEqual(x.store.getRun(a.runId).status, 'insufficient');
  await x.scheduler.cancel(a.runId); const count = x.scheduler.permits.snapshot().inFlight;
  x.host.emit(a.runId, { v: 1, runId: a.runId, kind: 'permit.request', requestId: randomUUID() });
  await x.scheduler.drain(); assert.equal(x.scheduler.permits.snapshot().inFlight, count);
});

test('trusted two-active configuration keeps per-Run handle and message routing separate', async t => {
  const x = await setup(t, { maxActiveRuns: 2 }); const a = await x.scheduler.submit(input()); const b = await x.scheduler.submit(input());
  assert.equal(x.host.handles.length, 2); const ra = randomUUID(), rb = randomUUID();
  x.host.emit(a.runId, { v: 1, runId: a.runId, kind: 'permit.request', requestId: ra });
  x.host.emit(b.runId, { v: 1, runId: b.runId, kind: 'permit.request', requestId: rb });
  await until(() => x.host.handles.every(h => h.messages.some(m => m.kind === 'permit.granted')));
  for (const [handle, rid] of [[x.host.handles[0], ra], [x.host.handles[1], rb]]) {
    assert.ok(handle.messages.filter(m => m.kind === 'permit.granted').every(m => m.requestId === rid && m.runId === handle.runId));
  }
  assert.equal(x.scheduler.permits.snapshot().inFlight, 2);
  await x.scheduler.cancel(a.runId); assert.equal(x.scheduler.permits.snapshot().inFlight, 1);
  assert.equal(x.store.getRun(b.runId).status, 'researching');
});

test('recovered unfinished store prevents admission and never restarts old workers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'einstein task5 restart '));
  let store = await RunStore.open(root); const i = input();
  const { hashRunInput } = await import('../../dist/server/evidence/hashing.js');
  await store.createRun({ runId: i.runId, input: i, inputHash: hashRunInput(i), runnerMode: 'offline_fixture', status: 'queued',
    createdAt: new Date().toISOString(), revisionCount: 0, cleanupState: 'not_started', lastSeq: 0 }); await store.close();
  store = await RunStore.open(root); let spawnCount = 0;
  const scheduler = new Scheduler({ store, snapshotPath: resolve('reference/einstein-matchmaker-data'), runnerMode: 'offline_fixture',
    createHost: cb => { const host = new ControlledHost(cb); const start = host.start.bind(host); host.start = (...a) => { spawnCount++; return start(...a); }; return host; } });
  t.after(async () => { await scheduler.close(); await store.close(); const target = resolve(root); assert.ok(target.startsWith(resolve(tmpdir())) && target.includes('einstein task5 restart ')); await rm(target, { recursive: true, force: true }); });
  assert.equal(scheduler.safetyHold, true);
  await assert.rejects(scheduler.submit(input()), e => e.code === 'RUN_SAFETY_HOLD'); assert.equal(spawnCount, 0);
  assert.equal(store.getRun(i.runId).status, 'queued');
});

test('pending permits do not block parent release and cancellation control messages', async t => {
  const x = await setup(t, { maxActiveRuns: 2 }); const a = await x.scheduler.submit(input()), b = await x.scheduler.submit(input());
  for (let n = 0; n < 3; n++) x.host.emit(b.runId, { v: 1, kind: 'permit.request', runId: b.runId, requestId: randomUUID() });
  await until(() => x.host.handles[1].messages.filter(m => m.kind === 'permit.granted').length === 2);
  const first = x.host.handles[1].messages.find(m => m.kind === 'permit.granted');
  x.host.emit(b.runId, { v: 1, kind: 'permit.release', runId: b.runId, permitId: first.permitId });
  await until(() => x.host.handles[1].messages.filter(m => m.kind === 'permit.granted').length === 3);
  assert.equal(x.scheduler.permits.snapshot().inFlight, 2);
  await x.scheduler.cancel(b.runId); assert.equal(x.scheduler.permits.snapshot().inFlight, 0);
  assert.equal(x.store.getRun(a.runId).status, 'researching');
});

test('worker outcome free text cannot break parent diagnostic-code control or grant publication', async t => {
  const x = await setup(t), a = await x.scheduler.submit(input());
  x.host.emit(a.runId, { v: 1, runId: a.runId, kind: 'outcome', typedOutcome: {
    runId: a.runId, kind: 'insufficient', reasonCodes: ['Offline fixture: not enough evidence.'] } });
  await x.scheduler.drain(); assert.equal(x.store.getRun(a.runId).status, 'insufficient'); assert.equal(x.scheduler.safetyHold, false);
});

test('released requestId cannot be reused as new transport authorization or restart an expiry timer', async t => {
  const x = await setup(t, { requestTimeoutMs: 150, runTimeoutMs: 2000 }), a = await x.scheduler.submit(input()), requestId = randomUUID();
  x.host.emit(a.runId, { v: 1, kind: 'permit.request', runId: a.runId, requestId });
  await until(() => x.host.handles[0].messages.some(m => m.kind === 'permit.granted'));
  const grant = x.host.handles[0].messages.find(m => m.kind === 'permit.granted');
  x.host.emit(a.runId, { v: 1, kind: 'permit.release', runId: a.runId, permitId: grant.permitId }); await x.scheduler.drain();
  x.host.emit(a.runId, { v: 1, kind: 'permit.request', runId: a.runId, requestId }); await x.scheduler.drain();
  assert.equal(x.host.handles[0].messages.filter(m => m.kind === 'permit.granted').length, 1);
  assert.ok(x.host.handles[0].messages.some(m => m.kind === 'permit.denied' && m.code === 'REQUEST_ALREADY_RELEASED'));
  await delay(200); await x.scheduler.drain(); assert.equal(x.store.getRun(a.runId).status, 'researching');
});

test('a storage write failure stops real control admission and cleans the current fixture handle', async t => {
  let armed = false;
  const x = await setup(t, {}, { storeOptions: { fault: point => { if (armed && point === 'events:beforeRename') throw Error('OFFLINE_INJECTED_IO_FAILURE'); } } });
  const a = await x.scheduler.submit(input()), b = await x.scheduler.submit(input()); armed = true;
  x.host.emit(a.runId, { v: 1, runId: a.runId, kind: 'ready' }); await x.scheduler.drain();
  await until(() => x.scheduler.cleanupEvidence.length > 0);
  assert.equal(x.scheduler.safetyHold, true); assert.equal(x.host.handles.length, 1);
  assert.equal(x.store.getRun(b.runId).status, 'queued');
});

test('released parent request timer remains canceled after a backward clock rearm', async t => {
  let offset = 0;
  // Synthetic dual-clock fixture isolates cancellation of a rearmed timer;
  // the separate native-monotonic test proves physical budgets under wall rollback.
  const x = await setup(t, { requestTimeoutMs: 100, runTimeoutMs: 2000 }, { now: () => Date.now() + offset, monotonicNow: () => 0 });
  const a = await x.scheduler.submit(input()), requestId = randomUUID();
  x.host.emit(a.runId, { v: 1, kind: 'permit.request', runId: a.runId, requestId });
  await until(() => x.host.handles[0].messages.some(m => m.kind === 'permit.granted'));
  const grant = x.host.handles[0].messages.find(m => m.kind === 'permit.granted');
  offset = -200; await delay(120);
  x.host.emit(a.runId, { v: 1, kind: 'permit.release', runId: a.runId, permitId: grant.permitId }); await x.scheduler.drain();
  offset = 0; await delay(250); await x.scheduler.drain();
  assert.equal(x.store.getRun(a.runId).status, 'researching');
});

test('shutdown with a write failure awaits emergency cleanup before its promise settles', async t => {
  let armed = false;
  const x = await setup(t, {}, { storeOptions: { fault: point => { if (armed && point === 'events:beforeRename') throw Error('OFFLINE_CLOSE_IO_FAILURE'); } } });
  await x.scheduler.submit(input()); await x.scheduler.submit(input());
  let release, started = false, settled = false;
  const barrier = new Promise(r => { release = r; }), handle = x.host.handles[0], original = handle.terminate;
  handle.terminate = async (...args) => { started = true; await barrier; return original(...args); };
  armed = true;
  const closing = x.scheduler.close().then(() => { settled = true; return null; }, error => { settled = true; return error; });
  try { await until(() => started); await delay(25); assert.equal(settled, false, 'Cleanup is still pending, so close must not settle.'); }
  finally { release(); }
  assert.ok(await closing); assert.equal(x.scheduler.safetyHold, true);
});

test('request timeout and cancellation preserve the first terminal decision in both orders', async t => {
  const x = await setup(t, { requestTimeoutMs: 80, runTimeoutMs: 2000 });
  const a = await x.scheduler.submit(input());
  x.host.emit(a.runId, { v: 1, kind: 'permit.request', runId: a.runId, requestId: randomUUID() });
  await until(() => x.scheduler.permits.snapshot().inFlight === 1); await x.scheduler.cancel(a.runId);
  await delay(100); await x.scheduler.drain(); assert.equal(x.store.getRun(a.runId).status, 'cancelled');
  const b = await x.scheduler.submit(input());
  x.host.emit(b.runId, { v: 1, kind: 'permit.request', runId: b.runId, requestId: randomUUID() });
  await until(() => x.store.getRun(b.runId).status === 'failed');
  await x.scheduler.cancel(b.runId); assert.equal(x.store.getRun(b.runId).status, 'failed');
  assert.equal(x.scheduler.permits.snapshot().inFlight, 0);
});

test('a schema-valid synthetic reviewed outcome cannot approve or publish a Run', async t => {
  const x = await setup(t), a = await x.scheduler.submit(input());
  const f = await import('../fixtures/contracts.mjs');
  const result = { runId: a.runId, kind: 'reviewed', draft: { ...f.draft(), runId: a.runId },
    counter: { ...f.counter(), runId: a.runId }, review: { ...f.review(), runId: a.runId }, reasonCodes: [] };
  x.host.emit(a.runId, { v: 1, kind: 'outcome', runId: a.runId, typedOutcome: result }); await x.scheduler.drain();
  assert.equal(x.store.getRun(a.runId).status, 'failed'); assert.equal(x.store.getRun(a.runId).acceptedReview, undefined);
  assert.equal(x.store.getRun(a.runId).publishedDraftHash, undefined);
});

test('two admitted actual Windows offline workers retain separate state, context, messages and cleanup', async t => {
  const { ProcessHost, queryWindowsIdentity } = await import('../../dist/server/supervisor/process-host.js');
  const root = await mkdtemp(join(tmpdir(), 'einstein task5 actual 双进程 ')), store = await RunStore.open(root);
  let host;
  const scheduler = new Scheduler({ store, snapshotPath: resolve('reference/einstein-matchmaker-data'), runnerMode: 'offline_fixture',
    limits: { ...DEFAULT_LIMITS, maxActiveRuns: 2, runTimeoutMs: 30000, requestTimeoutMs: 20000 },
    createHost: callbacks => { host = new ProcessHost({ workerPath: fileURLToPath(new URL('../fixtures/offline-worker.mjs', import.meta.url)), workerArgs: ['--mode', 'permits'], ...callbacks }); return host; } });
  t.after(async () => { await scheduler.close(); await store.close(); const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir())) && absolute.includes('einstein task5 actual 双进程 ')); await rm(absolute, { recursive: true, force: true }); });
  const a = await scheduler.submit(input()), b = await scheduler.submit(input());
  await Promise.all(host.list().map(h => h.ready));
  const identities = await Promise.all(host.list().map(h => queryWindowsIdentity(h.pid)));
  assert.ok(identities.every(i => i.status === 'present')); assert.notEqual(identities[0].identity.pid, identities[1].identity.pid);
  await until(() => scheduler.permits.snapshot().inFlight === 2, 10000);
  await scheduler.cancel(a.runId); assert.equal(store.getRun(b.runId).status, 'researching');
  await scheduler.cancel(b.runId); await scheduler.waitForIdle();
  const cleanups = scheduler.cleanupEvidence; assert.equal(cleanups.length, 2); assert.ok(cleanups.every(c => c.confirmed && c.exit.closeObserved));
  const states = cleanups.map(c => c.exit.stdout.trim().split('\n').map(line => JSON.parse(line)).find(v => v.fixture === 'offline_fixture'));
  assert.ok(states.every(s => s.counter === 1 && s.messages.length === 1));
  assert.notEqual(states[0].contextId, states[1].contextId); assert.notEqual(states[0].messages[0], states[1].messages[0]);
  assert.ok([a.runId, b.runId].every(id => store.getRun(id).status === 'cancelled' && store.getRun(id).runnerMode === 'offline_fixture'));
  const file = 'docs/implementation/task-5-scheduler-evidence-' + Date.now() + '-' + randomUUID() + '.json';
  await writeFile(file, JSON.stringify({ runnerMode: 'offline_fixture', platform: process.platform, actualTwoWorkers: true, identities, states,
    records: store.listRuns(), cleanups }, null, 2) + '\n', { flag: 'wx' });
  console.log('Immutable scheduler Windows evidence: ' + file);
});

test('cached permit response is not resent after expiry even before the timeout callback runs', async t => {
  let offset = 0;
  const x = await setup(t, { requestTimeoutMs: 300, runTimeoutMs: 3000 }, { now: () => Date.now() + offset });
  const a = await x.scheduler.submit(input()), requestId = randomUUID();
  x.host.emit(a.runId, { v: 1, kind: 'permit.request', runId: a.runId, requestId });
  await until(() => x.host.handles[0].messages.some(m => m.kind === 'permit.granted'));
  offset = 500;
  x.host.emit(a.runId, { v: 1, kind: 'permit.request', runId: a.runId, requestId }); await x.scheduler.drain();
  assert.equal(x.host.handles[0].messages.filter(m => m.kind === 'permit.granted').length, 1);
  assert.equal(x.store.getRun(a.runId).status, 'failed');
});

for (const action of ['deadline', 'cancel']) test(`${action} stops the worker without waiting for a blocked storage confirmation`, async t => {
  let release, blocked = false, armed = false, terminated = false;
  // Admission I/O under a busy full suite must not consume this controlled
  // fixture's 160 ms budget before the stop observer/barrier are installed.
  const wall = Date.now(); let elapsed = 0;
  const barrier = new Promise(r => { release = r; });
  const x = await setup(t, { runTimeoutMs: 160, requestTimeoutMs: 80 }, { now: () => wall + elapsed, monotonicNow: () => elapsed, storeOptions: { fault: async point => {
    if (armed && point === 'events:beforeRename') { blocked = true; await barrier; }
  } } });
  const a = await x.scheduler.submit(input()), handle = x.host.handles[0], original = handle.terminate;
  handle.terminate = async (...args) => { terminated = true; return original(...args); };
  armed = true; x.host.emit(a.runId, { v: 1, runId: a.runId, kind: 'ready' }); await until(() => blocked);
  let cancellation;
  if (action === 'cancel') cancellation = x.scheduler.cancel(a.runId);
  else elapsed = 160;
  try { await until(() => terminated); assert.equal(blocked, true, 'Stopping is observed while the serial I/O queue is still blocked.'); }
  finally { armed = false; release(); }
  await cancellation; await x.scheduler.drain();
  assert.equal(x.store.getRun(a.runId).status, action === 'deadline' ? 'failed' : 'cancelled');
});

test('native monotonic Run and queue budgets cannot be extended by wall-clock rollback', async t => {
  // The 120ms Run and 70ms queue limits are independent properties. Waiting
  // for two real fsync-backed submissions can consume >50ms, legitimately
  // letting the first Run end before the queue limit. Do not infer a clock
  // failure from that legal admission order. Keep native performance.now.
  let runOffset = 0;
  const runCase = await setup(t, { runTimeoutMs: 120, requestTimeoutMs: 60 }, { now: () => Date.now() + runOffset });
  const nativeStart = runCase.host.start.bind(runCase.host);
  runCase.host.start = (...args) => { const handle = nativeStart(...args); runOffset = -10000; return handle; };
  const a = await runCase.scheduler.submit(input());
  await delay(220); await runCase.scheduler.drain();
  assert.equal(runCase.store.getRun(a.runId).status, 'failed');
  assert.equal(runCase.host.handles.length, 1);
  const end = runCase.store.eventsAfter(a.runId, 0).find(e => e.type === 'run.status' && e.payload.reasonCodes.includes('RUN_TIMEOUT'));
  assert.ok(end.elapsedMs >= 90, 'Elapsed time must retain monotonic duration despite backward UTC timestamps.');
  assert.ok(Date.parse(end.at) < Date.parse(a.admittedAt), 'The observed timeout must occur after a real wall-clock rollback.');

  // A separate live-slot control stays active while testing the original
  // 70ms queue budget. Its normal 10s fixture deadline is not a replacement
  // for, or extension of, the 120ms Run deadline verified above.
  let queueOffset = 0;
  const queueCase = await setup(t, { runTimeoutMs: 10000, queueTimeoutMs: 70, requestTimeoutMs: 60 }, { now: () => Date.now() + queueOffset });
  const control = await queueCase.scheduler.submit(input()), q = await queueCase.scheduler.submit(input());
  assert.equal(q.status, 'queued'); queueOffset = -10000;
  await delay(220); await queueCase.scheduler.drain();
  assert.equal(queueCase.store.getRun(control.runId).status, 'researching');
  assert.equal(queueCase.store.getRun(q.runId).status, 'failed');
  assert.equal(queueCase.host.handles.length, 1, 'An expired queued Run must never spawn.');
  assert.ok(queueCase.store.eventsAfter(q.runId, 0).some(e => e.type === 'run.status' && e.payload.reasonCodes.includes('QUEUE_TIMEOUT')));
  await queueCase.scheduler.cancel(control.runId);
});

test('grant delivery rechecks stop intent after blocked event confirmation', async t => {
  let armed = false, blocked = false, release;
  const barrier = new Promise(r => { release = r; });
  // Keep the same 160/80ms budgets. Admission I/O must not consume the
  // controlled scenario before its grant-write barrier has been installed.
  const wall = Date.now(); let elapsed = 0;
  const x = await setup(t, { runTimeoutMs: 160, requestTimeoutMs: 80 }, { now: () => wall + elapsed, monotonicNow: () => elapsed, storeOptions: { fault: async point => {
    if (armed && point === 'events:beforeRename') { blocked = true; await barrier; }
  } } });
  const a = await x.scheduler.submit(input()); armed = true;
  x.host.emit(a.runId, { v: 1, runId: a.runId, kind: 'permit.request', requestId: randomUUID() }); await until(() => blocked);
  elapsed = 160;
  try { await until(() => x.scheduler.permits.snapshot().runs.some(r => r.runId === a.runId && r.stopped)); }
  finally { armed = false; release(); }
  await x.scheduler.drain();
  assert.equal(x.host.handles[0].messages.filter(m => m.kind === 'permit.granted').length, 0);
  assert.equal(x.store.getRun(a.runId).status, 'failed');
});

test('emergency cleanup starts every active handle before awaiting the first one', async t => {
  let armed = false, release, first = false, second = false;
  const barrier = new Promise(r => { release = r; });
  const x = await setup(t, { maxActiveRuns: 2 }, { storeOptions: { fault: point => { if (armed && point === 'events:beforeRename') throw Error('OFFLINE_PARALLEL_CLEANUP_IO'); } } });
  const a = await x.scheduler.submit(input()); await x.scheduler.submit(input());
  const [ha, hb] = x.host.handles, oa = ha.terminate, ob = hb.terminate;
  ha.terminate = async (...args) => { first = true; await barrier; return oa(...args); };
  hb.terminate = async (...args) => { second = true; return ob(...args); };
  armed = true; x.host.emit(a.runId, { v: 1, runId: a.runId, kind: 'ready' });
  try { await until(() => first); await delay(25); assert.equal(second, true); }
  finally { release(); }
});

test('queued cancellation reserves zero-spawn intent while the active worker cleanup is pending', async t => {
  const x = await setup(t), a = await x.scheduler.submit(input()), b = await x.scheduler.submit(input());
  let release, started = false; const barrier = new Promise(r => { release = r; }), handle = x.host.handles[0], original = handle.terminate;
  handle.terminate = async (...args) => { started = true; await barrier; return original(...args); };
  const ca = x.scheduler.cancel(a.runId); await until(() => started); const cb = x.scheduler.cancel(b.runId); release();
  await Promise.all([ca, cb]); assert.equal(x.host.handles.length, 1); assert.equal(x.store.getRun(b.runId).status, 'cancelled');
  assert.equal(x.scheduler.permits.snapshot().runs.some(r => r.runId === b.runId), false);
});

test('facts received before outcome retain ready, Trace and typed artifacts even while the writer is blocked', async t => {
  let armed = false, blocked = false, release; const barrier = new Promise(r => { release = r; });
  const x = await setup(t, {}, { storeOptions: { fault: async point => {
    if (armed && point === 'events:beforeRename') { blocked = true; await barrier; }
  } } }), a = await x.scheduler.submit(input());
  armed = true; x.host.emit(a.runId, { v: 1, runId: a.runId, kind: 'ready' }); await until(() => blocked);
  const f = await import('../fixtures/contracts.mjs');
  const artifact = { ...f.counter(), runId: a.runId };
  x.host.emit(a.runId, { v: 1, runId: a.runId, kind: 'event', nativeOrAppEvent: {
    source: 'application', type: 'task.started', runId: a.runId, agentId: randomUUID(), role: 'counter-evidence', loopId: randomUUID(),
    taskId: randomUUID(), contextId: randomUUID(), attempt: 1, payload: { kind: 'task' } } });
  x.host.emit(a.runId, { v: 1, runId: a.runId, kind: 'artifact', typedArtifact: { kind: 'counter_report', artifact } });
  x.host.emit(a.runId, outcome(a.runId));
  x.host.emit(a.runId, { v: 1, runId: a.runId, kind: 'artifact', typedArtifact: { kind: 'counter_report', artifact: { ...artifact, id: 'late-counter' } } });
  armed = false; release(); await x.scheduler.drain();
  const bundle = JSON.parse(await readFile(join(x.root, a.runId, 'terminal.json'), 'utf8'));
  assert.equal(bundle.artifacts.length, 1); assert.equal(bundle.artifacts[0].artifact.id, artifact.id);
  assert.ok(x.store.eventsAfter(a.runId, 0).some(e => e.type === 'task.started'));
  assert.ok(x.store.eventsAfter(a.runId, 0).some(e => e.type === 'worker.ready'));
});

test('shutdown immediately stops active work and blocks new admission while storage is hung', async t => {
  let armed = false, blocked = false, release, terminated = false; const barrier = new Promise(r => { release = r; });
  const x = await setup(t, {}, { storeOptions: { fault: async point => { if (armed && point === 'events:beforeRename') { blocked = true; await barrier; } } } });
  const a = await x.scheduler.submit(input()); await x.scheduler.submit(input());
  const handle = x.host.handles[0], original = handle.terminate; handle.terminate = async (...args) => { terminated = true; return original(...args); };
  armed = true; x.host.emit(a.runId, { v: 1, runId: a.runId, kind: 'ready' }); await until(() => blocked);
  const closing = x.scheduler.close();
  try { await delay(30); assert.equal(terminated, true); }
  finally { armed = false; release(); }
  await closing; assert.equal(x.host.handles.length, 1);
});

test('queue duration includes its creation write and cannot be extended by rollback during that write', async t => {
  let armed = false, blocked = false, release, offset = 0; const barrier = new Promise(r => { release = r; });
  const x = await setup(t, { queueTimeoutMs: 60, runTimeoutMs: 2000, requestTimeoutMs: 1000 }, { now: () => Date.now() + offset,
    storeOptions: { fault: async point => { if (armed && point === 'record:beforeRename') { blocked = true; await barrier; } } } });
  await x.scheduler.submit(input()); armed = true; const pending = x.scheduler.submit(input()); await until(() => blocked);
  offset = -10000; await delay(90); armed = false; release(); const q = await pending; await delay(25); await x.scheduler.drain();
  assert.equal(x.store.getRun(q.runId).status, 'failed'); assert.equal(x.host.handles.length, 1);
});

test('cancel during admission persistence prevents any later spawn or permit registration', async t => {
  let armed = false, blocked = false, release; const barrier = new Promise(r => { release = r; });
  const x = await setup(t, {}, { storeOptions: { fault: async point => { if (armed && point === 'events:beforeRename') { blocked = true; await barrier; } } } });
  const a = await x.scheduler.submit(input()), b = await x.scheduler.submit(input()); armed = true;
  // Finishing A produces cleanup/status writes too: arm only once B begins admission.
  armed = false; const original = x.host.handles[0].terminate;
  x.host.handles[0].terminate = async (...args) => { const result = await original(...args); return result; };
  let admissions = 0;
  const prior = x.store.appendEvent.bind(x.store);
  x.store.appendEvent = async event => { if (event.runId === b.runId && event.type === 'run.status' && event.payload.status === 'researching') { admissions++; armed = true; } return prior(event); };
  const ca = x.scheduler.cancel(a.runId); await until(() => blocked && admissions === 1); const cb = x.scheduler.cancel(b.runId);
  armed = false; release(); await Promise.all([ca, cb]);
  assert.equal(x.host.handles.length, 1); assert.equal(x.store.getRun(b.runId).status, 'cancelled');
  assert.equal(x.scheduler.permits.snapshot().runs.some(r => r.runId === b.runId), false);
});

for (const stage of ['create', 'admit']) test(`a safety hold arriving during ${stage} persistence forbids a subsequent fork`, async t => {
  let armed = false, blocked = false, release; const barrier = new Promise(r => { release = r; });
  const point = stage === 'create' ? 'record:beforeRename' : 'events:beforeRename';
  const x = await setup(t, { maxActiveRuns: 2 }, { confirmed: false, storeOptions: { fault: async where => {
    if (armed && where === point) { blocked = true; await barrier; }
  } } });
  const a = await x.scheduler.submit(input()); armed = true; const bInput = input(), b = x.scheduler.submit(bInput);
  await until(() => blocked); const cancelA = x.scheduler.cancel(a.runId); await until(() => x.scheduler.safetyHold);
  armed = false; release(); await Promise.all([b, cancelA]); await x.scheduler.drain();
  assert.equal(x.host.handles.length, 1); assert.equal(x.scheduler.permits.snapshot().runs.some(r => r.runId === bInput.runId), false);
});

test('canceling a queued Run during its creation write prevents an earlier queued completion from spawning it', async t => {
  let armed = false, blocked = false, release; const barrier = new Promise(r => { release = r; });
  const x = await setup(t, {}, { storeOptions: { fault: async point => { if (armed && point === 'record:beforeRename') { blocked = true; await barrier; } } } });
  const a = await x.scheduler.submit(input()), next = input(); armed = true; const pending = x.scheduler.submit(next);
  await until(() => blocked); x.host.emit(a.runId, outcome(a.runId)); const cancellation = x.scheduler.cancel(next.runId);
  armed = false; release(); await Promise.all([pending, cancellation]); await x.scheduler.drain();
  assert.equal(x.host.handles.length, 1); assert.equal(x.store.getRun(next.runId).status, 'cancelled');
  assert.equal(x.scheduler.permits.snapshot().runs.some(r => r.runId === next.runId), false);
});

test('actual Windows Scheduler covers never-ready timeout, pre-ready cancellation and crash queue advancement', async t => {
  for (const mode of ['never-ready', 'pre-ready-cancel', 'crash']) await t.test(mode, async childTest => {
    const root = await mkdtemp(join(tmpdir(), 'einstein task5 native lifecycle ')), store = await RunStore.open(root);
    const scheduler = new Scheduler({ store, snapshotPath: resolve('reference/einstein-matchmaker-data'), runnerMode: 'offline_fixture',
      limits: { ...DEFAULT_LIMITS, runTimeoutMs: mode === 'never-ready' ? 1500 : 8000, requestTimeoutMs: 1000, queueTimeoutMs: 7000 },
      workerPath: fileURLToPath(new URL('../fixtures/offline-worker.mjs', import.meta.url)), workerArgs: ['--mode', mode === 'pre-ready-cancel' ? 'wait' : mode] });
    childTest.after(async () => { await scheduler.close(); await store.close(); const absolute = resolve(root);
      assert.ok(absolute.startsWith(resolve(tmpdir())) && absolute.includes('einstein task5 native lifecycle ')); await rm(absolute, { recursive: true, force: true }); });
    const a = await scheduler.submit(input());
    if (mode === 'pre-ready-cancel') await scheduler.cancel(a.runId);
    const b = mode === 'crash' ? await scheduler.submit(input()) : undefined;
    await scheduler.waitForIdle(20000);
    assert.equal(scheduler.safetyHold, false);
    assert.equal(store.getRun(a.runId).status, mode === 'pre-ready-cancel' ? 'cancelled' : 'failed');
    assert.equal(store.getRun(a.runId).cleanupState, 'confirmed');
    assert.equal(store.eventsAfter(a.runId, 0).filter(e => e.type === 'worker.ready').length, 0);
    if (mode === 'never-ready') assert.ok(store.eventsAfter(a.runId, 0).some(e => e.type === 'run.status' && e.payload.reasonCodes.includes('RUN_TIMEOUT')));
    if (mode === 'pre-ready-cancel') assert.equal(scheduler.permits.snapshot().runs.find(r => r.runId === a.runId).attempts, 0);
    if (b) {
      assert.equal(store.getRun(b.runId).status, 'failed'); assert.equal(store.getRun(b.runId).cleanupState, 'confirmed');
      const cleanup = store.eventsAfter(a.runId, 0).find(e => e.type === 'cleanup.completed');
      assert.ok(Date.parse(store.getRun(b.runId).admittedAt) >= Date.parse(cleanup.at));
    }
    const cleanups = scheduler.cleanupEvidence;
    assert.equal(cleanups.length, b ? 2 : 1); assert.ok(cleanups.every(c => c.confirmed && c.exit.closeObserved && c.identity));
    const file = 'docs/implementation/task-5-scheduler-evidence-lifecycle-' + mode + '-' + Date.now() + '-' + randomUUID() + '.json';
    await writeFile(file, JSON.stringify({ runnerMode: 'offline_fixture', platform: process.platform, actualSchedulerLifecycle: mode,
      limits: { runTimeoutMs: mode === 'never-ready' ? 1500 : 8000, productionRunDefaultMs: DEFAULT_LIMITS.runTimeoutMs }, records: store.listRuns(),
      events: store.listRuns().map(r => ({ runId: r.runId, events: store.eventsAfter(r.runId, 0) })), cleanups }, null, 2) + '\n', { flag: 'wx' });
    console.log('Immutable native Scheduler lifecycle evidence: ' + file);
  });
});
