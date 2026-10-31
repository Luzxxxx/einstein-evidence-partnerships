// Read-only Windows identity audit. No PID termination, Store opening or model calls.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { queryWindowsIdentity } from '../dist/server/supervisor/process-host.js';

if (process.platform !== 'win32') throw Error('WINDOWS_REQUIRED');
const folder = resolve('docs/implementation');
const suffix = process.argv[2] ?? '';
if (!/^(?:-v[1-9][0-9]*)?$/.test(suffix) || process.argv.length > 3) throw Error('TASK9_AUDIT_ARGUMENT');
const names = (await readdir(folder)).filter(n => /^task-9-browser-(first|second|third|fourth|fifth|sixth|seventh|repaired)\.json$/.test(n)).sort();
const identities = new Map(), sources = [], missing = [];
for (const name of names) {
  const bytes = await readFile(resolve(folder, name)), record = JSON.parse(bytes);
  const edge = record.temporaryBrowser;
  if (!edge.exitObserved || !edge.profileIsNewTemporaryDirectory || edge.userProfileRead) throw Error('TASK9_BROWSER_CLOSE_EVIDENCE');
  if (edge.identity?.status === 'present') register(edge.identity.identity, name, 'temporary_headless_edge');
  else missing.push({ source: name, kind: 'temporary_headless_edge', code: 'BIRTH_IDENTITY_NOT_CAPTURED' });
  for (const cleanup of record.fixture.cleanups ?? []) {
    if (!cleanup.confirmed || !cleanup.exit.exitObserved || !cleanup.exit.closeObserved || cleanup.scanDiagnostics.length) throw Error('TASK9_WORKER_CLEANUP_EVIDENCE');
    register(cleanup.identity, name, 'offline_fixture_worker');
    for (const child of cleanup.descendants) register(child.identity, name, 'offline_fixture_registered_descendant');
  }
  sources.push({ file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), browserPassed: record.passed, actualModelRequests: record.actualModelRequests });
}
function register(identity, source, kind) {
  if (!identity || !Number.isSafeInteger(identity.pid) || !/^[0-9]{17,20}$/.test(identity.creationFileTime)) throw Error('TASK9_REGISTERED_IDENTITY_INVALID');
  const key = `${identity.pid}:${identity.creationFileTime}`, row = identities.get(key) ?? { pid: identity.pid, creationFileTime: identity.creationFileTime, sources: [], kinds: [] };
  row.sources.push(source); if (!row.kinds.includes(kind)) row.kinds.push(kind); identities.set(key, row);
}
const rows = [];
for (const identity of identities.values()) {
  const current = await queryWindowsIdentity(identity.pid);
  rows.push({ ...identity, observed: current.status === 'present' ? current.identity.creationFileTime === identity.creationFileTime ? 'same_original_identity_present' : 'identity_replaced' : current.status,
    currentCreationFileTime: current.status === 'present' ? current.identity.creationFileTime : null });
}
const result = { task: 'Task9', kind: 'actual_readonly_windows_identity_audit', observedAt: new Date().toISOString(),
  sources, rows, missing, registeredIdentities: rows.length, allCapturedOriginalsGone: rows.every(r => ['absent', 'identity_replaced'].includes(r.observed)),
  allBirthIdentitiesCaptured: missing.length === 0, workerScope: 'Exact registered worker/root/descendant identities only. No unknown-orphan or JobObject guarantee.',
  modelRequests: 0, terminationCalls: 0, storeOpenCalls: 0, recoveryApplyCalls: 0 };
await writeFile(resolve(folder, 'task-9-process-audit'+suffix+'.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ registeredIdentities: rows.length, missing: missing.length, allCapturedOriginalsGone: result.allCapturedOriginalsGone, modelRequests: 0 }));
if (!result.allCapturedOriginalsGone || missing.length) process.exitCode = 1;
