import { createHash } from 'node:crypto';
import { canonicalizeArtifact } from '../contracts/canonical.js';
import { RunInputSchema, CandidatePoolSchema, UnhashedCandidatePoolSchema, EvidenceSnapshotSchema } from '../contracts/domain.js';

// Contract v1: only the artifact root's own hashes and these recording times are excluded.
// Nested Critic targets, Evidence hashes/times and all other root fields remain bound.
const ROOT_RECORDING_FIELDS = new Set(['hash', 'draftHash', 'createdAt', 'recordedAt', 'committedAt']);

/** Hash exactly these raw bytes, including their BOM/newlines and Uint8Array view boundaries.
 * Callers obtaining sourceFileSha256 must supply the entire source file's original bytes.
 * This helper never reads files or substitutes a canonical record/excerpt hash.
 */
export function sha256Bytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('SHA-256 input must be Uint8Array bytes.');
  return createHash('sha256').update(bytes).digest('hex');
}

/** Hash a plain JSON artifact, validating every original field before root projection.
 * Never use for source recordSha256: ordinary source hash/time fields must remain bound. */
export function hashArtifact(artifact: unknown): string {
  canonicalizeArtifact(artifact);
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact))
    throw new TypeError('Artifact root must be a plain JSON object.');

  const projected: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(artifact))) {
    if (!ROOT_RECORDING_FIELDS.has(key)) projected[key] = descriptor.value;
  }
  return sha256Bytes(new TextEncoder().encode(canonicalizeArtifact(projected)));
}

/** Parsed source record: every canonical field participates; distinct from raw source-file bytes. */
export function hashSourceRecord(record: unknown): string {
  return sha256Bytes(new TextEncoder().encode(canonicalizeArtifact(record)));
}

/** Client selection + pinned trusted configuration, excluding only the per-Run identity. */
export function hashRunInput(value: unknown): string {
  canonicalizeArtifact(value);
  const { runId: _runId, ...content } = RunInputSchema.parse(value);
  return hashSourceRecord(content);
}

/** Do not omit poolHash globally: a draft/review MUST bind its referenced poolHash. */
export function hashCandidatePool(value: unknown): string {
  canonicalizeArtifact(value);
  const parsed = CandidatePoolSchema.safeParse(value);
  if (!parsed.success) return hashSourceRecord(UnhashedCandidatePoolSchema.parse(value));
  const { poolHash: _poolHash, ...content } = parsed.data;
  return hashSourceRecord(content);
}

export function hashEvidenceSnapshot(value: unknown): string {
  canonicalizeArtifact(value);
  return hashSourceRecord(EvidenceSnapshotSchema.parse(value));
}
