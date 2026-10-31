import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { hashArtifact } from '../../dist/server/evidence/hashing.js';
import { evaluateRetrievalMetrics } from '../../dist/server/evaluation/metrics.js';

const queryManifest = JSON.parse(await readFile(new URL('../fixtures/retrieval-queries.json', import.meta.url), 'utf8'));
const labelManifest = JSON.parse(await readFile(new URL('../fixtures/retrieval-labels.json', import.meta.url), 'utf8'));
const queryId = 'q-C001-CH1-original';
const id = n => `R${String(n).padStart(4, '0')}`;
const rehash = manifest => { manifest.hash = hashArtifact(manifest); return manifest; };
const blankLane = () => ({ candidateIds: [], allRankedIds: [] });
function run(ids = [id(1), id(2), id(3)], selected = ids, stage = 'L0') {
  return { queryId, stage, lanes: { L0: {candidateIds: [...ids], allRankedIds: [...ids]}, L1: blankLane(), L2: blankLane() },
    unionIds: [...ids], selectedIds: [...selected], omitted: ids.filter(x => !selected.includes(x)).map(researcherId => ({researcherId, reason: 'review_pool_cutoff'})) };
}
// These are synthetic unit-test declarations, never saved or represented as actual human gold.
function humanLabels(entries) {
  const labels = structuredClone(labelManifest);
  labels.reviewStatus = 'partial_human_review';
  const q = labels.queries.find(q => q.queryId === queryId);
  q.referencePoolStatus = 'pooled';
  q.labels = entries.map(([researcherId, relevance]) => ({ researcherId, relevance, sourceSufficiency: 'not_assessed',
    origin: 'human_review', seedRef: 'test-only-synthetic-review', evidenceRefs: [],
    reviewerId: 'test-only-synthetic-reviewer', reviewedAt: '2026-10-30T00:00:00.000Z',
    relevanceRationale: 'Synthetic unit fixture; no actual human review or source support claimed.', sourceRationale: null }));
  return rehash(labels);
}
const evaluate = (runs, labels = labelManifest, queries = queryManifest) => evaluateRetrievalMetrics({queryManifest: queries, labelManifest: labels, runs});
const firstStage = report => report.queries.find(q => q.queryId === queryId).stages[0];
const measured = (numerator, denominator) => ({status: 'measured', numerator, denominator});
const na = {status: 'NA', numerator: null, denominator: null};

test('frozen manifests with only AI-prepared unjudged seeds produce NA capture and disclose all queries', () => {
  const report = evaluate([run()]);
  assert.equal(report.qualityStatus, 'human_review_incomplete');
  assert.equal(report.queries.length, 9);
  assert.equal(report.queries.find(q => q.queryId === queryId).judgedCount, 0);
  assert.deepEqual(firstStage(report).unionCapture, na);
  assert.deepEqual(firstStage(report).selectedCapture, na);
  assert.deepEqual(firstStage(report).judgedPrecision, na);
  assert.deepEqual(firstStage(report).unjudgedProportion, measured(3, 3));
  assert.equal(report.queries.find(q => q.split === 'holdout').stages.length, 0);
  assert.equal(report.queries.find(q => q.split === 'holdout').evaluationStatus, 'unopened');
});

test('capture, judged precision and unjudged proportion use separate denominators', () => {
  const labels = humanLabels([[id(1), 'relevant'], [id(2), 'adjacent'], [id(4), 'relevant'], [id(5), 'unrelated']]);
  const report = evaluate([run()], labels);
  const s = firstStage(report);
  assert.deepEqual(s.unionCapture, measured(1, 2));
  assert.deepEqual(s.selectedCapture, measured(1, 2));
  assert.deepEqual(s.selectionRetention, measured(1, 1));
  assert.deepEqual(s.judgedPrecision, measured(1, 2));
  assert.deepEqual(s.unjudgedProportion, measured(1, 3));
  assert.deepEqual(s.lanes.L1.capture, na);
  assert.equal(report.queries.find(q => q.queryId === queryId).qualityStatus, 'human_review_incomplete');
  assert.deepEqual(s.notRankedRelevantIds, [id(4)]);
});

test('no positive labels and empty returned pools remain NA where denominator is empty', () => {
  const labels = humanLabels([[id(1), 'unrelated']]);
  const s = firstStage(evaluate([run([], [])], labels));
  assert.deepEqual(s.unionCapture, na);
  assert.deepEqual(s.selectionRetention, na);
  assert.deepEqual(s.judgedPrecision, na);
  assert.deepEqual(s.unjudgedProportion, na);
  const nonempty = firstStage(evaluate([run([id(1)])], labels));
  assert.deepEqual(nonempty.judgedPrecision, measured(0, 1));
});

test('eight genuine-declared judgments satisfy only the per-query review quantity, never source sufficiency', () => {
  const labels = humanLabels(Array.from({length: 8}, (_, i) => [id(i + 1), 'relevant']));
  const report = evaluate([run([id(1), id(2)])], labels);
  const q = report.queries.find(q => q.queryId === queryId);
  assert.equal(q.qualityStatus, 'human_review_complete');
  assert.equal(q.sourceSufficiencyCounts.not_assessed, 8);
  assert.equal(q.sourceSufficiencyCounts.supported, 0);
  assert.equal(report.qualityStatus, 'human_review_incomplete');
});

test('lane cutoff and review-pool cutoff losses are reported separately', () => {
  const all = Array.from({length: 41}, (_, i) => id(i + 1));
  const r = run(all.slice(0, 40), all.slice(0, 8));
  r.lanes.L0.allRankedIds = all;
  const labels = humanLabels([[id(1), 'relevant'], [id(9), 'relevant'], [id(41), 'relevant']]);
  const s = firstStage(evaluate([r], labels));
  assert.deepEqual(s.lanes.L0.capture, measured(2, 3));
  assert.deepEqual(s.lanes.L0.cutoffRelevantIds, [id(41)]);
  assert.deepEqual(s.truncatedRelevantIds, {laneCutoff: [id(41)], reviewCutoff: [id(9)]});
  assert.deepEqual(s.selectedCapture, measured(1, 3));
});

test('a relevant researcher recovered by another active lane is not a union lane-cutoff loss', () => {
  const all = Array.from({length: 41}, (_, i) => id(i + 1));
  const r = run(all.slice(0, 40), all.slice(0, 8), 'L0_L1');
  r.lanes.L0.allRankedIds = all;
  r.lanes.L1 = {candidateIds: [id(41)], allRankedIds: [id(41)]};
  r.unionIds.push(id(41));
  r.omitted.push({researcherId: id(41), reason: 'review_pool_cutoff'});
  const s = firstStage(evaluate([r], humanLabels([[id(41), 'relevant']])));
  assert.deepEqual(s.truncatedRelevantIds, {laneCutoff: [], reviewCutoff: [id(41)]});
});

test('AI labels cannot masquerade as human judgments', () => {
  const labels = structuredClone(labelManifest);
  const seed = labels.queries.find(q => q.queryId === queryId).labels[0];
  seed.relevance = 'relevant';
  seed.reviewerId = 'claimed-human'; seed.reviewedAt = '2026-10-30T00:00:00.000Z'; seed.relevanceRationale = 'Claimed relevant.';
  assert.throws(() => evaluate([], rehash(labels)));
  const missingReviewer = humanLabels([[id(1), 'relevant']]);
  missingReviewer.queries.find(q => q.queryId === queryId).labels[0].reviewerId = null;
  assert.throws(() => evaluate([], rehash(missingReviewer)));
  const falseSourceSupport = humanLabels([[id(1), 'relevant']]);
  falseSourceSupport.queries.find(q => q.queryId === queryId).labels[0].sourceSufficiency = 'supported';
  assert.throws(() => evaluate([], rehash(falseSourceSupport)));
  const fakeComplete = structuredClone(labelManifest); fakeComplete.reviewStatus = 'human_reviewed';
  assert.throws(() => evaluate([], rehash(fakeComplete)));
});

test('label self-hash, query self-hash and cross-manifest binding are verified', () => {
  const wrongLabelHash = structuredClone(labelManifest); wrongLabelHash.hash = '0'.repeat(64);
  assert.throws(() => evaluate([], wrongLabelHash));
  const wrongQueryHash = structuredClone(queryManifest); wrongQueryHash.hash = '0'.repeat(64);
  assert.throws(() => evaluate([], labelManifest, wrongQueryHash));
  const staleLabels = structuredClone(labelManifest); staleLabels.minimumJudgedPerQuery = 7;
  assert.throws(() => evaluate([], staleLabels));
  const staleQueries = structuredClone(queryManifest); staleQueries.queries[0].queryText += '!';
  assert.throws(() => evaluate([], labelManifest, staleQueries));
  const mismatch = structuredClone(labelManifest); mismatch.queryManifestHash = '0'.repeat(64);
  assert.throws(() => evaluate([], rehash(mismatch)));
});

test('valid manifest self-hash cannot hide stale field/query/source hashes', () => {
  for (const target of ['value', 'queryText', 'querySourceHash']) {
    const queries = structuredClone(queryManifest);
    if (target === 'value') queries.queries[0].sourceFields.text.value += '!';
    else if (target === 'querySourceHash') queries.queries[0][target] = '0'.repeat(64);
    else queries.queries[0][target] += '!';
    rehash(queries);
    const labels = structuredClone(labelManifest); labels.queryManifestHash = queries.hash; rehash(labels);
    assert.throws(() => evaluate([], labels, queries));
  }
});

test('holdout runs are sealed even when their supplied trace is empty', () => {
  const r = run([], []);
  r.queryId = queryManifest.queries.find(q => q.split === 'holdout').queryId;
  assert.throws(() => evaluate([r]), /Holdout is sealed/);
});

test('company/variant grouping, duplicate labels and exposed holdout seeds are rejected', () => {
  const duplicate = humanLabels([[id(1), 'relevant'], [id(1), 'unrelated']]);
  assert.throws(() => evaluate([], duplicate));
  const holdoutSeed = structuredClone(labelManifest);
  holdoutSeed.queries.find(q => q.queryId.includes('C040')).labels.push(structuredClone(holdoutSeed.queries[0].labels[0]));
  assert.throws(() => evaluate([], rehash(holdoutSeed)));
  const queries = structuredClone(queryManifest); queries.splitPolicy.holdoutCompanyIds.push('C001'); rehash(queries);
  const labels = structuredClone(labelManifest); labels.queryManifestHash = queries.hash; rehash(labels);
  assert.throws(() => evaluate([], labels, queries));
  const variant = structuredClone(queryManifest); variant.queries.find(q => q.split === 'holdout').variantGroupId = 'C001-CH1'; rehash(variant);
  const vl = structuredClone(labelManifest); vl.queryManifestHash = variant.hash; rehash(vl);
  assert.throws(() => evaluate([], vl, variant));
});

test('duplicate, out-of-union, oversized and cross-stage candidate traces are rejected', () => {
  const cases = [
    r => {r.selectedIds = [id(1), id(1)];},
    r => {r.selectedIds = [id(99)];},
    r => {r.unionIds.push(id(99));},
    r => {r.omitted = []; r.selectedIds = [id(1)];},
    r => {r.lanes.L1 = {candidateIds: [id(4)], allRankedIds: [id(4)]};},
    r => {r.lanes.L0.allRankedIds.reverse();},
    r => {r.queryId = 'unknown-query';},
    r => {r.unexpected = true;},
  ];
  for (const mutate of cases) {const r = run(); mutate(r); assert.throws(() => evaluate([r]));}
  assert.throws(() => evaluate([run(), run()]));
  assert.throws(() => evaluate([run(Array.from({length: 41}, (_, i) => id(i + 1)), [])]));
  assert.throws(() => evaluate([run(Array.from({length: 9}, (_, i) => id(i + 1)))]));
});
