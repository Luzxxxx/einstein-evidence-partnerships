import { readFile, lstat, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DATASET_COMMIT, HashSchema } from '../contracts/primitives.js';
import { SourceRefSchema, type SourceRef } from '../contracts/domain.js';
import { sha256Bytes } from '../evidence/hashing.js';
import { SOURCE_DEFINITIONS, SourceError, deepFreeze, parseSource, resolvePointer,
  arrayValue, stringIds, objectValue, type SourceFile, type EntityKind, type LocatedRecord,
  type FrozenJson, type Diagnostic } from './records.js';
export { SourceError } from './records.js';
const execFileAsync = promisify(execFile);
const handles = new WeakSet<object>();
export type DatasetSnapshot = Readonly<{
  datasetCommit: typeof DATASET_COMMIT; sourcePolicy: 'official' | 'test_copy';
  files: readonly Readonly<{ file: SourceFile; sourceFileSha256: string; byteLength: number }>[];
  counts: Readonly<Record<EntityKind, number>>; diagnostics: readonly Diagnostic[];
  getRecord(kind: EntityKind, id: string): LocatedRecord | undefined;
  listRecords(kind: EntityKind): readonly LocatedRecord[];
  locateRecord(ref: SourceRef): LocatedRecord;
}>;
export function assertSnapshot(value: unknown): asserts value is DatasetSnapshot {
  if (!value || typeof value !== 'object' || !handles.has(value)) throw new SourceError('UNTRUSTED_SNAPSHOT', 'source', 'Expected a loader-created immutable snapshot.');
}
async function git(root: string, args: string[], binary = false): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync('git', ['--no-optional-locks', '--no-replace-objects', '-C', root, ...args],
      { encoding: 'buffer', windowsHide: true, timeout: 15_000, maxBuffer: binary ? 40 * 1024 * 1024 : 1024 * 1024 });
    return stdout;
  } catch { throw new SourceError('NOT_DATA_REPOSITORY', 'source', 'Cannot read the selected local data repository.'); }
}
async function safePath(root: string, file?: SourceFile): Promise<string> {
  if (!isAbsolute(root)) throw new SourceError('UNSAFE_SOURCE_PATH', 'source', 'Snapshot root must be absolute.');
  const base = resolve(root), target = file ? join(base, file) : base;
  const components = file ? [base, join(base, 'data'), target] : [base];
  for (const path of components) {
    let info;
    try { info = await lstat(path); }
    catch { throw new SourceError('SOURCE_FILE_MISSING', 'source', 'A required source path is missing.'); }
    if (info.isSymbolicLink() || (path === target && file ? !info.isFile() : !info.isDirectory()))
      throw new SourceError('UNSAFE_SOURCE_PATH', 'source', 'Source must use regular files and directories, without links.');
  }
  const realBase = await realpath(base), realTarget = await realpath(target);
  const rel = relative(realBase, realTarget);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new SourceError('UNSAFE_SOURCE_PATH', 'source', 'Source escaped its snapshot root.');
  return target;
}

/** Git LF blob and its deterministic Windows CRLF checkout are the same pinned text.
 * This comparison NEVER supplies sourceFileSha256: that always hashes actual read bytes. */
function matchesBlob(raw: Buffer, blob: Buffer): boolean {
  if (raw.equals(blob)) return true;
  let offset = 0;
  for (let i = 0; i < blob.length; i++) {
    if (blob[i] === 10 && blob[i - 1] !== 13 && raw[offset++] !== 13) return false;
    if (raw[offset++] !== blob[i]) return false;
  }
  return offset === raw.length;
}
function assemble(raw: Map<SourceFile, Buffer>, sourcePolicy: DatasetSnapshot['sourcePolicy']): DatasetSnapshot {
  const indexes = new Map<EntityKind, Map<string, LocatedRecord>>(), documents = new Map<SourceFile, FrozenJson>();
  const counts = {} as Record<EntityKind, number>;
  const files = SOURCE_DEFINITIONS.map(definition => {
    const bytes = raw.get(definition.file)!, parsed = parseSource(definition.file, bytes);
    documents.set(definition.file, parsed.document);
    indexes.set(definition.kind, new Map(parsed.records.map(record => [record.recordId, record])));
    counts[definition.kind] = parsed.records.length;
    return { file: definition.file, sourceFileSha256: sha256Bytes(bytes), byteLength: bytes.length };
  });
  const diagnostics: Diagnostic[] = [];
  const lookup = (kind: EntityKind, id: string) => indexes.get(kind)!.get(id);
  const requireId = (kind: EntityKind, id: unknown) => {
    if (typeof id !== 'string' || !lookup(kind, id)) throw new SourceError('DANGLING_REFERENCE', 'source', 'An explicit source ID has no matching record.');
    return id;
  };
  for (const person of indexes.get('researcher')!.values()) {
    for (const [field, kind] of [['publications', 'publication'], ['projects', 'project'], ['patents', 'patent']] as const)
      for (const id of stringIds(person.record[field])) {
        requireId(kind, id);
        const row = lookup(kind, id)!;
        const relation = kind === 'publication' ? 'authors' : kind === 'project' ? 'participants' : 'inventors';
        if (!arrayValue(row.record[relation]).some(v => objectValue(v).researcher_id === person.recordId))
          diagnostics.push({ code: 'PROFILE_LINK_ASYMMETRY', file: person.file, recordId: person.recordId, relatedId: id,
            message: 'Profile lists a result, but its explicit participant IDs do not confirm this researcher.' });
      }
  }
  for (const [kind, relation, reverse] of [['publication', 'authors', 'publications'], ['project', 'participants', 'projects'], ['patent', 'inventors', 'patents']] as const)
    for (const row of indexes.get(kind)!.values()) for (const value of arrayValue(row.record[relation])) {
      const id = objectValue(value).researcher_id;
      if (id === null) { diagnostics.push({ code: 'IDENTITY_UNRESOLVED', file: row.file, recordId: row.recordId, message: 'A participant has no internal researcher ID; names are not merged.' }); continue; }
      const rid = requireId('researcher', id);
      if (!stringIds(lookup('researcher', rid)!.record[reverse]).includes(row.recordId))
        diagnostics.push({ code: 'RESULT_LINK_ASYMMETRY', file: row.file, recordId: row.recordId, relatedId: rid, message: 'Explicit result participant is not listed by the profile.' });
    }
  const challenges = new Set<string>();
  for (const company of indexes.get('company')!.values()) for (const v of arrayValue(company.record.challenges)) {
    const id = objectValue(v).id;
    if (typeof id !== 'string' || !id.startsWith(`${company.recordId}-CH`) || challenges.has(id))
      throw new SourceError('INVALID_CHALLENGE_ID', 'source', 'Invalid or duplicate company challenge ID.');
    challenges.add(id);
  }
  for (const page of indexes.get('company_page')!.values()) requireId('company', page.record.company_id);
  const byName = new Map<string, string[]>();
  for (const person of indexes.get('researcher')!.values()) {
    if (typeof person.record.name !== 'string') throw new SourceError('INVALID_RECORD', 'source', 'Researcher name must remain a source string.');
    const ids = byName.get(person.record.name) ?? []; ids.push(person.recordId); byName.set(person.record.name, ids);
  }
  for (const ids of byName.values()) if (ids.length > 1) for (const id of ids)
    diagnostics.push({ code: 'NAME_COLLISION', file: 'data/researchers.json', recordId: id, message: 'Exact same name has separate IDs; no merge performed.' });
  const snapshot: DatasetSnapshot = {
    datasetCommit: DATASET_COMMIT, sourcePolicy, files, counts, diagnostics,
    getRecord: lookup,
    listRecords(kind: EntityKind) {
      const index = indexes.get(kind);
      if (!index) throw new SourceError('INVALID_ENTITY_KIND', 'source', 'Unknown source entity kind.');
      return Object.freeze([...index.values()]);
    },
    locateRecord(ref: SourceRef) {
      const parsed = SourceRefSchema.safeParse(ref);
      if (!parsed.success) throw new SourceError('INVALID_SOURCE_REF', 'location', 'SourceRef does not satisfy the shared contract.');
      const r = parsed.data;
      const doc = documents.get(r.file)!;
      const value = r.locator.format === 'json' ? resolvePointer(doc, r.locator.jsonPointer)
        : arrayValue(doc)[r.locator.line1Based - 1];
      if (!value) throw new SourceError('RECORD_NOT_FOUND', 'location', 'No record at this source locator.');
      const definition = SOURCE_DEFINITIONS.find(d => d.file === r.file)!;
      const located = lookup(definition.kind, r.recordId);
      if (!located || located.record !== value || located.derivedRecordId !== r.derivedRecordId)
        throw new SourceError('RECORD_ID_MISMATCH', 'location', 'Locator, source record ID and derived-ID flag must identify the same record.');
      return located;
    },
  };
  deepFreeze(files); deepFreeze(counts); deepFreeze(diagnostics); Object.freeze(snapshot); handles.add(snapshot);
  return snapshot;
}

export async function loadSnapshot(root: string, expectedCommit: string): Promise<DatasetSnapshot> {
  if (expectedCommit !== DATASET_COMMIT) throw new SourceError('WRONG_COMMIT', 'source', 'Only the approved pinned dataset commit is supported.');
  await safePath(root);
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  if ((await realpath(top)).toLowerCase() !== (await realpath(root)).toLowerCase()) throw new SourceError('NOT_DATA_REPOSITORY', 'source', 'Snapshot must be the repository root.');
  const checkVersion = async () => {
    if ((await git(root, ['rev-parse', '--verify', 'HEAD'])).toString('utf8').trim() !== expectedCommit) throw new SourceError('WRONG_COMMIT', 'source', 'Dataset HEAD differs from its approved commit.');
    if ((await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).length) throw new SourceError('DIRTY_DATA', 'source', 'Dataset changes are refused and left untouched.');
  };
  await checkVersion();
  const raw = new Map<SourceFile, Buffer>();
  for (const { file } of SOURCE_DEFINITIONS) {
    const bytes = await readFile(await safePath(root, file));
    const blob = await git(root, ['cat-file', 'blob', `${expectedCommit}:${file}`], true);
    if (!matchesBlob(bytes, blob)) throw new SourceError('SOURCE_FILE_HASH_MISMATCH', 'source', 'Source bytes do not match the pinned blob or its CRLF checkout.');
    raw.set(file, bytes);
  }
  await checkVersion();
  return assemble(raw, 'official');
}

/** Test-only, explicitly labelled copy loader. No CLI, environment or automatic fallback selects it.
 * Its caller-supplied manifest authenticates a fixture, NEVER the official repository. */
export async function loadTestSnapshot(root: string, manifest: { datasetCommit: string; sourceFileSha256s: Record<string, string> }): Promise<DatasetSnapshot> {
  if (manifest.datasetCommit !== DATASET_COMMIT) throw new SourceError('WRONG_COMMIT', 'source', 'Test copy must declare its baseline.');
  await safePath(root);
  const raw = new Map<SourceFile, Buffer>();
  for (const { file } of SOURCE_DEFINITIONS) {
    const expected = manifest.sourceFileSha256s[file];
    if (!HashSchema.safeParse(expected).success) throw new SourceError('INVALID_MANIFEST', 'source', 'Test copy requires every exact source-file hash.');
    const bytes = await readFile(await safePath(root, file));
    if (sha256Bytes(bytes) !== expected) throw new SourceError('SOURCE_FILE_HASH_MISMATCH', 'source', 'Test-copy bytes differ from the declared manifest.');
    raw.set(file, bytes);
  }
  return assemble(raw, 'test_copy');
}
