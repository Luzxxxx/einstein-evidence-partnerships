import { canonicalizeArtifact } from '../contracts/canonical.js';
import { JsonPointerSchema } from '../contracts/primitives.js';
import type { JsonValue } from '../contracts/primitives.js';
import type { SourceRef } from '../contracts/domain.js';
import { hashSourceRecord } from '../evidence/hashing.js';

export type SourceFile = SourceRef['file'];
export type EntityKind = 'researcher' | 'company' | 'publication' | 'project' | 'patent' | 'company_page';
export type FrozenJson = null | boolean | number | string | readonly FrozenJson[] | { readonly [key: string]: FrozenJson };
export type RecordObject = { readonly [key: string]: FrozenJson };
export type LocatedRecord = Readonly<{ file: SourceFile; recordId: string; locator: SourceRef['locator'];
  record: RecordObject; recordSha256: string; derivedRecordId: boolean }>;
export type Diagnostic = Readonly<{ code: string; recordId: string; relatedId?: string; file: SourceFile; message: string }>;
export class SourceError extends Error {
  constructor(public readonly code: string, public readonly category: 'source' | 'location' | 'insufficient', message: string) {
    super(message); this.name = 'SourceError';
  }
}
export const SOURCE_DEFINITIONS = deepFreeze([
  { file: 'data/researchers.json', kind: 'researcher', collection: 'researchers', idPattern: '^R\\d{4}$' },
  { file: 'data/companies.json', kind: 'company', collection: 'companies', idPattern: '^C\\d{3}$' },
  { file: 'data/publications.jsonl', kind: 'publication', collection: null, idPattern: '^SYN-PUB-\\d{5}$' },
  { file: 'data/projects.json', kind: 'project', collection: 'projects', idPattern: '^SYN-PRJ-\\d{4}$' },
  { file: 'data/patents.json', kind: 'patent', collection: 'patents', idPattern: '^SYN-PAT-\\d{3}$' },
  { file: 'data/company-pages.jsonl', kind: 'company_page', collection: null, idPattern: '^company-page:[1-9]\\d*$' },
] as const);

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export function objectValue(value: FrozenJson, code = 'INVALID_RECORD'): RecordObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceError(code, 'source', 'Expected a source record object.');
  return value as RecordObject;
}
export function arrayValue(value: FrozenJson | undefined): readonly FrozenJson[] {
  if (!Array.isArray(value)) throw new SourceError('INVALID_RECORD', 'source', 'Expected an original source array.');
  return value;
}
export function stringIds(value: FrozenJson | undefined): readonly string[] {
  const list = arrayValue(value);
  if (list.some(id => typeof id !== 'string')) throw new SourceError('INVALID_RECORD', 'source', 'Entity IDs must be original strings, never coerced.');
  return list as readonly string[];
}
/** RFC6901 traversal is own-property only; no prototype lookup or index clipping. */
export function resolvePointer(value: FrozenJson, pointer: string): FrozenJson {
  if (!JsonPointerSchema.safeParse(pointer).success) throw new SourceError('INVALID_POINTER', 'location', 'Invalid project JSON pointer.');
  if (pointer === '') return value;
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const token = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object') throw new SourceError('FIELD_NOT_FOUND', 'location', 'Pointer traverses a scalar.');
    if (Array.isArray(current) && (!/^(0|[1-9]\d*)$/.test(token) || !Number.isSafeInteger(Number(token))))
      throw new SourceError('INVALID_POINTER', 'location', 'Array index must be a safe unsigned integer.');
    if (!Object.hasOwn(current, token)) throw new SourceError('FIELD_NOT_FOUND', 'location', 'Pointer field does not exist.');
    current = (current as RecordObject)[token];
  }
  return current;
}

export function parseSource(file: SourceFile, bytes: Uint8Array): { document: FrozenJson; records: readonly LocatedRecord[] } {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new SourceError('INVALID_UTF8', 'source', `Invalid UTF-8 in ${file}.`); }
  const definition = SOURCE_DEFINITIONS.find(d => d.file === file)!;
  const parse = (json: string): JsonValue => {
    try { const value: unknown = JSON.parse(json); canonicalizeArtifact(value); return value as JsonValue; }
    catch { throw new SourceError(file.endsWith('.jsonl') ? 'INVALID_JSONL' : 'INVALID_JSON', 'source', `Invalid strict JSON in ${file}.`); }
  };
  let document: FrozenJson;
  if (definition.collection) document = parse(text);
  else {
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop(); // Only the final line terminator is not a record.
    if (lines.some(line => !line.trim())) throw new SourceError('INVALID_JSONL', 'source', 'An empty physical JSONL record cannot be skipped.');
    document = lines.map(parse);
  }
  const rows = definition.collection ? arrayValue(objectValue(document)[definition.collection]) : arrayValue(document);
  const seen = new Set<string>();
  const idPattern = new RegExp(definition.idPattern);
  const records = rows.map((value, index): LocatedRecord => {
    const record = objectValue(value);
    const derived = definition.kind === 'company_page';
    const id = derived ? `company-page:${index + 1}` : record.id;
    if (typeof id !== 'string' || !idPattern.test(id)) throw new SourceError('INVALID_RECORD_ID', 'source', `Invalid source ID in ${file}.`);
    if (seen.has(id)) throw new SourceError('DUPLICATE_RECORD_ID', 'source', `Duplicate record ID in ${file}.`);
    seen.add(id);
    if (derived && Object.hasOwn(record, 'id')) throw new SourceError('INVALID_RECORD_ID', 'source', 'Derived page ID cannot replace an original ID.');
    return { file, recordId: id, record, recordSha256: hashSourceRecord(record), derivedRecordId: derived,
      locator: definition.collection ? { format: 'json', jsonPointer: `/${definition.collection}/${index}` }
        : { format: 'jsonl', line1Based: index + 1 } };
  });
  deepFreeze(document); deepFreeze(records);
  return { document, records };
}
