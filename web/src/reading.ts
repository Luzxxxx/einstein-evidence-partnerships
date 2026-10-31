import type {CriticReview, ProposalDraft, RunRecord} from '../../src/contracts/domain.js';
import type {RevisionDiff} from './types.js';

export type ReadingView = 'overview' | 'proposal' | 'review' | 'changes' | 'activity';
export function readRouteHash(hash: string, saved: boolean): {page: 'run' | 'showcase' | 'replay' | 'analyze'; id: string; view: ReadingView} {
  const value = hash.replace(/^#/, ''), params = new URLSearchParams(value);
  const id = params.get('run'), requested = params.get('view');
  if (value.startsWith('run=') && id) return {page: 'run', id, view: ['overview','proposal','review','changes','activity'].includes(requested ?? '') ? requested as ReadingView : 'overview'};
  return {page: value === 'showcase' ? 'showcase' : value === 'replay' ? 'replay' : saved ? 'showcase' : 'analyze', id: '', view: 'overview'};
}

/** Available draft bindings only; this display helper never grants publication. */
export function matchingReview(draft: ProposalDraft, review?: CriticReview) {
  if (!review || review.runId !== draft.runId) return undefined;
  const t = review.target;
  return t.inputHash === draft.inputHash && t.poolVersion === draft.poolVersion && t.poolHash === draft.poolHash
    && t.draftVersion === draft.version && t.draftHash === draft.draftHash && t.evidenceSnapshotHash === draft.evidenceSnapshotHash ? review : undefined;
}

export function briefPublicationReady(draft: ProposalDraft, review: CriticReview | undefined, run: RunRecord, parentPublicationVisible: boolean) {
  return Boolean(parentPublicationVisible && draft.runId === run.runId && draft.draftHash === run.publishedDraftHash
    && matchingReview(draft, review)?.verdict === 'approve' && review?.hash === run.acceptedReview?.hash);
}

const meetingLabels = [
  ['summary', 'Problem and opportunity'], ['technicalRationale', 'Why this partner'],
  ['cooperationScope', 'Proposed pilot'], ['validation', 'How to test it'],
  ['constraints', 'Conditions to confirm'], ['unknowns', 'Questions for the first meeting'],
] as const;
/** Exact source arrays, no inferred owners, numbers, timelines or new paragraphs. */
export function meetingSections(draft: ProposalDraft) {
  return meetingLabels.map(([key, title]) => ({key, title, paragraphs: draft.sections[key] ?? []}));
}

export function reviewStory(diff: RevisionDiff | null) {
  if (!diff?.available) return [];
  return (diff.findings ?? []).map(finding => ({finding,
    changes: (diff.claims ?? []).filter(c => finding.claimIds.includes(c.id) && c.change !== 'unchanged'),
    unchangedClaimIds: (diff.claims ?? []).filter(c => finding.claimIds.includes(c.id) && c.change === 'unchanged').map(c => c.id),
  }));
}

export function laterReviewForComparison(diff: RevisionDiff | null, drafts: readonly ProposalDraft[], reviews: readonly CriticReview[], runId: string) {
  if (!diff?.available) return undefined;
  const after = drafts.find(d => d.runId === runId && d.version === diff.to?.version && d.draftHash === diff.to?.hash);
  return after ? reviews.find(r => matchingReview(after, r)) : undefined;
}
