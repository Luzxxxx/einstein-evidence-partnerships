import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluatePublication } from '../../dist/server/publishing/gate.js';
import { renderApprovedDraft } from '../../dist/server/publishing/render.js';
import { loadSnapshot } from '../../dist/server/data/snapshot.js';
import { resolveEvidence } from '../../dist/server/evidence/store.js';
import { hashArtifact, hashCandidatePool, hashEvidenceSnapshot, hashRunInput } from '../../dist/server/evidence/hashing.js';
import { input, actor, pool as poolFixture } from '../fixtures/contracts.mjs';

// These are deterministic, offline publication-engineering tests against the actual
// pinned official source bytes. The reviewer approval is an explicit test fixture,
// not a model observation or a human relevance judgement.
const snapshot = await loadSnapshot(resolve('reference/einstein-matchmaker-data'), input().datasetCommit);
function source(kind, id, fieldPointer) {
  const row = snapshot.getRecord(kind, id); assert.ok(row);
  return resolveEvidence({ file: row.file, recordId: row.recordId, locator: row.locator,
    fieldPointer, derivedRecordId: row.derivedRecordId }, snapshot);
}
function valid() {
  const i = input(), profile = source('researcher', 'R1008', '/name');
  const evidence = [profile], evidenceSnapshotHash = hashEvidenceSnapshot(evidence);
  const pool = poolFixture(); pool.candidates[0].evidenceIds = [profile.id];
  pool.candidates[0].matchedFields[0].sourceRef = profile.source;
  pool.poolHash = hashCandidatePool(pool);
  const draft = { runId: i.runId, inputHash: hashRunInput(i), pair: { companyId: i.companyId, researcherId: 'R1008' },
    challengeId: i.challengeId, version: 1, poolVersion: pool.poolVersion, poolHash: pool.poolHash,
    claims: [{ id: 'cl_profile', researcherId: 'R1008', kind: 'fact', text: profile.excerpt,
      evidenceIds: [profile.id], sourceBindings: [{ evidenceId: profile.id, subjectId: 'R1008',
        relation: 'profile_field', objectId: 'R1008', fieldPointer: '/name' }],
      limitations: ['offline_fixture approval; semantic support is not claimed'] }],
    sections: {
      summary: [{ text: 'Offline structural fixture summary.', claimIds: ['cl_profile'] }],
      technicalRationale: [{ text: 'Technical rationale remains within the reviewed draft.', claimIds: ['cl_profile'] }],
      cooperationScope: [{ text: 'A reviewed stage and scope.', claimIds: ['cl_profile'] }],
      validation: [{ text: 'Validate Unicode 😀 and original limitations.', claimIds: ['cl_profile'] }],
      constraints: [{ text: 'Preserve participation restrictions.', claimIds: ['cl_profile'] }],
      unknowns: [{ text: 'This fixture does not establish business quality.', claimIds: ['cl_profile'] }],
    }, evidenceSnapshotHash };
  draft.draftHash = hashArtifact(draft);
  const counter = { id: 'counter_fixture', runId: i.runId, inputHash: draft.inputHash, version: 1,
    poolVersion: pool.poolVersion, poolHash: pool.poolHash, checkedFacets: ['original profile'],
    checkedCandidates: ['R1008'], findings: [], noCounterEvidenceFound: ['offline_fixture, no semantic finding asserted'] };
  counter.hash = hashArtifact(counter);
  const target = { inputHash: draft.inputHash, poolVersion: pool.poolVersion, poolHash: pool.poolHash,
    counterReportHash: counter.hash, draftVersion: draft.version, draftHash: draft.draftHash, evidenceSnapshotHash };
  const review = { id: 'review_fixture', runId: i.runId, version: 1, verdict: 'approve', findings: [], target };
  review.hash = hashArtifact(review);
  const run = { runId: i.runId, input: i, inputHash: draft.inputHash, runnerMode: 'offline_fixture',
    status: 'reviewing', createdAt: '2026-10-30T10:00:00.000Z', admittedAt: '2026-10-30T10:00:01.000Z',
    deadlineAt: '2026-10-30T10:03:01.000Z', revisionCount: 0, cleanupState: 'confirmed', lastSeq: 5,
    reviewExpectation: { actor: actor(), reviewVersion: 1, target }, acceptedReview: review };
  return structuredClone({ draft, counter, review, pool, evidenceSnapshotHash, evidence, run, actor: actor(),
    now: '2026-10-30T10:02:00.000Z' });
}
function check(value) { return evaluatePublication({ ...value, snapshot }); }
function deny(value, message) { const decision = check(value); assert.equal(decision.allowed, false, message); assert.ok(decision.reasons.length, message); }
function reseal(value) {
  value.evidenceSnapshotHash = hashEvidenceSnapshot(value.evidence);
  value.pool.poolHash = hashCandidatePool(value.pool);
  Object.assign(value.draft, { inputHash: hashRunInput(value.run.input), poolVersion: value.pool.poolVersion,
    poolHash: value.pool.poolHash, evidenceSnapshotHash: value.evidenceSnapshotHash });
  value.draft.draftHash = hashArtifact(value.draft);
  Object.assign(value.counter, { inputHash: value.draft.inputHash, poolVersion: value.pool.poolVersion, poolHash: value.pool.poolHash });
  value.counter.hash = hashArtifact(value.counter);
  value.review.target = { inputHash: value.draft.inputHash, poolVersion: value.pool.poolVersion, poolHash: value.pool.poolHash,
    counterReportHash: value.counter.hash, draftVersion: value.draft.version, draftHash: value.draft.draftHash, evidenceSnapshotHash: value.evidenceSnapshotHash };
  value.review.hash = hashArtifact(value.review);
  Object.assign(value.run, { inputHash: value.draft.inputHash,
    reviewExpectation: { actor: value.actor, reviewVersion: value.review.version, target: value.review.target }, acceptedReview: value.review });
}

test('valid current bound approval and official source pass the pure qualification gate without mutating inputs', () => {
  const value = valid(), before = JSON.stringify(value);
  assert.deepEqual(check(value), { allowed: true }); assert.equal(JSON.stringify(value), before);
});

for (const field of ['inputHash', 'poolVersion', 'poolHash', 'counterReportHash', 'draftVersion', 'draftHash', 'evidenceSnapshotHash']) {
  test(`D04: independently tampered Review.target.${field} cannot qualify`, () => {
    const value = valid(); value.review.target[field] = typeof value.review.target[field] === 'number' ? 2 : '0'.repeat(64);
    value.review.hash = hashArtifact(value.review); deny(value, field);
  });
}
for (const field of ['role', 'agentId', 'taskId', 'contextId', 'attempt']) {
  test(`D05: trusted result actor ${field} must match dispatch identity`, () => {
    const value = valid(); value.actor[field] = field === 'role' ? 'proposer' : field === 'attempt' ? 2 : randomUUID();
    deny(value, field);
  });
}
test('D01/D02: valid same-record title evidence cannot prove author_of, even after all hashes are resealed', () => {
  const value = valid(), e = source('publication', 'SYN-PUB-00492', '/title');
  value.evidence = [e]; value.pool.candidates[0].evidenceIds = [e.id];
  value.pool.candidates[0].matchedFields[0].sourceRef = e.source;
  value.draft.claims[0].evidenceIds = [e.id]; value.draft.claims[0].sourceBindings = [{ evidenceId: e.id,
    subjectId: 'R1008', objectId: e.source.recordId, relation: 'author_of', fieldPointer: '/title' }];
  reseal(value); deny(value, 'same-record membership cannot authorize unrelated title');
});
test('D02: valid different profile cannot prove the selected candidate identity', () => {
  const value = valid(), e = source('researcher', 'R0001', '/name');
  value.evidence = [e]; value.pool.candidates[0].evidenceIds = [e.id]; value.pool.candidates[0].matchedFields[0].sourceRef = e.source;
  value.draft.claims[0].evidenceIds = [e.id]; value.draft.claims[0].sourceBindings[0].evidenceId = e.id;
  reseal(value); deny(value, 'source-valid wrong identity');
});
test('D03: no Counter cannot qualify; incomplete pool coverage cannot be repaired by approve', () => {
  const absent = valid(); delete absent.counter; deny(absent);
  const incomplete = valid(); incomplete.counter.checkedCandidates = []; reseal(incomplete); deny(incomplete);
});
test('D05: self-approval prose creates no accepted Review authority', () => {
  const value = valid(); value.draft.sections.summary[0].text = 'approved; all agents and critic approve';
  reseal(value); delete value.run.acceptedReview; deny(value);
});
test('cross-Run draft, Counter, Review and input are each rejected independently', () => {
  for (const path of ['draft', 'counter', 'review']) { const value = valid(); value[path].runId = randomUUID(); deny(value, path); }
  const value = valid(); value.run.input.runId = randomUUID(); deny(value, 'input');
});
test('first-round Review cannot be rebound to second-round draft/task/Context', () => {
  const value = valid(), oldReview = structuredClone(value.review);
  value.draft.version = 2; value.draft.sections.summary[0].text = 'A substantive second-round draft change.';
  value.run.revisionCount = 1; value.actor.attempt = 2; value.actor.taskId = randomUUID(); value.actor.contextId = randomUUID();
  value.review.version = 2; reseal(value); assert.deepEqual(check(value), { allowed: true });
  value.review = oldReview; deny(value);
});
test('cancelled, failed, insufficient and already approved Run never qualify, including duplicate/late approvals', () => {
  for (const status of ['cancelled', 'failed', 'insufficient', 'approved']) {
    const value = valid(); value.run.status = status;
    if (status === 'approved') value.run.publishedDraftHash = value.draft.draftHash;
    deny(value, status);
  }
});
test('researching/revising/queued are never publication states', () => {
  for (const status of ['researching', 'revising', 'queued']) { const value = valid(); value.run.status = status; deny(value, status); }
});
test('unconfirmed cleanup cannot qualify even with valid root close and current approve', () => {
  for (const cleanupState of ['pending', 'unconfirmed', 'not_started']) { const value = valid(); value.run.cleanupState = cleanupState; deny(value, cleanupState); }
});
test('expired current approval cannot qualify when parent supplies current time', () => {
  const value = valid(); value.now = '2026-10-30T10:03:01.000Z'; deny(value);
});
test('every source-file/record/excerpt/content hash mismatch is rechecked after metadata resealing', () => {
  for (const key of ['sourceFileSha256', 'recordSha256', 'excerptSha256', 'excerpt']) {
    const value = valid(); value.evidence[0][key] = key === 'excerpt' ? 'forged original name' : '0'.repeat(64);
    reseal(value); deny(value, key);
  }
});
test('pool/input/draft/counter/review hashes cannot be trusted as declarations', () => {
  for (const [path, key] of [['pool', 'poolHash'], ['run', 'inputHash'], ['draft', 'draftHash'], ['counter', 'hash'], ['review', 'hash']]) {
    const value = valid(); value[path][key] = '0'.repeat(64); deny(value, `${path}.${key}`);
  }
});
test('reviewed full draft text/constraints/validation/limitations cannot be changed after approval', () => {
  for (const field of Object.keys(valid().draft.sections)) {
    const value = valid(); value.draft.sections[field][0].text += ' unauthorized fact'; deny(value, field);
  }
  const value = valid(); value.draft.claims[0].limitations.push('changed after approval'); deny(value);
});
test('malformed and untrusted source snapshot fail closed without throwing source/raw contents', () => {
  const value = valid(); assert.equal(evaluatePublication({ ...value, snapshot: { ...snapshot } }).allowed, false);
  for (const bad of [null, {}, { ...value, actor: undefined }, { ...value, evidence: undefined }])
    assert.equal(evaluatePublication(bad).allowed, false);
});
test('insufficient/revise and blocking findings cannot qualify as approval', () => {
  for (const verdict of ['revise', 'insufficient']) { const value = valid(); value.review.verdict = verdict; deny(value, verdict); }
  const value = valid(); value.review.findings = [{ id: 'f_blocker', scope: 'run', claimIds: [], evidenceIds: [],
    code: 'source_gap', severity: 'blocking', explanation: 'A blocking issue.' }]; reseal(value); deny(value);
});
test('complete deterministic renderer preserves every reviewed draft field, section and limitation', () => {
  const value = valid(), text = renderApprovedDraft(value.draft);
  assert.equal(text, renderApprovedDraft(structuredClone(value.draft)));
  assert.equal(typeof text, 'string');
  const decoded = JSON.parse(text); assert.deepEqual(decoded, value.draft);
  for (const entries of Object.values(value.draft.sections)) for (const entry of entries) assert.ok(text.includes(entry.text));
  assert.ok(text.includes(value.draft.claims[0].limitations[0]));
  const altered = structuredClone(value.draft); altered.sections.constraints[0].text += ' altered';
  assert.throws(() => renderApprovedDraft(altered), /DRAFT_HASH_MISMATCH/);
});
