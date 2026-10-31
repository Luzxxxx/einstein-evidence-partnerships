import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PermitManager } from '../../dist/server/supervisor/permits.js';
import { DEFAULT_LIMITS } from '../../dist/server/contracts/config.js';

// Fixed clocks exercise production arithmetic, without sleeping for a real Run,
// opening any Store, spawning a process, or making a model/network request.
const EPOCH = 1761834240000;
const MONOTONIC_ORIGINS = [0.1, 1.5, 1000.1, 1000000.1, 10000000.1];
const hasCode = expected => error => error?.code === expected;
function managerAt(t, monotonicOrigin) {
  const clock = { wall: EPOCH, mono: monotonicOrigin };
  const manager = new PermitManager({ now: () => clock.wall, monotonicNow: () => clock.mono });
  t.after(() => manager.dispose());
  return { manager, clock };
}
function nextRepresentable(value) {
  const buffer = new ArrayBuffer(8), view = new DataView(buffer);
  view.setFloat64(0, value); view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
}

for (const origin of MONOTONIC_ORIGINS) {
  for (const explicit of [false, true]) {
    test(`exact 180000ms admission is legal at mono ${origin} (${explicit ? 'explicit' : 'implicit'})`, async t => {
      const { manager, clock } = managerAt(t, origin), runId = randomUUID();
      const endMono = origin + DEFAULT_LIMITS.runTimeoutMs;
      manager.registerRun(runId, EPOCH + 180000, ...(explicit ? [endMono] : []));
      const permit = await manager.acquire(runId, randomUUID());
      assert.equal(manager.timing(runId, permit.id).expiresMonotonicAt, origin + 40000);
      assert.equal(Date.parse(permit.expiresAt), EPOCH + 40000);
      assert.equal(manager.snapshot().runs[0].attempts, 1);
      clock.wall -= 1000000; clock.mono = endMono;
      await assert.rejects(manager.acquire(runId, randomUUID()), hasCode('RUN_DEADLINE_EXCEEDED'));
      assert.equal(manager.snapshot().inFlight, 1, 'expiration does not prove active work has exited');
      assert.equal(manager.snapshot().runs[0].attempts, 1);
      manager.reclaimRun(runId); // Unit-only trusted cleanup signal, not an OS cleanup claim.
      assert.equal(manager.snapshot().inFlight, 0);
      assert.equal(manager.snapshot().runs[0].attempts, 1, 'cleanup does not refund attempts');
    });
  }
  test(`next representable deadline above the absolute 180000ms bound is rejected at mono ${origin}`, t => {
    const { manager } = managerAt(t, origin);
    const absoluteBound = origin + 180000, actualOverCap = nextRepresentable(absoluteBound);
    assert.ok(actualOverCap > absoluteBound);
    assert.throws(() => manager.registerRun(randomUUID(), EPOCH + 180000, actualOverCap), hasCode('INVALID_RUN_DEADLINE'));
    assert.deepEqual(manager.snapshot(), { inFlight: 0, runs: [] });
  });
}

test('implicit integer wall duration above 180000ms is rejected before registering a Run', t => {
  const { manager } = managerAt(t, 0.1);
  assert.throws(() => manager.registerRun(randomUUID(), EPOCH + 180001), hasCode('INVALID_RUN_DEADLINE'));
  assert.deepEqual(manager.snapshot(), { inFlight: 0, runs: [] });
});

for (const [name, value] of [['NaN', NaN], ['positive Infinity', Infinity], ['negative Infinity', -Infinity], ['string', String(EPOCH + 180000)], ['fractional epoch', EPOCH + 0.5]]) {
  test(`invalid wall deadline ${name} cannot mutate registration or budgets`, t => {
    const { manager } = managerAt(t, 1000000.1);
    assert.throws(() => manager.registerRun(randomUUID(), value), hasCode('INVALID_RUN_DEADLINE'));
    assert.deepEqual(manager.snapshot(), { inFlight: 0, runs: [] });
  });
}
for (const [name, value] of [['NaN', NaN], ['positive Infinity', Infinity], ['negative Infinity', -Infinity], ['string', '1180000.1']]) {
  test(`invalid explicit monotonic deadline ${name} cannot mutate registration or budgets`, t => {
    const { manager } = managerAt(t, 1000000.1);
    assert.throws(() => manager.registerRun(randomUUID(), EPOCH + 180000, value), hasCode('INVALID_RUN_DEADLINE'));
    assert.deepEqual(manager.snapshot(), { inFlight: 0, runs: [] });
  });
}

test('already expired wall or monotonic deadlines are rejected without registration', t => {
  const { manager } = managerAt(t, 1000000.1);
  for (const deadline of [EPOCH, EPOCH - 1]) {
    assert.throws(() => manager.registerRun(randomUUID(), deadline), hasCode('RUN_DEADLINE_EXCEEDED'));
  }
  for (const deadline of [1000000.1, 1000000]) {
    assert.throws(() => manager.registerRun(randomUUID(), EPOCH + 180000, deadline), hasCode('RUN_DEADLINE_EXCEEDED'));
  }
  assert.deepEqual(manager.snapshot(), { inFlight: 0, runs: [] });
});

test('explicit admission deadline retains startup cost despite wall rollback and never grants a fresh 180 seconds', async t => {
  const origin = 1000000.1, { manager, clock } = managerAt(t, origin), runId = randomUUID();
  const originalWallDeadline = clock.wall + 180000, originalMonoDeadline = clock.mono + 180000;
  clock.wall -= 1000000; clock.mono += 150000;
  manager.registerRun(runId, originalWallDeadline, originalMonoDeadline);
  const permit = await manager.acquire(runId, randomUUID());
  assert.equal(manager.timing(runId, permit.id).expiresMonotonicAt, originalMonoDeadline);
  assert.equal(Date.parse(permit.expiresAt), clock.wall + 30000);
  clock.mono = originalMonoDeadline;
  await assert.rejects(manager.acquire(runId, randomUUID()), hasCode('RUN_DEADLINE_EXCEEDED'));
  assert.equal(manager.snapshot().inFlight, 1); assert.equal(manager.snapshot().runs[0].attempts, 1);
});

test('40-second request expiration under backward wall movement preserves its outstanding reservation', async t => {
  const origin = 1000000.1, { manager, clock } = managerAt(t, origin), runId = randomUUID();
  manager.registerRun(runId, EPOCH + 180000, origin + 180000);
  const permit = await manager.acquire(runId, randomUUID());
  clock.wall -= 1000000; clock.mono = origin + 40000;
  await assert.rejects(manager.acquire(runId, randomUUID()), hasCode('REQUEST_TIMEOUT'));
  assert.equal(manager.timing(runId, permit.id).expiresMonotonicAt, origin + 40000);
  assert.equal(manager.snapshot().inFlight, 1); assert.equal(manager.snapshot().runs[0].attempts, 1);
});

test('cancel wins once, denies pending work, and keeps reservations and attempts until trusted cleanup', async t => {
  const origin = 1000000.1, { manager, clock } = managerAt(t, origin), runId = randomUUID();
  manager.registerRun(runId, EPOCH + 180000, origin + 180000);
  await Promise.all([manager.acquire(runId, randomUUID()), manager.acquire(runId, randomUUID())]);
  const waiting = manager.acquire(runId, randomUUID()), rejected = assert.rejects(waiting, hasCode('RUN_CANCELLED'));
  assert.equal(manager.snapshot().runs[0].pending, 1);
  manager.stopRun(runId); await rejected;
  clock.mono = origin + 180000; manager.stopRun(runId, 'RUN_DEADLINE_EXCEEDED');
  await assert.rejects(manager.acquire(runId, randomUUID()), hasCode('RUN_CANCELLED'));
  assert.equal(manager.snapshot().runs[0].stopCode, 'RUN_CANCELLED');
  assert.equal(manager.snapshot().inFlight, 2); assert.equal(manager.snapshot().runs[0].attempts, 2);
  manager.reclaimRun(runId); // Explicit trusted boundary; this test has no Host/process.
  assert.equal(manager.snapshot().inFlight, 0); assert.equal(manager.snapshot().runs[0].attempts, 2);
});
