import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../../dist/server/contracts/domain.js';
import { input, draft, review, counter, pool, evidence, finding, h, ids } from '../fixtures/contracts.mjs';
const bundle = () => ({ input: input(), inputHash: h(1), pool: pool(), draft: draft(),
  counter: counter(), review: review(), evidence: [evidence()], evidenceSnapshotHash: h(5) });
const reject = mutate => { const v = bundle(); mutate(v); assert.equal(c.ArtifactBundleSchema.safeParse(v).success, false); };

test('joined artifact contract binds identities, snapshots and every cited ID', () => {
  c.ArtifactBundleSchema.parse(bundle());
  for (const mutate of [v => { v.input.runId = ids.otherRun; }, v => { v.inputHash = h(0); },
    v => { v.pool.poolHash = h(0); }, v => { v.pool.poolVersion = 2; },
    v => { v.evidenceSnapshotHash = h(0); }, v => { v.pool.candidates[0].researcherId = 'R0001'; },
    v => { v.counter.checkedCandidates = ['R0001']; }, v => { v.evidence = []; },
    v => { v.evidence.push(evidence()); }, v => { v.evidence[0].id = 'other'; },
    v => { v.draft.claims[0].sourceBindings[0].fieldPointer = '/title'; },
    v => { v.draft.claims[0].sourceBindings[0].subjectId = 'SYN-PUB-00001'; },
    v => { v.pool.candidates[0].restrictionRefs = ['missing']; },
    v => { v.counter.findings = [{ ...finding(), claimIds: ['missing'] }]; },
    v => { v.review.findings = [{ ...finding(), severity: 'advisory', evidenceIds: ['missing'] }]; },
  ]) reject(mutate);
});

test('structural source bindings cannot declare the wrong record relation', () => {
  const v = bundle();
  v.draft.claims[0].sourceBindings = [{ evidenceId: 'e-1', subjectId: 'R1008', relation: 'author_of',
    objectId: 'SYN-PUB-00492', fieldPointer: '/abstract' }];
  c.ArtifactBundleSchema.parse(v);
  v.draft.claims[0].sourceBindings[0].objectId = 'SYN-PUB-00491';
  assert.equal(c.ArtifactBundleSchema.safeParse(v).success, false);
  // Real author IDs, original bytes and technical relevance are Task3/7 checks, not proven here.
});

test('Counter must cover the complete reviewed pool, not only the selected pair', () => {
  const v = bundle();
  v.pool.candidates.push({ ...structuredClone(v.pool.candidates[0]), researcherId: 'R0001', rank: 2 });
  v.pool.mergedCandidateCount = 2; v.pool.diagnostics.mergedCount = 2; v.pool.diagnostics.selectedCount = 2;
  c.CandidatePoolSchema.parse(v.pool);
  assert.equal(c.ArtifactBundleSchema.safeParse(v).success, false, 'Main candidate coverage cannot stand in for whole-pool coverage');
  v.counter.checkedCandidates = ['R0001', 'R1008'];
  c.ArtifactBundleSchema.parse(v); // Set coverage, no arbitrary order requirement.
});
