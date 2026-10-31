import {
  ArtifactBundleSchema, ReviewActorSchema, RunRecordSchema,
  type ReviewExpectation,
} from '../contracts/domain.js';
import { TimestampSchema } from '../contracts/primitives.js';
import { canonicalizeArtifact } from '../contracts/canonical.js';
import { assertSnapshot, type DatasetSnapshot } from '../data/snapshot.js';
import { validateClaimSources } from '../evidence/validate.js';
import {
  hashArtifact, hashCandidatePool, hashEvidenceSnapshot, hashRunInput,
} from '../evidence/hashing.js';

export type PublishDecision = { allowed: true } | { allowed: false; reasons: string[] };
/** All fields are checked at the trust boundary. `actor` must be obtained by the
 * parent from the authenticated worker's dispatched/completed Critic task, never
 * copied from a worker outcome's claim to have been reviewed.
 *
 * The parent supplies a newly source-verified official DatasetSnapshot and owns
 * cancellation/deadline arbitration, cleanup identity proof and atomic writing.
 * This pure function grants qualification only; it never publishes or writes.
 */
export type PublicationInput = {
  draft: unknown; review: unknown; run: unknown; counter: unknown; pool: unknown;
  evidenceSnapshotHash: unknown; evidence: unknown; snapshot: DatasetSnapshot;
  actor: ReviewExpectation['actor']; now?: string;
};

/** Unique publication qualification entry. A structurally valid source is not a
 * semantic judgement: only the captured independent Critic approves semantics.
 * Adversarial/offline qualification remains diagnostic; Showcase eligibility is
 * a separate, stricter research/live export boundary owned by the parent.
 */
export function evaluatePublication(value: unknown): PublishDecision {
  const reasons: string[] = [];
  const reject = (reason: string) => { if (!reasons.includes(reason)) reasons.push(reason); };
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { allowed: false, reasons: ['PUBLICATION_INPUT_INVALID'] };
    const raw = value as Record<string, unknown>;
    for (const field of ['draft', 'review', 'run', 'counter', 'pool', 'evidence', 'actor']) canonicalizeArtifact(raw[field]);
    assertSnapshot(raw.snapshot);
    if (raw.snapshot.sourcePolicy !== 'official') reject('OFFICIAL_SOURCE_REQUIRED');
    const run = RunRecordSchema.safeParse(raw.run), actor = ReviewActorSchema.safeParse(raw.actor);
    if (!run.success || !actor.success) return { allowed: false, reasons: ['RUN_OR_ACTOR_INVALID'] };
    const state = run.data;
    const bundle = ArtifactBundleSchema.safeParse({
      input: state.input, inputHash: state.inputHash, pool: raw.pool, draft: raw.draft,
      counter: raw.counter, review: raw.review, evidence: raw.evidence, evidenceSnapshotHash: raw.evidenceSnapshotHash,
    });
    if (!bundle.success) return { allowed: false, reasons: ['PUBLICATION_BUNDLE_INVALID'] };
    const { input, pool, draft, counter, review, evidence, evidenceSnapshotHash } = bundle.data;
    if (state.status !== 'reviewing') reject('RUN_NOT_REVIEWING');
    if (state.cleanupState !== 'confirmed') reject('CLEANUP_UNCONFIRMED');
    if (state.publishedDraftHash) reject('PUBLICATION_ALREADY_COMMITTED');
    if (!state.admittedAt || !state.deadlineAt || Date.parse(state.deadlineAt) <= Date.parse(state.admittedAt)) reject('RUN_DEADLINE_INVALID');
    if (raw.now !== undefined) {
      const now = TimestampSchema.safeParse(raw.now);
      if (!now.success || !state.deadlineAt || Date.parse(now.data) >= Date.parse(state.deadlineAt)) reject('RUN_DEADLINE_EXPIRED');
    }
    const expectation = state.reviewExpectation;
    if (!expectation) reject('REVIEW_EXPECTATION_MISSING');
    else {
      if (actor.data.role !== 'critic' || canonicalizeArtifact(actor.data) !== canonicalizeArtifact(expectation.actor)) reject('REVIEW_ACTOR_MISMATCH');
      if (expectation.reviewVersion !== state.revisionCount + 1 || review.version !== expectation.reviewVersion
        || actor.data.attempt !== expectation.reviewVersion || draft.version !== expectation.reviewVersion) reject('REVIEW_ROUND_MISMATCH');
      if (canonicalizeArtifact(review.target) !== canonicalizeArtifact(expectation.target)) reject('REVIEW_TARGET_MISMATCH');
    }
    if (review.verdict !== 'approve' || review.findings.some(finding => finding.severity === 'blocking')) reject('REVIEW_NOT_APPROVED');
    if (!state.acceptedReview || canonicalizeArtifact(state.acceptedReview) !== canonicalizeArtifact(review)) reject('REVIEW_NOT_ACCEPTED');
    if (state.runId !== input.runId || review.runId !== state.runId) reject('RUN_ID_MISMATCH');
    if (hashRunInput(input) !== state.inputHash) reject('INPUT_HASH_MISMATCH');
    if (hashCandidatePool(pool) !== pool.poolHash) reject('POOL_HASH_MISMATCH');
    if (hashArtifact(draft) !== draft.draftHash) reject('DRAFT_HASH_MISMATCH');
    if (hashArtifact(counter) !== counter.hash) reject('COUNTER_HASH_MISMATCH');
    if (hashArtifact(review) !== review.hash) reject('REVIEW_HASH_MISMATCH');
    if (hashEvidenceSnapshot(evidence) !== evidenceSnapshotHash) reject('EVIDENCE_SNAPSHOT_HASH_MISMATCH');
    if (input.datasetCommit !== raw.snapshot.datasetCommit) reject('SOURCE_COMMIT_MISMATCH');
    const sourceIssues = validateClaimSources(draft, raw.snapshot, evidence);
    for (const issue of sourceIssues) if (issue.severity === 'error') reject(`SOURCE_${issue.code}`);
    return reasons.length ? { allowed: false, reasons } : { allowed: true };
  } catch {
    // Neither source text, model output, local paths nor arbitrary exception
    // messages are copied into this externally consumed decision.
    return { allowed: false, reasons: ['PUBLICATION_INPUT_INVALID'] };
  }
}
