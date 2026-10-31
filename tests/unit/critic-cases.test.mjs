import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadSnapshot } from '../../dist/server/data/snapshot.js';
import { DATASET_COMMIT } from '../../dist/server/contracts/primitives.js';
import { ProposalDraftSchema, CounterReportSchema, CandidatePoolSchema } from '../../dist/server/contracts/domain.js';
import { hashArtifact, hashCandidatePool, hashEvidenceSnapshot } from '../../dist/server/evidence/hashing.js';
import { verifyEvidence, validateClaimSources } from '../../dist/server/evidence/validate.js';
import { CRITIC_VARIANTS, buildCriticCase, createCriticMatrixFreeze, summarizeCriticObservations } from '../../dist/server/evaluation/critic-cases.js';

const snapshot = await loadSnapshot(resolve('reference/einstein-matchmaker-data'), DATASET_COMMIT);
const runId = '9cfef99e-9d84-4a21-8337-ab877cd30b6a';
const labels = JSON.parse(await readFile(new URL('../fixtures/critic/labels.json', import.meta.url), 'utf8'));
const live = CRITIC_VARIANTS.filter(v => v.layer !== 'D');

test('frozen logical15 matrix expands L06 and paired C03 without adding hidden live repeats', () => {
  assert.equal(new Set(CRITIC_VARIANTS.map(v => v.caseId)).size, 15);
  assert.equal(CRITIC_VARIANTS.length, 28);
  assert.equal(live.length, 12);
  const freeze = createCriticMatrixFreeze({ model: 'configured-model', gatewayOrigin: 'https://example.invalid',
    promptHashes: { critic: 'a'.repeat(64), proposer: 'b'.repeat(64), counter: 'c'.repeat(64) },
    executableHashes: { 'runtime.js': 'd'.repeat(64) } });
  assert.equal(freeze.plannedRunCount, 36);
  assert.equal(freeze.maxGrantedRequests, 576);
  assert.equal(freeze.runs.filter(v => v.variantId === 'L05').length, 3);
  assert.deepEqual(freeze.executionOrder.slice(0, 3), ['L05', 'L05', 'L05']);
  assert.equal(freeze.limits.maxModelRequestsPerRun, 16);
  assert.equal(freeze.limits.runTimeoutMs, 180_000);
  assert.equal(freeze.limits.requestTimeoutMs, 40_000);
  assert.equal(freeze.hash, hashArtifact(freeze));
  assert.ok(Object.isFrozen(freeze.runs));
});

test('all L/C source manifests use verified official bytes, valid declared relationships and full source fields', () => {
  for (const variant of live) {
    const sample = buildCriticCase(snapshot, variant.variantId, runId);
    assert.equal(sample.manifest.sourcePolicy, 'official');
    assert.equal(sample.manifest.datasetCommit, DATASET_COMMIT);
    assert.equal(sample.manifest.controlledInput, true);
    assert.equal(sample.manifest.showcaseEligible, false);
    for (const e of sample.research.evidence) assert.deepEqual(verifyEvidence(e, snapshot), []);
    assert.ok(!validateClaimSources(sample.draft, snapshot, sample.research.evidence).some(v => v.severity === 'error'), variant.variantId);
    assert.equal(sample.draft.evidenceSnapshotHash, hashEvidenceSnapshot(sample.research.evidence));
    assert.equal(sample.research.pool.poolHash, hashCandidatePool(sample.research.pool));
    ProposalDraftSchema.parse(sample.draft);
    CounterReportSchema.parse(sample.counter);
    CandidatePoolSchema.parse(sample.research.pool);
    assert.ok(sample.manifest.sources.every(s => s.evidenceId.startsWith('ev-') && s.sourceFileSha256.length === 64));
    assert.ok(Object.isFrozen(sample.proposerBody.claims));
  }
});

test('source-valid L05 changes only declared attack pointers and preserves explicit author/content separation', () => {
  const sample = buildCriticCase(snapshot, 'L05', runId);
  assert.equal(sample.draft.claims[2].id, 'C-GUARANTEE');
  assert.match(sample.draft.claims[2].text, /zero false positives/i);
  assert.equal(sample.manifest.baseFixtureHash, hashArtifact(sample.baselineDraft));
  assert.deepEqual(sample.attackDiff.map(d => d.pointer).sort(), ['/claims/2', '/sections/technicalRationale/1', '/sections/validation/0']);
  assert.ok(sample.attackDiff.every(d => JSON.stringify(d.before) !== JSON.stringify(d.after)));
  const author = sample.research.evidence.find(e => e.source.fieldPointer === '/authors');
  const abstract = sample.research.evidence.find(e => e.source.fieldPointer === '/abstract');
  assert.ok(sample.draft.claims[0].sourceBindings.some(b => b.relation === 'author_of' && b.evidenceId === author.id));
  assert.ok(sample.draft.claims[2].sourceBindings.some(b => b.evidenceId === abstract.id && b.relation === 'source_field'));
  assert.ok(!sample.draft.claims[2].sourceBindings.some(b => b.evidenceId === abstract.id && b.relation === 'author_of'));
});

test('draft hypotheses and expected findings never enter model payload or research context', () => {
  assert.equal(labels.semanticGold, false);
  assert.equal(labels.humanReviewedCount, 0);
  assert.ok(labels.cases.every(c => c.status === 'draft' && c.origin === 'developer_agent' && c.humanJudgment === null));
  for (const variant of live) {
    const sample = buildCriticCase(snapshot, variant.variantId, runId);
    const text = JSON.stringify(sample.modelMaterial);
    for (const forbidden of ['expectedFinding', 'expectedRoutes', 'humanJudgment', 'baseFixtureHash', 'attackDiff', 'variantId', 'caseId'])
      assert.ok(!text.includes(`"${forbidden}"`), `${variant.variantId}: ${forbidden}`);
    assert.deepEqual(Object.keys(sample.modelMaterial).sort(), ['counterBody', 'proposerBody']);
  }
});

test('explicit D identity/cross-object attacks fail production relation precheck without source fabrication', () => {
  for (const variantId of ['D01-profile', 'D01-null', 'D02-name', 'D02-notes']) {
    const sample = buildCriticCase(snapshot, variantId, runId);
    assert.ok(sample.research.evidence.every(e => verifyEvidence(e, snapshot).length === 0));
    assert.ok(validateClaimSources(sample.draft, snapshot, sample.research.evidence).some(i => i.severity === 'error'), variantId);
  }
});

test('every case begins from a structurally valid baseline and declares its complete draft mutation', () => {
  for (const variant of CRITIC_VARIANTS) {
    const sample = buildCriticCase(snapshot, variant.variantId, runId);
    assert.ok(!validateClaimSources(sample.baselineDraft, snapshot, sample.research.evidence).some(i => i.severity === 'error'), `${variant.variantId} baseline`);
    const rebuilt = structuredClone(sample.baselineDraft);
    for (const change of sample.attackDiff.filter(d => d.artifact === 'draft')) {
      const tokens = change.pointer.split('/').slice(1);
      let parent = rebuilt;
      for (const token of tokens.slice(0, -1)) parent = parent[token];
      const key = tokens.at(-1);
      assert.deepEqual(parent[key], change.before, `${variant.variantId} before ${change.pointer}`);
      parent[key] = structuredClone(change.after);
    }
    rebuilt.draftHash = hashArtifact(rebuilt);
    assert.deepEqual(rebuilt, sample.draft, `${variant.variantId} undeclared mutation`);
  }
});

test('injection variants alter artifact text only; controls retain full notes and null author IDs', () => {
  for (const variantId of ['L06-system', 'L06-endorsement']) {
    const sample = buildCriticCase(snapshot, variantId, runId);
    assert.ok(sample.manifest.attackOrigin === 'injected_artifact_text');
    assert.ok(sample.attackDiff.some(d => d.pointer === '/sections/summary/0'));
    assert.equal(sample.draft.claims[2].id, 'C-GUARANTEE');
  }
  const restricted = buildCriticCase(snapshot, 'L03', runId);
  const notes = restricted.research.evidence.find(e => e.source.recordId === 'R0079' && e.source.fieldPointer === '/notes');
  assert.match(notes.excerpt, /Not available for project coordination or laboratory work/);
  const nullAuthor = buildCriticCase(snapshot, 'D01-null', runId).research.evidence.find(e => e.source.fieldPointer === '/authors/1/researcher_id');
  assert.equal(nullAuthor.excerpt, 'null');
});

test('unjudged model observations report all raw outcomes and quality NA without grading or majority publication', () => {
  const result = summarizeCriticObservations([{ variantId: 'L05', repetition: 1, status: 'failed', reasonCodes: ['REQUEST_TIMEOUT'] },
    { variantId: 'L05', repetition: 2, status: 'insufficient', verdict: 'insufficient', reasonCodes: [] },
    { variantId: 'L05', repetition: 3, status: 'approved', verdict: 'approve', reasonCodes: [] }], labels);
  assert.equal(result.observationCount, 3);
  assert.equal(result.humanReviewedCount, 0);
  assert.equal(result.qualityMetrics.status, 'NA');
  assert.equal(result.qualityMetrics.reason, 'NO_HUMAN_ADJUDICATED_LABELS');
  assert.equal(result.publicationRule, 'single_current_trusted_review_and_parent_gate');
  assert.deepEqual(result.byVariant[0].statuses, { failed: 1, insufficient: 1, approved: 1 });
  assert.equal(result.omittedTechnicalFailures, 0);
});
