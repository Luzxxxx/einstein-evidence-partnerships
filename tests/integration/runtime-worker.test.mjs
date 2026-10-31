import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorker } from '../../dist/server/runtime/worker-entry.js';
import { Scheduler } from '../../dist/server/supervisor/scheduler.js';
import { ProcessHost } from '../../dist/server/supervisor/process-host.js';
import { RunStore } from '../../dist/server/storage/run-store.js';
import { DEFAULT_LIMITS } from '../../dist/server/contracts/config.js';
import { input as inputFixture } from '../fixtures/contracts.mjs';

// Real Windows Scheduler + ProcessHost + parent PermitManager + native Mozaik loops.
// Only the model transport is scripted; the fixture imports the production bootstrap.
// No network, credential read, or semantic quality claim is involved. Task7 now
// verifies the actual parent publishing gate with explicit offline model answers.
const workerPath = fileURLToPath(new URL('../fixtures/mozaik-worker.mjs', import.meta.url));
const snapshotPath = fileURLToPath(new URL('../../reference/einstein-matchmaker-data/', import.meta.url));
const nativeOptions = { skip: process.platform !== 'win32', timeout: 90_000 };
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) { if (Date.now() >= deadline) throw Error(`OFFLINE_FIXTURE_WAIT_${label}`); await pause(20); }
}
async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
function cleanupProjection(cleanup) {
  const { stdout, stderr, ...exit } = cleanup.exit;
  return { ...cleanup, exit, outputBytes: { stdout: Buffer.byteLength(stdout), stderr: Buffer.byteLength(stderr) } };
}
async function setup(t, mode, overrides = {}) {
  assert.equal(typeof startWorker, 'function');
  const root = await mkdtemp(join(tmpdir(), 'einstein task6 native worker '));
  const barrierPath = join(root, 'fixture-barrier.json');
  // Keep this separate from RunStore's strict UUID-only directory namespace.
  const workerCwd = await mkdtemp(join(tmpdir(), 'einstein task6 isolated worker cwd '));
  const store = await RunStore.open(root);
  const limits = { ...DEFAULT_LIMITS, runTimeoutMs: 60_000, requestTimeoutMs: 30_000, queueTimeoutMs: 30_000, ...overrides };
  let host;
  const scheduler = new Scheduler({ store, snapshotPath, runnerMode: 'offline_fixture', limits,
    // This is the actual host, including actual Windows identity probes/termination.
    // Fresh cwd prevents the native optional telemetry client from reading a real cwd/.env.
    createHost: callbacks => { host = new ProcessHost({ ...callbacks, cwd: workerCwd,
      workerPath, workerArgs: ['--mode', mode, '--barrier-path', barrierPath] }); return host; } });
  const x = { root, barrierPath, mode, scheduler, store, limits, metadata: {} };
  t.after(async () => {
    let closeFailure;
    try { await scheduler.close(); } catch { closeFailure = 'SCHEDULER_CLOSE_FAILED'; }
    const records = store.listRuns(); const terminal = [];
    for (const record of records) {
      const bundle = await readJson(join(root, record.runId, 'terminal.json'));
      if (bundle) terminal.push({ runId: record.runId, kind: bundle.outcome.kind,
        reasonCodes: bundle.outcome.reasonCodes, artifactKinds: bundle.artifacts.map(a => a.kind),
        reviewVerdicts: bundle.artifacts.filter(a => a.kind === 'critic_review').map(a => a.artifact.verdict) });
    }
    const evidence = { runnerMode: 'offline_fixture', platform: process.platform,
      actualNativeWorkerLifecycle: mode, sharedProductionBootstrap: true, networkTransport: 'controlled_fake_fetch',
      isolatedNewWorkerCwd: workerCwd, limits, records, events: records.map(r => ({ runId: r.runId, events: store.eventsAfter(r.runId, 0) })),
      permitSnapshot: scheduler.permits.snapshot(), cleanups: scheduler.cleanupEvidence.map(cleanupProjection),
      barrier: await readJson(barrierPath) ?? null, signalObservation: await readJson(`${barrierPath}.signal.json`) ?? null,
      terminal, ...x.metadata, ...(closeFailure ? { closeFailure } : {}) };
    const evidencePath = resolve('docs/implementation', `task-6-runtime-worker-${mode}-${Date.now()}-${randomUUID()}.json`);
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    console.log(`Immutable actual native worker evidence: ${evidencePath}`);
    await store.close();
    if (!closeFailure && scheduler.cleanupEvidence.every(c => c.confirmed)) {
      const absolute = resolve(root), tempRoot = resolve(tmpdir());
      assert.ok(absolute.startsWith(`${tempRoot}${sep}`) && absolute.includes('einstein task6 native worker '));
      await rm(absolute, { recursive: true, force: true });
      const isolated = resolve(workerCwd);
      assert.ok(isolated.startsWith(`${tempRoot}${sep}`) && isolated.includes('einstein task6 isolated worker cwd '));
      await rm(isolated, { recursive: true, force: true });
    }
    if (closeFailure) throw Error(closeFailure);
  });
  x.run = () => ({ ...inputFixture(), runId: randomUUID(), promptVersion: 'offline_fixture', configVersion: 'task6_native_fixture' });
  x.events = runId => store.eventsAfter(runId, 0);
  x.barrier = async stage => {
    await until(async () => {
      if ((await readJson(barrierPath))?.stage === stage) return true;
      if (store.listRuns().some(r => ['failed', 'cancelled', 'insufficient'].includes(r.status))) throw Error('OFFLINE_FIXTURE_BARRIER_NOT_REACHED');
      return false;
    }, stage);
    return readJson(barrierPath);
  };
  x.releaseStartup = () => writeFile(`${barrierPath}.release`, 'offline_fixture\n', { flag: 'wx' });
  x.signalObservation = async stage => {
    await until(async () => (await readJson(`${barrierPath}.signal.json`))?.stage === stage, stage);
    return readJson(`${barrierPath}.signal.json`);
  };
  x.host = () => host;
  return x;
}
async function assertClean(x, runId, status) {
  await x.scheduler.waitForIdle(45_000);
  const record = x.store.getRun(runId);
  assert.equal(record.runnerMode, 'offline_fixture'); assert.equal(record.status, status);
  assert.equal(record.cleanupState, 'confirmed'); assert.equal(x.scheduler.safetyHold, false);
  assert.equal(x.scheduler.permits.snapshot().inFlight, 0);
  const cleanup = x.scheduler.cleanupEvidence.find(c => c.runId === runId);
  assert.ok(cleanup?.confirmed && cleanup.identity && cleanup.exit.exitObserved && cleanup.exit.closeObserved);
  assert.equal(cleanup.termination, null, 'The real worker cooperates; no root identity termination was needed.');
  assert.equal(cleanup.identity.parentPid, process.pid); assert.equal(cleanup.identity.pid, cleanup.exit.pid);
  assert.ok(cleanup.identity.commandLine.includes('--supervisor-run-id') && cleanup.identity.commandLine.includes(runId));
  assert.ok(x.events(runId).some(e => e.type === 'cleanup.completed'));
  assert.equal(x.events(runId).some(e => e.type === 'run.status' && e.payload.status === 'approved'), false);
  const diagnostic = JSON.stringify({ events: x.events(runId), stdout: cleanup.exit.stdout, stderr: cleanup.exit.stderr });
  for (const secret of ['offline-fixture-dummy-key', 'authorization', 'Execute the assigned JSON task']) assert.equal(diagnostic.includes(secret), false);
  return JSON.parse(await readFile(join(x.root, runId, 'terminal.json'), 'utf8'));
}

test('actual native Windows worker retains answer field diagnostics before failure cleanup', nativeOptions, async t => {
  const x = await setup(t, 'answer-invalid'), run = await x.scheduler.submit(x.run());
  const bundle = await assertClean(x, run.runId, 'failed');
  const event = x.events(run.runId).find(e => e.type === 'task.failed' && e.role === 'proposer');
  assert.ok(event, 'the pre-abort failure must reach persisted parent events');
  assert.deepEqual(bundle.outcome.reasonCodes, ['ANSWER_SCHEMA_INVALID']);
  assert.equal(event.payload.validation.stage, 'schema_validation');
  assert.ok(event.payload.validation.issues.some(i => JSON.stringify(i.path) === '["claims",0,"sourceBindings"]'));
  assert.ok(x.events(run.runId).some(e => e.type === 'model.answer' && e.role === 'proposer'));
  assert.equal(bundle.artifacts.some(a => a.kind === 'proposal_draft'), false);
});

test('actual native Windows worker publishes a diagnostic only after parent gate and confirmed cleanup', nativeOptions, async t => {
  const x = await setup(t, 'normal'), run = await x.scheduler.submit(x.run());
  const bundle = await assertClean(x, run.runId, 'approved');
  assert.deepEqual(bundle.outcome.reasonCodes, []);
  assert.equal(bundle.publication.runnerMode,'offline_fixture');assert.equal(bundle.publication.formalProposal,null);
  assert.deepEqual(JSON.parse(bundle.publication.renderedDraft),bundle.outcome.draft);
  assert.deepEqual(new Set(bundle.artifacts.map(a => a.kind)), new Set(['proposal_draft', 'counter_report', 'critic_review']));
  assert.equal(bundle.artifacts.find(a => a.kind === 'critic_review').artifact.verdict, 'approve');
  const events = x.events(run.runId), grants = events.filter(e => e.type === 'permit.granted');
  assert.equal(grants.length, 5); assert.equal(events.filter(e => e.type === 'model.request.started').length, 5);
  assert.equal(events.filter(e => e.type === 'model.request.completed').length, 5);
  assert.equal(events.filter(e => e.type === 'function_call.started').length, 2);
  assert.equal(events.filter(e => e.type === 'function_call.completed').length, 2);
  assert.equal(events.filter(e => e.type === 'model.answer').length, 3);
  assert.equal(events.filter(e => e.type === 'review.completed').length, 1);
  for (const started of events.filter(e => e.type === 'model.request.started')) {
    const granted = grants.find(e => e.payload.permitId === started.payload.permitId);
    assert.ok(granted && granted.seq < started.seq); assert.equal(granted.payload.requestId, started.payload.requestId);
  }
  for (const role of ['proposer', 'counter-evidence', 'critic']) {
    const own = events.filter(e => e.role === role && e.type === 'task.started'); assert.equal(own.length, 1);
    for (const field of ['agentId', 'loopId', 'taskId', 'contextId']) assert.match(own[0][field], /^[a-f0-9-]{36}$/);
  }
  const firstCritic = events.find(e => e.type === 'task.started' && e.role === 'critic');
  assert.ok(['proposer', 'counter-evidence'].every(role => events.some(e => e.type === 'task.completed' && e.role === role && e.seq < firstCritic.seq)));
  let active = 0, maximum = 0;
  for (const event of events) {
    if (event.type === 'model.request.started') maximum = Math.max(maximum, ++active);
    if (event.type === 'model.request.completed' || event.type === 'model.request.failed') active--;
  }
  assert.equal(active, 0); assert.equal(maximum, 2);
  assert.equal(x.scheduler.permits.snapshot().runs.find(r => r.runId === run.runId).attempts, 5);
});

test('cancel while real native loops wait for parent permits prevents every fake fetch', nativeOptions, async t => {
  const x = await setup(t, 'permit-wait'), run = await x.scheduler.submit(x.run());
  await x.barrier('startup');
  // A trusted configure barrier prevents native loops from racing these real parent reservations.
  const held = await Promise.all([x.scheduler.permits.acquire(run.runId, randomUUID()), x.scheduler.permits.acquire(run.runId, randomUUID())]);
  x.metadata.occupiedParentPermitIds = held.map(p => p.id);
  await x.releaseStartup();
  await until(() => x.scheduler.permits.snapshot().runs.find(r => r.runId === run.runId)?.pending >= 1, 'NATIVE_PERMIT_WAIT');
  assert.ok(x.events(run.runId).some(e => e.type === 'worker.ready'));
  assert.equal(x.events(run.runId).some(e => e.type === 'model.request.started'), false);
  await x.scheduler.cancel(run.runId); const bundle = await assertClean(x, run.runId, 'cancelled');
  assert.equal(bundle.artifacts.length, 0); assert.equal(x.events(run.runId).some(e => e.type === 'model.request.started'), false);
  assert.equal(x.scheduler.permits.snapshot().runs.find(r => r.runId === run.runId).attempts, 2);
});

test('cancel during the actual gateway fetch interval aborts the worker and reclaims real permits', nativeOptions, async t => {
  const x = await setup(t, 'fetch-wait'), run = await x.scheduler.submit(x.run());
  const barrier = await x.barrier('fetch'); assert.equal(barrier.runnerMode, 'offline_fixture');
  await until(() => x.events(run.runId).some(e => e.type === 'model.request.started'), 'FETCH_STARTED_EVENT');
  assert.ok(x.scheduler.permits.snapshot().inFlight >= 1);
  const spawned = x.events(run.runId).find(e => e.type === 'worker.spawned'); assert.ok(spawned);
  const auditName = `task-6-process-positive-${Date.now()}-${randomUUID()}.json`;
  const auditPath = fileURLToPath(new URL(`../../docs/implementation/${auditName}`, import.meta.url));
  x.metadata.positiveAuditPath = auditPath;
  const audit = await new Promise(done => {
    execFile(process.execPath, [fileURLToPath(new URL('../../scripts/verify-task6-processes.mjs', import.meta.url)), auditName],
      { windowsHide: true, timeout: 25_000, maxBuffer: 1024 * 1024 }, error => done({ exitCode: error?.code ?? 0, signal: error?.signal }));
  });
  assert.equal(audit.exitCode, 1, 'The read-only audit must detect this actual live worker.');
  assert.ok(!audit.signal);
  const report = await readJson(auditPath); assert.ok(report);
  assert.ok(report.liveProcesses.some(row => row.pid === spawned.payload.pid));
  assert.deepEqual(report.pathsUsed, [workerPath,
    fileURLToPath(new URL('../../dist/server/runtime/worker-entry.js', import.meta.url))].map(path => path.replaceAll('\\', '/').toLowerCase()));
  await x.scheduler.cancel(run.runId); const bundle = await assertClean(x, run.runId, 'cancelled');
  assert.equal(bundle.artifacts.length, 0); assert.equal(x.events(run.runId).some(e => e.type === 'model.request.completed'), false);
  assert.equal(x.events(run.runId).some(e => e.type === 'function_call.started'), false);
});

test('cancel after real Tool.invoke returns its receipt prevents the native tool continuation', nativeOptions, async t => {
  const x = await setup(t, 'tool-wait'), run = await x.scheduler.submit(x.run());
  const barrier = await x.barrier('tool-continuation');
  assert.equal(barrier.realInvokeSucceeded, true); assert.match(barrier.receiptId, /^[a-f0-9-]{36}$/);
  await until(() => x.events(run.runId).some(e => e.type === 'function_call.started'), 'TOOL_STARTED_EVENT');
  assert.equal(x.events(run.runId).some(e => e.type === 'function_call.completed'), false);
  await x.scheduler.cancel(run.runId); const bundle = await assertClean(x, run.runId, 'cancelled');
  assert.equal(bundle.artifacts.length, 0); assert.equal(x.events(run.runId).some(e => e.type === 'function_call.completed'), false);
  assert.equal(x.events(run.runId).some(e => e.type === 'model.answer'), false);
});

test('cancel while a validated artifact is held in the outbound queue cannot deliver or publish it later', nativeOptions, async t => {
  const x = await setup(t, 'artifact-wait'), run = await x.scheduler.submit(x.run());
  const barrier = await x.barrier('artifact-queued'); assert.ok(['proposal_draft', 'counter_report'].includes(barrier.artifactKind));
  await until(() => x.events(run.runId).some(e => e.type === 'model.answer'), 'NATIVE_ANSWER_BEFORE_ARTIFACT');
  assert.equal(x.events(run.runId).some(e => e.type === 'artifact.validated'), false);
  await x.scheduler.cancel(run.runId); const bundle = await assertClean(x, run.runId, 'cancelled');
  assert.equal(bundle.artifacts.length, 0); assert.equal(x.events(run.runId).some(e => e.type === 'artifact.validated'), false);
  assert.equal(x.events(run.runId).some(e => e.type === 'review.completed'), false);
});

test('cancel while a reviewed outcome waits in the outbound queue cannot publish or revive the Run', nativeOptions, async t => {
  const x = await setup(t, 'outcome-wait'), run = await x.scheduler.submit(x.run());
  const barrier = await x.barrier('outcome-queued'); assert.equal(barrier.outcomeKind, 'reviewed');
  await until(() => x.events(run.runId).some(e => e.type === 'review.completed'), 'REVIEW_BEFORE_OUTCOME');
  assert.equal(x.store.getRun(run.runId).status, 'reviewing');
  await x.scheduler.cancel(run.runId); const bundle = await assertClean(x, run.runId, 'cancelled');
  assert.equal(bundle.outcome.kind, 'cancelled'); assert.equal(bundle.artifacts.length, 3);
  assert.equal(bundle.artifacts.find(a => a.kind === 'critic_review').artifact.verdict, 'approve');
  assert.equal(x.events(run.runId).some(e => e.type === 'run.status' && e.payload.reasonCodes.includes('PUBLISHING_UNAVAILABLE_TASK5')), false);
});

test('one actual gateway failure fences sibling native inference and cooperatively closes the real worker', nativeOptions, async t => {
  const x = await setup(t, 'fetch-fail'), run = await x.scheduler.submit(x.run());
  const barrier = await x.barrier('failure-fence'); assert.equal(barrier.bothNativeFetchesEntered, true);
  const observation = await x.signalObservation('sibling-fetch-aborted'); assert.equal(observation.observed, true);
  const bundle = await assertClean(x, run.runId, 'failed');
  assert.equal(bundle.artifacts.length, 0); assert.equal(x.events(run.runId).some(e => e.type === 'model.answer'), false);
  assert.equal(x.events(run.runId).some(e => e.type === 'function_call.started'), false);
  assert.equal(x.events(run.runId).filter(e => e.type === 'model.request.started').length, 2);
  assert.ok(x.events(run.runId).some(e => e.type === 'model.request.failed' && e.payload.code === 'GATEWAY_FETCH_FAILED'));
  assert.equal(JSON.stringify({ bundle, events: x.events(run.runId) }).includes('private-offline-provider-error'), false);
});

test('real child channel loss aborts the shared signal and retains safety hold when root scanning is unconfirmed', nativeOptions, async t => {
  const x = await setup(t, 'fetch-disconnect'), run = await x.scheduler.submit(x.run());
  await x.barrier('channel-disconnect');
  const observation = await x.signalObservation('disconnect-signal-aborted'); assert.equal(observation.observed, true);
  await until(() => x.scheduler.cleanupEvidence.some(c => c.runId === run.runId), 'DISCONNECTED_CHILD_CLEANUP');
  await x.scheduler.drain();
  const cleanup = x.scheduler.cleanupEvidence.find(c => c.runId === run.runId);
  assert.ok(cleanup.identity && cleanup.exit.exitObserved && cleanup.exit.closeObserved);
  assert.equal(cleanup.termination, null, 'Channel loss closes cooperatively, without root forced termination.');
  assert.equal(x.events(run.runId).some(e => ['model.answer', 'artifact.validated', 'review.completed'].includes(e.type)), false);
  assert.equal(x.store.getRun(run.runId).status, 'failed'); assert.equal(x.store.getRun(run.runId).runnerMode, 'offline_fixture');
  if (cleanup.confirmed) {
    assert.equal(x.scheduler.safetyHold, false); assert.equal(x.scheduler.permits.snapshot().inFlight, 0);
  } else {
    assert.equal(x.scheduler.safetyHold, true); assert.equal(x.store.getRun(run.runId).cleanupState, 'unconfirmed');
    assert.ok(x.scheduler.permits.snapshot().inFlight >= 1, 'Unconfirmed cleanup cannot reopen parent capacity.');
  }
  x.metadata.channelLossScope = 'trusted_fixture_self_disconnect_not_abrupt_parent_death';
});

test('a real native worker request deadline fails closed without user cancellation or forced root termination', nativeOptions, async t => {
  const x = await setup(t, 'fetch-wait', { requestTimeoutMs: 600 });
  assert.equal(x.limits.requestTimeoutMs, 600, 'The trusted fixture must actually apply the short request deadline.');
  x.metadata.deadlineCase = 'actual_native_worker_request_timeout_without_user_cancel';
  const run = await x.scheduler.submit(x.run());
  const barrier = await x.barrier('fetch'); assert.equal(barrier.runnerMode, 'offline_fixture');
  await until(() => x.events(run.runId).some(e => e.type === 'model.request.started'), 'DEADLINE_FETCH_STARTED');
  const bundle = await assertClean(x, run.runId, 'failed');
  assert.equal(bundle.artifacts.length, 0);
  assert.equal(x.events(run.runId).some(e => e.type === 'model.answer'), false);
  assert.equal(x.events(run.runId).some(e => e.type === 'model.request.completed'), false);
  const timeoutCodes = new Set([...bundle.outcome.reasonCodes,
    ...x.events(run.runId).filter(e => e.type === 'run.status').flatMap(e => e.payload.reasonCodes),
    ...x.events(run.runId).filter(e => e.type === 'model.request.failed').map(e => e.payload.code)]);
  assert.ok(timeoutCodes.has('REQUEST_TIMEOUT') || timeoutCodes.has('GATEWAY_REQUEST_TIMEOUT'),
    'The actual parent or child request deadline must explain the failed outcome.');
});

test('actual Windows native revision preserves Counter v1 and publishes only approved changed v2 after cleanup', nativeOptions, async t => {
  // All five native tasks and source Tool.invoke/parent gate/Windows cleanup are
  // real; every model answer is a labelled offline_fixture protocol script.
  const x=await setup(t,'revise'),run=await x.scheduler.submit({...x.run(),mode:'adversarial',configVersion:'task7-native-revision'});
  const bundle=await assertClean(x,run.runId,'approved');
  const drafts=bundle.artifacts.filter(a=>a.kind==='proposal_draft').map(a=>a.artifact).sort((a,b)=>a.version-b.version);
  const counters=bundle.artifacts.filter(a=>a.kind==='counter_report').map(a=>a.artifact);
  const reviews=bundle.artifacts.filter(a=>a.kind==='critic_review').map(a=>a.artifact).sort((a,b)=>a.version-b.version);
  assert.deepEqual(drafts.map(d=>d.version),[1,2]);assert.equal(counters.length,1);assert.equal(counters[0].version,1);
  assert.deepEqual(reviews.map(r=>r.verdict),['revise','approve']);
  assert.notEqual(drafts[0].draftHash,drafts[1].draftHash);
  assert.notDeepEqual(drafts[0].sections,drafts[1].sections,'fixture revision must change actual content, not only version/hash');
  assert.equal(drafts[0].sections.validation,undefined);assert.ok(drafts[1].sections.validation.length>0);
  assert.notDeepEqual(drafts[0].claims[0].limitations,drafts[1].claims[0].limitations);
  for(const review of reviews){assert.equal(review.target.counterReportHash,counters[0].hash);assert.equal(review.target.poolHash,drafts[0].poolHash);}
  assert.equal(reviews[0].target.draftHash,drafts[0].draftHash);assert.equal(reviews[1].target.draftHash,drafts[1].draftHash);
  assert.deepEqual(JSON.parse(bundle.publication.renderedDraft),drafts[1]);assert.equal(bundle.publication.formalProposal,null);
  assert.equal(bundle.publication.mode,'adversarial');assert.equal(bundle.record.acceptedReview.hash,reviews[1].hash);
  const events=x.events(run.runId);
  for(const role of ['proposer','critic']){
    const tasks=events.filter(e=>e.type==='task.started'&&e.role===role);
    assert.equal(tasks.length,2);assert.equal(tasks[0].agentId,tasks[1].agentId);
    assert.notEqual(tasks[0].taskId,tasks[1].taskId);assert.notEqual(tasks[0].contextId,tasks[1].contextId);
    assert.deepEqual(tasks.map(task=>task.attempt),[1,2]);
  }
  assert.equal(events.filter(e=>e.type==='task.started'&&e.role==='counter-evidence').length,1);
  assert.equal(events.filter(e=>e.type==='model.answer').length,5);
  assert.equal(events.filter(e=>e.type==='function_call.completed').length,3);
  assert.equal(events.filter(e=>e.type==='permit.granted').length,8);
  x.metadata.task7RevisionProtocol={scope:'offline_fixture_only_not_Critic_semantic_quality',draftHashes:drafts.map(d=>d.draftHash),
    counterHash:counters[0].hash,reviewHashes:reviews.map(r=>r.hash),finalVersion:2};
});

test('actual Windows native tool batches preserve both ordered source results and publish diagnostic only', nativeOptions, async t => {
  // OFFLINE_FIXTURE: all production SDK, native Tool.invoke, Contexts, gateway
  // adapter, parent permits, gate and OS cleanup execute; HTTPS responses alone
  // are scripted, with two original calls in each analysis response.
  const x=await setup(t,'batch'),run=await x.scheduler.submit({...x.run(),mode:'adversarial',configVersion:'task7r-native-batch'});
  const bundle=await assertClean(x,run.runId,'approved');
  assert.equal(bundle.publication.runnerMode,'offline_fixture');assert.equal(bundle.publication.mode,'adversarial');assert.equal(bundle.publication.formalProposal,null);
  const events=x.events(run.runId),staged=events.filter(e=>e.type==='tool.batch.updated'&&e.payload.phase==='staged');
  const completed=events.filter(e=>e.type==='tool.batch.updated'&&e.payload.phase==='completed');
  assert.equal(staged.length,2);assert.equal(completed.length,2);
  assert.equal(events.filter(e=>e.type==='permit.granted').length,5);assert.equal(events.filter(e=>e.type==='model.request.started').length,5);
  assert.equal(events.filter(e=>e.type==='model.request.completed').length,5);
  assert.equal(events.filter(e=>e.type==='function_call.started').length,4);assert.equal(events.filter(e=>e.type==='function_call.completed').length,4);
  for(const role of ['proposer','counter-evidence']){
    const batch=staged.find(e=>e.role===role),done=completed.find(e=>e.role===role);assert.ok(batch&&done);
    assert.equal(batch.payload.calls.length,2);assert.equal(done.payload.batchId,batch.payload.batchId);
    assert.deepEqual(done.payload.calls.map(c=>c.callId),batch.payload.calls.map(c=>c.callId));
    assert.deepEqual(batch.payload.calls.map(c=>c.toolName),role==='proposer'
      ?['read_candidate_bundle','read_company_challenge']:['read_company_challenge','read_candidate_bundle']);
    assert.ok(done.payload.calls.every(c=>c.started&&c.returned&&/^[a-f0-9]{64}$/.test(c.outputSha256)));
    const own=events.filter(e=>e.role===role&&['function_call.started','function_call.completed'].includes(e.type));
    assert.deepEqual(own.map(e=>e.type),['function_call.started','function_call.completed','function_call.started','function_call.completed']);
    assert.deepEqual(own.map(e=>e.payload.callId),[batch.payload.calls[0].callId,batch.payload.calls[0].callId,batch.payload.calls[1].callId,batch.payload.calls[1].callId]);
    for(let i=0;i<2;i++)assert.equal(own[i*2+1].payload.artifactRef.hash,done.payload.calls[i].outputSha256);
    assert.equal(new Set(own.map(e=>e.contextId)).size,1);assert.equal(new Set(own.map(e=>e.taskId)).size,1);
  }
  const roundtrip=await readJson(x.barrierPath);assert.equal(roundtrip.stage,'batch-roundtrip');assert.equal(roundtrip.runnerMode,'offline_fixture');
  assert.equal(roundtrip.originalCalls.length,2);assert.equal(roundtrip.wireMessages[0].role,'assistant');assert.equal(roundtrip.wireMessages[0].tool_calls.length,2);
  assert.deepEqual(roundtrip.wireMessages.slice(1).map(m=>m.tool_call_id),roundtrip.originalCalls.map(c=>c.id));
  assert.deepEqual(roundtrip.contextItems.map(i=>i.type),['function_call','function_call_output','function_call','function_call_output']);
  const done=completed.find(e=>e.role===roundtrip.role);assert.ok(done);assert.equal(done.contextId,roundtrip.actor.contextId);assert.equal(done.taskId,roundtrip.actor.taskId);
  for(let i=0;i<2;i++){
    const receipt=roundtrip.receipts[i],wire=JSON.parse(roundtrip.wireMessages[i+1].content);
    assert.equal(receipt.callId,roundtrip.originalCalls[i].id);assert.equal(receipt.receiptId,wire.receiptId);assert.match(receipt.receiptId,/^[a-f0-9-]{36}$/);
    assert.equal(receipt.runId,run.runId);assert.equal(receipt.outputSha256,done.payload.calls[i].outputSha256);
    assert.equal(roundtrip.contextItems[i*2].callId,receipt.callId);assert.equal(roundtrip.contextItems[i*2+1].callId,receipt.callId);
    assert.equal(roundtrip.contextItems[i*2+1].outputSha256,receipt.outputSha256);
  }
  x.metadata.task7rBatchScope='offline_fixture actual native serial two-call batches with complete original tool-result wire roundtrip';
});

test('actual Windows cancellation during first source invoke leaves queued batch calls unexecuted', nativeOptions, async t => {
  const x=await setup(t,'batch-tool-wait'),run=await x.scheduler.submit({...x.run(),mode:'adversarial',configVersion:'task7r-native-batch-cancel'});
  const barrier=await x.barrier('batch-tool-continuation');assert.equal(barrier.realInvokeSucceeded,true);assert.match(barrier.receiptId,/^[a-f0-9-]{36}$/);
  await until(()=>x.events(run.runId).filter(e=>e.type==='function_call.started').length===2,'TWO_FIRST_SOURCE_INVOKES');
  const before=x.events(run.runId),staged=before.filter(e=>e.type==='tool.batch.updated'&&e.payload.phase==='staged');
  assert.equal(staged.length,2);assert.ok(staged.every(e=>e.payload.calls.length===2&&e.payload.calls.every(c=>!c.returned&&!c.outputSha256)));
  assert.equal(before.some(e=>e.type==='function_call.completed'),false);
  await x.scheduler.cancel(run.runId);const bundle=await assertClean(x,run.runId,'cancelled');const events=x.events(run.runId);
  assert.equal(bundle.artifacts.length,0);assert.equal(events.filter(e=>e.type==='model.request.started').length,2);
  assert.equal(events.filter(e=>e.type==='permit.granted').length,2);assert.equal(events.filter(e=>e.type==='function_call.started').length,2);
  assert.equal(events.some(e=>e.type==='function_call.completed'||e.type==='model.answer'||e.type==='review.completed'),false);
  assert.equal(events.some(e=>e.type==='tool.batch.updated'&&e.payload.phase==='completed'),false);
  for(const batch of staged){
    assert.ok(events.some(e=>e.type==='function_call.started'&&e.payload.callId===batch.payload.calls[0].callId));
    assert.equal(events.some(e=>e.type==='function_call.started'&&e.payload.callId===batch.payload.calls[1].callId),false);
    const manifests=events.filter(e=>e.type==='tool.batch.updated'&&e.payload.batchId===batch.payload.batchId);
    assert.ok(manifests.every(e=>e.payload.calls.every(c=>!c.returned&&!c.outputSha256)),'a source invoke held before SDK return must not get a fabricated receipt');
  }
  x.metadata.task7rCancelledBatchPendingCalls=staged.map(e=>({role:e.role,taskId:e.taskId,contextId:e.contextId,batchId:e.payload.batchId,calls:e.payload.calls}));
});
