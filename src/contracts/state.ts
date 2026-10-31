/** Pure application rules only: no Runtime, I/O, supervisor or publishing implementation. */
import { z } from 'zod';
import { RunRecordSchema, CriticReviewSchema, ReviewExpectationSchema, ReviewActorSchema,
  type RunRecord, type ReviewExpectation } from './domain.js';
import { UuidSchema, PositiveCountSchema, ArtifactIdSchema, HashSchema, TextSchema } from './primitives.js';

const eventBase = { runId: UuidSchema, seq: PositiveCountSchema };
export const RunTransitionSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...eventBase, action: z.literal('start') }),
  z.strictObject({ ...eventBase, action: z.literal('begin_review'), expectation: ReviewExpectationSchema }),
  z.strictObject({ ...eventBase, action: z.literal('review_result'), actor: ReviewActorSchema, review: CriticReviewSchema }),
  z.strictObject({ ...eventBase, action: z.literal('publication_committed'), reviewId: ArtifactIdSchema,
    reviewHash: HashSchema, draftHash: HashSchema }),
  z.strictObject({ ...eventBase, action: z.literal('cleanup_confirmed') }),
  z.strictObject({ ...eventBase, action: z.literal('cancel') }),
  z.strictObject({ ...eventBase, action: z.literal('fail'), reason: TextSchema }),
  z.strictObject({ ...eventBase, action: z.literal('insufficient'), reason: TextSchema }),
]);
const terminal = new Set(['approved', 'insufficient', 'failed', 'cancelled']);

export function validateReviewBinding(review: unknown, expectation: unknown, runId: string): string[] {
  const r = CriticReviewSchema.safeParse(review), e = ReviewExpectationSchema.safeParse(expectation);
  if (!r.success || !e.success) return ['invalid_review_or_expectation'];
  const errors: string[] = [];
  if (r.data.runId !== runId) errors.push('runId');
  if (r.data.version !== e.data.reviewVersion) errors.push('reviewVersion');
  for (const key of Object.keys(e.data.target) as (keyof ReviewExpectation['target'])[])
    if (r.data.target[key] !== e.data.target[key]) errors.push(key);
  return errors;
}

export type TransitionResult = { kind: 'changed' | 'ignored'; state: RunRecord; reason: string };

/** Caller must authenticate control events/actors before this guard (Task5/6).
 * Schemas and hash equality do not authenticate a Critic, read bytes, or commit a proposal.
 */
export function transitionRun(input: unknown, incoming: unknown): TransitionResult {
  const current = RunRecordSchema.parse(input);
  const parsed = RunTransitionSchema.safeParse(incoming);
  if (!parsed.success) return { kind: 'ignored', state: current, reason: 'invalid_event' };
  const event = parsed.data;
  if (event.runId !== current.runId) return { kind: 'ignored', state: current, reason: 'wrong_run' };
  if (event.seq <= current.lastSeq) return { kind: 'ignored', state: current, reason: 'duplicate_or_old_sequence' };
  const next = { ...current, lastSeq: event.seq };
  const ignore = (reason: string): TransitionResult => ({ kind: 'ignored', state: next, reason });
  const changed = (): TransitionResult => ({ kind: 'changed', state: RunRecordSchema.parse(next), reason: event.action });

  // Terminal status is immutable; cleanup acknowledgement may still close resource bookkeeping.
  if (event.action === 'cleanup_confirmed') {
    if (!['pending', 'unconfirmed'].includes(current.cleanupState)) return ignore('no_cleanup_pending');
    next.cleanupState = 'confirmed';
    return changed();
  }
  if (terminal.has(current.status)) return ignore('terminal_status');
  if (event.action === 'cancel' || event.action === 'fail' || event.action === 'insufficient') {
    next.status = event.action === 'cancel' ? 'cancelled' : event.action === 'fail' ? 'failed' : 'insufficient';
    delete next.acceptedReview;
    delete next.publishedDraftHash;
    return changed();
  }
  if (event.action === 'start') {
    if (current.status !== 'queued') return ignore('illegal_transition');
    next.status = 'researching'; next.cleanupState = 'pending';
    return changed();
  }
  if (event.action === 'begin_review') {
    if (!['researching', 'revising'].includes(current.status)) return ignore('illegal_transition');
    const expected = event.expectation;
    if (expected.target.inputHash !== current.inputHash || expected.reviewVersion !== current.revisionCount + 1
      || expected.actor.attempt !== current.revisionCount + 1
      || expected.target.draftVersion !== current.revisionCount + 1) return ignore('invalid_review_round');
    if (current.status === 'revising') {
      const old = current.reviewExpectation;
      if (!old || expected.target.poolHash !== old.target.poolHash || expected.target.poolVersion !== old.target.poolVersion
        || expected.target.draftHash === old.target.draftHash
        || expected.actor.agentId !== old.actor.agentId || expected.actor.taskId === old.actor.taskId
        || expected.actor.contextId === old.actor.contextId) return ignore('recheck_requires_fixed_pool_and_fresh_task_context');
    }
    next.status = 'reviewing'; next.reviewExpectation = expected; delete next.acceptedReview;
    return changed();
  }
  if (event.action === 'review_result') {
    if (current.status !== 'reviewing' || !current.reviewExpectation) return ignore('not_reviewing');
    if (current.acceptedReview) return ignore('review_already_received');
    const expectedActor = current.reviewExpectation.actor;
    if ((Object.keys(expectedActor) as (keyof typeof expectedActor)[]).some(key => event.actor[key] !== expectedActor[key]))
      return ignore('unexpected_review_actor');
    if (validateReviewBinding(event.review, current.reviewExpectation, current.runId).length) return ignore('stale_or_invalid_review');
    if (event.review.verdict === 'approve') next.acceptedReview = event.review;
    else if (event.review.verdict === 'insufficient' || current.revisionCount === 1) next.status = 'insufficient';
    else { next.status = 'revising'; next.revisionCount = 1; }
    return changed();
  }
  if (event.action === 'publication_committed') {
    if (current.status !== 'reviewing' || !current.acceptedReview || !current.reviewExpectation
      || current.cleanupState !== 'confirmed' || event.reviewId !== current.acceptedReview.id
      || event.reviewHash !== current.acceptedReview.hash || event.draftHash !== current.reviewExpectation.target.draftHash)
      return ignore('publication_not_authorized');
    next.status = 'approved'; next.publishedDraftHash = event.draftHash;
    return changed();
  }
  return ignore('illegal_transition');
}
