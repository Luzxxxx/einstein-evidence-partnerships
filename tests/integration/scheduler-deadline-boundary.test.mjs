import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Scheduler } from '../../dist/server/supervisor/scheduler.js';
import { RunStore } from '../../dist/server/storage/run-store.js';
import { DEFAULT_LIMITS } from '../../dist/server/contracts/config.js';
import { input as inputFixture } from '../fixtures/contracts.mjs';

// Actual production Scheduler/PermitManager and real temporary Store fsync/rename.
// Host transport, identity and cleanup evidence are explicitly synthetic doubles:
// no OS worker, historical Store, provider request or live authorization is used.
const EPOCH = 1761834240000;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class SyntheticHost {
  constructor(callbacks) { this.callbacks = callbacks; this.handles = []; this.cleanupStarted = deferred(); this.cleanupGate = deferred(); }
  start(input) {
    const identity = { pid: 790001 + this.handles.length, creationFileTime: '134378991358375532', executablePath: 'C:\\offline_fixture\\node.exe',
      parentPid: process.pid, commandLine: 'offline_fixture --supervisor-run-id ' + input.runId };
    const closed = deferred();
    const handle = { runId: input.runId, pid: identity.pid, identity: Promise.resolve(identity), ready: Promise.resolve(), closed: closed.promise, messages: [],
      send: message => { handle.messages.push(message); return true; }, inspectDescendants: async () => [],
      terminate: async () => {
        this.cleanupStarted.resolve(); await this.cleanupGate.promise;
        const exit = { runId: input.runId, pid: identity.pid, exitCode: 0, signal: null, exitObserved: true, closeObserved: true, spawnError: false,
          stdout: '', stderr: '', outputTruncated: false };
        closed.resolve(exit); this.callbacks.onExit(input.runId, exit);
        return { runId: input.runId, confirmed: true, scope: 'registered_identities_only_no_job_object', identity, rootVerification: 'absent', termination: null,
          exit, descendants: [], scanDiagnostics: [], unobservedDescendantsNotGuaranteed: true };
      } };
    this.handles.push(handle); return handle;
  }
  emit(runId, value) { this.callbacks.onMessage(runId, value); }
}
async function setup(t, { origin = 1000000.1, blockAdmission = false, name } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'einstein task7x deadline offline ')), storeRoot = join(root, 'offline store');
  const clock = { wall: EPOCH, mono: origin }, blocked = deferred(), writeGate = deferred(); let armed = blockAdmission, host;
  const store = await RunStore.open(storeRoot, { fault: async point => {
    // The first event belongs to admission. This real persistence await occurs
    // after Scheduler captures both deadlines and before PermitManager registers.
    if (armed && point === 'events:beforeRename') { armed = false; blocked.resolve(); await writeGate.promise; }
  } });
  const scheduler = new Scheduler({ store, snapshotPath: resolve('reference/einstein-matchmaker-data'), runnerMode: 'offline_fixture', limits: DEFAULT_LIMITS,
    now: () => clock.wall, monotonicNow: () => clock.mono, createHost: callbacks => { host = new SyntheticHost(callbacks); return host; } });
  t.after(async () => {
    writeGate.resolve(); host.cleanupGate.resolve(); let closeFailure = null;
    try { await scheduler.close(); } catch { closeFailure = 'OFFLINE_FIXTURE_SCHEDULER_CLOSE_FAILED'; }
    const evidence = { runnerMode: 'offline_fixture', kind: 'fixed_clock_actual_Scheduler_and_temporary_RunStore',
      hostIdentityEvidence: 'synthetic_not_actual_OS_verification', name, origin, currentClock: clock,
      sourceLimits: DEFAULT_LIMITS, storeRecords: store.listRuns(), events: store.listRuns().map(r => ({ runId: r.runId, events: store.eventsAfter(r.runId, 0) })),
      cleanups: scheduler.cleanupEvidence, permitSnapshot: scheduler.permits.snapshot(), safetyHold: scheduler.safetyHold,
      syntheticSpawnCount: host.handles.length, providerRequests: 0, closeFailure };
    const file = resolve('docs/implementation', 'task-7x-deadline-controlled-' + name + '-' + Date.now() + '-' + randomUUID() + '.json');
    await writeFile(file, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' }); console.log('Immutable synthetic Host deadline evidence: ' + file);
    await store.close(); const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('einstein task7x deadline offline '));
    await rm(absolute, { recursive: true, force: true });
    if (closeFailure) throw Error(closeFailure);
  });
  return { scheduler, store, storeRoot, clock, host, blocked, writeGate };
}
async function request(x, runId) {
  const requestId = randomUUID(); x.host.emit(runId, { v: 1, kind: 'permit.request', runId, requestId }); await x.scheduler.drain();
  const grant = x.host.handles[0].messages.find(m => m.kind === 'permit.granted' && m.requestId === requestId);
  assert.ok(grant, 'actual Scheduler must grant the authenticated fixture request'); return grant;
}

for (const origin of [0.1, 1.5, 1000.1, 1000000.1, 10000000.1]) {
  test(`Scheduler admits the unchanged 180-second default at fractional mono ${origin}`, async t => {
    const x = await setup(t, { origin, name: 'exact-' + origin }), run = await x.scheduler.submit({ ...inputFixture(), runId: randomUUID() });
    assert.equal(run.status, 'researching'); assert.equal(x.host.handles.length, 1);
    assert.equal(Date.parse(run.admittedAt), EPOCH); assert.equal(Date.parse(run.deadlineAt), EPOCH + 180000);
    const grant = await request(x, run.runId), timing = x.scheduler.permits.timing(run.runId, grant.permitId);
    assert.equal(timing.expiresAt, EPOCH + 40000); assert.equal(timing.expiresMonotonicAt, origin + 40000);
    x.host.cleanupGate.resolve(); await x.scheduler.cancel(run.runId); await x.scheduler.drain();
    assert.equal(x.scheduler.getRun(run.runId).cleanupState, 'confirmed'); assert.equal(x.scheduler.permits.snapshot().inFlight, 0);
    assert.equal(x.scheduler.permits.snapshot().runs[0].attempts, 1); assert.equal(x.scheduler.safetyHold, false);
  });
}

test('real admission persistence barrier preserves startup cost and backward wall time; cancellation retains capacity until cleanup', async t => {
  const origin = 1000000.1, x = await setup(t, { origin, blockAdmission: true, name: 'startup-cost-wall-rollback-cancel' });
  const runId = randomUUID(), submitting = x.scheduler.submit({ ...inputFixture(), runId });
  await x.blocked.promise; x.clock.wall -= 1000000; x.clock.mono += 150000; x.writeGate.resolve();
  const run = await submitting; assert.equal(run.status, 'researching'); assert.equal(x.host.handles.length, 1);
  assert.equal(Date.parse(run.admittedAt), EPOCH); assert.equal(Date.parse(run.deadlineAt), EPOCH + 180000);
  const grant = await request(x, runId), timing = x.scheduler.permits.timing(runId, grant.permitId);
  assert.equal(timing.expiresMonotonicAt, origin + 180000, '150s of admission persistence cannot be refunded');
  assert.equal(timing.expiresAt, x.clock.wall + 30000, 'late request has only original 30s remaining');
  const cancelling = x.scheduler.cancel(runId); await x.host.cleanupStarted.promise;
  assert.equal(x.scheduler.permits.snapshot().inFlight, 1, 'cancel alone is not cleanup confirmation');
  assert.equal(x.scheduler.permits.snapshot().runs[0].attempts, 1);
  x.host.cleanupGate.resolve(); await cancelling; await x.scheduler.drain();
  const terminal = JSON.parse(await readFile(join(x.storeRoot, runId, 'terminal.json'), 'utf8'));
  assert.equal(terminal.record.status, 'cancelled'); assert.equal(terminal.record.cleanupState, 'confirmed');
  assert.equal(x.scheduler.permits.snapshot().inFlight, 0); assert.equal(x.scheduler.permits.snapshot().runs[0].attempts, 1);
  assert.equal(x.scheduler.safetyHold, false);
});

test('admission persistence exhausting 180 seconds fails before any synthetic spawn or permit despite wall rollback', async t => {
  const origin = 1000000.1, x = await setup(t, { origin, blockAdmission: true, name: 'startup-exhausted-zero-spawn' });
  const runId = randomUUID(), submitting = x.scheduler.submit({ ...inputFixture(), runId });
  await x.blocked.promise; x.clock.wall -= 1000000; x.clock.mono = origin + 180000; x.writeGate.resolve();
  const run = await submitting; await x.scheduler.drain();
  assert.equal(run.status, 'failed'); assert.equal(x.host.handles.length, 0);
  assert.equal(Date.parse(run.admittedAt), EPOCH); assert.equal(Date.parse(run.deadlineAt), EPOCH + 180000);
  assert.equal(x.scheduler.permits.snapshot().inFlight, 0); assert.equal(x.scheduler.permits.snapshot().runs.length, 0);
  const terminal = JSON.parse(await readFile(join(x.storeRoot, runId, 'terminal.json'), 'utf8'));
  assert.ok(terminal.outcome.reasonCodes.includes('RUN_TIMEOUT')); assert.equal(x.scheduler.safetyHold, false);
});
