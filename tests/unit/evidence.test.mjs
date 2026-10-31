import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadSnapshot, loadTestSnapshot } from '../../dist/server/data/snapshot.js';
import { resolvePointer } from '../../dist/server/data/records.js';
import { SourceRefSchema } from '../../dist/server/contracts/domain.js';
import { hashSourceRecord, hashEvidenceSnapshot, hashArtifact } from '../../dist/server/evidence/hashing.js';
import * as store from '../../dist/server/evidence/store.js';
import * as validator from '../../dist/server/evidence/validate.js';
import { draft as draftFixture } from '../fixtures/contracts.mjs';

const root = fileURLToPath(new URL('../../reference/einstein-matchmaker-data/', import.meta.url));
const commit = '4fb99b3749adf0d10b5977089ff4c73f4f522240';
const book = JSON.parse(await readFile(new URL('../fixtures/evidence-cases.json', import.meta.url), 'utf8'));
const snapshot = await loadSnapshot(root, commit);
const digest = value => createHash('sha256').update(value).digest('hex');
function refOf(e) { return { file: e.source_file, recordId: e.record_id,
  locator: e.record_pointer ? { format: 'json', jsonPointer: e.record_pointer }
    : { format: 'jsonl', line1Based: e.jsonl_line_1based }, fieldPointer: e.field_pointer,
  derivedRecordId: false, ...(e.character_range ? { codePointRange: e.character_range } : {}) }; }
let legacyCount = 0;
for (const c of book.cases) test(`${c.case_id}: every JSON/JSONL legacy excerpt resolves through production source validation`, () => {
  for (const legacy of c.evidence) {
    if (legacy.source_file.endsWith('.csv')) { assert.equal(SourceRefSchema.safeParse(refOf(legacy)).success, false); continue; }
    legacyCount++;
    const evidence = store.resolveEvidence(refOf(legacy), snapshot);
    assert.equal(evidence.excerpt, legacy.excerpt, legacy.evidence_id);
    assert.equal(evidence.excerptSha256, legacy.excerpt_sha256);
    assert.equal(evidence.recordSha256, hashSourceRecord(snapshot.locateRecord(evidence.source).record));
    assert.equal(evidence.sourceFileSha256, snapshot.files.find(f => f.file === evidence.source.file).sourceFileSha256);
    assert.deepEqual(validator.verifyEvidence(evidence, snapshot), []);
  }
});
test('all 73 production legacy excerpts were actually executed, with two CSV sources explicitly refused', () => assert.equal(legacyCount, 73));

function ref(kind, id, fieldPointer, codePointRange) {
  const row = snapshot.getRecord(kind, id); assert.ok(row);
  return { file: row.file, recordId: id, locator: row.locator, fieldPointer,
    derivedRecordId: row.derivedRecordId, ...(codePointRange ? { codePointRange } : {}) };
}
function evidence(kind, id, field) { return store.resolveEvidence(ref(kind, id, field), snapshot); }
const person = evidence('researcher', 'R0001', '/name');
function draftFor(researcherId, ev, relation, objectId, subjectId = researcherId) {
  const d = draftFixture(); d.pair.researcherId = researcherId;
  d.claims = [{ id: 'claim-1', researcherId, kind: 'fact', text: 'Offline structural fixture; semantic truth is not asserted.',
    evidenceIds: [ev.id], sourceBindings: [{ evidenceId: ev.id, subjectId, relation, objectId, fieldPointer: ev.source.fieldPointer }], limitations: [] }];
  d.sections.summary = [{ text: d.claims[0].text, claimIds: ['claim-1'] }];
  d.evidenceSnapshotHash = hashEvidenceSnapshot([ev]); d.draftHash = hashArtifact(d); return d;
}
const errors = issues => issues.filter(i => i.severity === 'error');
function issuesFor(draft, evs) { return validator.validateClaimSources(draft, snapshot, store.createEvidenceSnapshot(evs)); }

test('Evidence rejects every declared hash/locator/field/content mismatch, not merely unknown IDs', () => {
  for (const patch of [{ id: 'arbitrary-alias' }, { datasetCommit: 'a'.repeat(40) }, { sourceFileSha256: '0'.repeat(64) },
    { recordSha256: '0'.repeat(64) }, { excerptSha256: '0'.repeat(64) }, { excerpt: 'forged' },
    { source: { ...person.source, recordId: 'R0002' } },
    { source: { ...person.source, fieldPointer: '/title' } },
    { source: { ...person.source, locator: { format: 'json', jsonPointer: '/researchers/1' } } }]) {
    const issues = validator.verifyEvidence({ ...person, ...patch }, snapshot);
    assert.ok(errors(issues).length > 0, JSON.stringify(patch));
    assert.ok(issues.every(i => ['source', 'location'].includes(i.category)));
  }
});

test('strict pointers cannot traverse inherited properties, invalid indices, or nonexistent fields', () => {
  const value = JSON.parse('{"a/b":{"~key":["ok"]}}');
  assert.equal(resolvePointer(value, '/a~1b/~0key/0'), 'ok');
  for (const pointer of ['/constructor', '/toString', '/__proto__', '/a~1b/~0key/-1',
    '/a~1b/~0key/01', '/a~1b/~0key/-', '/a~1b/~0key/9007199254740992', '/a~2b'])
    assert.throws(() => resolvePointer(value, pointer));
  assert.throws(() => store.resolveEvidence(ref('researcher', 'R0001', '/absent'), snapshot), e => e.code === 'FIELD_NOT_FOUND');
  assert.throws(() => store.resolveEvidence({ ...ref('publication', 'SYN-PUB-00001', '/title'), locator: { format: 'jsonl', line1Based: 999999 } }, snapshot));
});

test('project, patent, company challenge and derived company-page use actual original ID edges', () => {
  const cases = [
    ['project', 'SYN-PRJ-0001', '/participants', 'R0765', 'project_participant', 'SYN-PRJ-0001'],
    ['patent', 'SYN-PAT-001', '/inventors', 'R0662', 'patent_inventor', 'SYN-PAT-001'],
    ['company', 'C001', '/challenges/0/text', 'R0001', 'challenge_field', 'C001-CH1', 'C001'],
  ];
  for (const [kind, id, field, rid, relation, objectId, subjectId] of cases) {
    const e = evidence(kind, id, field), d = draftFor(rid, e, relation, objectId, subjectId);
    assert.deepEqual(errors(issuesFor(d, [e])), [], relation);
    if (relation !== 'challenge_field') {
      const wrong = draftFor('R0001', e, relation, objectId);
      assert.ok(issuesFor(wrong, [e]).some(i => i.category === 'relation' && i.severity === 'error'));
    }
  }
  const page = store.resolveEvidence(ref('company_page', 'company-page:1', '/text'), snapshot);
  assert.equal(page.source.derivedRecordId, true); assert.deepEqual(validator.verifyEvidence(page, snapshot), []);
  assert.throws(() => store.resolveEvidence({ ...page.source, recordId: 'company-page:2' }, snapshot));
  const challenge = evidence('company', 'C001', '/challenges/0/text');
  assert.ok(errors(issuesFor(draftFor('R0001', challenge, 'challenge_field', 'C001-CH2', 'C001'), [challenge])).length);
});

test('correct hashes from another researcher or same-name profile cannot prove candidate identity', () => {
  for (const [from, candidate] of [['R0001', 'R0002'], ['R0128', 'R0881'], ['R0191', 'R0435']]) {
    const e = evidence('researcher', from, '/name');
    assert.deepEqual(validator.verifyEvidence(e, snapshot), []);
    assert.ok(issuesFor(draftFor(candidate, e, 'profile_field', candidate), [e]).some(i => i.category === 'relation' && i.severity === 'error'));
  }
});

test('profile-only publication association is preserved as a fact, never upgraded to author_of', () => {
  const e = evidence('publication', 'SYN-PUB-01827', '/authors');
  assert.deepEqual(validator.verifyEvidence(e, snapshot), []);
  assert.ok(errors(issuesFor(draftFor('R0139', e, 'author_of', 'SYN-PUB-01827'), [e])).length);
  const correct = issuesFor(draftFor('R0539', e, 'author_of', 'SYN-PUB-01827'), [e]);
  assert.deepEqual(errors(correct), []);
  const profile = evidence('researcher', 'R0139', '/publications/0');
  const issues = issuesFor(draftFor('R0139', profile, 'profile_field', 'R0139'), [profile]);
  assert.deepEqual(errors(issues), []);
  assert.ok(issues.some(i => i.code === 'PROFILE_LINK_ASYMMETRY'));
});

test('membership in a paper does not attribute another author slot to that researcher', () => {
  const e = evidence('publication', 'SYN-PUB-00001', '/authors/1/name');
  const issues = issuesFor(draftFor('R0001', e, 'author_of', 'SYN-PUB-00001'), [e]);
  assert.ok(issues.some(i => i.code === 'PARTICIPANT_SLOT_MISMATCH' && i.category === 'relation'));
  const nullId = evidence('publication', 'SYN-PUB-00001', '/authors/1/researcher_id');
  const field = store.resolveField(nullId.source, snapshot);
  assert.equal(field.value, null); assert.equal(field.valueType, 'null'); assert.equal(field.text, 'null');
  assert.ok(errors(issuesFor(draftFor('R0001', nullId, 'author_of', 'SYN-PUB-00001'), [nullId])).length);
  assert.equal(snapshot.getRecord('researcher', field.value), undefined);
});

test('explicit project membership does not attribute another participant slot', () => {
  const e = evidence('project', 'SYN-PRJ-0022', '/participants/1/role');
  assert.ok(issuesFor(draftFor('R0983', e, 'project_participant', 'SYN-PRJ-0022'), [e])
    .some(i => i.code === 'PARTICIPANT_SLOT_MISMATCH'));
  assert.deepEqual(errors(issuesFor(draftFor('R0375', e, 'project_participant', 'SYN-PRJ-0022'), [e])), []);
});

test('authentic empty source fields are evidence insufficiency, not corrupt source files', () => {
  for (const [kind, id] of [['publication', 'SYN-PUB-00009'], ['patent', 'SYN-PAT-001']]) {
    const r = ref(kind, id, '/abstract');
    assert.equal(store.resolveField(r, snapshot).value, '');
    assert.throws(() => store.resolveEvidence(r, snapshot), e => e.category === 'insufficient' && e.code === 'EMPTY_EVIDENCE_FIELD');
  }
});

test('source_field cannot turn a genuine unrelated paper into verified candidate ownership', () => {
  const e = evidence('publication', 'SYN-PUB-01827', '/abstract');
  const forged = draftFor('R0139', e, 'source_field', 'R0139', 'SYN-PUB-01827');
  const issues = issuesFor(forged, [e]);
  assert.ok(issues.some(i => i.category === 'insufficient' && i.severity === 'error' && i.code === 'CANDIDATE_RELATION_UNPROVEN'));
  const background = draftFor('R0139', e, 'source_field', 'SYN-PUB-01827', 'SYN-PUB-01827');
  background.claims[0].text = 'R0139 authored this paper. Intentionally false prose; the deterministic validator must not pretend to understand it.';
  const backgroundIssues = issuesFor(background, [e]);
  assert.deepEqual(errors(backgroundIssues), []);
  assert.ok(backgroundIssues.some(i => i.code === 'CONTEXT_ONLY_NO_CANDIDATE_RELATION'));
  assert.ok(backgroundIssues.some(i => i.category === 'semantic_review'));
  const authors = evidence('publication', 'SYN-PUB-01827', '/authors');
  const related = draftFor('R0539', authors, 'author_of', 'SYN-PUB-01827');
  assert.ok(issuesFor(related, [authors]).some(i => i.category === 'semantic_review'), 'Correct author edge still does not prove technical relevance');
});

test('binding cannot swap fields or current Evidence snapshots while keeping valid source hashes', () => {
  const d = draftFor('R0001', person, 'profile_field', 'R0001');
  d.claims[0].sourceBindings[0].fieldPointer = '/bio';
  assert.ok(errors(issuesFor(d, [person])).length);
  const good = draftFor('R0001', person, 'profile_field', 'R0001'); good.evidenceSnapshotHash = '0'.repeat(64);
  assert.ok(issuesFor(good, [person]).some(i => i.code === 'EVIDENCE_SNAPSHOT_HASH_MISMATCH'));
  assert.ok(errors(issuesFor(draftFor('R0001', person, 'profile_field', 'R0001'), [])).length);
});

test('validation is read-only and Evidence Snapshot is deeply immutable', () => {
  const list = store.createEvidenceSnapshot([person]), d = draftFor('R0001', person, 'profile_field', 'R0001');
  const before = JSON.stringify({ list, d });
  assert.ok(Object.isFrozen(list)); assert.ok(Object.isFrozen(list[0].source.locator));
  assert.throws(() => { list[0].source.recordId = 'R0002'; }, TypeError);
  assert.deepEqual(errors(validator.validateClaimSources(d, snapshot, list)), []);
  assert.equal(JSON.stringify({ list, d }), before);
});

test('full notes remain available; an undeclared truncation or wrong code-point excerpt is rejected', () => {
  const e = evidence('researcher', 'R0881', '/notes');
  assert.equal(e.excerpt, snapshot.getRecord('researcher', 'R0881').record.notes);
  assert.ok(e.excerpt.includes('not available for project leadership'));
  const truncated = { ...e, excerpt: e.excerpt.slice(0, 30), excerptSha256: digest(e.excerpt.slice(0, 30)) };
  assert.ok(errors(validator.verifyEvidence(truncated, snapshot)).length);
});

test('explicit modified copies retain scalar types and code-point boundaries without coercion', async t => {
  const copyRoot = await mkdtemp(join(tmpdir(), 'einstein-task3-types-'));
  t.after(async () => { assert.equal(resolve(copyRoot, '..'), resolve(tmpdir())); assert.ok(basename(copyRoot).startsWith('einstein-task3-types-')); await rm(copyRoot, { recursive: true, force: true }); });
  await mkdir(join(copyRoot, 'data'));
  const manifest = {};
  for (const file of snapshot.files) {
    let bytes = await readFile(join(root, file.file));
    if (file.file === 'data/researchers.json') {
      const doc = JSON.parse(bytes.toString('utf8'));
      Object.assign(doc.researchers[0], { notes: 'A😀e\u0301中', testNull: null, testString: 'null', testNumber: 12, testLong: 'x'.repeat(16_385),
        testBoolean: false, testObject: { b: 2, a: 1 }, testArray: [2, 1] });
      bytes = Buffer.from(JSON.stringify(doc));
    }
    manifest[file.file] = digest(bytes); await writeFile(join(copyRoot, file.file), bytes);
  }
  const copy = await loadTestSnapshot(copyRoot, { datasetCommit: commit, sourceFileSha256s: manifest });
  for (const [field, text, type] of [['testNull', 'null', 'null'], ['testString', 'null', 'string'],
    ['testNumber', '12', 'number'], ['testBoolean', 'false', 'boolean'], ['testObject', '{"a":1,"b":2}', 'object'], ['testArray', '[2,1]', 'array']]) {
    const r = ref('researcher', 'R0001', `/${field}`), resolved = store.resolveField(r, copy);
    assert.equal(resolved.text, text); assert.equal(resolved.valueType, type);
    const e = store.resolveEvidence(r, copy); assert.deepEqual(validator.verifyEvidence(e, copy), []);
    if (type !== 'string') assert.throws(() => store.resolveEvidence({ ...r, codePointRange: [0, 1] }, copy), e => e.code === 'RANGE_REQUIRES_STRING');
  }
  const r = ref('researcher', 'R0001', '/notes', [1, 2]);
  assert.equal(store.resolveEvidence(r, copy).excerpt, '😀');
  const whole = store.resolveEvidence({ ...r, codePointRange: [0, 5] }, copy);
  assert.equal(whole.excerpt, 'A😀e\u0301中');
  for (const range of [[0, 6], [-1, 2], [1, 1.5]]) assert.throws(() => store.resolveEvidence({ ...r, codePointRange: range }, copy));
  const long = ref('researcher', 'R0001', '/testLong');
  assert.equal(store.resolveField(long, copy).text.length, 16_385, 'Full original remains available');
  assert.throws(() => store.resolveEvidence(long, copy), e => e.category === 'insufficient' && e.code === 'EXCERPT_REQUIRES_NARROWER_SOURCE');
  assert.equal(store.resolveEvidence({ ...long, codePointRange: [0, 20] }, copy).excerpt.length, 20, 'Only explicit ranges select a shorter excerpt');
});
