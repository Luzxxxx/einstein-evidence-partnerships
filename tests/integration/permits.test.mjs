import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { PermitManager } from '../../dist/server/supervisor/permits.js';
import { DEFAULT_LIMITS } from '../../dist/server/contracts/config.js';

const limits = overrides => ({ ...DEFAULT_LIMITS, ...overrides });
const code = expected => error => error?.code === expected;
const run = (manager, timeout = 10_000) => { const id = randomUUID(); manager.registerRun(id, Date.now() + timeout); return id; };

test('concurrent acquisition reserves at most two global slots and preserves FIFO without consuming pending attempts', async t => {
  const manager = new PermitManager(); t.after(() => manager.dispose());
  const a = run(manager), b = run(manager), requests = Array.from({ length: 5 }, () => randomUUID());
  const first = await Promise.all([manager.acquire(a, requests[0]), manager.acquire(b, requests[1])]);
  let thirdResolved = false;
  const third = manager.acquire(a, requests[2]).then(p => { thirdResolved = true; return p; });
  const fourth = manager.acquire(b, requests[3]);
  const fifth = manager.acquire(a, requests[4]);
  assert.equal(manager.snapshot().inFlight, 2);
  assert.equal(manager.snapshot().runs.find(r => r.runId === a).attempts, 1);
  assert.equal(manager.snapshot().runs.find(r => r.runId === a).pending, 2);
  await delay(5); assert.equal(thirdResolved, false);
  manager.release(a, first[0].id);
  const p3 = await third; assert.equal(p3.requestId, requests[2]);
  assert.equal(manager.snapshot().inFlight, 2);
  manager.release(b, first[1].id);
  assert.equal((await fourth).requestId, requests[3]);
  manager.release(a, p3.id);
  assert.equal((await fifth).requestId, requests[4]);
  assert.equal(manager.snapshot().inFlight, 2);
});

test('the seventeenth approved attempt is refused and releasing never returns the per-Run budget', async t => {
  const manager = new PermitManager(); t.after(() => manager.dispose()); const id = run(manager);
  for (let n = 0; n < 16; n++) {
    const permit = await manager.acquire(id, randomUUID());
    assert.equal(manager.release(id, permit.id), true);
    assert.equal(manager.release(id, permit.id), false);
    assert.equal(manager.snapshot().runs[0].attempts, n + 1);
  }
  await assert.rejects(manager.acquire(id, randomUUID()), code('RUN_REQUEST_LIMIT'));
  assert.equal(manager.snapshot().inFlight, 0); assert.equal(manager.snapshot().runs[0].attempts, 16);
});

test('twenty simultaneous requests for one Run still grant only sixteen attempts under global pressure', async t => {
  const manager = new PermitManager(); t.after(() => manager.dispose()); const id = run(manager);
  const pending = Array.from({ length: 20 }, () => manager.acquire(id, randomUUID()));
  const completion = Promise.allSettled(pending);
  assert.equal(manager.snapshot().inFlight, 2);
  assert.equal(manager.snapshot().runs[0].attempts, 2);
  for (let n = 0; n < 16; n++) {
    const permit = await pending[n];
    assert.ok(manager.snapshot().inFlight <= 2); manager.release(id, permit.id);
  }
  const outcomes = await completion;
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 16);
  assert.equal(outcomes.filter(r => r.status === 'rejected' && r.reason.code === 'RUN_REQUEST_LIMIT').length, 4);
  assert.equal(manager.snapshot().runs[0].attempts, 16); assert.equal(manager.snapshot().inFlight, 0);
});

test('same request identity is idempotent while pending, granted and released, and cannot be borrowed by another Run', async t => {
  const manager = new PermitManager({ limits: limits({ maxConcurrentModelRequests: 1 }) }); t.after(() => manager.dispose());
  const a = run(manager), b = run(manager), requestId = randomUUID(), pendingId = randomUUID();
  const p1 = await manager.acquire(a, requestId);
  assert.equal(await manager.acquire(a, requestId), p1);
  await assert.rejects(manager.acquire(b, requestId), code('REQUEST_RUN_MISMATCH'));
  const pending1 = manager.acquire(a, pendingId), pending2 = manager.acquire(a, pendingId);
  assert.equal(pending1, pending2); assert.equal(manager.snapshot().runs[0].pending, 1);
  await assert.rejects(manager.acquire(b, pendingId), code('REQUEST_RUN_MISMATCH'));
  manager.release(a, p1.id);
  const p2 = await pending1; assert.equal(await pending2, p2);
  manager.release(a, p2.id);
  assert.equal(await manager.acquire(a, requestId), p1);
  assert.equal(manager.snapshot().runs[0].attempts, 2); assert.equal(manager.snapshot().inFlight, 0);
});

test('cross-Run or unknown release cannot remove a genuine reservation', async t => {
  const manager = new PermitManager(); t.after(() => manager.dispose()); const a = run(manager), b = run(manager);
  const permit = await manager.acquire(a, randomUUID());
  assert.throws(() => manager.release(b, permit.id), code('PERMIT_RUN_MISMATCH'));
  assert.throws(() => manager.release(a, randomUUID()), code('PERMIT_UNKNOWN'));
  assert.equal(manager.snapshot().inFlight, 1); assert.equal(manager.release(a, permit.id), true);
});

test('cancel stops pending/future grants while holding active capacity until confirmed exit reclamation', async t => {
  const manager = new PermitManager({ limits: limits({ maxConcurrentModelRequests: 1 }) }); t.after(() => manager.dispose());
  const a = run(manager), b = run(manager), first = await manager.acquire(a, randomUUID());
  const waitingA = manager.acquire(a, randomUUID());
  const rejectedA = assert.rejects(waitingA, code('RUN_CANCELLED'));
  let grantedB = false; const waitingB = manager.acquire(b, randomUUID()).then(p => { grantedB = true; return p; });
  manager.stopRun(a); await rejectedA;
  await assert.rejects(manager.acquire(a, first.requestId), code('RUN_CANCELLED'));
  assert.equal(manager.snapshot().inFlight, 1); await delay(5); assert.equal(grantedB, false);
  manager.reclaimRun(a);
  const bPermit = await waitingB; assert.equal(bPermit.runId, b);
  assert.equal(manager.snapshot().runs.find(r => r.runId === a).attempts, 1);
  assert.equal(manager.release(a, first.id), false); assert.equal(manager.snapshot().inFlight, 1);
});

test('a Run canceled before its first request has zero grants and no pending permit can outlive its deadline', async t => {
  const manager = new PermitManager({ limits: limits({ maxConcurrentModelRequests: 1 }) }); t.after(() => manager.dispose());
  const a = run(manager), b = run(manager, 80), c = run(manager);
  manager.stopRun(c);
  await assert.rejects(manager.acquire(c, randomUUID()), code('RUN_CANCELLED'));
  await manager.acquire(a, randomUUID());
  const waiting = manager.acquire(b, randomUUID());
  const rejection = assert.rejects(waiting, code('RUN_DEADLINE_EXCEEDED'));
  await delay(110); await rejection;
  const state = manager.snapshot().runs.find(r => r.runId === b);
  assert.equal(state.attempts, 0); assert.equal(state.pending, 0); assert.equal(state.stopped, true);
  assert.equal(manager.snapshot().runs.find(r => r.runId === c).attempts, 0);
});

test('permit request timeout stops the Run but does not recycle an in-flight reservation without release/exit', async t => {
  const manager = new PermitManager({ limits: limits({ requestTimeoutMs: 35, maxConcurrentModelRequests: 1 }) });
  t.after(() => manager.dispose()); const a = run(manager), b = run(manager);
  const first = await manager.acquire(a, randomUUID());
  let resolved = false; const other = manager.acquire(b, randomUUID()).then(p => { resolved = true; return p; });
  const expiry = Date.parse(first.expiresAt) - Date.parse(first.grantedAt);
  assert.equal(expiry, 35);
  await delay(60); assert.equal(manager.snapshot().inFlight, 1); assert.equal(resolved, false);
  await assert.rejects(manager.acquire(a, randomUUID()), code('REQUEST_TIMEOUT'));
  manager.reclaimRun(a); assert.equal((await other).runId, b);
});

test('deadline checked during acquire/release race cannot grant a queued request after Run deadline', async t => {
  let time = Date.now();
  const manager = new PermitManager({ now: () => time, limits: limits({ maxConcurrentModelRequests: 1 }) });
  t.after(() => manager.dispose()); const a = randomUUID(), b = randomUUID();
  manager.registerRun(a, time + 1000); manager.registerRun(b, time + 20);
  const pa = await manager.acquire(a, randomUUID()), waiting = manager.acquire(b, randomUUID());
  const rejection = assert.rejects(waiting, code('RUN_DEADLINE_EXCEEDED'));
  time += 21; manager.release(a, pa.id); await rejection;
  assert.equal(manager.snapshot().runs.find(r => r.runId === b).attempts, 0);
});

test('permit expiry is capped to Run deadline and frozen snapshots cannot mutate budgets', async t => {
  let now = Date.now(); const manager = new PermitManager({ now: () => now, monotonicNow: () => now }); t.after(() => manager.dispose());
  const a = randomUUID(); manager.registerRun(a, now + 500);
  const permit = await manager.acquire(a, randomUUID());
  assert.equal(Date.parse(permit.expiresAt), now + 500); assert.equal(Object.isFrozen(permit), true);
  const state = manager.snapshot(); assert.equal(Object.isFrozen(state.runs), true);
  assert.throws(() => { state.runs[0].attempts = 0; }, TypeError);
  assert.throws(() => { permit.runId = randomUUID(); }, TypeError);
  assert.throws(() => manager.registerRun(a, now + 900), code('RUN_ALREADY_REGISTERED'));
  now += 501; await assert.rejects(manager.acquire(a, randomUUID()), code('RUN_DEADLINE_EXCEEDED'));
  assert.equal(manager.snapshot().inFlight, 1);
});

test('synthetic early timer rearming preserves its cancellable handle after release', async t => {
  const base = Date.now(); let time = base;
  // BOTH clocks are synthetic here, only to exercise an early native callback.
  // Real OS wall-clock changes must never postpone the native monotonic bound.
  const manager = new PermitManager({ now: () => time, monotonicNow: () => time, limits: limits({ requestTimeoutMs: 25 }) });
  t.after(() => manager.dispose()); const id = randomUUID(); manager.registerRun(id, base + 1000);
  const permit = await manager.acquire(id, randomUUID());
  time = base - 100; // Its first real callback now fires before the injected expiry.
  await delay(50);
  manager.release(id, permit.id); time = base + 26;
  await delay(160); // The canceled rearmed callback would now reach the old expiry.
  assert.equal(manager.snapshot().runs[0].stopped, false);
  assert.equal(manager.snapshot().inFlight, 0);
  const next = await manager.acquire(id, randomUUID());
  assert.equal(next.runId, id); manager.release(id, next.id);
});

test('an early callback reschedules only the remaining deadline rather than the original request duration', async t => {
  const base = Date.now(); let wall = base, mono = 1000;
  const manager = new PermitManager({ now: () => wall, monotonicNow: () => mono, limits: limits({ requestTimeoutMs: 120 }) });
  t.after(() => manager.dispose()); const id = randomUUID(); manager.registerRun(id, base + 2000);
  await manager.acquire(id, randomUUID());
  await delay(65); wall = base + 119; mono = 1119;
  await delay(80); wall = base + 121; mono = 1121;
  await delay(30);
  assert.equal(manager.snapshot().runs[0].stopped, true);
  assert.equal(manager.snapshot().runs[0].stopCode, 'REQUEST_TIMEOUT');
  assert.equal(manager.snapshot().inFlight, 1);
});

test('backward wall-clock movement cannot extend a real monotonic request budget or free its active reservation', async t => {
  let offset = 0;
  const manager = new PermitManager({ now: () => Date.now() + offset, limits: limits({ requestTimeoutMs: 40 }) });
  t.after(() => manager.dispose()); const id = run(manager, 2000);
  const permit = await manager.acquire(id, randomUUID()), started = performance.now();
  offset = -100_000; await delay(85);
  const state = manager.snapshot().runs[0];
  assert.equal(state.stopped, true); assert.equal(state.stopCode, 'REQUEST_TIMEOUT');
  assert.equal(manager.snapshot().inFlight, 1); assert.ok(performance.now() - started < 1000);
  await assert.rejects(manager.acquire(id, randomUUID()), code('REQUEST_TIMEOUT'));
  manager.reclaimRun(id); assert.equal(manager.release(id, permit.id), false);
});

test('the supplied admission monotonic deadline caps late request expiry even after wall rollback', async t => {
  let wall = Date.now(), mono = 1000;
  const manager = new PermitManager({ now: () => wall, monotonicNow: () => mono }); t.after(() => manager.dispose());
  const id = randomUUID(), endWall = wall + 500;
  manager.registerRun(id, endWall, mono + 500);
  wall -= 100_000; mono += 490;
  const permit = await manager.acquire(id, randomUUID()), timing = manager.timing(id, permit.id);
  assert.equal(Date.parse(permit.expiresAt), wall + 10);
  assert.equal(timing.expiresAt, wall + 10); assert.equal(timing.expiresMonotonicAt, 1500);
  assert.equal(Object.isFrozen(timing), true);
  assert.throws(() => manager.timing(randomUUID(), permit.id), code('PERMIT_RUN_MISMATCH'));
  assert.throws(() => manager.timing(id, randomUUID()), code('PERMIT_UNKNOWN'));
  mono += 11;
  await assert.rejects(manager.acquire(id, randomUUID()), code('RUN_DEADLINE_EXCEEDED'));
  assert.equal(manager.snapshot().inFlight, 1);
});

test('exact admission monotonic deadline remains usable if wall clock rolls back during startup before registration', async t => {
  let wall = Date.now(), mono = 1000;
  const admittedWallDeadline = wall + 500, admittedMonotonicDeadline = mono + 500;
  const manager = new PermitManager({ now: () => wall, monotonicNow: () => mono }); t.after(() => manager.dispose());
  wall -= 1_000_000; mono += 400;
  const id = randomUUID();
  manager.registerRun(id, admittedWallDeadline, admittedMonotonicDeadline);
  const permit = await manager.acquire(id, randomUUID());
  assert.equal(Date.parse(permit.expiresAt), wall + 100);
  assert.equal(manager.timing(id, permit.id).expiresMonotonicAt, admittedMonotonicDeadline);
});

test('invalid IDs, unregistered Runs, and invalid or expired deadlines are refused before budget mutation', async t => {
  const manager = new PermitManager(); t.after(() => manager.dispose());
  await assert.rejects(manager.acquire(randomUUID(), randomUUID()), code('RUN_UNKNOWN'));
  await assert.rejects(manager.acquire('not-a-uuid', randomUUID()));
  assert.throws(() => manager.registerRun(randomUUID(), Number.NaN));
  assert.throws(() => manager.registerRun(randomUUID(), Date.now() - 1), code('RUN_DEADLINE_EXCEEDED'));
  assert.equal(manager.snapshot().inFlight, 0); assert.equal(manager.snapshot().runs.length, 0);
});
