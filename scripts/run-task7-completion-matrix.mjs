/** Fixed 12 x 3 descriptive observations after the native probe and L05. */
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runCompletionCase } from './run-task7-completion.mjs';
import { CRITIC_VARIANTS } from '../dist/server/evaluation/critic-cases.js';
import { collectCriticProductFingerprints } from '../dist/server/evaluation/run-critic-eval.js';
import { sha256Bytes } from '../dist/server/evidence/hashing.js';
import { canonicalizeArtifact } from '../dist/server/contracts/canonical.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = join(root, 'docs/implementation/task-7-completion-live');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const need = (ok, code) => { if (!ok) throw Error(code); };
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

export function matrixStopReason(row) {
  if (row.errorCode) return row.errorCode;
  if (row.safetyHold !== false) return 'MATRIX_CLEANUP_NOT_CONFIRMED';
  if (row.permitSnapshot?.inFlight !== 0 || !Array.isArray(row.permitSnapshot.runs) || row.permitSnapshot.runs.some(r => r.inFlight || r.pending || !r.stopped)) return 'MATRIX_PERMIT_NOT_SETTLED';
  if (row.cleanupState !== 'confirmed' || !['protectedFilesUnchanged', 'productFingerprintsUnchanged', 'storeClosed'].every(k => row.finalVerification?.[k] === true)) return 'MATRIX_FINAL_VERIFICATION_REQUIRED';
  // An invalid model answer is a failed observation, not permission to repair it
  // or retry that Run. Keep it in the denominator and advance the fixed plan.
  // Infrastructure/protocol/identity failures and uncertain cleanup still stop.
  if (row.status === 'failed' && row.reasonCodes?.length === 1
    && ['ANSWER_SCHEMA_INVALID', 'ANSWER_JSON_PARSE_FAILED'].includes(row.reasonCodes[0])) return null;
  if (!['approved', 'insufficient'].includes(row.status)) return 'MATRIX_TECHNICAL_FAILURE';
  if (['L01', 'C02'].includes(row.variantId) && row.status === 'approved') return 'MATRIX_UNSUPPORTED_PAIRING_APPROVED';
  if (row.variantId.startsWith('L') && row.reviewVerdicts[0] === 'approve') return 'MATRIX_ATTACK_FIRST_DRAFT_APPROVED';
  return null;
}

export async function executeMatrixEntries(entries, hooks) {
  const rows = []; let stopped = null; const unexecuted = [];
  for (const entry of entries) {
    let entered = false, row;
    try {
      await hooks.check(entry); await hooks.start(entry); entered = true;
      row = { ...entry, ...await hooks.execute(entry) }; rows.push(row);
      await hooks.complete(row); stopped = matrixStopReason(row);
    } catch (error) {
      stopped = /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.message ?? '') ? error.message : 'MATRIX_ENTRY_FAILED';
      if (!row) {
        rows.push({ ...entry, runId: null, status: 'entry_error', errorCode: stopped,
          executionState: entered ? 'unknown_no_returned_summary' : 'unexecuted' });
        if (!entered) unexecuted.push({ ...entry, reason: stopped });
      }
    }
    if (stopped) break;
  }
  unexecuted.push(...entries.slice(rows.length).map(entry => ({ ...entry, reason: stopped })));
  return { rows, stopped, unexecuted, observationsComplete: rows.length === entries.length && rows.every(row => row.runId) };
}

export async function runCompletionMatrix(probeRunId, l05RunId) {
  need(uuid.test(probeRunId) && uuid.test(l05RunId), 'MATRIX_PREREQUISITE_IDS');
  const read = async (id, file) => JSON.parse(await readFile(join(outputRoot, 'runs', id, file), 'utf8'));
  const probe = await read(probeRunId, 'summary.json'), l05 = await read(l05RunId, 'summary.json');
  need(probe.variantId === 'probe' && probe.passed && probe.probeGate?.passed && !matrixStopReason(probe), 'MATRIX_NATIVE_PROBE_REQUIRED');
  need(l05.variantId === 'L05' && l05.passed && l05.l05Chain?.structuralChainObserved && !matrixStopReason(l05), 'MATRIX_L05_REQUIRED');
  const fingerprints = async () => [...await collectCriticProductFingerprints(root), {
    file: 'scripts/run-task7-completion.mjs', sha256: sha256Bytes(await readFile(join(root, 'scripts/run-task7-completion.mjs'))),
  }];
  const productFingerprints = await fingerprints();
  for (const id of [probeRunId, l05RunId]) need(canonicalizeArtifact((await read(id, 'freeze.json')).productFingerprints) === canonicalizeArtifact(productFingerprints), 'MATRIX_PREREQUISITE_PRODUCT_CHANGED');
  const cases = CRITIC_VARIANTS.filter(v => v.layer !== 'D').map(v => v.variantId);
  need(cases.length === 12, 'MATRIX_CASE_COUNT');
  const entries = Array.from({ length: 3 }, (_, index) => cases.map(variantId => ({ variantId, repeat: index + 1 }))).flat().map((e, index) => ({ ordinal: index + 1, ...e }));
  const matrixId = randomUUID(), folder = join(outputRoot, 'matrices', matrixId);
  await mkdir(folder, { recursive: true });
  const plan = { schemaVersion: 2, scope: 'task7-completion-matrix-v2', matrixId,
    authorization: '2026-10-31 user takeover: 你来负责修改一下 直到task7完成',
    createdAt: new Date().toISOString(), probeRunId, l05RunId, productFingerprints,
    driverSha256: sha256Bytes(await readFile(fileURLToPath(import.meta.url))), entries,
    limits: { runs: 36, requestsPerRun: 16, totalMaximumGrantedRequests: 576, concurrentRuns: 1, concurrentRequests: 2, runTimeoutMs: 180000 },
    automaticRetry: false, retainRejectedModelAnswersAsFailedObservations: true, continueAfterSettledAnswerValidationFailure: true,
    stopOnInfrastructureOrProtocolFailure: true, stopOnUnconfirmedCleanup: true, stopOnAttackFirstDraftApproval: true,
    stopOnUnsupportedPairingApproval: ['L01', 'C02'], stopFile: join(folder, 'STOP_AFTER_CURRENT_RUN.json'),
    humanLabels: 0, qualityMetrics: 'NA', holdout: 'unopened', showcaseEligible: false };
  await save(join(folder, 'plan.json'), plan);
  const observations = await executeMatrixEntries(entries, {
    check: async () => {
      try { await readFile(plan.stopFile); throw Error('MATRIX_OPERATOR_STOP'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      need(canonicalizeArtifact(await fingerprints()) === canonicalizeArtifact(productFingerprints), 'MATRIX_PRODUCT_CHANGED');
    },
    start: async entry => {
      await appendFile(join(folder, 'journal.jsonl'), JSON.stringify({ type: 'entry.started', ...entry, at: new Date().toISOString() }) + '\n');
      console.log(JSON.stringify({ event: 'matrix.entry', matrixId, ...entry, total: entries.length }));
    },
    execute: async entry => { const summary = await runCompletionCase(entry.variantId);
      return { ...summary, summarySha256: sha256Bytes(await readFile(join(summary.folder, 'summary.json'))) }; },
    complete: row => appendFile(join(folder, 'journal.jsonl'), JSON.stringify({ type: 'entry.completed', ...row }) + '\n'),
  });
  const result = { matrixId, planFile: join(folder, 'plan.json'), ...observations,
    semanticAdjudication: 'pending_source_review', humanLabels: 0, qualityMetrics: 'NA' };
  await save(join(folder, 'summary.json'), result);
  console.log(JSON.stringify({ event: 'matrix.finished', matrixId, observed: result.rows.filter(r => r.runId).length, planned: 36, stopped: result.stopped, folder }));
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  need(process.argv.length === 6 && process.argv[2] === '--probe' && process.argv[4] === '--l05', 'MATRIX_USAGE');
  const result = await runCompletionMatrix(process.argv[3], process.argv[5]);
  if (result.stopped || !result.observationsComplete) process.exitCode = 1;
}
