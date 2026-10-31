import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { loadSnapshot } from '../../dist/server/data/snapshot.js';
import { buildIndex, retrieveWithTrace } from '../../dist/server/retrieval/index.js';
import { createResearchTools } from '../../dist/server/runtime/tools.js';
import { createModelResearchView } from '../../dist/server/runtime/model-research-view.js';
import { ArtifactCoordinator, buildReviewSnapshot } from '../../dist/server/runtime/orchestrator.js';
import { hashEvidenceSnapshot, hashCandidatePool } from '../../dist/server/evidence/hashing.js';
import { resolveEvidence } from '../../dist/server/evidence/store.js';
import { sourceBindingForEvidence } from '../../dist/server/evidence/source-binding.js';
import { input as fixtureInput } from '../fixtures/contracts.mjs';

let input, research, view;
test.before(async () => {
  input = { ...fixtureInput(), runId: randomUUID(), companyId: 'C001', challengeId: 'C001-CH1', mode: 'research' };
  const snapshot = await loadSnapshot(resolve('reference/einstein-matchmaker-data'), input.datasetCommit);
  research = { snapshot, ...retrieveWithTrace(input, buildIndex(snapshot)) };
  view = createModelResearchView(research.evidence, research.snapshot);
});
const bytes = value => Buffer.byteLength(JSON.stringify(value));

test('Run-local short references are deterministic, unique and resolve only exact captured Evidence', () => {
  assert.equal(new Set(view.aliases).size, research.evidence.length);
  assert.deepEqual(createModelResearchView([...research.evidence].reverse(), research.snapshot).pool(research.pool), view.pool(research.pool));
  for (const e of research.evidence) {
    const model = view.evidence(e);
    assert.match(model.id, /^E\d{3}$/);
    assert.equal(view.resolveEvidenceId(model.id), e.id);
    assert.equal(view.resolveEvidenceId(e.id), e.id);
  }
  assert.equal(view.resolveEvidenceId('E999'), undefined);
  assert.equal(view.resolveEvidenceId('e001'), undefined);
});

test('compact native tools preserve complete source excerpts, profiles, restrictions and verified snapshot identities', async () => {
  const captured = { evidence: hashEvidenceSnapshot(research.evidence), pool: hashCandidatePool(research.pool) };
  const base = { ...research, input, signal: new AbortController().signal };
  const complete = createResearchTools(base), compact = createResearchTools({ ...base, modelView: view });
  for (const candidate of research.pool.candidates) {
    const args = { runId: input.runId, researcherId: candidate.researcherId };
    const full = await complete[1].invoke(args), small = await compact[1].invoke(args);
    assert.equal(small.ok, true); assert.equal(small.poolHash, full.poolHash); assert.equal(small.evidenceSnapshotHash, full.evidenceSnapshotHash);
    assert.deepEqual(small.data.profile, full.data.profile);
    assert.deepEqual(small.data.restrictions.map(r => ({ ...r, evidenceId: r.evidenceId ? view.resolveEvidenceId(r.evidenceId) : null })), full.data.restrictions);
    for (const e of small.data.evidence) {
      const original = full.data.evidence.find(f => f.id === view.resolveEvidenceId(e.id));
      assert.ok(original); assert.equal(e.excerpt, original.excerpt); assert.deepEqual(e.source, original.source);
    }
    assert.ok(bytes(small) < bytes(full) * 0.7, 'remove repeated hashes/reference bookkeeping, not source facts');
  }
  const ref = view.aliases[0], e = await compact[2].invoke({ runId: input.runId, evidenceId: ref });
  assert.equal(e.ok, true); assert.equal(e.data.evidence.id, ref);
  const original = research.evidence.find(e => e.id === view.resolveEvidenceId(ref));
  assert.equal(e.data.evidence.excerpt, original.excerpt);
  assert.equal((await compact[2].invoke({ runId: input.runId, evidenceId: 'E999' })).ok, false);
  assert.equal(hashEvidenceSnapshot(research.evidence), captured.evidence);
  assert.equal(hashCandidatePool(research.pool), captured.pool);
  const def = t => ({ ...t, invoke: undefined });
  console.log(JSON.stringify({ kind: 'model_view_bytes', poolBefore: bytes(research.pool), poolAfter: bytes(view.pool(research.pool)),
    toolsBefore: bytes(complete.map(def)), toolsAfter: bytes(compact.map(def)) }));
});

test('short citations expand before original coordinator validation and never rewrite source or narrative text', () => {
  const coordinator = new ArtifactCoordinator({ ...research, input });
  const candidate = research.pool.candidates[0];
  const evidence = research.evidence.find(e => candidate.restrictionRefs.includes(e.id) && e.source.fieldPointer === '/notes');
  const ref = view.evidence(evidence).id;
  const body = { researcherId: candidate.researcherId, claims: [{ id: 'claim_fixture', researcherId: candidate.researcherId,
    kind: 'fact', text: `offline_fixture literal ${ref}`, evidenceIds: [ref], sourceBindings: [{ evidenceId: ref, subjectId: candidate.researcherId,
      relation: 'profile_field', objectId: candidate.researcherId, fieldPointer: '/notes' }], limitations: ['offline_fixture'] }],
    sections: { summary: [{ text: 'offline_fixture', claimIds: ['claim_fixture'] }] } };
  const frozen = JSON.stringify(body), expanded = view.expandAnswer('proposer', body);
  assert.equal(JSON.stringify(body), frozen);
  assert.equal(expanded.claims[0].text, body.claims[0].text);
  assert.deepEqual(expanded.claims[0].evidenceIds, [evidence.id]);
  assert.equal(expanded.claims[0].sourceBindings[0].evidenceId, evidence.id);
  const actor = role => ({ runId: input.runId, role, agentId: randomUUID(), taskId: randomUUID(), contextId: randomUUID(), loopId: randomUUID(), attempt: 1 });
  const proposer = actor('proposer'); coordinator.bind(proposer); coordinator.accept('proposer', expanded, proposer);
  const counter = actor('counter-evidence'); coordinator.bind(counter);
  coordinator.accept('counter-evidence', view.expandAnswer('counter-evidence', { checkedFacets: ['offline_fixture'],
    checkedCandidates: research.pool.candidates.map(c => c.researcherId), noCounterEvidenceFound: [],
    findings: [{ id: 'finding_fixture', scope: 'run', claimIds: [], evidenceIds: [ref], code: 'FIXTURE', severity: 'advisory', explanation: 'offline_fixture' }] }), counter);
  const review = buildReviewSnapshot({ ...research, input, draft: coordinator.draft, counter: coordinator.counter });
  const projected = view.reviewSnapshot(review);
  assert.deepEqual(projected.target, review.target);
  assert.deepEqual(projected.sources.map(s => s.value), review.sources.map(s => s.value));
  assert.deepEqual(projected.draft.claims[0].evidenceIds, [ref]);
  assert.deepEqual(projected.counter.findings[0].evidenceIds, [ref]);
  assert.deepEqual(view.expandAnswer('critic', { verdict: 'approve', findings: [{ evidenceIds: [ref], explanation: `literal ${ref}` }] }),
    { verdict: 'approve', findings: [{ evidenceIds: [evidence.id], explanation: `literal ${ref}` }] });
});

test('actual live one-character Evidence typo remains rejected; a short reference resolves without fuzzy correction', () => {
  const bad = 'ev-e391df1cbba3e26f85f1972ae1080378e2ff7ad7476950a0d8d50ca4ad3abab';
  const good = 'ev-e391df1cbba3e26f85f1972ae1080378e2ff7ad7476950a0d8d50dca4ad3abab';
  const original = research.evidence.find(e => e.id === good); assert.ok(original);
  assert.equal(view.resolveEvidenceId(bad), undefined);
  assert.throws(() => view.expandAnswer('counter-evidence', { findings: [{ evidenceIds: [bad] }] }), /MODEL_EVIDENCE_REFERENCE_UNKNOWN/);
  assert.throws(() => view.expandAnswer('proposer', { claims: [{ evidenceIds: ['E999'], sourceBindings: [] }] }), /MODEL_EVIDENCE_REFERENCE_UNKNOWN/);
  assert.deepEqual(view.expandAnswer('counter-evidence', { findings: [{ evidenceIds: [view.evidence(original).id] }] }), { findings: [{ evidenceIds: [good] }] });
});

test('natural proposals derive missing source coordinates from cited registered Evidence, without changing explicit bindings', () => {
  // Minimal reproduction of the actual natural Proposer K19 failure: three
  // correct references, but the middle reference has no handwritten binding.
  const body = { researcherId: 'R1008', claims: [{ id: 'K19', researcherId: 'R1008', kind: 'proposal', text: 'offline_fixture bounded pilot',
    evidenceIds: ['E087', 'E069', 'E137'], sourceBindings: [
      { evidenceId: 'E087', subjectId: 'R1008', relation: 'profile_field', objectId: 'R1008', fieldPointer: '/keywords' },
      { evidenceId: 'E137', subjectId: 'R1008', relation: 'profile_field', objectId: 'R1008', fieldPointer: '/bio' },
    ], limitations: ['offline_fixture; no semantic approval'] }], sections: { summary: [{ text: 'offline_fixture', claimIds: ['K19'] }] } };
  const repaired = view.expandAnswer('proposer', body);
  assert.equal(repaired.claims[0].sourceBindings.length, 3);
  const added = repaired.claims[0].sourceBindings.find(b => b.evidenceId === view.resolveEvidenceId('E069'));
  const original = research.evidence.find(e => e.id === added.evidenceId);
  assert.equal(added.fieldPointer, original.source.fieldPointer);
  assert.equal(added.objectId, original.source.recordId);
  assert.deepEqual(repaired.claims[0].sourceBindings[0], { ...body.claims[0].sourceBindings[0], evidenceId: view.resolveEvidenceId('E087') });
  const withoutBindings = structuredClone(body); delete withoutBindings.claims[0].sourceBindings;
  assert.equal(view.expandAnswer('proposer', withoutBindings).claims[0].sourceBindings.length, 3);
  const bad = structuredClone(body); bad.claims[0].sourceBindings[0].fieldPointer = '/unrelated_field';
  assert.equal(view.expandAnswer('proposer', bad).claims[0].sourceBindings[0].fieldPointer, '/unrelated_field', 'explicit wrong declarations are not silently rewritten');
  const accept = value => {
    const coordinator = new ArtifactCoordinator({ ...research, input });
    const actor = { runId: input.runId, role: 'proposer', agentId: randomUUID(), taskId: randomUUID(), contextId: randomUUID(), loopId: randomUUID(), attempt: 1 };
    coordinator.bind(actor); return coordinator.accept('proposer', value, actor);
  };
  assert.equal(accept(repaired).kind, 'proposal_draft');
  assert.throws(() => accept(view.expandAnswer('proposer', bad)), /CLAIM_SOURCE_BINDING_FAILED/);
});

test('duplicate citation references normalize as sets without deleting different evidence or duplicate claim records', () => {
  const [a, b] = view.aliases;
  const body = { verdict: 'revise', findings: [{ claimIds: ['K1', 'K1', 'K2'], evidenceIds: [a, a, b, view.resolveEvidenceId(a)] }] };
  const normalized = view.expandAnswer('critic', body);
  assert.deepEqual(normalized.findings[0].evidenceIds, [view.resolveEvidenceId(a), view.resolveEvidenceId(b)]);
  assert.deepEqual(normalized.findings[0].claimIds, ['K1', 'K2']);
  const draft = { claims: [{ id: 'K1', evidenceIds: [a, a] }, { id: 'K1', evidenceIds: [b] }],
    sections: { summary: [{ text: 'offline_fixture', claimIds: ['K1', 'K1'] }] } };
  const result = view.expandAnswer('proposer', draft);
  assert.equal(result.claims.length, 2, 'distinct claim records with colliding IDs must still fail the original contract');
  assert.deepEqual(result.sections.summary[0].claimIds, ['K1']);
});

test('derived source coordinates distinguish explicit authorship from context and another researcher', () => {
  const row = research.evidence.filter(e => e.source.file === 'data/publications.jsonl')
    .map(e => research.snapshot.getRecord('publication', e.source.recordId))
    .find(r => r.record.authors.some(a => a.researcher_id));
  assert.ok(row);
  const slot = row.record.authors.findIndex(a => a.researcher_id);
  const researcherId = row.record.authors[slot].researcher_id;
  assert.ok(slot >= 0);
  const evidence = fieldPointer => resolveEvidence({ file: row.file, recordId: row.recordId, locator: row.locator,
    derivedRecordId: row.derivedRecordId, fieldPointer }, research.snapshot);
  for (const path of ['/authors', `/authors/${slot}`, `/authors/${slot}/researcher_id`]) {
    assert.equal(sourceBindingForEvidence(evidence(path), researcherId, research.snapshot).relation, 'author_of');
  }
  for (const path of ['/abstract', '/title']) {
    const binding = sourceBindingForEvidence(evidence(path), researcherId, research.snapshot);
    assert.equal(binding.relation, 'source_field');
    assert.equal(binding.subjectId, row.recordId);
    assert.equal(binding.objectId, row.recordId);
  }
  const absent = ['R0001', 'R0002', 'R0003'].find(id => !row.record.authors.some(a => a.researcher_id === id));
  assert.equal(sourceBindingForEvidence(evidence('/authors'), absent, research.snapshot).relation, 'source_field');
});
