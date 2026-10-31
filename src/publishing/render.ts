import { ProposalDraftSchema } from '../contracts/domain.js';
import { canonicalizeArtifact } from '../contracts/canonical.js';
import { hashArtifact } from '../evidence/hashing.js';

/** Complete deterministic JSON rendering, version canonical-json-draft-v1.
 * Every reviewed field participates, including all optional sections, stage and
 * validation text, Claim limitations and source bindings. This is a renderer,
 * not publication authorization; the parent must first evaluatePublication and
 * atomically commit the same approved snapshot. No model rewriting occurs.
 */
export function renderApprovedDraft(value: unknown): string {
  canonicalizeArtifact(value);
  const draft = ProposalDraftSchema.parse(value);
  if (hashArtifact(draft) !== draft.draftHash) throw new Error('DRAFT_HASH_MISMATCH');
  return canonicalizeArtifact(draft) + '\n';
}
