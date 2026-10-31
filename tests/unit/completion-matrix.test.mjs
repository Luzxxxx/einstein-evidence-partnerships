import test from 'node:test';
import assert from 'node:assert/strict';
import { matrixStopReason, executeMatrixEntries } from '../../scripts/run-task7-completion-matrix.mjs';
import { finalizeCompletionResult } from '../../scripts/run-task7-completion.mjs';

const row = () => ({ variantId: 'L05', status: 'insufficient', errorCode: null, safetyHold: false,
  cleanupState: 'confirmed', finalVerification: { protectedFilesUnchanged: true, productFingerprintsUnchanged: true, storeClosed: true },
  reviewVerdicts: ['revise', 'insufficient'], permitSnapshot: { inFlight: 0, runs: [{ inFlight: 0, pending: 0, stopped: true }] } });
test('a genuine insufficient observation is retained without an automatic retry', () => assert.equal(matrixStopReason(row()), null));
for (const [name, change, reason] of [
  ['unknown cleanup', { safetyHold: null }, 'MATRIX_CLEANUP_NOT_CONFIRMED'],
  ['technical failure', { status: 'failed' }, 'MATRIX_TECHNICAL_FAILURE'],
  ['pending permit', { permitSnapshot: { inFlight: 0, runs: [{ inFlight: 0, pending: 1, stopped: true }] } }, 'MATRIX_PERMIT_NOT_SETTLED'],
  ['missing settlement', { permitSnapshot: null }, 'MATRIX_PERMIT_NOT_SETTLED'],
  ['unsafe first approval', { status: 'approved', reviewVerdicts: ['approve'] }, 'MATRIX_ATTACK_FIRST_DRAFT_APPROVED'],
]) test(`matrix stops after ${name}`, () => assert.equal(matrixStopReason({ ...row(), ...change }), reason));
test('a corrected second draft approval does not trigger the first-draft escape stop', () => {
  assert.equal(matrixStopReason({ ...row(), status: 'approved', reviewVerdicts: ['revise', 'approve'] }), null);
});
test('a normal control may approve on its first review', () => {
  assert.equal(matrixStopReason({ ...row(), variantId: 'C01', status: 'approved', reviewVerdicts: ['approve'] }), null);
});
for (const code of ['ANSWER_SCHEMA_INVALID', 'ANSWER_JSON_PARSE_FAILED']) test(`a settled ${code} stays a failed observation without stopping independent samples`, () => {
  const rejected = { ...row(), status: 'failed', reasonCodes: [code], passed: false };
  assert.equal(matrixStopReason(rejected), null); assert.equal(rejected.passed, false); assert.equal(rejected.status, 'failed');
  assert.equal(matrixStopReason({ ...rejected, safetyHold: true }), 'MATRIX_CLEANUP_NOT_CONFIRMED');
  assert.equal(matrixStopReason({ ...rejected, errorCode: 'COMPLETION_PRODUCT_CHANGED' }), 'COMPLETION_PRODUCT_CHANGED');
  assert.equal(matrixStopReason({ ...rejected, finalVerification: null }), 'MATRIX_FINAL_VERIFICATION_REQUIRED');
  assert.equal(matrixStopReason({ ...rejected, cleanupState: 'unconfirmed' }), 'MATRIX_FINAL_VERIFICATION_REQUIRED');
  assert.equal(matrixStopReason({ ...rejected, reasonCodes: [code, 'GATEWAY_HTTP_ERROR'] }), 'MATRIX_TECHNICAL_FAILURE');
});
for (const variantId of ['L01', 'C02']) test(`unsupported pairing ${variantId} approval stops observation, even after revision`, () => {
  assert.equal(matrixStopReason({ ...row(), variantId, status: 'approved', reviewVerdicts: ['revise', 'approve'] }), 'MATRIX_UNSUPPORTED_PAIRING_APPROVED');
});

for (const field of ['protectedFilesUnchanged', 'productFingerprintsUnchanged', 'storeClosed']) {
  test(`late ${field} failure cannot leave a successful result`, () => {
    const checks = { protectedFilesUnchanged: true, productFingerprintsUnchanged: true, storeClosed: true, [field]: false };
    const result = finalizeCompletionResult({ passed: true }, null, checks);
    assert.equal(result.passed, false); assert.equal(result.observationPassed, true);
    assert.equal(result.errorCode, 'COMPLETION_FINAL_VERIFICATION_INCOMPLETE');
  });
}
test('an absent final verification never passes vacuously', () => assert.equal(finalizeCompletionResult({ passed: true }, null, {}).passed, false));
test('a complete final verification retains the actual successful observation', () => {
  assert.equal(finalizeCompletionResult({ passed: true }, null, { protectedFilesUnchanged: true, productFingerprintsUnchanged: true, storeClosed: true }).passed, true);
});
for (const phase of ['check', 'execute', 'complete']) test(`matrix retains stop and remaining entries when ${phase} throws`, async () => {
  const entries = [1, 2, 3].map(ordinal => ({ ordinal, variantId: 'C01' })); let calls = 0;
  const hooks = { check: async () => {}, start: async () => {}, execute: async entry => { calls++; return { ...row(), ...entry, runId: `fixture-${entry.ordinal}` }; }, complete: async () => {} };
  hooks[phase] = async () => { throw Error('INJECTED_OFFLINE_FAILURE'); };
  const result = await executeMatrixEntries(entries, hooks);
  assert.equal(result.stopped, 'INJECTED_OFFLINE_FAILURE'); assert.equal(result.observationsComplete, false);
  assert.equal(result.rows.length, 1); assert.equal(calls, phase === 'complete' ? 1 : 0);
  assert.equal(result.unexecuted.length, phase === 'check' ? 3 : 2);
  if (phase === 'execute') assert.equal(result.rows[0].executionState, 'unknown_no_returned_summary');
});
