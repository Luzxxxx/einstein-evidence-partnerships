import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import * as report from '../../dist/server/evaluation/retrieval-report.js';
const { assertDevOnly, createEvaluationFreeze, validateFrozenQueries } = report;
import { DEFAULT_RETRIEVAL_CONFIG } from '../../dist/server/retrieval/config.js';
import { hashArtifact } from '../../dist/server/evidence/hashing.js';
const queries = JSON.parse(await readFile(new URL('../fixtures/retrieval-queries.json', import.meta.url), 'utf8'));
const labels = JSON.parse(await readFile(new URL('../fixtures/retrieval-labels.json', import.meta.url), 'utf8'));
test('evaluation entry rejects holdout and unknown splits before data or ranking work', () => {
  assert.equal(assertDevOnly('dev'), undefined);
  for (const split of ['holdout', 'all', undefined]) assert.throws(() => assertDevOnly(split), /HOLDOUT_SEALED/);
});
test('engineering freeze binds original manifests, code, config and dictionary without inventing quality approval', () => {
  const freeze = createEvaluationFreeze({ queryManifest: queries, labelManifest: labels, config: DEFAULT_RETRIEVAL_CONFIG,
    indexHash: 'a'.repeat(64), sourceCodeHashes: { 'src/retrieval/index.ts': 'b'.repeat(64) },
    executableHashes: { 'dist/server/retrieval/index.js': 'c'.repeat(64) } });
  assert.equal(freeze.hash, hashArtifact(freeze)); assert.equal(freeze.holdoutStatus, 'unopened');
  assert.equal(freeze.queryManifestHash, queries.hash); assert.equal(freeze.labelManifestHash, labels.hash);
  assert.equal(freeze.humanJudgedCount, 0); assert.equal(freeze.qualityThresholdStatus, 'pending_human_review_and_user_approval');
  assert.ok(Object.isFrozen(freeze.config));
  assert.equal(freeze.executableHashes['dist/server/retrieval/index.js'], 'c'.repeat(64));
  assert.throws(() => createEvaluationFreeze({ queryManifest: { ...queries, hash: '0'.repeat(64) }, labelManifest: labels,
    config: DEFAULT_RETRIEVAL_CONFIG, indexHash: 'a'.repeat(64), sourceCodeHashes: {} }));
});
test('freeze cannot claim execution binding with missing or empty executable fingerprints', () => {
  const base = { queryManifest: queries, labelManifest: labels, config: DEFAULT_RETRIEVAL_CONFIG,
    indexHash: 'a'.repeat(64), sourceCodeHashes: { 'src/retrieval/index.ts': 'b'.repeat(64) } };
  assert.throws(() => createEvaluationFreeze(base), /executable/i);
  assert.throws(() => createEvaluationFreeze({ ...base, executableHashes: {} }), /executable/i);
});
test('output path guard rejects a junction before creating anything beyond it and preserves old reports', async t => {
  const base = await mkdtemp(join(tmpdir(), 'einstein-task4-output-'));
  t.after(async () => { assert.equal(resolve(base, '..'), resolve(tmpdir())); assert.ok(basename(base).startsWith('einstein-task4-output-')); await rm(base, { recursive: true, force: true }); });
  const project = join(base, 'project'), outside = join(base, 'outside'); await mkdir(project); await mkdir(outside);
  await symlink(outside, join(project, 'artifacts'), 'junction');
  await assert.rejects(report.prepareReportDirectory(project, 'artifacts/evaluations/new'), /link|junction/i);
  await assert.rejects(access(join(outside, 'evaluations')));
  await rm(join(project, 'artifacts'));
  const output = await report.prepareReportDirectory(project, 'artifacts/evaluations/first');
  await writeFile(join(output, 'sentinel.txt'), 'keep');
  await assert.rejects(report.prepareReportDirectory(project, 'artifacts/evaluations/first'));
  assert.equal(await readFile(join(output, 'sentinel.txt'), 'utf8'), 'keep');
  await assert.rejects(report.prepareReportDirectory(project, '../escape'), /below artifacts/);
});
test('query verification reads frozen exact original sources and rejects a counterfeit snapshot', () => {
  assert.throws(() => validateFrozenQueries(queries, {}), /snapshot/i);
});
test('manual reference materials pool lane top20, exposed dev seeds and deterministic lexical-stratum samples', () => {
  const ids = start => Array.from({ length: 40 }, (_, i) => `R${String(start + i).padStart(4, '0')}`);
  const lanes = { L0: { candidateIds: ids(1), allRankedIds: ids(1) }, L1: { candidateIds: ids(21), allRankedIds: ids(21) },
    L2: { candidateIds: ids(41), allRankedIds: ids(41) } };
  const pool = report.pooledReferenceCandidates('dev-test-only', lanes, ['R0090']);
  assert.equal(pool.length, 65); assert.equal(new Set(pool.map(r => r.researcherId)).size, 65);
  for (const lane of ['L0', 'L1', 'L2']) for (const id of lanes[lane].candidateIds.slice(0, 20))
    assert.ok(pool.find(r => r.researcherId === id).origins.includes(`${lane}_top20`));
  assert.ok(pool.find(r => r.researcherId === 'R0090').origins.includes('exposed_dev_seed_unjudged'));
  assert.equal(pool.filter(r => r.origins.includes('deterministic_lexical_stratum_sample_unjudged')).length, 4);
  assert.deepEqual(pool, report.pooledReferenceCandidates('dev-test-only', lanes, ['R0090']));
});
