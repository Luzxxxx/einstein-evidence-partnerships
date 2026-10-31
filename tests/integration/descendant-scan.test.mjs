import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Synthetic fault injection ONLY at CIM enumeration. The compiled production scan,
// native GetProcessById/StartTime, JSON parsing, ProcessHost and Scheduler all execute.
// No predefined scan/cleanup result and no mocked termination/identity probe.
const originalExecFile = childProcess.execFile;
const modes = new Map(), scanGates = new Map(), scans = [], cleanups = [], controls = [];
const missingPid = 2147483000; // synthetic, outside the normal Windows PID range
const interceptedExecFile = function (path, args, options, callback) {
  const at = args.indexOf('-EncodedCommand');
  const script = at >= 0 ? Buffer.from(args[at + 1], 'base64').toString('utf16le') : '';
  if (!script.includes('$all=@(Get-CimInstance Win32_Process)')) return originalExecFile(path, args, options, callback);
  const rootPid = Number(script.match(/\$p=\[Diagnostics.Process\]::GetProcessById\((\d+)\)/)[1]);
  const mode = modes.get(rootPid) ?? 'actual_os';
  let prelude = '';
  if (mode !== 'actual_os') {
    // A fabricated enumerated relationship, never a claim about the actual test-parent tree.
    // Null CreationDate uses a live native PID so production reaches that exact field read.
    prelude = mode === 'enumeration_throw' ? "function Get-CimInstance { throw 'SYNTHETIC_ENUMERATION_FAILURE' };" :
      `function Get-CimInstance { [pscustomobject]@{ProcessId=${mode === 'identity_query_throw' ? missingPid : process.pid};ParentProcessId=${rootPid};CreationDate=${mode === 'identity_query_throw' ? '[DateTime]::UtcNow' : '$null'};ExecutablePath='synthetic';CommandLine='synthetic CIM entry, not a real descendant'} };`;
  }
  const next = [...args]; next[at + 1] = Buffer.from(prelude + script, 'utf16le').toString('base64');
  return originalExecFile(path, next, options, (error, stdout, stderr) => {
    let result; try { result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); } catch { /* retain original error */ }
    scans.push({ rootPid, mode, result, error: error?.message ?? null });
    const gate = scanGates.get(rootPid);
    if (gate && !gate.release) { gate.release = () => callback(error, stdout, stderr); gate.observed(); return; }
    callback(error, stdout, stderr);
  });
};
// Native execFile carries a promisify.custom closure over the ORIGINAL function.
// Replace that closure too, so promisify cannot silently bypass the CIM injection.
interceptedExecFile[promisify.custom] = (path, args, options) => new Promise((resolveResult, reject) => {
  interceptedExecFile(path, args, options, (error, stdout, stderr) => error ? reject(error) : resolveResult({ stdout, stderr }));
});
childProcess.execFile = interceptedExecFile;
syncBuiltinESMExports();
// Import after installing the boundary interception: production promisify captures it.
const { ProcessHost, queryWindowsIdentity } = await import('../../dist/server/supervisor/process-host.js');
const { Scheduler } = await import('../../dist/server/supervisor/scheduler.js');
const { RunStore } = await import('../../dist/server/storage/run-store.js');
const { DEFAULT_LIMITS } = await import('../../dist/server/contracts/config.js');
const { input } = await import('../fixtures/contracts.mjs');
const worker = fileURLToPath(new URL('../fixtures/offline-worker.mjs', import.meta.url));
const snapshotPath = resolve('reference/einstein-matchmaker-data');
const run = () => ({ ...input(), runId: randomUUID() });
const pause = ms => new Promise(r => setTimeout(r, ms));
async function bounded(promise, ms = 20000) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('TEST_DEADLINE')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(check) { const deadline = Date.now() + 12000; while (!check()) { if (Date.now() > deadline) throw Error('TEST_CONDITION_TIMEOUT'); await pause(10); } }
function host(mode = 'wait', callbacks = {}) { return new ProcessHost({ workerPath: worker, workerArgs: ['--mode', mode], ...callbacks }); }

test('production scan propagates each enumerated metadata/identity failure through real cleanup', async t => {
  for (const mode of ['missing_creation_date', 'identity_query_throw', 'enumeration_throw']) await t.test(mode, async t => {
    const faults = [], h = host('wait', { onFault: (_id, code) => faults.push(code) }).start(run(), snapshotPath, DEFAULT_LIMITS);
    t.after(async () => { const c = await bounded(h.terminate('TEST_TEARDOWN')); if (!cleanups.includes(c)) cleanups.push(c); modes.delete(h.pid); });
    await bounded(h.ready); modes.set(h.pid, mode);
    const rows = await bounded(h.inspectDescendants());
    const scan = scans.filter(x => x.rootPid === h.pid).at(-1);
    assert.equal(scan.error, null); assert.equal(scan.result.known, false, JSON.stringify(scan));
    assert.equal(rows.length, 0, 'unverified enumerated identities must never become kill targets');
    assert.ok(faults.includes('DESCENDANT_SCAN_UNCONFIRMED'));
    // Actually rescan successfully while the root is still alive; sticky failure
    // must survive this recovery, not just a cached repeat of terminate().
    modes.delete(h.pid); await bounded(h.inspectDescendants());
    assert.equal(scans.filter(x => x.rootPid === h.pid).at(-1).result.known, true);
    const c = await bounded(h.terminate('TEST_SCAN_UNCONFIRMED')); cleanups.push(c);
    assert.equal(c.exit.closeObserved, true);
    assert.ok(['absent','identity_replaced'].includes(c.rootVerification), 'the original identity must be gone; a reused PID is not the original worker');
    assert.equal(c.confirmed, false, 'root close does not erase a failed scan');
    assert.ok(c.scanDiagnostics.some(d => d.code && d.stage), 'cleanup retains diagnostic reason');
    const expectedStage = { missing_creation_date: 'cim_creation_date', identity_query_throw: 'native_identity', enumeration_throw: 'enumeration' }[mode];
    assert.ok(c.scanDiagnostics.some(d => d.stage === expectedStage && d.pid === (mode === 'enumeration_throw' ? h.pid : mode === 'identity_query_throw' ? missingPid : process.pid)
      && d.code === (mode === 'enumeration_throw' ? 'DESCENDANT_SCAN_FAILED' : 'DESCENDANT_IDENTITY_UNCONFIRMED')));
    assert.ok(Object.isFrozen(c.scanDiagnostics)); assert.ok(c.scanDiagnostics.every(Object.isFrozen));
    assert.equal((await queryWindowsIdentity(process.pid)).status, 'present', 'test parent was never a verified descendant');
    assert.equal((await h.terminate('LATE_RETRY')).confirmed, false);
  });
});

test('normal production metadata discovers and cleans actual detached descendants', async t => {
  const h = host('child').start(run(), snapshotPath, DEFAULT_LIMITS);
  t.after(async () => { const c = await bounded(h.terminate('TEST_TEARDOWN')); if (!cleanups.includes(c)) cleanups.push(c); });
  await bounded(h.ready); const rows = await bounded(h.inspectDescendants());
  const normal = scans.filter(x => x.rootPid === h.pid).at(-1);
  assert.equal(normal.mode, 'actual_os'); assert.equal(normal.result.known, true);
  assert.ok(rows.some(r => r.commandLine.includes('detached-child')));
  const c = await bounded(h.terminate('NORMAL_DESCENDANT_CONTROL')); cleanups.push(c);
  assert.equal(c.confirmed, true); assert.equal(c.exit.closeObserved, true);
  assert.ok(c.descendants.every(d => ['absent', 'identity_replaced'].includes(d.verification)));
  controls.push({ case: 'normal_actual_os_descendant', runId: h.runId, found: rows.length });
});

test('cleanup cannot overtake an already-running production scan that later reports uncertainty', async t => {
  const h = host().start(run(), snapshotPath, DEFAULT_LIMITS); await bounded(h.ready);
  let observed; const gate = { observed: () => observed() }, held = new Promise(r => { observed = r; });
  scanGates.set(h.pid, gate); modes.set(h.pid, 'missing_creation_date');
  t.after(async () => { gate.release?.(); const c = await bounded(h.terminate('TEST_TEARDOWN')); if (!cleanups.includes(c)) cleanups.push(c); modes.delete(h.pid); scanGates.delete(h.pid); });
  const earlier = h.inspectDescendants(); await bounded(held); modes.delete(h.pid);
  const cleanup = h.terminate('SCAN_RACE_CONTROL');
  const lateInspection = h.inspectDescendants();
  let timing;
  try { timing = await Promise.race([cleanup.then(() => 'overtook_scan'), pause(3000).then(() => 'waiting_for_scan')]); }
  finally { gate.release(); }
  await bounded(earlier); await bounded(lateInspection); const c = await bounded(cleanup); cleanups.push(c);
  controls.push({ case: 'synthetic_delayed_CIM_response_actual_worker_cleanup', timing, confirmed: c.confirmed });
  assert.equal(timing, 'waiting_for_scan', 'an in-flight scan must settle before cleanup can be certified');
  assert.equal(c.exit.closeObserved, true); assert.equal(c.confirmed, false);
  assert.ok(c.scanDiagnostics.some(d => d.stage === 'cim_creation_date'));
  assert.equal(scans.filter(x => x.rootPid === h.pid).length, 2, 'post-stop public inspection cannot start a third OS scan');
});

test('production failed scan holds Scheduler capacity and permit after actual worker close', async t => {
  const root = await mkdtemp(join(tmpdir(), 'einstein scan repair 中文 ')), store = await RunStore.open(root);
  let realHost;
  const scheduler = new Scheduler({ store, snapshotPath, runnerMode: 'offline_fixture',
    createHost: callbacks => (realHost = host('wait', callbacks)) });
  t.after(async () => {
    await scheduler.close(); await store.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir())) && root.includes('einstein scan repair 中文 '));
    await rm(root, { recursive: true, force: true });
  });
  const a = await scheduler.submit(run()), h = realHost.get(a.runId); await bounded(h.ready);
  // Parent-owned actual PermitManager grant, held deliberately; no model/network request.
  const permit = await scheduler.permits.acquire(a.runId, randomUUID());
  const queued = await scheduler.submit(run()); modes.set(h.pid, 'missing_creation_date');
  t.after(() => modes.delete(h.pid));
  await bounded(h.inspectDescendants());
  await bounded(scheduler.cancel(a.runId));
  await until(() => scheduler.getRun(a.runId).cleanupState === 'unconfirmed' || scheduler.getRun(a.runId).cleanupState === 'confirmed');
  await scheduler.drain(); const c = scheduler.cleanupEvidence.find(x => x.runId === a.runId); cleanups.push(...scheduler.cleanupEvidence);
  assert.equal(c.exit.closeObserved, true); assert.equal(c.rootVerification, 'absent'); assert.equal(c.confirmed, false);
  assert.equal(scheduler.safetyHold, true); assert.equal(store.getRun(a.runId).cleanupState, 'unconfirmed');
  assert.equal(store.getRun(queued.runId).status, 'queued'); assert.equal(realHost.list().length, 1);
  assert.equal(scheduler.permits.snapshot().inFlight, 1, 'unconfirmed scan cannot authorize quota reclaim');
  const reservation = scheduler.permits.snapshot().runs.find(r => r.runId === a.runId);
  assert.equal(reservation.inFlight, 1); assert.equal(reservation.attempts, 1); assert.equal(reservation.stopped, true);
  assert.equal(scheduler.permits.snapshot().runs.some(r => r.runId === queued.runId), false);
  await assert.rejects(scheduler.submit(run()), error => error.code === 'RUN_SAFETY_HOLD');
  controls.push({ case: 'synthetic_CIM_fault_real_scheduler_and_worker', permitId: permit.id, queuedRun: queued.runId,
    queuedStatus: store.getRun(queued.runId).status, spawnedWorkers: realHost.list().length, permits: scheduler.permits.snapshot(), safetyHold: scheduler.safetyHold });
});

test.after(async () => {
  childProcess.execFile = originalExecFile; syncBuiltinESMExports();
  const path = resolve(`docs/implementation/task-5-process-evidence-scan-repair-${Date.now()}-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ runnerMode: 'offline_fixture', platform: process.platform,
    scope: 'synthetic CIM faults; actual production PowerShell scan, native identity/termination, real workers and Scheduler; normal control has no injection',
    scans, cleanups, controls }, null, 2) + '\n', { flag: 'wx' });
  console.log('Immutable scan repair evidence: ' + path);
});
