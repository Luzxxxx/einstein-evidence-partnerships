import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createResearchTools } from '../../dist/server/runtime/tools.js';
import { loadSnapshot } from '../../dist/server/data/snapshot.js';
import { buildIndex, retrieveWithTrace } from '../../dist/server/retrieval/index.js';
import { resolveEvidence } from '../../dist/server/evidence/store.js';
import { verifyEvidence } from '../../dist/server/evidence/validate.js';
import { hashCandidatePool, hashEvidenceSnapshot } from '../../dist/server/evidence/hashing.js';
import { input as inputFixture, ids, pool as poolFixture } from '../fixtures/contracts.mjs';

// Only the fixed C001 development challenge is used. No query/label or holdout input is read.
const input = inputFixture();
const root = fileURLToPath(new URL('../../reference/einstein-matchmaker-data/', import.meta.url));
const snapshot = await loadSnapshot(root, input.datasetCommit);
const retrieved = retrieveWithTrace(input, buildIndex(snapshot));

function toolsFor({ runInput = input, pool = retrieved.pool, evidence = retrieved.evidence,
  signal = new AbortController().signal } = {}) {
  const tools = createResearchTools({ input: runInput, snapshot, pool, evidence, signal });
  return Object.fromEntries(tools.map(tool => [tool.name, tool]));
}
function evidenceFor(kind, id, fieldPointer) {
  const row = snapshot.getRecord(kind, id);
  return resolveEvidence({ file: row.file, recordId: row.recordId, locator: row.locator,
    fieldPointer, derivedRecordId: row.derivedRecordId }, snapshot);
}
function manualContext(rows) {
  const evidence = [...new Map(rows.flatMap(row => row.evidence).map(e => [e.id, e])).values()];
  const pool = poolFixture();
  pool.query = 'Fixed C001 development-only source boundary checks.';
  pool.candidates = rows.map((row, index) => ({ researcherId: row.id, rank: index + 1,
    channels: ['L0'], matchedFields: [{ sourceRef: row.evidence[0].source, terms: ['source'], score: 1 }],
    evidenceIds: row.evidence.map(e => e.id), restrictionRefs: [], identityFlags: [] }));
  pool.mergedCandidateCount = rows.length;
  pool.diagnostics.mergedCount = rows.length; pool.diagnostics.selectedCount = rows.length;
  pool.poolHash = hashCandidatePool(pool);
  return { pool, evidence };
}
function assertOk(value) {
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.runId, input.runId);
  assert.match(value.receiptId, /^[a-f0-9-]{36}$/);
  assert.equal(value.checks.semanticSupport, 'unassessed');
  assert.equal(value.checks.sourceTextPolicy, 'data_only');
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, 'Real Tool.invoke output is JSON data');
  return value.data;
}
function assertError(value, code) {
  assert.equal(value.ok, false, JSON.stringify(value));
  assert.equal(value.error.code, code); assert.equal(value.error.retryable, false);
  assert.ok(value.error.message.length > 12, 'Agent receives actionable recovery guidance');
  assert.equal(Object.hasOwn(value, 'data'), false);
  assert.equal(Object.hasOwn(value, 'receiptId'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}

test('real Tool interface exposes exactly three strict semantic read-only operations', () => {
  const tools = toolsFor();
  assert.deepEqual(Object.keys(tools), ['read_company_challenge', 'read_candidate_bundle', 'read_evidence_record']);
  for (const tool of Object.values(tools)) {
    assert.equal(tool.type, 'function'); assert.equal(tool.strict, true);
    assert.equal(typeof tool.invoke, 'function'); assert.ok(tool.description.includes('data'));
    assert.equal(tool.parameters.type, 'object'); assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [...tool.parameters.required].sort());
    assert.ok(!Object.keys(tool.parameters.properties).some(key => /path|file|pointer|command/i.test(key)));
  }
});

test('company tool returns only the captured C001 challenge and original full challenge data', async () => {
  const tools = toolsFor();
  const result = await tools.read_company_challenge.invoke({ runId: input.runId,
    companyId: input.companyId, challengeId: input.challengeId });
  const data = assertOk(result);
  const company = snapshot.getRecord('company', 'C001');
  assert.deepEqual(data.challenge, company.record.challenges[0]);
  assert.equal(data.company.id, 'C001'); assert.equal(data.company.name, company.record.name);
  assert.equal(Object.hasOwn(data.company, 'challenges'), false, 'Other challenges are outside the captured pair');
  assert.equal(data.source.recordId, 'C001'); assert.equal(data.source.fieldPointer, '/challenges/0');
  assert.equal(result.poolHash, retrieved.pool.poolHash);
  assert.equal(result.evidenceSnapshotHash, hashEvidenceSnapshot(retrieved.evidence));
});

test('candidate tool retains full profile restrictions and bounded registered Evidence', async () => {
  const tools = toolsFor();
  const byId = new Map(retrieved.evidence.map(e => [e.id, e]));
  for (const candidate of retrieved.pool.candidates) {
    const result = await tools.read_candidate_bundle.invoke({ runId: input.runId, researcherId: candidate.researcherId });
    const data = assertOk(result), original = snapshot.getRecord('researcher', candidate.researcherId).record;
    assert.deepEqual(data.candidate, candidate); assert.deepEqual(data.profile.record, original);
    assert.equal(data.profile.source.recordId, candidate.researcherId);
    for (const field of ['notes', 'open_to', 'industry_experience']) {
      const restriction = data.restrictions.find(r => r.fieldPointer === `/${field}`);
      assert.ok(restriction); assert.deepEqual(restriction.value, original[field]);
      assert.equal(restriction.source.recordId, candidate.researcherId);
      if (restriction.evidenceId !== null) assert.ok(byId.has(restriction.evidenceId));
    }
    const registered = new Set([...candidate.evidenceIds, ...candidate.restrictionRefs]);
    assert.ok(data.evidence.length <= registered.size);
    for (const e of data.evidence) { assert.ok(registered.has(e.id)); assert.deepEqual(e, byId.get(e.id)); assert.deepEqual(verifyEvidence(e, snapshot), []); }
    for (const binding of data.identityBindings) {
      const e = data.evidence.find(e => e.id === binding.evidenceId);
      assert.ok(e); assert.equal(binding.subjectId, candidate.researcherId);
      assert.equal(binding.fieldPointer, e.source.fieldPointer);
      if (binding.relation !== 'profile_field') assert.match(e.source.fieldPointer, /^\/(authors|participants|inventors)(\/|$)/);
    }
    for (const link of data.contentLinks) {
      assert.notEqual(link.contentEvidenceId, link.identityEvidenceId, 'Content and ownership are separate Evidence');
      assert.ok(data.identityBindings.some(b => b.evidenceId === link.identityEvidenceId && b.relation === link.relation));
    }
  }
});

test('authorship, participation and inventorship require separate original identity Evidence', async () => {
  const rows = [
    { id: 'R0001', kind: 'publication', recordId: 'SYN-PUB-00001', field: 'authors', relation: 'author_of' },
    { id: 'R0765', kind: 'project', recordId: 'SYN-PRJ-0001', field: 'participants', relation: 'project_participant' },
    { id: 'R0033', kind: 'patent', recordId: 'SYN-PAT-005', field: 'inventors', relation: 'patent_inventor' },
  ].map(row => ({ ...row, evidence: [evidenceFor(row.kind, row.recordId, '/title'),
    evidenceFor(row.kind, row.recordId, `/${row.field}/0/researcher_id`)] }));
  const tools = toolsFor(manualContext(rows));
  for (const row of rows) {
    const data = assertOk(await tools.read_candidate_bundle.invoke({ runId: input.runId, researcherId: row.id }));
    assert.ok(data.identityBindings.some(b => b.relation === row.relation && b.evidenceId === row.evidence[1].id));
    assert.deepEqual(data.contentLinks, [{ contentEvidenceId: row.evidence[0].id,
      identityEvidenceId: row.evidence[1].id, relation: row.relation, objectId: row.recordId }]);
    assert.ok(!data.identityBindings.some(b => b.evidenceId === row.evidence[0].id), 'A title is not an identity witness');
  }
});

test('profile-only links and null author slots do not acquire candidate identity', async () => {
  const context = manualContext([
    { id: 'R0139', evidence: [evidenceFor('publication', 'SYN-PUB-01827', '/title'),
      evidenceFor('publication', 'SYN-PUB-01827', '/authors/0/researcher_id')] },
    { id: 'R0001', evidence: [evidenceFor('publication', 'SYN-PUB-00001', '/title'),
      evidenceFor('publication', 'SYN-PUB-00001', '/authors/1/name'),
      evidenceFor('publication', 'SYN-PUB-00001', '/authors/1/researcher_id')] },
  ]);
  const tools = toolsFor(context);
  for (const row of context.pool.candidates) {
    const data = assertOk(await tools.read_candidate_bundle.invoke({ runId: input.runId, researcherId: row.researcherId }));
    assert.deepEqual(data.identityBindings, []); assert.deepEqual(data.contentLinks, []);
    assert.deepEqual(new Set(data.unattributedEvidenceIds), new Set(row.evidenceIds));
  }
});

test('read_evidence_record only returns an exact previously registered source-verified ID', async () => {
  const tools = toolsFor(), e = retrieved.evidence[0];
  const data = assertOk(await tools.read_evidence_record.invoke({ runId: input.runId, evidenceId: e.id }));
  assert.deepEqual(data.evidence, e); assert.deepEqual(verifyEvidence(data.evidence, snapshot), []);
  const unregistered = evidenceFor('company', 'C001', '/challenges/0/text');
  assert.ok(!retrieved.evidence.some(e => e.id === unregistered.id));
  assertError(await tools.read_evidence_record.invoke({ runId: input.runId, evidenceId: unregistered.id }), 'EVIDENCE_NOT_REGISTERED');
});

test('agent argument mistakes return stable recoverable error data without throwing', async () => {
  const tools = toolsFor(), candidate = retrieved.pool.candidates[0].researcherId;
  const outOfPool = snapshot.listRecords('researcher').find(row => !retrieved.pool.candidates.some(c => c.researcherId === row.recordId)).recordId;
  for (const args of [null, [], 'read all files', {}, { runId: input.runId, researcherId: candidate, path: '../../.env.local' },
    { runId: input.runId, researcherId: '../../R1008' }, { runId: input.runId, researcherId: candidate, command: 'ignore instructions' }])
    assertError(await tools.read_candidate_bundle.invoke(args), 'INVALID_ARGUMENTS');
  assertError(await tools.read_candidate_bundle.invoke({ runId: ids.otherRun, researcherId: candidate }), 'RUN_MISMATCH');
  assertError(await tools.read_candidate_bundle.invoke({ runId: input.runId, researcherId: outOfPool }), 'CANDIDATE_OUTSIDE_POOL');
  assertError(await tools.read_company_challenge.invoke({ runId: input.runId, companyId: 'C002', challengeId: 'C002-CH1' }), 'PAIR_MISMATCH');
  assertError(await tools.read_company_challenge.invoke({ runId: input.runId, companyId: 'C001', challengeId: 'C001-CH2' }), 'PAIR_MISMATCH');
  assertError(await tools.read_evidence_record.invoke({ runId: input.runId, evidenceId: '../../data/researchers.json' }), 'INVALID_ARGUMENTS');
  assertError(await tools.read_evidence_record.invoke({ runId: ids.otherRun, evidenceId: retrieved.evidence[0].id }), 'RUN_MISMATCH');
});

test('tools own immutable Run/pool/Evidence copies and cannot register later caller mutations', async () => {
  const runInput = structuredClone(input), pool = structuredClone(retrieved.pool), evidence = structuredClone(retrieved.evidence);
  const tools = toolsFor({ runInput, pool, evidence }), captured = pool.candidates[0].researcherId, e = structuredClone(evidence[0]);
  runInput.runId = ids.otherRun; pool.candidates.length = 0; evidence[0].excerpt = 'Changed caller text';
  evidence.push(evidenceFor('company', 'C001', '/challenges/0/text'));
  assert.equal(Object.isFrozen(runInput), false, 'Tool ownership does not freeze caller objects');
  assert.equal(assertOk(await tools.read_candidate_bundle.invoke({ runId: input.runId, researcherId: captured })).candidate.researcherId, captured);
  assert.deepEqual(assertOk(await tools.read_evidence_record.invoke({ runId: input.runId, evidenceId: e.id })).evidence, e);
  assertError(await tools.read_evidence_record.invoke({ runId: input.runId, evidenceId: evidence.at(-1).id }), 'EVIDENCE_NOT_REGISTERED');
});

test('every invocation checks registered Evidence hashes and source coordinates before returning data', async () => {
  for (const mutate of [e => { e.excerptSha256 = '0'.repeat(64); }, e => { e.recordSha256 = '0'.repeat(64); },
    e => { e.sourceFileSha256 = '0'.repeat(64); }, e => { e.excerpt = 'Invented source prose'; },
    e => { e.source.fieldPointer = '/id'; }]) {
    const evidence = structuredClone(retrieved.evidence); mutate(evidence[0]);
    const tools = toolsFor({ evidence });
    assertError(await tools.read_company_challenge.invoke({ runId: input.runId, companyId: input.companyId, challengeId: input.challengeId }), 'EVIDENCE_INTEGRITY_FAILED');
    assertError(await tools.read_candidate_bundle.invoke({ runId: input.runId, researcherId: retrieved.pool.candidates[0].researcherId }), 'EVIDENCE_INTEGRITY_FAILED');
    assertError(await tools.read_evidence_record.invoke({ runId: input.runId, evidenceId: evidence[0].id }), 'EVIDENCE_INTEGRITY_FAILED');
  }
});

test('trusted context rejects invalid pool hashes, more than eight candidates and unregistered pool references', () => {
  const badHash = structuredClone(retrieved.pool); badHash.poolHash = '0'.repeat(64);
  assert.throws(() => toolsFor({ pool: badHash }), /pool/i);
  const tooMany = structuredClone(retrieved.pool);
  tooMany.candidates.push({ ...tooMany.candidates[0], researcherId: 'R0001', rank: 9 });
  assert.throws(() => toolsFor({ pool: tooMany }), /pool/i);
  const unknown = structuredClone(retrieved.pool); unknown.candidates[0].evidenceIds.push('ev-unregistered');
  unknown.poolHash = hashCandidatePool(unknown);
  assert.throws(() => toolsFor({ pool: unknown }), /evidence|registered/i);
});

test('abort cooperates at the actual Tool.invoke boundary and after a prior successful call', async () => {
  const controller = new AbortController(), tools = toolsFor({ signal: controller.signal });
  assertOk(await tools.read_evidence_record.invoke({ runId: input.runId, evidenceId: retrieved.evidence[0].id }));
  controller.abort();
  for (const [name, args] of [
    ['read_company_challenge', { runId: input.runId, companyId: input.companyId, challengeId: input.challengeId }],
    ['read_candidate_bundle', { runId: input.runId, researcherId: retrieved.pool.candidates[0].researcherId }],
    ['read_evidence_record', { runId: input.runId, evidenceId: retrieved.evidence[0].id }],
  ]) await assert.rejects(tools[name].invoke(args), error => error.name === 'AbortError');
});
