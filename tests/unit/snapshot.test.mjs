import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as data from '../../dist/server/data/snapshot.js';
import { SOURCE_DEFINITIONS } from '../../dist/server/data/records.js';

const root = fileURLToPath(new URL('../../reference/einstein-matchmaker-data/', import.meta.url));
const commit = '4fb99b3749adf0d10b5977089ff4c73f4f522240';
const names = ['researchers.json', 'companies.json', 'publications.jsonl', 'projects.json', 'patents.json', 'company-pages.jsonl'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const original = new Map(await Promise.all(names.map(async name => [`data/${name}`, await readFile(join(root, 'data', name))])));
const hashes = Object.fromEntries([...original].map(([name, bytes]) => [name, digest(bytes)]));
const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const before = { head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain=v1', '--untracked-files=all') };

test('official snapshot verifies pinned commit and exposes all six typed ID indexes', async () => {
  const snapshot = await data.loadSnapshot(root, commit);
  assert.equal(snapshot.sourcePolicy, 'official'); assert.equal(snapshot.datasetCommit, commit);
  assert.deepEqual(snapshot.counts, { researcher: 1047, company: 153, publication: 10779, project: 1823, patent: 111, company_page: 917 });
  for (const [kind, id] of [['researcher', 'R0001'], ['company', 'C001'], ['publication', 'SYN-PUB-00001'],
    ['project', 'SYN-PRJ-0001'], ['patent', 'SYN-PAT-001'], ['company_page', 'company-page:1']]) {
    const located = snapshot.getRecord(kind, id); assert.ok(located, `${kind}/${id}`); assert.equal(located.recordId, id);
  }
  assert.equal(snapshot.getRecord('researcher', 'Natalija Fejsa'), undefined, 'No name-to-ID fallback');
  assert.equal(snapshot.getRecord('researcher', 'null'), undefined);
  for (const file of snapshot.files) assert.equal(file.sourceFileSha256, hashes[file.file]);
  assert.ok(snapshot.diagnostics.some(d => d.code === 'PROFILE_LINK_ASYMMETRY' && d.recordId === 'R0139'));
  assert.ok(snapshot.diagnostics.some(d => d.code === 'NAME_COLLISION'));
});

test('snapshot cannot be forged, mutate nested records, or expose mutable maps/raw buffers', async () => {
  const s = await data.loadSnapshot(root, commit), person = s.getRecord('researcher', 'R0001');
  assert.ok(Object.isFrozen(s)); assert.ok(Object.isFrozen(person.record)); assert.ok(Object.isFrozen(person.record.publications));
  assert.throws(() => { person.record.name = 'changed'; }, TypeError);
  assert.throws(() => { person.record.publications.push('fake'); }, TypeError);
  assert.equal('raw' in s, false); assert.equal('records' in s, false);
  assert.throws(() => data.assertSnapshot({ ...s }), e => e.code === 'UNTRUSTED_SNAPSHOT');
});

test('read-only record enumeration covers each actual source without guessing consecutive IDs', async () => {
  const s = await data.loadSnapshot(root, commit);
  for (const [kind, count] of Object.entries(s.counts)) {
    const rows = s.listRecords(kind);
    assert.equal(rows.length, count); assert.ok(Object.isFrozen(rows));
    assert.equal(new Set(rows.map(row => row.recordId)).size, count);
    for (const row of rows) assert.equal(s.getRecord(kind, row.recordId), row);
    assert.throws(() => rows.pop(), TypeError);
    assert.ok(rows.every(row => Object.isFrozen(row.record)));
  }
  assert.equal(s.listRecords('researcher').length, 1047);
});

test('source definitions cannot change the semantics of an already loaded snapshot', async () => {
  const s = await data.loadSnapshot(root, commit), row = s.getRecord('researcher', 'R0001');
  assert.ok(Object.isFrozen(SOURCE_DEFINITIONS[0]));
  assert.throws(() => { SOURCE_DEFINITIONS[0].kind = 'company'; }, TypeError);
  assert.equal(s.locateRecord({ file: row.file, recordId: row.recordId, locator: row.locator, fieldPointer: '/name', derivedRecordId: false }).record, row.record);
});

async function testCopy(t, change) {
  const copyRoot = await mkdtemp(join(tmpdir(), 'einstein-task3-copy-'));
  t.after(async () => {
    assert.equal(resolve(copyRoot, '..'), resolve(tmpdir())); assert.ok(basename(copyRoot).startsWith('einstein-task3-copy-'));
    await rm(copyRoot, { recursive: true, force: true });
  });
  await mkdir(join(copyRoot, 'data'));
  const bytes = new Map([...original].map(([name, value]) => [name, Buffer.from(value)]));
  if (change) change(bytes);
  for (const [name, value] of bytes) await writeFile(join(copyRoot, name), value);
  return { copyRoot, bytes, manifest: Object.fromEntries([...bytes].map(([name, value]) => [name, digest(value)])) };
}

test('explicit test copies preserve raw BOM/newlines and cannot masquerade as official data', async t => {
  const copy = await testCopy(t, bytes => bytes.set('data/researchers.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes.get('data/researchers.json')])));
  const s = await data.loadTestSnapshot(copy.copyRoot, { datasetCommit: commit, sourceFileSha256s: copy.manifest });
  assert.equal(s.sourcePolicy, 'test_copy'); assert.equal(s.files.find(f => f.file === 'data/researchers.json').sourceFileSha256, copy.manifest['data/researchers.json']);
  assert.notEqual(copy.manifest['data/researchers.json'], hashes['data/researchers.json']);
  await assert.rejects(data.loadSnapshot(copy.copyRoot, commit), e => e.code === 'NOT_DATA_REPOSITORY');
  const oldName = s.getRecord('researcher', 'R0001').record.name;
  await writeFile(join(copy.copyRoot, 'data/researchers.json'), '{}');
  assert.equal(s.getRecord('researcher', 'R0001').record.name, oldName);
  await assert.rejects(data.loadTestSnapshot(copy.copyRoot, { datasetCommit: commit, sourceFileSha256s: copy.manifest }), e => e.code === 'SOURCE_FILE_HASH_MISMATCH');
});

test('source failures distinguish wrong commit, absent file and byte tampering', async t => {
  await assert.rejects(data.loadSnapshot(root, 'a'.repeat(40)), e => e.code === 'WRONG_COMMIT');
  const copy = await testCopy(t);
  await writeFile(join(copy.copyRoot, 'data/patents.json'), Buffer.concat([copy.bytes.get('data/patents.json'), Buffer.from(' ')]));
  await assert.rejects(data.loadTestSnapshot(copy.copyRoot, { datasetCommit: commit, sourceFileSha256s: copy.manifest }), e => e.code === 'SOURCE_FILE_HASH_MISMATCH');
  await rm(join(copy.copyRoot, 'data/patents.json'));
  await assert.rejects(data.loadTestSnapshot(copy.copyRoot, { datasetCommit: commit, sourceFileSha256s: copy.manifest }), e => e.code === 'SOURCE_FILE_MISSING');
});

test('a root junction cannot redirect the source outside the selected snapshot', async t => {
  const copy = await testCopy(t), link = join(copy.copyRoot, 'linked');
  await symlink(root, link, 'junction');
  await assert.rejects(data.loadSnapshot(link, commit), e => e.code === 'UNSAFE_SOURCE_PATH');
});

test('matching HEAD and a clean Git status cannot hide altered source bytes', async t => {
  const container = await mkdtemp(join(tmpdir(), 'einstein-task3-gitcopy-'));
  t.after(async () => { assert.equal(resolve(container, '..'), resolve(tmpdir())); assert.ok(basename(container).startsWith('einstein-task3-gitcopy-')); await rm(container, { recursive: true, force: true }); });
  const copyRoot = join(container, 'repository');
  const copyGit = (...args) => execFileSync('git', ['--no-optional-locks', '-C', copyRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  // Keep checkout and subsequent status/add on the same fixture byte policy,
  // even when the caller's global autocrlf differs from this source checkout.
  execFileSync('git', ['--no-optional-locks', 'clone', '--no-hardlinks', '--no-checkout', '--config', 'core.autocrlf=true', root, copyRoot], { stdio: 'pipe', windowsHide: true });
  copyGit('checkout', '--detach', commit);
  copyGit('update-index', '--assume-unchanged', 'data/researchers.json');
  const altered = Buffer.concat([await readFile(join(copyRoot, 'data/researchers.json')), Buffer.from(' ')]);
  await writeFile(join(copyRoot, 'data/researchers.json'), altered);
  assert.equal(copyGit('rev-parse', 'HEAD').trim(), commit); assert.equal(copyGit('status', '--porcelain=v1').trim(), '');
  await assert.rejects(data.loadSnapshot(copyRoot, commit), e => e.code === 'SOURCE_FILE_HASH_MISMATCH');
  assert.equal(digest(await readFile(join(copyRoot, 'data/researchers.json'))), digest(altered), 'No repair of test copy');
});

test('Git replacement objects cannot redefine the official pinned commit contents', async t => {
  const container = await mkdtemp(join(tmpdir(), 'einstein-task3-replace-'));
  t.after(async () => { assert.equal(resolve(container, '..'), resolve(tmpdir())); assert.ok(basename(container).startsWith('einstein-task3-replace-')); await rm(container, { recursive: true, force: true }); });
  const copyRoot = join(container, 'repository');
  const copyGit = (...args) => execFileSync('git', ['--no-optional-locks', '-C', copyRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  execFileSync('git', ['--no-optional-locks', 'clone', '--no-hardlinks', '--no-checkout', '--config', 'core.autocrlf=true', root, copyRoot], { stdio: 'pipe', windowsHide: true });
  copyGit('checkout', '--detach', commit);
  const bytes = Buffer.concat([await readFile(join(copyRoot, 'data/researchers.json')), Buffer.from(' ')]);
  await writeFile(join(copyRoot, 'data/researchers.json'), bytes);
  copyGit('add', '--', 'data/researchers.json');
  const tree = copyGit('write-tree');
  const replacement = copyGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit-tree', tree, '-m', 'Explicit Task3 replacement attack fixture');
  copyGit('replace', commit, replacement);
  assert.equal(copyGit('rev-parse', 'HEAD'), commit); assert.equal(copyGit('status', '--porcelain=v1'), '');
  await assert.rejects(data.loadSnapshot(copyRoot, commit), e => ['DIRTY_DATA', 'SOURCE_FILE_HASH_MISMATCH'].includes(e.code));
});

test('parse errors, duplicate IDs and dangling non-null IDs fail on explicit copies', async t => {
  for (const [code, mutate] of [
    ['INVALID_UTF8', bytes => bytes.set('data/publications.jsonl', Buffer.from([0xff]))],
    ['INVALID_JSONL', bytes => { const text = bytes.get('data/publications.jsonl').toString('utf8'); bytes.set('data/publications.jsonl', Buffer.from(text.replace('\n', '\n\n'))); }],
    ['DUPLICATE_RECORD_ID', bytes => { const doc = JSON.parse(bytes.get('data/researchers.json').toString('utf8')); doc.researchers[1].id = doc.researchers[0].id; bytes.set('data/researchers.json', Buffer.from(JSON.stringify(doc))); }],
    ['DANGLING_REFERENCE', bytes => { const doc = JSON.parse(bytes.get('data/researchers.json').toString('utf8')); doc.researchers[0].publications.push('SYN-PUB-99999'); bytes.set('data/researchers.json', Buffer.from(JSON.stringify(doc))); }],
  ]) {
    const copy = await testCopy(t, mutate);
    await assert.rejects(data.loadTestSnapshot(copy.copyRoot, { datasetCommit: commit, sourceFileSha256s: copy.manifest }), e => e.code === code, code);
  }
});

test('all original file bytes and dataset Git state remain unchanged', async () => {
  for (const [name, bytes] of original) assert.equal(digest(await readFile(join(root, name))), digest(bytes), name);
  assert.equal(git('rev-parse', 'HEAD'), before.head); assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), before.status);
});
