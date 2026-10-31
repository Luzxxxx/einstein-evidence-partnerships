import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadSnapshot, loadTestSnapshot } from '../../dist/server/data/snapshot.js';
import { buildIndex, retrieveCandidates, retrieveWithTrace } from '../../dist/server/retrieval/index.js';
import { DEFAULT_RETRIEVAL_CONFIG } from '../../dist/server/retrieval/config.js';
import { fuseRanks } from '../../dist/server/retrieval/select.js';
import { expandConcepts } from '../../dist/server/retrieval/concepts.js';
import { CandidatePoolSchema } from '../../dist/server/contracts/domain.js';
import { verifyEvidence } from '../../dist/server/evidence/validate.js';
import { resolveField } from '../../dist/server/evidence/store.js';
import { hashCandidatePool } from '../../dist/server/evidence/hashing.js';
import { input as inputFixture } from '../fixtures/contracts.mjs';
const root = fileURLToPath(new URL('../../reference/einstein-matchmaker-data/', import.meta.url));
const snapshot = await loadSnapshot(root, inputFixture().datasetCommit);
const index = buildIndex(snapshot);

test('index enumerates the entire corpus and keeps explicitly owned research results only', () => {
  assert.equal(index.stats.researchers, 1047); assert.equal(index.stats.publications, 10779);
  assert.equal(index.stats.projects, 1823); assert.equal(index.stats.patents, 111);
  assert.equal(index.researcherIds.length, 1047); assert.ok(Object.isFrozen(index.researcherIds));
  assert.ok(index.getDocuments('R1047').length > 0, 'No early source truncation');
  assert.ok(index.getDocuments('R0539').some(d => d.sourceRef.recordId === 'SYN-PUB-01827'));
  assert.ok(!index.getDocuments('R0139').some(d => d.sourceRef.recordId === 'SYN-PUB-01827'), 'Profile-only edge cannot attach another author paper');
  assert.ok(!index.getDocuments('R0001').some(d => d.sourceRef.recordId === 'SYN-PUB-00001'
    && d.identityRef?.fieldPointer === '/authors/1/researcher_id'), 'Null author on this exact paper cannot be linked by name');
  for (const doc of index.getDocuments('R0128')) assert.equal(doc.researcherId, 'R0128');
  assert.ok(!index.getDocuments('R0128').some(d => d.sourceRef.recordId === 'R0881'));
  assert.ok(index.serializedBytes > 0); assert.match(index.indexHash, /^[a-f0-9]{64}$/);
  assert.throws(() => index.getDocuments('R0001').pop(), TypeError);
});

test('retrieval consumes original challenge and separates strict pool, trace and current Evidence', async () => {
  const result = retrieveWithTrace(inputFixture(), index, DEFAULT_RETRIEVAL_CONFIG);
  CandidatePoolSchema.parse(result.pool);
  assert.deepEqual(retrieveCandidates(inputFixture(), index, DEFAULT_RETRIEVAL_CONFIG), result.pool);
  assert.equal(result.pool.poolHash, hashCandidatePool(result.pool)); assert.equal(result.trace.poolHash, result.pool.poolHash);
  assert.equal(result.trace.coverage.searchedResearchers, 1047);
  assert.equal(result.trace.validationStatus, 'uncalibrated'); assert.equal(result.pool.diagnostics.judgedCapture, null);
  assert.ok(result.pool.query.includes('without labelled attack data'));
  const manifest = JSON.parse(await readFile(new URL('../fixtures/retrieval-queries.json', import.meta.url), 'utf8'));
  const frozen = manifest.queries.find(q => q.challengeId === inputFixture().challengeId);
  assert.equal(result.pool.query, frozen.queryText);
  assert.equal(result.trace.query.querySourceHash, frozen.querySourceHash, 'Trace and frozen query must bind the same exact original fields');
  assert.ok(result.trace.query.background.every(b => b.usedForScoring === false));
  for (const lane of Object.values(result.trace.lanes)) assert.ok(lane.candidateIds.length <= 40);
  assert.ok(result.trace.unionIds.length <= 120); assert.ok(result.pool.candidates.length <= 8);
  assert.equal(new Set(result.trace.unionIds).size, result.trace.unionIds.length);
  for (const e of result.evidence) assert.deepEqual(verifyEvidence(e, snapshot), []);
  for (const c of result.pool.candidates) {
    for (const m of c.matchedFields) assert.ok(!/\/(authors|participants|inventors)(\/|$)/.test(m.sourceRef.fieldPointer));
    const restrictions = c.restrictionRefs.map(id => result.evidence.find(e => e.id === id));
    const original = snapshot.getRecord('researcher', c.researcherId).record.notes;
    const metadata = result.trace.restrictions.find(r => r.researcherId === c.researcherId && r.sourceRef.fieldPointer === '/notes');
    assert.ok(metadata, 'Even an empty original restriction field must be disclosed, not fabricated or lost');
    assert.equal(metadata.originalValue, original);
    const notes = restrictions.find(e => e.source.fieldPointer === '/notes');
    if (original.trim()) assert.equal(notes.excerpt, original); else assert.equal(metadata.evidenceId, null);
    for (const field of ['open_to', 'industry_experience']) {
      const meta = result.trace.restrictions.find(r => r.researcherId === c.researcherId && r.sourceRef.fieldPointer === `/${field}`);
      assert.ok(meta); assert.deepEqual(meta.originalValue, snapshot.getRecord('researcher', c.researcherId).record[field]);
    }
  }
});

test('index and trace retain official/test-copy provenance outside the unchanged pool contract', () => {
  assert.equal(index.sourcePolicy, 'official');
  assert.equal(retrieveWithTrace(inputFixture(), index, DEFAULT_RETRIEVAL_CONFIG).trace.sourcePolicy, 'official');
});
test('inactive lanes neither report searched coverage nor contribute to baseline latency', () => {
  const result = retrieveWithTrace(inputFixture(), index, { ...DEFAULT_RETRIEVAL_CONFIG, lanes: ['L0'] });
  assert.equal(result.trace.coverage.perLaneDomain.L0, 1047);
  assert.equal(result.trace.coverage.perLaneDomain.L1, 0); assert.equal(result.trace.coverage.perLaneDomain.L2, 0);
  assert.deepEqual(result.trace.lanes.L1.allRankedIds, []);
});

test('every top40 lane contribution including unselected union candidates has an original-field explanation', () => {
  const { trace } = retrieveWithTrace(inputFixture(), index, DEFAULT_RETRIEVAL_CONFIG);
  for (const lane of ['L0', 'L1', 'L2']) {
    const rows = trace.laneExplanations[lane];
    assert.deepEqual(rows.map(row => row.researcherId), trace.lanes[lane].candidateIds);
    for (const row of rows) {
      assert.ok(row.rawScore > 0); assert.equal(row.scoreDirection, 'higher_is_better');
      assert.equal(row.contributingFields.reduce((sum, field) => sum + field.fieldScore, 0), row.rawScore);
      for (const field of row.contributingFields) {
        assert.ok(resolveField(field.sourceRef, snapshot).text.length > 0);
        assert.equal(resolveField(field.identityRef, snapshot).value, row.researcherId);
      }
    }
  }
});

test('identity witnesses are distinct relation-field sources rather than relabelled summaries', () => {
  for (const rid of ['R0030', 'R0765', 'R0662']) for (const d of index.getDocuments(rid)) {
    if (!d.identityRef) continue;
    assert.ok(d.identityRef.fieldPointer.match(/^\/(authors|participants|inventors)\/[0-9]+\/researcher_id$/));
    assert.equal(resolveField(d.identityRef, snapshot).value, rid);
    assert.notEqual(d.sourceRef.fieldPointer, d.identityRef.fieldPointer);
  }
});

test('rank fusion is deterministic, deduplicates and preserves every 40/120/8 cutoff reason', () => {
  const lane = (start, count) => Array.from({ length: count }, (_, i) => ({ researcherId: `R${String(start + i).padStart(4, '0')}`, score: 1 }));
  const lanes = { L0: lane(1, 60), L1: lane(41, 60), L2: lane(81, 60) };
  const a = fuseRanks(lanes, DEFAULT_RETRIEVAL_CONFIG), b = fuseRanks({ L2: [...lanes.L2].reverse(), L1: [...lanes.L1].reverse(), L0: [...lanes.L0].reverse() }, DEFAULT_RETRIEVAL_CONFIG);
  assert.deepEqual(a, b); assert.equal(a.unionIds.length, 120); assert.equal(a.selectedIds.length, 8);
  assert.equal(new Set(a.unionIds).size, 120); assert.equal(a.selectedIds[0], 'R0001');
  assert.ok(a.omitted.some(o => o.reason === 'REVIEW_LIMIT_8'));
  assert.ok(a.omitted.some(o => o.reason === 'LANE_LIMIT_40'));
  assert.deepEqual(fuseRanks({ L0: [], L1: [], L2: [] }, DEFAULT_RETRIEVAL_CONFIG).selectedIds, []);
});

test('concept rules are domain-scoped, traceable and do not turn morphology into a universal synonym', () => {
  const a = expandConcepts('unusual behaviour on Modbus without labelled attack data');
  assert.ok(a.some(x => x.derivedTerms.includes('anomaly detection') && x.sourceFragment && x.expansionId));
  assert.equal(expandConcepts('fish gill morphology').some(x => x.domain === 'language'), false);
  assert.equal(expandConcepts('changing rehabilitation exercises').some(x => x.domain === 'electronics'), false);
  assert.equal(expandConcepts('nonserbian search').some(x => x.domain === 'language'), false, 'A substring is not the declared trigger term');
  assert.equal(expandConcepts('unchanging circuit board').some(x => x.domain === 'electronics'), false, 'Do not turn unchanging into changing');
});

test('invalid configuration and source input fail rather than silently shrink the search domain', () => {
  assert.throws(() => retrieveCandidates(inputFixture(), index, { ...DEFAULT_RETRIEVAL_CONFIG, maxPerLane: 41 }));
  assert.throws(() => retrieveCandidates({ ...inputFixture(), challengeId: 'C001-CH99' }, index, DEFAULT_RETRIEVAL_CONFIG));
  assert.throws(() => buildIndex({ ...snapshot }));
});

test('marked full-corpus copy verifies ties, NFC/script variants, no stemming, restrictions and empty nonfilled pool', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'einstein-task4-copy-'));
  t.after(async () => { assert.equal(resolve(dir, '..'), resolve(tmpdir())); assert.ok(basename(dir).startsWith('einstein-task4-copy-')); await rm(dir, { recursive: true, force: true }); });
  await mkdir(join(dir, 'data'));
  const manifest = {}, digest = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const file of snapshot.files) {
    let bytes = await readFile(join(root, file.file));
    if (file.file === 'data/researchers.json') {
      const doc = JSON.parse(bytes.toString('utf8'));
      for (const p of doc.researchers) { p.fields = ['qztechnical kartica café']; p.keywords = []; p.bio = ''; }
      doc.researchers[0].notes = 'Not interested in purely unsupervised projects; until mid-2026. Preserve exactly.';
      doc.researchers[0].publications = doc.researchers[0].publications.filter(id => id !== 'SYN-PUB-00001');
      bytes = Buffer.from(JSON.stringify(doc));
    } else if (file.file === 'data/publications.jsonl') {
      const lines = bytes.toString('utf8').trimEnd().split('\n'), row = JSON.parse(lines[0]);
      row.authors.push(structuredClone(row.authors[0])); lines[0] = JSON.stringify(row); bytes = Buffer.from(lines.join('\n') + '\n');
    } else if (file.file === 'data/patents.json') {
      const doc = JSON.parse(bytes.toString('utf8')); doc.patents[0].inventors.push({ researcher_id: 'R0002', name: 'Explicit test-copy additional inventor' });
      bytes = Buffer.from(JSON.stringify(doc));
    }
    manifest[file.file] = digest(bytes); await writeFile(join(dir, file.file), bytes);
  }
  const companyFile = 'data/companies.json', companies = JSON.parse(await readFile(join(dir, companyFile), 'utf8'));
  const queries = ['qztechnical', 'café', 'cafe\u0301', 'kartica', 'картица', 'karticu', 'qznoactualtechnicalword', 'software data machine learning', 'university research collaboration'];
  companies.companies[0].challenges = queries.map((text, slot) => ({ id: `C001-CH${slot + 1}`, text, detail: '' }));
  const bytes = Buffer.from(JSON.stringify(companies)); manifest[companyFile] = digest(bytes); await writeFile(join(dir, companyFile), bytes);
  const copySnapshot = await loadTestSnapshot(dir, { datasetCommit: snapshot.datasetCommit, sourceFileSha256s: manifest });
  const copyIndex = buildIndex(copySnapshot);
  async function query(text) {
    return { copy: copySnapshot, result: retrieveWithTrace({ ...inputFixture(), challengeId: `C001-CH${queries.indexOf(text) + 1}` }, copyIndex, DEFAULT_RETRIEVAL_CONFIG) };
  }
  const { copy, result } = await query('qztechnical');
  assert.equal(copyIndex.sourcePolicy, 'test_copy'); assert.equal(result.trace.sourcePolicy, 'test_copy');
  assert.ok(result.pool.candidates.find(c => c.researcherId === 'R0001').identityFlags.includes('RESULT_LINK_ASYMMETRY'));
  assert.equal(copyIndex.getDocuments('R0001').filter(d => d.sourceRef.recordId === 'SYN-PUB-00001').length,
    index.getDocuments('R0001').filter(d => d.sourceRef.recordId === 'SYN-PUB-00001').length, 'Duplicate author slot does not duplicate content contribution');
  for (const rid of ['R0662', 'R0002']) {
    const doc = copyIndex.getDocuments(rid).find(d => d.sourceRef.recordId === 'SYN-PAT-001');
    assert.ok(doc); assert.equal(resolveField(doc.identityRef, copy).value, rid);
  }
  for (const rid of ['R0983', 'R0375', 'R0233']) assert.ok(copyIndex.getDocuments(rid).some(d => d.sourceRef.recordId === 'SYN-PRJ-0022'));
  assert.equal(result.trace.coverage.searchedResearchers, 1047);
  assert.deepEqual(result.pool.candidates.map(c => c.researcherId), Array.from({ length: 8 }, (_, i) => `R${String(i + 1).padStart(4, '0')}`));
  const notes = result.evidence.find(e => e.source.recordId === 'R0001' && e.source.fieldPointer === '/notes');
  assert.equal(notes.excerpt, copy.getRecord('researcher', 'R0001').record.notes);
  const nfc = (await query('café')).result, nfd = (await query('cafe\u0301')).result;
  assert.deepEqual(nfc.trace.lanes.L0.candidateIds, nfd.trace.lanes.L0.candidateIds);
  const latin = (await query('kartica')).result, cyrillic = (await query('картица')).result;
  assert.deepEqual(latin.trace.lanes.L1.candidateIds, cyrillic.trace.lanes.L1.candidateIds);
  assert.ok(cyrillic.trace.lanes.L1.candidateIds.length > 0); assert.equal(cyrillic.trace.lanes.L0.candidateIds.length, 0);
  assert.equal((await query('karticu')).result.pool.candidates.length, 0, 'No implicit morphological stemming');
  for (const text of ['qznoactualtechnicalword', 'software data machine learning', 'university research collaboration']) {
    const empty = (await query(text)).result; assert.equal(empty.pool.candidates.length, 0);
    assert.ok(empty.pool.diagnostics.lowRecallReasons.includes('NO_TECHNICAL_ANCHOR'));
    assert.ok(empty.trace.expansionPasses <= 1);
  }
});
