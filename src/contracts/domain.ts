import { z } from 'zod';
import { DATASET_COMMIT, CANONICALIZATION_VERSION, HashSchema, UuidSchema, ArtifactIdSchema,
  VersionSchema, SafeCountSchema, PositiveCountSchema, TextSchema, CompanyIdSchema,
  ResearcherIdSchema, ChallengeIdSchema, TimestampSchema, JsonPointerSchema,
  AgentRoleSchema, RecordIdSchema, unique, sameCompany } from './primitives.js';
export { HashSchema, UuidSchema } from './primitives.js';

const ids = z.array(ArtifactIdSchema).max(128).refine(unique, 'Duplicate IDs.');
const researchers = z.array(ResearcherIdSchema).max(8).refine(unique, 'Duplicate researchers.');
const texts = z.array(TextSchema).max(128);
const pairFields = { companyId: CompanyIdSchema, challengeId: ChallengeIdSchema };
export const RunRequestSchema = z.strictObject(pairFields).refine(v => sameCompany(v.companyId, v.challengeId), 'Challenge/company mismatch.');
export const RunInputSchema = z.strictObject({ ...pairFields, runId: UuidSchema,
  datasetCommit: z.literal(DATASET_COMMIT), promptVersion: ArtifactIdSchema, configVersion: ArtifactIdSchema,
  mode: z.enum(['research', 'adversarial']) }).refine(v => sameCompany(v.companyId, v.challengeId), 'Challenge/company mismatch.');
export const RunStatusSchema = z.enum(['queued', 'researching', 'reviewing', 'revising', 'approved', 'insufficient', 'failed', 'cancelled']);
export const ApprovalTargetSchema = z.strictObject({ inputHash: HashSchema, poolVersion: PositiveCountSchema,
  poolHash: HashSchema, counterReportHash: HashSchema, draftVersion: VersionSchema,
  draftHash: HashSchema, evidenceSnapshotHash: HashSchema });
export const ReviewActorSchema = z.strictObject({ role: AgentRoleSchema, agentId: UuidSchema,
  taskId: UuidSchema, contextId: UuidSchema, attempt: VersionSchema });
export const ReviewExpectationSchema = z.strictObject({ actor: ReviewActorSchema.refine(a => a.role === 'critic'),
  reviewVersion: VersionSchema, target: ApprovalTargetSchema });

const JsonLocator = z.strictObject({ format: z.literal('json'), jsonPointer: JsonPointerSchema });
const JsonlLocator = z.strictObject({ format: z.literal('jsonl'), line1Based: PositiveCountSchema });
export const SourceRefSchema = z.strictObject({
  file: z.enum(['data/researchers.json', 'data/companies.json', 'data/publications.jsonl',
    'data/projects.json', 'data/patents.json', 'data/company-pages.jsonl']),
  recordId: RecordIdSchema, locator: z.discriminatedUnion('format', [JsonLocator, JsonlLocator]),
  fieldPointer: JsonPointerSchema, derivedRecordId: z.boolean(),
  codePointRange: z.tuple([SafeCountSchema, SafeCountSchema]).optional(),
}).refine(v => v.file.endsWith('.jsonl') === (v.locator.format === 'jsonl'), 'File/locator format mismatch.')
  .refine(v => v.derivedRecordId === (v.file === 'data/company-pages.jsonl'), 'Derived IDs only identify source pages without original IDs.')
  .refine(v => !v.codePointRange || v.codePointRange[0] <= v.codePointRange[1], 'Reversed range.');
export const EvidenceSchema = z.strictObject({ id: ArtifactIdSchema, datasetCommit: z.literal(DATASET_COMMIT),
  source: SourceRefSchema, excerpt: TextSchema, excerptSha256: HashSchema, recordSha256: HashSchema,
  sourceFileSha256: HashSchema, canonicalizationVersion: z.literal(CANONICALIZATION_VERSION),
}).refine(v => !v.source.codePointRange || v.source.codePointRange[1] - v.source.codePointRange[0]
  === Array.from(v.excerpt).length, 'Range must describe excerpt code points, not UTF-16 units.');

const bindingCommon = { evidenceId: ArtifactIdSchema, fieldPointer: JsonPointerSchema };
const genericRecordId = RecordIdSchema;
export const SourceBindingSchema = z.discriminatedUnion('relation', [
  z.strictObject({ ...bindingCommon, relation: z.literal('author_of'), subjectId: ResearcherIdSchema,
    objectId: z.string().regex(/^SYN-PUB-\d{5}$/) }),
  z.strictObject({ ...bindingCommon, relation: z.literal('profile_field'), subjectId: ResearcherIdSchema,
    objectId: ResearcherIdSchema }).refine(v => v.subjectId === v.objectId),
  z.strictObject({ ...bindingCommon, relation: z.literal('project_participant'), subjectId: ResearcherIdSchema, objectId: genericRecordId }),
  z.strictObject({ ...bindingCommon, relation: z.literal('patent_inventor'), subjectId: ResearcherIdSchema, objectId: genericRecordId }),
  z.strictObject({ ...bindingCommon, relation: z.literal('challenge_field'), subjectId: CompanyIdSchema,
    objectId: ChallengeIdSchema }).refine(v => sameCompany(v.subjectId, v.objectId)),
  z.strictObject({ ...bindingCommon, relation: z.literal('source_field'), subjectId: genericRecordId, objectId: genericRecordId }),
]);
export const ClaimSchema = z.strictObject({ id: ArtifactIdSchema, researcherId: ResearcherIdSchema,
  kind: z.enum(['fact', 'inference', 'proposal']), text: TextSchema, evidenceIds: ids,
  sourceBindings: z.array(SourceBindingSchema).max(128), limitations: texts,
}).superRefine((v, ctx) => {
  if (v.kind === 'fact' && (!v.evidenceIds.length || !v.sourceBindings.length))
    ctx.addIssue({ code: 'custom', message: 'Facts require evidence and bindings.' });
  if (v.sourceBindings.some(b => !v.evidenceIds.includes(b.evidenceId)))
    ctx.addIssue({ code: 'custom', message: 'Binding points outside the Claim evidence IDs.' });
  if (v.evidenceIds.some(id => !v.sourceBindings.some(b => b.evidenceId === id)))
    ctx.addIssue({ code: 'custom', message: 'Every cited Evidence needs a binding.' });
  if (v.sourceBindings.some(b => ['author_of', 'profile_field', 'project_participant', 'patent_inventor'].includes(b.relation)
    && b.subjectId !== v.researcherId)) ctx.addIssue({ code: 'custom', message: 'Relation subject differs from candidate.' });
});
export const ReviewFindingSchema = z.strictObject({ id: ArtifactIdSchema,
  scope: z.enum(['claim', 'run']), claimIds: ids, evidenceIds: ids,
  code: ArtifactIdSchema, severity: z.enum(['blocking', 'advisory']), explanation: TextSchema,
  recheckQuestion: TextSchema.optional(),
}).refine(v => v.scope !== 'claim' || v.claimIds.length > 0, 'Claim findings need Claim IDs.');
const critiqueFields = { verdict: z.enum(['approve', 'revise', 'insufficient']), findings: z.array(ReviewFindingSchema).max(128) };
function critiqueIssues(v: { verdict: string; findings: z.infer<typeof ReviewFindingSchema>[] }, ctx: z.RefinementCtx) {
  if (!unique(v.findings.map(f => f.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate finding IDs.' });
  const blockers = v.findings.filter(f => f.severity === 'blocking');
  if (v.verdict === 'approve' && blockers.length) ctx.addIssue({ code: 'custom', message: 'Blocking findings prohibit approve.' });
  if (v.verdict !== 'approve' && !blockers.length) ctx.addIssue({ code: 'custom', message: 'Non-approval requires a concrete blocker.' });
  if (v.verdict === 'revise' && blockers.some(f => !f.recheckQuestion))
    ctx.addIssue({ code: 'custom', message: 'Revision blockers require targeted recheck questions.' });
}
export const CriticOutputSchema = z.strictObject(critiqueFields).superRefine(critiqueIssues);
export const CriticReviewSchema = z.strictObject({ ...critiqueFields, id: ArtifactIdSchema,
  runId: UuidSchema, version: VersionSchema, hash: HashSchema, target: ApprovalTargetSchema }).superRefine(critiqueIssues);

const sectionEntry = z.strictObject({ text: TextSchema, claimIds: ids.min(1) });
const sectionFields = { summary: z.array(sectionEntry).min(1).max(32), technicalRationale: z.array(sectionEntry).max(32).optional(),
  cooperationScope: z.array(sectionEntry).max(32).optional(), validation: z.array(sectionEntry).max(32).optional(),
  constraints: z.array(sectionEntry).max(32).optional(), unknowns: z.array(sectionEntry).max(32).optional() };
export const ProposalDraftSchema = z.strictObject({ runId: UuidSchema, inputHash: HashSchema,
  pair: z.strictObject({ companyId: CompanyIdSchema, researcherId: ResearcherIdSchema }), challengeId: ChallengeIdSchema,
  version: VersionSchema, poolVersion: PositiveCountSchema, poolHash: HashSchema, claims: z.array(ClaimSchema).min(1).max(128),
  sections: z.strictObject(sectionFields), evidenceSnapshotHash: HashSchema, draftHash: HashSchema,
}).superRefine((v, ctx) => {
  if (!sameCompany(v.pair.companyId, v.challengeId) || v.claims.some(c => c.researcherId !== v.pair.researcherId))
    ctx.addIssue({ code: 'custom', message: 'Draft identity mismatch.' });
  const claimIds = v.claims.map(c => c.id);
  if (!unique(claimIds) || Object.values(v.sections).flat().some(s => s.claimIds.some(id => !claimIds.includes(id))))
    ctx.addIssue({ code: 'custom', message: 'Draft has duplicate or unknown Claim references.' });
});
export const CounterReportSchema = z.strictObject({ id: ArtifactIdSchema, runId: UuidSchema, inputHash: HashSchema,
  version: VersionSchema, hash: HashSchema, poolVersion: PositiveCountSchema, poolHash: HashSchema,
  checkedFacets: texts.min(1), checkedCandidates: researchers.min(1), findings: z.array(ReviewFindingSchema).max(128),
  noCounterEvidenceFound: texts,
}).refine(v => v.findings.length + v.noCounterEvidenceFound.length > 0, 'Counter report must record findings or checked absence.')
  .refine(v => unique(v.findings.map(f => f.id)), 'Duplicate Counter finding IDs.');

const matchField = z.strictObject({ sourceRef: SourceRefSchema, terms: texts.min(1), score: z.number().finite() });
const candidate = z.strictObject({ researcherId: ResearcherIdSchema, rank: z.int().min(1).max(8),
  channels: z.array(z.enum(['L0', 'L1', 'L2'])).min(1).max(3).refine(unique), matchedFields: z.array(matchField).min(1).max(64),
  evidenceIds: ids, identityFlags: texts, restrictionRefs: ids });
export const RecallDiagnosticsSchema = z.strictObject({
  corpusCounts: z.record(ArtifactIdSchema, SafeCountSchema),
  channelStatus: z.strictObject({ L0: z.enum(['available', 'empty', 'unavailable']),
    L1: z.enum(['available', 'empty', 'unavailable']), L2: z.enum(['available', 'empty', 'unavailable']) }),
  facets: texts, mergedCount: z.int().min(0).max(120), selectedCount: z.int().min(0).max(8),
  truncated: z.boolean(), lowRecallReasons: texts,
  judgedCapture: z.strictObject({ captured: SafeCountSchema, relevant: PositiveCountSchema })
    .refine(v => v.captured <= v.relevant).nullable(),
});
export const CandidatePoolContentSchema = z.strictObject({ poolVersion: PositiveCountSchema,
  datasetCommit: z.literal(DATASET_COMMIT), query: TextSchema, expandedTerms: texts,
  mergedCandidateCount: z.int().min(0).max(120), candidates: z.array(candidate).max(8), diagnostics: RecallDiagnosticsSchema });
function poolIssues(v: z.infer<typeof CandidatePoolContentSchema>, ctx: z.RefinementCtx) {
  if (!unique(v.candidates.map(c => c.researcherId)) || v.candidates.some((c, i) => c.rank !== i + 1)
    || v.candidates.length > v.mergedCandidateCount || v.diagnostics.selectedCount !== v.candidates.length
    || v.diagnostics.mergedCount !== v.mergedCandidateCount || v.diagnostics.truncated !== (v.mergedCandidateCount > v.candidates.length))
    ctx.addIssue({ code: 'custom', message: 'Inconsistent pool identities, ranks or counts.' });
}
export const CandidatePoolSchema = CandidatePoolContentSchema.extend({ poolHash: HashSchema }).superRefine(poolIssues);
export const UnhashedCandidatePoolSchema = CandidatePoolContentSchema.superRefine(poolIssues);

export const RawUsageSchema = z.strictObject({ source: z.literal('gateway_reported'), requestId: UuidSchema,
  promptTokens: SafeCountSchema.optional(), completionTokens: SafeCountSchema.optional(),
  totalTokens: SafeCountSchema.optional(), cachedInputTokens: SafeCountSchema.optional(),
}).refine(v => v.promptTokens === undefined || v.completionTokens === undefined || v.totalTokens === undefined
  || v.promptTokens + v.completionTokens === v.totalTokens, 'Inconsistent reported token totals.')
  .refine(v => v.cachedInputTokens === undefined || v.promptTokens === undefined || v.cachedInputTokens <= v.promptTokens);

export const RunOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ runId: UuidSchema, kind: z.literal('reviewed'), draft: ProposalDraftSchema,
    review: CriticReviewSchema.refine(r => r.verdict === 'approve'), counter: CounterReportSchema, reasonCodes: texts }),
  ...(['insufficient', 'failed', 'cancelled'] as const).map(kind => z.strictObject({ runId: UuidSchema,
    kind: z.literal(kind), reasonCodes: texts.min(1) })),
]).superRefine((v, ctx) => {
  if (v.kind === 'reviewed') {
    if ([v.draft.runId, v.review.runId, v.counter.runId].some(id => id !== v.runId))
      ctx.addIssue({ code: 'custom', message: 'Outcome contains cross-Run artifacts.' });
    artifactBindingIssues(v, ctx);
  }
});

/** Cross-object claims only. Hash recomputation, source bytes, actor authentication and
 * publication permission belong to their trusted consumers, never to schema success. */
function artifactBindingIssues(v: { draft: ProposalDraft; counter: CounterReport; review: CriticReview }, ctx: z.RefinementCtx) {
  const d = v.draft, c = v.counter, r = v.review;
  const expected = { inputHash: d.inputHash, poolVersion: d.poolVersion, poolHash: d.poolHash,
    counterReportHash: c.hash, draftVersion: d.version, draftHash: d.draftHash, evidenceSnapshotHash: d.evidenceSnapshotHash };
  if (c.inputHash !== d.inputHash || c.poolHash !== d.poolHash || c.poolVersion !== d.poolVersion
    || r.version !== d.version || Object.keys(expected).some(key => r.target[key as keyof ApprovalTarget] !== expected[key as keyof ApprovalTarget]))
    ctx.addIssue({ code: 'custom', message: 'Artifacts do not share the exact review target.' });
}

export const EvidenceSnapshotSchema = z.array(EvidenceSchema).max(1024)
  .refine(v => unique(v.map(e => e.id)), 'Duplicate Evidence IDs.');
export const ArtifactBundleSchema = z.strictObject({ input: RunInputSchema, inputHash: HashSchema,
  pool: CandidatePoolSchema, draft: ProposalDraftSchema, counter: CounterReportSchema, review: CriticReviewSchema,
  evidence: EvidenceSnapshotSchema, evidenceSnapshotHash: HashSchema,
}).superRefine((v, ctx) => {
  artifactBindingIssues(v, ctx);
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const d = v.draft, p = v.pool, c = v.counter;
  if ([d.runId, c.runId, v.review.runId].some(id => id !== v.input.runId) || d.inputHash !== v.inputHash
    || d.pair.companyId !== v.input.companyId || d.challengeId !== v.input.challengeId
    || p.datasetCommit !== v.input.datasetCommit || d.poolHash !== p.poolHash || d.poolVersion !== p.poolVersion
    || d.evidenceSnapshotHash !== v.evidenceSnapshotHash) issue('Bundle identity/snapshot mismatch.');
  const selected = new Set(p.candidates.map(candidate => candidate.researcherId));
  if (!selected.has(d.pair.researcherId) || c.checkedCandidates.length !== selected.size
    || c.checkedCandidates.some(id => !selected.has(id))) issue('Draft/Counter escaped or did not cover the candidate pool.');
  const evidenceById = new Map(v.evidence.map(e => [e.id, e]));
  const claimIds = new Set(d.claims.map(claim => claim.id));
  const evidenceIds = [...d.claims.flatMap(claim => claim.evidenceIds),
    ...p.candidates.flatMap(candidate => [...candidate.evidenceIds, ...candidate.restrictionRefs]),
    ...[...c.findings, ...v.review.findings].flatMap(f => f.evidenceIds)];
  if (evidenceIds.some(id => !evidenceById.has(id)) || v.evidence.some(e => e.datasetCommit !== v.input.datasetCommit))
    issue('Unknown Evidence reference or snapshot.');
  if ([...c.findings, ...v.review.findings].some(f => f.claimIds.some(id => !claimIds.has(id)))) issue('Unknown Claim in finding.');
  for (const claim of d.claims) for (const binding of claim.sourceBindings) {
    const source = evidenceById.get(binding.evidenceId)?.source;
    if (!source || source.fieldPointer !== binding.fieldPointer) { issue('Binding field differs from Evidence.'); continue; }
    const recordId = binding.relation === 'source_field' || binding.relation === 'challenge_field'
      ? binding.subjectId : binding.objectId;
    if (recordId !== source.recordId) issue('Binding record differs from Evidence.');
  }
});
export const RunRecordSchema = z.strictObject({ runId: UuidSchema, input: RunInputSchema,
  inputHash: HashSchema, runnerMode: z.enum(['live', 'offline_fixture']), status: RunStatusSchema,
  createdAt: TimestampSchema, admittedAt: TimestampSchema.optional(), deadlineAt: TimestampSchema.optional(),
  revisionCount: z.union([z.literal(0), z.literal(1)]), cleanupState: z.enum(['not_started', 'pending', 'confirmed', 'unconfirmed']),
  lastSeq: SafeCountSchema, reviewExpectation: ReviewExpectationSchema.optional(),
  acceptedReview: CriticReviewSchema.optional(), publishedDraftHash: HashSchema.optional(),
}).superRefine((v, ctx) => {
  if (v.runId !== v.input.runId || (v.reviewExpectation && v.reviewExpectation.target.inputHash !== v.inputHash))
    ctx.addIssue({ code: 'custom', message: 'Run identity or input hash mismatch.' });
  if (v.status === 'approved' && (!v.acceptedReview || v.acceptedReview.verdict !== 'approve'
    || !v.reviewExpectation || v.cleanupState !== 'confirmed'
    || v.publishedDraftHash !== v.reviewExpectation.target.draftHash))
    ctx.addIssue({ code: 'custom', message: 'Approved state needs a bound review and publication/cleanup acknowledgement.' });
  if (v.acceptedReview && (!v.reviewExpectation || v.acceptedReview.runId !== v.runId
    || v.acceptedReview.version !== v.reviewExpectation.reviewVersion
    || v.acceptedReview.verdict !== 'approve'
    || Object.keys(v.reviewExpectation.target).some(key => v.acceptedReview!.target[key as keyof ApprovalTarget]
      !== v.reviewExpectation!.target[key as keyof ApprovalTarget])))
    ctx.addIssue({ code: 'custom', message: 'Accepted Review is not bound to the captured snapshot.' });
  if ((v.acceptedReview && !['reviewing', 'approved'].includes(v.status))
    || (v.publishedDraftHash && v.status !== 'approved')
    || (['queued', 'researching'].includes(v.status) && (v.reviewExpectation || v.revisionCount !== 0))
    || (['reviewing', 'revising'].includes(v.status) && !v.reviewExpectation)
    || (v.status === 'revising' && v.revisionCount !== 1))
    ctx.addIssue({ code: 'custom', message: 'Approval metadata or revision does not belong to this state.' });
  if (v.revisionCount === 1 && !v.reviewExpectation)
    ctx.addIssue({ code: 'custom', message: 'A revision requires captured first-round history.' });
  if (v.reviewExpectation) {
    const e = v.reviewExpectation;
    const expectedRound = v.status === 'revising' ? 1 : v.revisionCount + 1;
    if ((['reviewing', 'revising', 'approved'].includes(v.status) && e.reviewVersion !== expectedRound)
      || e.reviewVersion > v.revisionCount + 1 || e.actor.attempt !== e.reviewVersion || e.target.draftVersion !== e.reviewVersion)
      ctx.addIssue({ code: 'custom', message: 'Captured Critic round/version mismatch.' });
  }
});

export type RunInput = z.infer<typeof RunInputSchema>;
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type SourceBinding = z.infer<typeof SourceBindingSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type ProposalDraft = z.infer<typeof ProposalDraftSchema>;
export type CounterReport = z.infer<typeof CounterReportSchema>;
export type CandidatePool = z.infer<typeof CandidatePoolSchema>;
export type CriticReview = z.infer<typeof CriticReviewSchema>;
export type CriticOutput = z.infer<typeof CriticOutputSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ApprovalTarget = z.infer<typeof ApprovalTargetSchema>;
export type ReviewExpectation = z.infer<typeof ReviewExpectationSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;
export type RawUsage = z.infer<typeof RawUsageSchema>;
export type ArtifactBundle = z.infer<typeof ArtifactBundleSchema>;
