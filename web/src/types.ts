import type { Claim, CriticReview, Evidence, RunRecord } from '../../src/contracts/domain.js';
import type { TypedArtifact } from '../../src/contracts/ipc.js';

export type Company = { id: string; name: string; challenges: { id: string; text: string; detail?: string | null }[] };
export type Catalog = { synthetic: true; datasetCommit: string; newRunsAvailable: boolean; companies: Company[] };
export type RunDetail = { run: RunRecord; progress: { lastSeq: number; terminal: boolean; reasonCodes?: string[]; blockedByService?: boolean }; artifactRefs: unknown[] };
export type RunHistory = { runs: RunRecord[]; total: number; limit: number; blockedByService?: boolean; blockedRunIds?: string[] };
export type RevisionDiff = {
  available: boolean; reason?: string;
  from?: { version: number; hash: string }; to?: { version: number; hash: string };
  laterApproval?: { id: string; hash: string } | null;
  claims?: { id: string; before: Claim | null; after: Claim | null; change: string }[];
  sections?: { name: string; before: { text: string; claimIds: string[] }[] | null; after: { text: string; claimIds: string[] }[] | null; changed: boolean }[];
  findings?: (CriticReview['findings'][number] & { reviewHash: string; laterReviewHash: string | null; resolution: string })[];
};
export type RunArtifacts = {
  runId: string; status: RunRecord['status']; mode: 'research' | 'adversarial'; runnerMode: 'live' | 'offline_fixture';
  artifacts: TypedArtifact[];
  display?: { companyName?: string; researcherNames: Record<string, string | undefined> };
  publication: { draftHash: string; reviewHash: string; renderedDraft: string; formalProposal: unknown | null; committedAt: string } | null;
  revisionDiff: RevisionDiff;
};
export type EvidenceResponse = {
  runId: string; evidence: Evidence; originalField: { value: unknown; valueType: string; text: string };
  flags: { code: string; recordId?: string; relatedId?: string; [key: string]: unknown }[];
  sourceValidation: 'verified'; semanticSupport: 'not_determined_by_source_validation';
};
export type ShowcaseEntry = {
  id: string; runId: string; pairKey: string; companyId: string; researcherId: string; challengeId: string;
  draftVersion: number; draftHash: string; reviewHash: string; committedAt: string;
  companyName?: string; researcherName?: string;
  concurrency: { overlapMs: number; kind: string; scope: string };
};
