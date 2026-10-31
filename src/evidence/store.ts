import { canonicalizeArtifact, sliceCodePoints } from '../contracts/canonical.js';
import { EvidenceSchema, EvidenceSnapshotSchema, SourceRefSchema, type Evidence, type SourceRef } from '../contracts/domain.js';
import { CANONICALIZATION_VERSION } from '../contracts/primitives.js';
import { assertSnapshot, type DatasetSnapshot } from '../data/snapshot.js';
import { SourceError, deepFreeze, resolvePointer, type FrozenJson, type LocatedRecord } from '../data/records.js';
import { hashArtifact, sha256Bytes } from './hashing.js';

export type DeepReadonly<T> = T extends readonly (infer V)[] ? readonly DeepReadonly<V>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type EvidenceSnapshot = readonly DeepReadonly<Evidence>[];
export type ResolvedField = Readonly<{ value: FrozenJson; valueType: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';
  text: string; located: LocatedRecord; source: DeepReadonly<SourceRef> }>;

/** Full original typed field is retained. Only genuine strings support code-point slices. */
export function resolveField(ref: unknown, snapshot: DatasetSnapshot): ResolvedField {
  assertSnapshot(snapshot);
  try { canonicalizeArtifact(ref); } catch { throw new SourceError('INVALID_SOURCE_REF', 'location', 'SourceRef must be strict JSON.'); }
  const parsed = SourceRefSchema.safeParse(ref);
  if (!parsed.success) throw new SourceError('INVALID_SOURCE_REF', 'location', 'SourceRef does not satisfy the shared contract.');
  const source = parsed.data, located = snapshot.locateRecord(source);
  const value = resolvePointer(located.record, source.fieldPointer);
  const valueType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value as ResolvedField['valueType'];
  if (source.codePointRange && typeof value !== 'string') throw new SourceError('RANGE_REQUIRES_STRING', 'location', 'Code-point ranges apply only to original strings.');
  let text: string;
  try {
    text = typeof value === 'string' ? source.codePointRange
      ? sliceCodePoints(value, ...source.codePointRange) : value : canonicalizeArtifact(value);
  } catch { throw new SourceError('INVALID_CODE_POINT_RANGE', 'location', 'Range exceeds the original string code points.'); }
  return deepFreeze({ value, valueType, text, located, source });
}

export function resolveEvidence(ref: unknown, snapshot: DatasetSnapshot): Evidence {
  const field = resolveField(ref, snapshot);
  if (!field.text.trim()) throw new SourceError('EMPTY_EVIDENCE_FIELD', 'insufficient', 'The selected source excerpt is empty; original data remains valid and unchanged.');
  if (field.text.length > 16_384) throw new SourceError('EXCERPT_REQUIRES_NARROWER_SOURCE', 'insufficient', 'Select an explicit string range or a smaller original child field; no implicit truncation is performed.');
  const sourceFileSha256 = snapshot.files.find(file => file.file === field.located.file)!.sourceFileSha256;
  const excerptSha256 = sha256Bytes(new TextEncoder().encode(field.text));
  const identity = { datasetCommit: snapshot.datasetCommit, source: field.source,
    sourceFileSha256, recordSha256: field.located.recordSha256, excerptSha256 };
  const parsed = EvidenceSchema.safeParse({ ...identity, id: `ev-${hashArtifact(identity)}`, excerpt: field.text,
    canonicalizationVersion: CANONICALIZATION_VERSION });
  if (!parsed.success) throw new SourceError('UNREPRESENTABLE_EXCERPT', 'location', 'Resolved source cannot be represented by the existing Evidence contract.');
  return deepFreeze(parsed.data);
}

/** Owned immutable copy; does not freeze or modify the caller's array/objects. */
export function createEvidenceSnapshot(value: unknown): EvidenceSnapshot {
  try { canonicalizeArtifact(value); } catch { throw new SourceError('INVALID_EVIDENCE_SNAPSHOT', 'source', 'Evidence snapshot must contain strict JSON.'); }
  const parsed = EvidenceSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new SourceError('INVALID_EVIDENCE_SNAPSHOT', 'source', 'Evidence snapshot has invalid or duplicate entries.');
  return deepFreeze(parsed.data);
}
