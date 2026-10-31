import { z } from 'zod';
import { canonicalizeArtifact } from '../contracts/canonical.js';
import { SourceRefSchema } from '../contracts/domain.js';
import { ArtifactIdSchema, ChallengeIdSchema, CompanyIdSchema, DATASET_COMMIT, HashSchema,
  ResearcherIdSchema, TextSchema, TimestampSchema, unique } from '../contracts/primitives.js';
import { hashArtifact, hashSourceRecord, sha256Bytes } from '../evidence/hashing.js';

const lanes = ['L0', 'L1', 'L2'] as const;
const textHash = (value: string) => sha256Bytes(new TextEncoder().encode(value));
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(id => b.includes(id));
const sourceField = z.strictObject({ source: SourceRefSchema, value: TextSchema,
  excerptSha256: HashSchema, recordSha256: HashSchema, sourceFileSha256: HashSchema });
const query = z.strictObject({ queryId: ArtifactIdSchema, split: z.enum(['dev', 'holdout']),
  companyId: CompanyIdSchema, challengeId: ChallengeIdSchema, companyGroupId: CompanyIdSchema,
  variantGroupId: ChallengeIdSchema, variantKind: z.literal('original'),
  languages: z.array(z.enum(['en', 'sr-Latn'])).min(1).refine(unique),
  scripts: z.array(z.literal('Latin')).length(1),
  sourceFields: z.strictObject({ text: sourceField, detail: sourceField }), queryText: TextSchema,
  queryTextSha256: HashSchema, querySourceHash: HashSchema,
});

export const QueryManifestSchema = z.strictObject({ schemaVersion: z.literal(1),
  manifestVersion: z.literal('retrieval-queries-v1'), datasetCommit: z.literal(DATASET_COMMIT),
  canonicalizationVersion: z.literal('node-stable-json-v1'),
  freeze: z.strictObject({ status: z.literal('frozen_before_retrieval'), preparation: z.literal('ai_prepared'),
    retrievalOutputsObserved: z.literal(false), holdoutRankingsObserved: z.literal(false) }),
  splitPolicy: z.strictObject({ unit: z.literal('company'), variantGrouping: z.literal('challenge'),
    devCompanyIds: z.array(CompanyIdSchema).min(1).refine(unique),
    holdoutCompanyIds: z.array(CompanyIdSchema).min(1).refine(unique) }),
  queries: z.array(query).min(1), hash: HashSchema,
}).superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({code: 'custom', message});
  if (hashArtifact(v) !== v.hash) issue('Query manifest self hash mismatch.');
  if (!unique(v.queries.map(q => q.queryId))) issue('Duplicate query ID.');
  const dev = v.splitPolicy.devCompanyIds, holdout = v.splitPolicy.holdoutCompanyIds;
  if (dev.some(id => holdout.includes(id))) issue('Company group leaked between dev and holdout.');
  for (const split of ['dev', 'holdout'] as const) {
    const declared = split === 'dev' ? dev : holdout;
    const actual = [...new Set(v.queries.filter(q => q.split === split).map(q => q.companyId))];
    if (!sameSet(declared, actual)) issue('Declared company split differs from actual queries.');
  }
  const variantSplits = new Map<string, string>();
  for (const q of v.queries) {
    if (q.companyGroupId !== q.companyId || q.variantGroupId !== q.challengeId
      || !q.challengeId.startsWith(q.companyId + '-CH') || q.queryId !== `q-${q.challengeId}-original`)
      issue('Query company/challenge/variant identity mismatch.');
    const previous = variantSplits.get(q.variantGroupId);
    if (previous && previous !== q.split) issue('Variant group leaked between splits.');
    variantSplits.set(q.variantGroupId, q.split);
    const {text, detail} = q.sourceFields;
    for (const fieldName of ['text', 'detail'] as const) {
      const f = q.sourceFields[fieldName], s = f.source;
      if (s.file !== 'data/companies.json' || s.recordId !== q.companyId || s.derivedRecordId
        || s.codePointRange || s.locator.format !== 'json' || !/^\/companies\/(0|[1-9]\d*)$/.test(s.locator.jsonPointer)
        || !new RegExp(`^/challenges/(0|[1-9]\\d*)/${fieldName}$`).test(s.fieldPointer))
        issue('Query source must point to the full original company challenge field.');
      if (textHash(f.value) !== f.excerptSha256) issue('Query source excerpt hash mismatch.');
    }
    if (canonicalizeArtifact(text.source.locator) !== canonicalizeArtifact(detail.source.locator)
      || text.source.fieldPointer.replace(/\/text$/, '') !== detail.source.fieldPointer.replace(/\/detail$/, '')
      || text.recordSha256 !== detail.recordSha256 || text.sourceFileSha256 !== detail.sourceFileSha256)
      issue('Query text and detail do not belong to the same original challenge record.');
    if (q.queryText !== text.value + '\n' + detail.value || textHash(q.queryText) !== q.queryTextSha256)
      issue('Query original text/detail concatenation hash mismatch.');
    if (hashSourceRecord({datasetCommit: v.datasetCommit, companyId: q.companyId,
      challengeId: q.challengeId, sourceFields: q.sourceFields}) !== q.querySourceHash)
      issue('Query source hash mismatch.');
  }
});

const label = z.strictObject({ researcherId: ResearcherIdSchema,
  relevance: z.enum(['relevant', 'adjacent', 'unrelated', 'unjudged']),
  sourceSufficiency: z.enum(['supported', 'incomplete', 'conflicted', 'not_assessed']),
  origin: z.enum(['ai_prepared_seed', 'human_review']), seedRef: TextSchema,
  evidenceRefs: z.array(SourceRefSchema).max(128), reviewerId: TextSchema.nullable(),
  reviewedAt: TimestampSchema.nullable(), relevanceRationale: TextSchema.nullable(), sourceRationale: TextSchema.nullable(),
}).superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({code: 'custom', message});
  if (v.origin === 'ai_prepared_seed' && (v.relevance !== 'unjudged' || v.sourceSufficiency !== 'not_assessed'
    || v.reviewerId !== null || v.reviewedAt !== null || v.relevanceRationale !== null || v.sourceRationale !== null))
    issue('AI-prepared seeds cannot masquerade as human judgments.');
  if (v.origin === 'human_review' && (v.relevance === 'unjudged' || !v.reviewerId || !v.reviewedAt || !v.relevanceRationale))
    issue('Human judgment requires reviewer, date and relevance rationale.');
  if (v.sourceSufficiency !== 'not_assessed' && (!v.sourceRationale || !v.evidenceRefs.length))
    issue('Assessed source sufficiency requires separate rationale and source references.');
  if (v.sourceSufficiency === 'not_assessed' && v.sourceRationale !== null)
    issue('Unassessed source sufficiency cannot contain an assessment rationale.');
});
export const LabelManifestSchema = z.strictObject({ schemaVersion: z.literal(1),
  manifestVersion: z.literal('retrieval-labels-v1'), datasetCommit: z.literal(DATASET_COMMIT),
  queryManifestHash: HashSchema, minimumJudgedPerQuery: z.literal(8),
  reviewStatus: z.enum(['pending_human_review', 'partial_human_review', 'human_reviewed']),
  queries: z.array(z.strictObject({queryId: ArtifactIdSchema,
    referencePoolStatus: z.enum(['not_constructed', 'pooled', 'human_reviewed']), labels: z.array(label).max(1047)})),
  hash: HashSchema,
}).superRefine((v, ctx) => {
  if (hashArtifact(v) !== v.hash) ctx.addIssue({code: 'custom', message: 'Label manifest self hash mismatch.'});
  if (!unique(v.queries.map(q => q.queryId))) ctx.addIssue({code: 'custom', message: 'Duplicate label query ID.'});
  for (const q of v.queries) {
    if (!unique(q.labels.map(l => l.researcherId)))
      ctx.addIssue({code: 'custom', message: 'Duplicate researcher label for a query.'});
    const judged = q.labels.filter(l => l.origin === 'human_review').length;
    if (q.referencePoolStatus === 'not_constructed' && judged)
      ctx.addIssue({code: 'custom', message: 'Human judgments require a constructed reference pool.'});
    if (q.referencePoolStatus === 'human_reviewed' && (judged < v.minimumJudgedPerQuery || judged !== q.labels.length))
      ctx.addIssue({code: 'custom', message: 'Reviewed reference pool requires at least eight reviews and no unjudged labels.'});
  }
  const judgedCount = v.queries.flatMap(q => q.labels).filter(l => l.origin === 'human_review').length;
  if (v.reviewStatus === 'pending_human_review' && judgedCount)
    ctx.addIssue({code: 'custom', message: 'Pending review status cannot contain completed human judgments.'});
  if (v.reviewStatus === 'human_reviewed' && (!v.queries.length || v.queries.some(q => q.referencePoolStatus !== 'human_reviewed')))
    ctx.addIssue({code: 'custom', message: 'Reviewed manifest requires completed per-query reference pools.'});
});

const researcherIds = (max: number) => z.array(ResearcherIdSchema).max(max).refine(unique);
const lane = z.strictObject({ candidateIds: researcherIds(40), allRankedIds: researcherIds(1047) });
export const RetrievalEvalRunSchema = z.strictObject({ queryId: ArtifactIdSchema,
  stage: z.enum(['L0', 'L0_L1', 'L0_L1_L2']), lanes: z.strictObject({ L0: lane, L1: lane, L2: lane }),
  unionIds: researcherIds(120), selectedIds: researcherIds(8),
  omitted: z.array(z.strictObject({researcherId: ResearcherIdSchema, reason: TextSchema})).max(120),
}).superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({code: 'custom', message});
  const active = v.stage.split('_');
  for (const name of lanes) {
    const l = v.lanes[name];
    if (!active.includes(name) && (l.candidateIds.length || l.allRankedIds.length)) issue('Inactive lane contains candidates.');
    if (canonicalizeArtifact(l.candidateIds) !== canonicalizeArtifact(l.allRankedIds.slice(0, 40)))
      issue('Lane top40 differs from the eligible ranking prefix.');
  }
  const union = [...new Set(lanes.flatMap(name => v.lanes[name].candidateIds))];
  if (!sameSet(union, v.unionIds)) issue('Merged union differs from active lane top40 sets.');
  if (v.selectedIds.some(id => !v.unionIds.includes(id))) issue('Selected researcher is outside the union.');
  const omittedIds = v.omitted.map(o => o.researcherId);
  if (!unique(omittedIds) || !sameSet(omittedIds, v.unionIds.filter(id => !v.selectedIds.includes(id))))
    issue('Omitted reasons must cover exactly the unselected union candidates.');
});

export type CountMetric = {status: 'NA' | 'measured'; numerator: number | null; denominator: number | null};
function metric(numerator: number, denominator: number): CountMetric {
  return denominator ? {status: 'measured', numerator, denominator} : {status: 'NA', numerator: null, denominator: null};
}
const overlap = (ids: readonly string[], reference: Set<string>) => ids.filter(id => reference.has(id)).length;
const qualityStatus = (judged: number) => judged >= 8 ? 'human_review_complete' as const : 'human_review_incomplete' as const;

/** Counts declared, attributable human reviews; it neither authenticates reviewers nor assesses source semantics.
 * Current authorization is dev-only. Holdout runs stay sealed until separately authorized future work. */
export function evaluateRetrievalMetrics(input: {queryManifest: unknown; labelManifest: unknown; runs: unknown}) {
  canonicalizeArtifact(input);
  if (Object.keys(input).sort().join(',') !== 'labelManifest,queryManifest,runs') throw new Error('Unknown evaluation input field.');
  const queries = QueryManifestSchema.parse(input.queryManifest), labels = LabelManifestSchema.parse(input.labelManifest);
  const runs = z.array(RetrievalEvalRunSchema).parse(input.runs);
  if (labels.queryManifestHash !== queries.hash) throw new Error('Label query manifest binding hash mismatch.');
  if (!sameSet(queries.queries.map(q => q.queryId), labels.queries.map(q => q.queryId)))
    throw new Error('Label manifest must cover exactly the frozen queries.');
  const byId = new Map(queries.queries.map(q => [q.queryId, q]));
  const runKeys = new Set<string>();
  for (const r of runs) {
    if (!byId.has(r.queryId)) throw new Error('Evaluation run references an unknown query.');
    if (byId.get(r.queryId)!.split === 'holdout') throw new Error('Holdout is sealed; only dev runs are authorized.');
    const key = r.queryId + '/' + r.stage;
    if (runKeys.has(key)) throw new Error('Duplicate query/stage run.');
    runKeys.add(key);
  }
  for (const q of labels.queries) if (byId.get(q.queryId)!.split === 'holdout'
    && q.labels.some(l => l.origin === 'ai_prepared_seed'))
    throw new Error('Development AI seeds cannot leak into holdout reference labels.');
  const queryReports = queries.queries.map(q => {
    const ls = labels.queries.find(l => l.queryId === q.queryId)!.labels;
    const judged = new Set(ls.filter(l => l.origin === 'human_review').map(l => l.researcherId));
    const relevant = new Set(ls.filter(l => l.origin === 'human_review' && l.relevance === 'relevant').map(l => l.researcherId));
    const relevantIds = [...relevant].sort();
    const stageReports = runs.filter(r => r.queryId === q.queryId)
      .sort((a, b) => a.stage.length - b.stage.length).map(r => {
        const allRanked = new Set(lanes.flatMap(name => r.lanes[name].allRankedIds));
        const selectedRelevant = overlap(r.selectedIds, relevant), unionRelevant = overlap(r.unionIds, relevant);
        const judgedReturnedCount = overlap(r.selectedIds, judged);
        return {stage: r.stage,
          lanes: Object.fromEntries(lanes.map(name => [name, {
            capture: r.stage.split('_').includes(name)
              ? metric(overlap(r.lanes[name].candidateIds, relevant), relevant.size) : metric(0, 0),
            cutoffRelevantIds: relevantIds.filter(id => r.lanes[name].allRankedIds.includes(id) && !r.lanes[name].candidateIds.includes(id)),
          }])),
          unionCapture: metric(unionRelevant, relevant.size), selectedCapture: metric(selectedRelevant, relevant.size),
          selectionRetention: metric(selectedRelevant, unionRelevant),
          judgedPrecision: metric(selectedRelevant, judgedReturnedCount),
          unjudgedProportion: metric(r.selectedIds.length - judgedReturnedCount, r.selectedIds.length),
          returnedCount: r.selectedIds.length, judgedReturnedCount,
          truncatedRelevantIds: {laneCutoff: relevantIds.filter(id => allRanked.has(id) && !r.unionIds.includes(id)),
            reviewCutoff: relevantIds.filter(id => r.unionIds.includes(id) && !r.selectedIds.includes(id))},
          notRankedRelevantIds: relevantIds.filter(id => !allRanked.has(id)),
        };
      });
    const sourceSufficiencyCounts = {supported: 0, incomplete: 0, conflicted: 0, not_assessed: 0};
    for (const l of ls) sourceSufficiencyCounts[l.sourceSufficiency]++;
    return {queryId: q.queryId, split: q.split,
      evaluationStatus: q.split === 'holdout' ? 'unopened' as const : stageReports.length ? 'evaluated' as const : 'not_run' as const,
      judgedCount: judged.size, relevantCount: relevant.size,
      minimumJudgedPerQuery: labels.minimumJudgedPerQuery, qualityStatus: qualityStatus(judged.size),
      sourceSufficiencyCounts, stages: stageReports};
  });
  return {queryManifestHash: queries.hash, labelManifestHash: labels.hash,
    qualityStatus: queryReports.every(q => q.qualityStatus === 'human_review_complete')
      ? 'human_review_complete' as const : 'human_review_incomplete' as const,
    queries: queryReports};
}
