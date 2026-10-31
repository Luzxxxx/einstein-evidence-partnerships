/** Read-only replay/integrity checks. Never calls a model or applies recovery. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadSnapshot } from '../dist/server/data/snapshot.js';
import { DATASET_COMMIT } from '../dist/server/contracts/primitives.js';
import { RunStore } from '../dist/server/storage/run-store.js';
import { evaluatePublication } from '../dist/server/publishing/gate.js';
import { canonicalizeArtifact } from '../dist/server/contracts/canonical.js';
import { hashArtifact, sha256Bytes } from '../dist/server/evidence/hashing.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const liveRoot = join(root, 'docs/implementation/task-7-completion-live');
const baselineFile = join(root, 'docs/implementation/task-7-completion-protection-baseline.json');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const need = (value, code) => { if (!value) throw Error(code); };
need(process.argv.length === 6 && process.argv[2] === '--l05' && process.argv[4] === '--output', 'COMPLETION_VERIFY_USAGE');
const runId = process.argv[3], outputName = process.argv[5];
need(/^[a-f0-9-]{36}$/.test(runId) && /^task-7-completion-verification[-a-z0-9]*\.json$/.test(outputName), 'COMPLETION_VERIFY_PATH');
const baseline = await read(baselineFile), groups = {
  originalTrackedEdits: baseline.trackedChanges, originalUntracked: baseline.protectedUntracked,
  historicalImplementation: baseline.historicalImplementation, historicalStore: baseline.historicalStore.files,
  officialSources: baseline.officialSources, resolution: [baseline.existingResolution], authorization: [baseline.existingAuthorization],
};
const protection = {};
for (const [name, files] of Object.entries(groups)) {
  const changed = [];
  for (const f of files) if (sha256Bytes(await readFile(resolve(root, f.file))) !== f.sha256) changed.push(f.file);
  protection[name] = { count: files.length, changed };
  need(changed.length === 0, 'COMPLETION_PROTECTED_FILE_CHANGED');
}
const untracked = new Set(execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'));
need(baseline.protectedUntracked.every(f => untracked.has(f.file)), 'COMPLETION_ORIGINAL_UNTRACKED_STATUS_CHANGED');
const observed = [];
for (const id of (await readdir(join(liveRoot, 'runs'))).sort()) {
  if (!/^[a-f0-9-]{36}$/.test(id)) continue;
  const summary = await read(join(liveRoot, 'runs', id, 'summary.json'));
  let result = null;
  try { result = await read(join(liveRoot, 'runs', id, 'result.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  observed.push({ id, summary, result });
}
const selected = observed.find(row => row.id === runId);
need(selected?.summary.passed && selected.result?.l05Chain?.structuralChainObserved, 'COMPLETION_REAL_L05_REQUIRED');
const r = selected.result, snapshotPath = join(root, 'reference/einstein-matchmaker-data');
const snapshot = await loadSnapshot(snapshotPath, DATASET_COMMIT), publication = r.publication;
const value = { draft: r.terminalOutcome.draft, review: r.terminalOutcome.review, counter: r.terminalOutcome.counter,
  run: publication.proof.reviewedRecord, pool: publication.proof.pool, evidence: publication.proof.evidence,
  evidenceSnapshotHash: r.terminalOutcome.draft.evidenceSnapshotHash, actor: publication.proof.actor, now: publication.committedAt };
const check = object => evaluatePublication({ ...object, snapshot });
need(check(value).allowed, 'COMPLETION_REPLAY_POSITIVE_FAILED');
const negativeChecks = [];
for (const field of Object.keys(value.review.target)) {
  const altered = structuredClone(value);
  altered.review.target[field] = typeof altered.review.target[field] === 'number' ? altered.review.target[field] + 1 : '0'.repeat(64);
  altered.review.hash = hashArtifact(altered.review);
  const decision = check(altered); need(!decision.allowed, 'COMPLETION_TARGET_TAMPER_ACCEPTED');
  negativeChecks.push({ kind: 'offline_mutation_of_real_live_artifact', field, decision });
}
const stale = structuredClone(value); stale.review.target = r.reviewVersions[0].target; stale.review.version = 1; stale.review.hash = hashArtifact(stale.review);
const staleDecision = check(stale); need(!staleDecision.allowed, 'COMPLETION_STALE_APPROVAL_ACCEPTED');
const duplicate = check({ ...value, run: r.record }); need(!duplicate.allowed, 'COMPLETION_DUPLICATE_PUBLICATION_ACCEPTED');
const store = await RunStore.open(baseline.historicalStore.root, {
  historicalRecovery: await read(resolve(root, baseline.existingAuthorization.file)),
  publicationSnapshot: () => loadSnapshot(snapshotPath, DATASET_COMMIT),
});
let restart;
try {
  need(!store.safetyHold && store.unresolvedDiagnostics.length === 0, 'COMPLETION_RESTART_HOLD');
  const verified = [];
  for (const row of observed) if (row.result?.record) {
    const stored = store.getRun(row.id); need(stored?.status === row.result.record.status, 'COMPLETION_RESTART_STATUS');
    const saved = store.getPublication(row.id) ?? null;
    need(canonicalizeArtifact(saved) === canonicalizeArtifact(row.result.publication), 'COMPLETION_RESTART_PUBLICATION_CHANGED');
    verified.push({ runId: row.id, status: stored.status, publicationPresent: saved !== null });
  }
  restart = { verified, safetyHold: store.safetyHold, unresolvedCount: store.unresolvedDiagnostics.length,
    historicalResolutions: store.historicalResolutions, recoveryApplyCalls: 0 };
} finally { await store.close(); }
const summary = { scope: 'engineering_integrity_and_actual_artifact_replay_only', verifiedAt: new Date().toISOString(),
  baselineHead: baseline.head, currentHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  protection, originalUntrackedRetained: baseline.protectedUntracked.length, l05RunId: runId,
  positiveReplay: check(value), negativeChecks, staleV1ApprovalAgainstV2: staleDecision, duplicatePublication: duplicate,
  restart, engineeringIntegrityPassed: true, semanticAcceptance: 'separate_source_review_required', humanLabels: 0, qualityMetrics: 'NA', holdout: 'unopened' };
const output = join(root, 'docs/implementation', outputName);
await writeFile(output, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, engineeringIntegrityPassed: true, protectedGroups: Object.keys(protection),
  restartedRuns: restart.verified.length, staleApprovalRejected: true, targetTamperChecks: negativeChecks.length }));
