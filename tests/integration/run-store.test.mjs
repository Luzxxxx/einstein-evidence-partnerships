import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunStore } from '../../dist/server/storage/run-store.js';
import { hashRunInput } from '../../dist/server/evidence/hashing.js';
import { input, record, ids, draft, review, counter } from '../fixtures/contracts.mjs';

const openStores = new Set();
async function openStore(root, options) {
  const store = await RunStore.open(root, options); openStores.add({ store, root: resolve(root) }); return store;
}

// All data here are synthetic offline_fixture copies, never real model output.
const makeRecord = (id = ids.run) => {
  const value = { ...record(), runId: id, input: { ...input(), runId: id }, runnerMode: 'offline_fixture' };
  value.inputHash = hashRunInput(value.input); return value;
};
const event = (runId, seq, status = 'researching') => ({ schemaVersion: 1, runId, seq,
  at: '2026-10-30T10:00:00.000Z', elapsedMs: seq, source: 'supervisor', type: 'run.status',
  payload: { kind: 'run_status', status, reasonCodes: ['OFFLINE_FIXTURE'] } });
test('storage failure diagnostics retain bounded operation and OS code without exception text',async t=>{
 const root=await workspace(t);let inject=false;
 const store=await openStore(root,{fault(point){if(inject&&point==='events:beforeRename')throw Object.assign(Error('private exception content'),{code:'EPERM'});}});
 await store.createRun(makeRecord());inject=true;
 await assert.rejects(store.appendEvent(event(ids.run,1)));
 const failure=store.diagnostics.find(d=>d.code==='STORE_WRITE_FAILED');
 assert.equal(failure.ioCode,'EPERM');assert.equal(failure.stage,'rename');assert.ok(!JSON.stringify(failure).includes('private exception content'));
 assert.equal(store.safetyHold,true);assert.equal(store.eventsAfter(ids.run,0).length,0);
});
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'einstein-store-'));
  t.after(async () => {
    const absolute = resolve(root), rel = relative(resolve(tmpdir()), absolute);
    assert.ok(!isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('einstein-store-'));
    for (const entry of openStores) {
      const child = relative(absolute, entry.root);
      if (!isAbsolute(child) && !child.startsWith('..')) { await entry.store.close(); openStores.delete(entry); }
    }
    await rm(absolute, { recursive: true, force: true });
  });
  return join(root, '中文 带空格 Run storage');
}

test('store serially confirms events, freezes returned records, and keeps exact Run ownership', async t => {
  const root = await workspace(t), store = await openStore(root); t.after(() => store.close());
  const r = await store.createRun(makeRecord());
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.input));
  assert.throws(() => { r.input.companyId = 'C002'; }, TypeError);
  const pending = [1, 2, 3].map(seq => store.appendEvent(event(ids.run, seq)));
  assert.deepEqual((await Promise.all(pending)).map(e => e.seq), [1, 2, 3]);
  assert.deepEqual(store.eventsAfter(ids.run, 1).map(e => e.seq), [2, 3]);
  assert.equal(store.getRun(ids.run).lastSeq, 3);
  assert.ok(Object.isFrozen(store.eventsAfter(ids.run, 0)));
  await assert.rejects(store.appendEvent(event(ids.run, 3)), e => e.code === 'EVENT_SEQUENCE');
  await assert.rejects(store.appendEvent(event(ids.otherRun, 1)), e => e.code === 'RUN_NOT_FOUND');
  await assert.rejects(store.saveRecord({ ...r, lastSeq: 2 }), e => e.code === 'RECORD_SEQUENCE');
  await assert.rejects(store.saveRecord({ ...store.getRun(ids.run), inputHash: 'a'.repeat(64) }), e => e.code === 'INPUT_HASH');
  assert.equal(store.safetyHold, false, 'Invalid input is not an I/O failure');
});

test('an acknowledged atomic terminal bundle survives restart and late messages cannot reopen it', async t => {
  const root = await workspace(t); let store = await openStore(root);
  await store.createRun(makeRecord());
  await store.appendEvent(event(ids.run, 1, 'cancelled'));
  const cancelled = { ...store.getRun(ids.run), status: 'cancelled', cleanupState: 'not_started' };
  const outcome = { runId: ids.run, kind: 'cancelled', reasonCodes: ['OFFLINE_FIXTURE_CANCELLED'] };
  await store.commitOutcome(outcome, cancelled);
  const bytes = await readFile(join(root, ids.run, 'terminal.json'));
  await store.commitOutcome(outcome, cancelled); // exact duplicate is idempotent
  assert.deepEqual(await readFile(join(root, ids.run, 'terminal.json')), bytes);
  await assert.rejects(store.saveRecord({ ...cancelled, status: 'researching', cleanupState: 'pending' }), e => e.code === 'RUN_TERMINAL');
  await assert.rejects(store.commitOutcome({ ...outcome, kind: 'failed' }, { ...cancelled, status: 'failed' }), e => e.code === 'RUN_TERMINAL');
  await store.close(); store = await openStore(root); t.after(() => store.close());
  assert.equal(store.getRun(ids.run).status, 'cancelled');
  assert.equal(store.safetyHold, false);
  assert.equal(store.eventsAfter(ids.run, 0).length, 1);
});

test('unfinished restart is preserved under safety hold, never resumed or promoted to approved', async t => {
  const root = await workspace(t); let store = await openStore(root);
  await store.createRun(makeRecord()); await store.appendEvent(event(ids.run, 1));
  await store.saveRecord({ ...store.getRun(ids.run), status: 'researching', cleanupState: 'pending',
    admittedAt: '2026-10-30T10:00:00.000Z', deadlineAt: '2026-10-30T10:03:00.000Z' });
  await store.close(); store = await openStore(root); t.after(() => store.close());
  assert.equal(store.safetyHold, true); assert.equal(store.getRun(ids.run).status, 'researching');
  assert.ok(store.diagnostics.some(d => d.code === 'UNFINISHED_RUN' && d.runId === ids.run));
  await assert.rejects(store.createRun(makeRecord(ids.otherRun)), e => e.code === 'STORE_SAFETY_HOLD');
  assert.equal(store.listRuns().length, 1);
});

test('restart retains safety hold when a terminal Run has unconfirmed process cleanup', async t => {
  const root = await workspace(t); let store = await openStore(root);
  await store.createRun(makeRecord());
  await store.commitOutcome({ runId: ids.run, kind: 'failed', reasonCodes: ['OFFLINE_FIXTURE_CLEANUP_UNKNOWN'] },
    { ...store.getRun(ids.run), status: 'failed', cleanupState: 'unconfirmed' });
  await store.close(); store = await openStore(root); t.after(() => store.close());
  assert.equal(store.getRun(ids.run).status, 'failed'); assert.equal(store.getRun(ids.run).cleanupState, 'unconfirmed');
  assert.equal(store.safetyHold, true);
  assert.ok(store.diagnostics.some(d => d.code === 'UNCONFIRMED_CLEANUP' && d.runId === ids.run));
  await assert.rejects(store.createRun(makeRecord(ids.otherRun)), e => e.code === 'STORE_SAFETY_HOLD');
});

test('failed event write is not visible or acknowledged and preserves the prior disk bytes', async t => {
  const root = await workspace(t); let fail = false;
  const store = await openStore(root, { fault(point) { if (fail && point === 'events:beforeRename') throw Error('offline injected write failure'); } });
  t.after(() => store.close()); await store.createRun(makeRecord()); await store.appendEvent(event(ids.run, 1));
  const old = await readFile(join(root, ids.run, 'events.jsonl'));
  fail = true; await assert.rejects(store.appendEvent(event(ids.run, 2)), /offline injected write failure/);
  assert.equal(store.safetyHold, true); assert.equal(store.eventsAfter(ids.run, 0).length, 1);
  assert.equal(store.getRun(ids.run).lastSeq, 1);
  assert.deepEqual(await readFile(join(root, ids.run, 'events.jsonl')), old);
  assert.ok((await readdir(join(root, ids.run))).some(n => n.endsWith('.tmp')), 'Failed pending bytes retained for diagnostics');
});

test('failed terminal commit never changes visible status or exposes partial artifacts', async t => {
  const root = await workspace(t); let fail = false;
  let store = await openStore(root, { fault(point) { if (fail && point === 'terminal:beforeRename') throw Error('offline terminal failure'); } });
  await store.createRun(makeRecord()); fail = true;
  await assert.rejects(store.commitOutcome({ runId: ids.run, kind: 'failed', reasonCodes: ['OFFLINE_FIXTURE'] },
    { ...store.getRun(ids.run), status: 'failed' }), /offline terminal failure/);
  assert.equal(store.getRun(ids.run).status, 'queued'); assert.equal(store.safetyHold, true);
  await assert.rejects(readFile(join(root, ids.run, 'terminal.json')), e => e.code === 'ENOENT');
  await store.close(); store = await openStore(root); t.after(() => store.close());
  assert.equal(store.safetyHold, true); assert.notEqual(store.getRun(ids.run)?.status, 'approved');
});

test('bad middle lines and truncated final lines are preserved and only valid prefix is readable', async t => {
  for (const tail of ['{not-json}\n' + JSON.stringify(event(ids.run, 3)) + '\n', JSON.stringify(event(ids.run, 2)).slice(0, -5)]) {
    const root = join(await workspace(t), randomUUID()); let store = await openStore(root);
    await store.createRun(makeRecord()); await store.appendEvent(event(ids.run, 1)); await store.close();
    const path = join(root, ids.run, 'events.jsonl'), raw = JSON.stringify(event(ids.run, 1)) + '\n' + tail;
    await writeFile(path, raw); store = await openStore(root); t.after(() => store.close());
    assert.equal(store.safetyHold, true); assert.equal(store.eventsAfter(ids.run, 0).length, 1);
    assert.ok(store.diagnostics.some(d => ['INVALID_EVENT_LOG', 'TRUNCATED_EVENT_TAIL'].includes(d.code)));
    assert.equal(await readFile(path, 'utf8'), raw);
    assert.notEqual(store.getRun(ids.run)?.status, 'approved');
  }
});

test('reviewed worker outcomes, spoofed artifacts and direct approved states grant no publication authority', async t => {
  const root = await workspace(t), store = await openStore(root); t.after(() => store.close());
  await store.createRun(makeRecord());
  await assert.rejects(store.commitOutcome({ runId: ids.run, kind: 'reviewed', draft: draft(), review: review(), counter: counter(), reasonCodes: [] }, store.getRun(ids.run)), e => e.code === 'PUBLISHING_UNAVAILABLE');
  await assert.rejects(store.saveRecord({ ...store.getRun(ids.run), status: 'approved' }));
  const foreign = { kind: 'counter_report', artifact: { ...counter(), runId: ids.otherRun } };
  await assert.rejects(store.commitOutcome({ runId: ids.run, kind: 'failed', reasonCodes: ['OFFLINE_FIXTURE'] },
    { ...store.getRun(ids.run), status: 'failed' }, [foreign]), e => e.code === 'ARTIFACT_RUN');
  assert.equal(store.getRun(ids.run).status, 'queued'); assert.equal(store.safetyHold, false);
});

test('writer ownership, linked paths and relative paths are refused without touching foreign data', async t => {
  const root = await workspace(t), store = await openStore(root); t.after(() => store.close());
  await assert.rejects(openStore(root), e => e.code === 'STORE_LOCKED');
  await assert.rejects(openStore('relative-store'), e => e.code === 'STORE_PATH');
  const target = join(root, '..', 'foreign target'), linked = join(root, '..', 'linked store');
  await mkdir(target); await writeFile(join(target, 'sentinel'), 'unchanged');
  await symlink(target, linked, 'junction');
  await assert.rejects(openStore(linked), e => e.code === 'STORE_PATH');
  assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'unchanged');
});

test('all queued write APIs capture immutable call-time inputs rather than later caller mutations', async t => {
  const cases = ['createRun', 'saveRecord', 'appendEvent', 'commitOutcome'];
  for (const method of cases) await t.test(method, async t => {
    const root = await workspace(t);
    let release, signalEntered;
    const blocker = new Promise(done => { release = done; });
    const entered = new Promise(done => { signalEntered = done; });
    let block = false;
    const store = await openStore(root, { async fault(point) {
      if (block && point === 'events:beforeRename') { signalEntered(); await blocker; }
    } });
    t.after(() => store.close());
    if (method === 'createRun') {
      const value = makeRecord(), original = value.createdAt, pending = store.createRun(value);
      value.createdAt = '2026-10-30T10:00:00.001Z';
      assert.equal((await pending).createdAt, original);
      return;
    }
    await store.createRun(makeRecord());
    block = true;
    const prior = store.appendEvent(event(ids.run, 1));
    await entered;
    let pending, check;
    if (method === 'saveRecord') {
      const value = { ...store.getRun(ids.run), lastSeq: 1, status: 'researching', cleanupState: 'pending',
        admittedAt: '2026-10-30T10:00:00.000Z', deadlineAt: '2026-10-30T10:03:00.000Z' };
      pending = store.saveRecord(value); value.cleanupState = 'unconfirmed';
      check = () => assert.equal(store.getRun(ids.run).cleanupState, 'pending');
    } else if (method === 'appendEvent') {
      const value = event(ids.run, 2);
      pending = store.appendEvent(value); value.payload.reasonCodes[0] = 'MUTATED_AFTER_CALL';
      check = () => assert.deepEqual(store.eventsAfter(ids.run, 1)[0].payload.reasonCodes, ['OFFLINE_FIXTURE']);
    } else {
      const outcome = { runId: ids.run, kind: 'failed', reasonCodes: ['OFFLINE_FIXTURE'] };
      const record = { ...store.getRun(ids.run), lastSeq: 1, status: 'failed' };
      const artifacts = [{ kind: 'counter_report', artifact: counter() }];
      const expected = structuredClone({ outcome, record, artifacts });
      pending = store.commitOutcome(outcome, record, artifacts);
      outcome.reasonCodes[0] = 'MUTATED_AFTER_CALL'; record.cleanupState = 'unconfirmed';
      artifacts[0].artifact.noCounterEvidenceFound[0] = 'MUTATED_AFTER_CALL';
      check = async () => {
        const disk = JSON.parse(await readFile(join(root, ids.run, 'terminal.json'), 'utf8'));
        assert.deepEqual({ outcome: disk.outcome, record: disk.record, artifacts: disk.artifacts }, expected);
      };
    }
    block = false; release(); await prior; await pending; await check();
  });
});
