import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadSnapshot, loadTestSnapshot } from '../../dist/server/data/snapshot.js';
import { resolveEvidence, createEvidenceSnapshot } from '../../dist/server/evidence/store.js';
import { verifyEvidence, validateClaimSources } from '../../dist/server/evidence/validate.js';
import { hashEvidenceSnapshot, hashArtifact } from '../../dist/server/evidence/hashing.js';
import { draft as draftFixture } from '../fixtures/contracts.mjs';

const root = fileURLToPath(new URL('../../reference/einstein-matchmaker-data/', import.meta.url));
const commit = '4fb99b3749adf0d10b5977089ff4c73f4f522240';
const snapshot = await loadSnapshot(root, commit);
const relations = [
  { kind: 'publication', id: 'SYN-PUB-00001', rid: 'R0001', relation: 'author_of', field: 'authors' },
  { kind: 'project', id: 'SYN-PRJ-0001', rid: 'R0765', relation: 'project_participant', field: 'participants' },
  { kind: 'patent', id: 'SYN-PAT-005', rid: 'R0033', relation: 'patent_inventor', field: 'inventors' },
];
function run(s, row, pointer, bindings) {
  const located = s.getRecord(row.kind, row.id);
  const e = resolveEvidence({ file: located.file, recordId: row.id, locator: located.locator,
    fieldPointer: pointer, derivedRecordId: false }, s);
  assert.deepEqual(verifyEvidence(e, s), [], 'Test must use genuinely verified Evidence, not malformed sources');
  const d = draftFixture(); d.pair.researcherId = row.rid;
  d.claims = [{ id: 'relation-claim', researcherId: row.rid, kind: 'fact', text: 'Explicit offline structural relation fixture.',
    evidenceIds: [e.id], sourceBindings: bindings ? bindings(e) : [{ evidenceId: e.id, subjectId: row.rid,
      relation: row.relation, objectId: row.id, fieldPointer: e.source.fieldPointer }], limitations: [] }];
  d.sections.summary = [{ text: d.claims[0].text, claimIds: ['relation-claim'] }];
  d.evidenceSnapshotHash = hashEvidenceSnapshot([e]); d.draftHash = hashArtifact(d);
  return { e, issues: validateClaimSources(d, s, createEvidenceSnapshot([e])) };
}
function assertRelationError(result, code) {
  assert.ok(result.issues.some(i => i.category === 'relation' && i.severity === 'error'
    && i.code === code && i.claimId === 'relation-claim' && i.evidenceId === result.e.id), code);
}

for (const [index, pointer] of [[0, '/title'], [0, '/abstract'], [0, '/keywords/0'],
  [1, '/summary'], [1, '/title'], [2, '/title'], [2, '/abstract']]) {
  test(`${relations[index].relation}: genuine ${pointer} Evidence cannot prove the participant relation`, () => {
    assertRelationError(run(snapshot, relations[index], pointer), 'RELATION_FIELD_MISMATCH');
  });
}
for (const row of relations) for (const suffix of ['', '/0', '/0/researcher_id']) {
  test(`${row.relation}: /${row.field}${suffix} proves only its explicit original ID relation`, () => {
    const { issues } = run(snapshot, row, `/${row.field}${suffix}`);
    assert.deepEqual(issues.filter(i => i.severity === 'error'), []);
    assert.ok(issues.some(i => i.code === 'SEMANTIC_SUPPORT_UNASSESSED'));
  });
}

test('author_of cannot borrow identity from another authors slot, including a null-ID author', () => {
  assertRelationError(run(snapshot, relations[0], '/authors/1/name'), 'PARTICIPANT_SLOT_MISMATCH');
  assertRelationError(run(snapshot, relations[0], '/authors/1/researcher_id'), 'PARTICIPANT_SLOT_MISMATCH');
});
test('project_participant cannot borrow identity from another participant slot', () => {
  assertRelationError(run(snapshot, { ...relations[1], id: 'SYN-PRJ-0022', rid: 'R0983' }, '/participants/1/role'), 'PARTICIPANT_SLOT_MISMATCH');
});
test('source_field cannot launder an abstract through an invalid explicit author_of binding', () => {
  const row = relations[0];
  const { issues } = run(snapshot, row, '/abstract', e => [
    { evidenceId: e.id, subjectId: row.id, relation: 'source_field', objectId: row.rid, fieldPointer: '/abstract' },
    { evidenceId: e.id, subjectId: row.rid, relation: 'author_of', objectId: row.id, fieldPointer: '/abstract' },
  ]);
  assert.ok(issues.some(i => i.code === 'RELATION_FIELD_MISMATCH'));
  assert.ok(issues.some(i => i.code === 'CANDIDATE_RELATION_UNPROVEN' && i.severity === 'error'));
});

test('marked copies reject prefix/escaped siblings, wrong inventor slots, and IDs only outside the relation array', async t => {
  const copyRoot = await mkdtemp(join(tmpdir(), 'einstein-relation-fields-'));
  t.after(async () => {
    assert.equal(resolve(copyRoot, '..'), resolve(tmpdir())); assert.ok(basename(copyRoot).startsWith('einstein-relation-fields-'));
    await rm(copyRoot, { recursive: true, force: true });
  });
  await mkdir(join(copyRoot, 'data'));
  const manifest = {}, documents = new Map();
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const file of snapshot.files) {
    let bytes = await readFile(join(root, file.file));
    if (file.file === 'data/publications.jsonl') {
      const lines = bytes.toString('utf8').trimEnd().split('\n'), row = JSON.parse(lines[0]);
      row.authors_backup = structuredClone(row.authors); row['authors/shadow'] = structuredClone(row.authors);
      lines[0] = JSON.stringify(row); documents.set(file.file, lines); bytes = Buffer.from(lines.join('\n') + '\n');
    } else if (file.file === 'data/projects.json' || file.file === 'data/patents.json') {
      const doc = JSON.parse(bytes.toString('utf8'));
      const [row, field] = file.file.endsWith('projects.json') ? [doc.projects[0], 'participants'] : [doc.patents[4], 'inventors'];
      row[`${field}_backup`] = structuredClone(row[field]); row[`${field}/shadow`] = structuredClone(row[field]);
      if (field === 'inventors') row.inventors.push({ researcher_id: 'R0001', name: 'Explicit synthetic test-copy extra inventor' });
      bytes = Buffer.from(JSON.stringify(doc));
    }
    manifest[file.file] = digest(bytes); await writeFile(join(copyRoot, file.file), bytes);
  }
  const copy = await loadTestSnapshot(copyRoot, { datasetCommit: commit, sourceFileSha256s: manifest });
  assert.equal(copy.sourcePolicy, 'test_copy');
  for (const row of relations) for (const pointer of [`/${row.field}_backup/0`, `/${row.field}~1shadow/0`])
    assertRelationError(run(copy, row, pointer), 'RELATION_FIELD_MISMATCH');
  assertRelationError(run(copy, relations[2], '/inventors/1/name'), 'PARTICIPANT_SLOT_MISMATCH');
  const file = 'data/publications.jsonl', lines = documents.get(file), row = JSON.parse(lines[0]);
  row.authors = [{ researcher_id: 'R0002', name: 'Explicit synthetic test-copy different author', affiliation: 'Test copy' }];
  row.keywords.push('R0001'); row.candidate_id_outside_authors = 'R0001'; lines[0] = JSON.stringify(row);
  const bytes = Buffer.from(lines.join('\n') + '\n'); manifest[file] = digest(bytes); await writeFile(join(copyRoot, file), bytes);
  const elsewhere = await loadTestSnapshot(copyRoot, { datasetCommit: commit, sourceFileSha256s: manifest });
  assertRelationError(run(elsewhere, relations[0], '/authors'), 'EXPLICIT_PARTICIPANT_ID_MISSING');
});
