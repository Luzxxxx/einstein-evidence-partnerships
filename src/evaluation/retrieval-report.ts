import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { QueryManifestSchema, LabelManifestSchema, evaluateRetrievalMetrics } from './metrics.js';
import { DEFAULT_RETRIEVAL_CONFIG, RetrievalConfigSchema, type RetrievalConfig, type Lane } from '../retrieval/config.js';
import { CONCEPT_RULES, DICTIONARY_VERSION } from '../retrieval/concepts.js';
import { buildIndex, retrieveWithTrace, type RetrievalIndex } from '../retrieval/index.js';
import { loadSnapshot, assertSnapshot, type DatasetSnapshot } from '../data/snapshot.js';
import { deepFreeze } from '../data/records.js';
import { hashArtifact, hashSourceRecord, sha256Bytes } from '../evidence/hashing.js';
import { resolveField, resolveEvidence } from '../evidence/store.js';
import { verifyEvidence } from '../evidence/validate.js';
import { DATASET_COMMIT, HashSchema } from '../contracts/primitives.js';
import type { RunInput, SourceRef } from '../contracts/domain.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
export function assertDevOnly(split: unknown): asserts split is 'dev' {
  if (split !== 'dev') throw new Error('HOLDOUT_SEALED: only dev evaluation is authorized; no override flag exists.');
}
export function validateFrozenQueries(value: unknown, snapshot: DatasetSnapshot) {
  assertSnapshot(snapshot); const manifest = QueryManifestSchema.parse(value);
  for (const query of manifest.queries) for (const source of Object.values(query.sourceFields)) {
    const resolved = resolveField(source.source, snapshot);
    if (resolved.value !== source.value || resolved.located.recordSha256 !== source.recordSha256
      || snapshot.files.find(f => f.file === source.source.file)!.sourceFileSha256 !== source.sourceFileSha256)
      throw new Error('Frozen query differs from the actual immutable source snapshot.');
  }
  return manifest;
}
export function createEvaluationFreeze(input: { queryManifest: unknown; labelManifest: unknown; config: RetrievalConfig;
  indexHash: string; sourceCodeHashes: Record<string, string>; executableHashes: Record<string, string> }) {
  const queries = QueryManifestSchema.parse(input.queryManifest), labels = LabelManifestSchema.parse(input.labelManifest);
  if (labels.queryManifestHash !== queries.hash) throw new Error('Query/label freeze mismatch.');
  if (!Object.keys(input.sourceCodeHashes).length) throw new Error('Freeze requires source-code fingerprints.');
  if (!input.executableHashes || !Object.keys(input.executableHashes).length) throw new Error('Freeze requires actual executable fingerprints.');
  for (const hash of [input.indexHash, ...Object.values(input.sourceCodeHashes), ...Object.values(input.executableHashes)]) HashSchema.parse(hash);
  const content = { schemaVersion: 1, status: 'engineering_configuration_frozen_uncalibrated', holdoutStatus: 'unopened',
    queryManifestHash: queries.hash, labelManifestHash: labels.hash, config: RetrievalConfigSchema.parse(input.config),
    configHash: hashArtifact(input.config), dictionaryVersion: DICTIONARY_VERSION, dictionaryHash: hashSourceRecord(CONCEPT_RULES),
    dictionary: CONCEPT_RULES, indexHash: input.indexHash, sourceCodeHashes: input.sourceCodeHashes, executableHashes: input.executableHashes,
    humanJudgedCount: labels.queries.flatMap(q => q.labels).filter(l => l.origin === 'human_review').length,
    qualityThresholdStatus: 'pending_human_review_and_user_approval', minimumHumanJudgedPerQuery: 8,
    qualityThresholdProposal: 'For queries with human positives: retain at least one in union; report every lost positive and judged@8; any numeric @8 threshold requires later human calibration and user approval.',
    referencePoolRule: 'each active lane top20 + exposed dev seeds + four deterministic lexical-positive-stratum samples; all unjudged',
    stages: ['L0', 'L0_L1', 'L0_L1_L2'] };
  return deepFreeze({ ...content, hash: hashArtifact(content) });
}
export async function prepareReportDirectory(root: string, requested: string) {
  const artifacts = resolve(root, 'artifacts'), base = resolve(artifacts, 'evaluations'), output = resolve(root, requested);
  const subpath = relative(base, output);
  if (!subpath || subpath === '..' || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)) throw new Error('Output must be a new directory below artifacts/evaluations.');
  if (subpath.includes(sep)) throw new Error('Use one named evaluation directory under artifacts/evaluations.');
  for (const directory of [artifacts, base]) {
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Linked/junction output directories are refused before any child creation.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(directory); // Check the existing parent BEFORE creating a child.
    }
  }
  await mkdir(output); return output; // EEXIST intentionally preserves prior reports.
}
type Query = ReturnType<typeof QueryManifestSchema.parse>['queries'][number];
export function pooledReferenceCandidates(queryId: string, lanes: Record<Lane, { candidateIds: readonly string[]; allRankedIds: readonly string[] }>, seeds: readonly string[]) {
  const entries = new Map<string, Set<string>>();
  const add = (id: string, origin: string) => { const origins = entries.get(id) ?? new Set(); origins.add(origin); entries.set(id, origins); };
  for (const lane of ['L0', 'L1', 'L2'] as const) lanes[lane].candidateIds.slice(0, 20).forEach(id => add(id, `${lane}_top20`));
  seeds.forEach(id => add(id, 'exposed_dev_seed_unjudged'));
  const remaining = [...new Set(Object.values(lanes).flatMap(lane => [...lane.allRankedIds]))].filter(id => !entries.has(id));
  remaining.sort((a, b) => {
    const x = hashArtifact({ queryId, researcherId: a }), y = hashArtifact({ queryId, researcherId: b }); return x < y ? -1 : x > y ? 1 : 0;
  });
  remaining.slice(0, 4).forEach(id => add(id, 'deterministic_lexical_stratum_sample_unjudged'));
  return [...entries].map(([researcherId, origins]) => ({ researcherId, origins: [...origins] }));
}
function manualMaterials(query: Query, references: ReturnType<typeof pooledReferenceCandidates>, snapshot: DatasetSnapshot,
  index: RetrievalIndex, trace: ReturnType<typeof retrieveWithTrace>['trace']) {
  return { queryId: query.queryId, preparation: 'ai_prepared_for_human_review', relevance: 'unjudged', sourceSufficiency: 'not_assessed',
    challengeOriginal: query.sourceFields, requiredHumanReviewCount: 8, actualHumanReviewCount: 0,
    unresolvedQuestions: ['Does the technical object/data/method actually fit this challenge?', 'What validation and adaptation are required?',
      'Which original participation restrictions and dated statements require confirmation?'],
    referencePoolStatus: 'ai_prepared_unjudged', referencePoolCount: references.length,
    candidates: references.map(({ researcherId, origins }) => {
      const all = index.getDocuments(researcherId);
      const hitRefs = Object.values(trace.laneExplanations).flatMap(rows => rows.filter(row => row.researcherId === researcherId).flatMap(row => row.contributingFields.map(f => f.sourceRef)));
      const actualHits = hitRefs.flatMap(ref => all.filter(d => d.sourceRef.file === ref.file && d.sourceRef.recordId === ref.recordId && d.sourceRef.fieldPointer === ref.fieldPointer));
      const choices = [...actualHits, ...all.filter(d => d.sourceRef.file === 'data/researchers.json').slice(0, 1),
        ...all.filter(d => /\/(abstract|summary)$/.test(d.sourceRef.fieldPointer)).slice(0, 2)];
      const fields = [...new Map(choices.map(d => [JSON.stringify(d.sourceRef), d])).values()].slice(0, 3);
      const sourceMaterials = fields.map(d => {
        const content = resolveEvidence(d.sourceRef, snapshot), person = snapshot.getRecord('researcher', researcherId)!;
        const identity = resolveEvidence(d.identityRef ?? { file: person.file, recordId: person.recordId,
          locator: person.locator, fieldPointer: '/id', derivedRecordId: false }, snapshot);
        for (const e of [content, identity]) if (verifyEvidence(e, snapshot).length) throw new Error('Manual material source failed.');
        return { content, identity, relation: d.relation, semanticSupport: 'not_assessed' };
      });
      const person = snapshot.getRecord('researcher', researcherId)!;
      const restrictions = ['notes', 'open_to', 'industry_experience'].map(field => {
        const source: SourceRef = { file: person.file, recordId: person.recordId, locator: person.locator, fieldPointer: `/${field}`, derivedRecordId: false };
        const original = resolveField(source, snapshot);
        return { source, value: original.value, originalText: original.text };
      });
      return { researcherId, selectionOrigins: origins, relevance: 'unjudged', sourceSufficiency: 'not_assessed', origin: 'ai_prepared_for_human_review',
        applicability: 'unassessed; source validity and keyword overlap do not establish technical fit', sourceMaterials, restrictions,
        diagnostics: snapshot.diagnostics.filter(d => d.recordId === researcherId || d.relatedId === researcherId) };
    }) };
}

/** Dev-only local artifact writer. It refuses existing output directories, preserving prior runs/failures. */
export async function runRetrievalReport(options: { split: string; output: string }) {
  assertDevOnly(options.split); // BEFORE reading manifests, indexing, scoring or writing.
  const output = await prepareReportDirectory(projectRoot, options.output);
  const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  try {
    const queriesRaw = JSON.parse(await readFile(resolve(projectRoot, 'tests/fixtures/retrieval-queries.json'), 'utf8'));
    const labels = LabelManifestSchema.parse(JSON.parse(await readFile(resolve(projectRoot, 'tests/fixtures/retrieval-labels.json'), 'utf8')));
    const loadStart = performance.now(), snapshot = await loadSnapshot(resolve(projectRoot, 'reference/einstein-matchmaker-data'), DATASET_COMMIT);
    const sourceLoadMs = performance.now() - loadStart, queries = validateFrozenQueries(queriesRaw, snapshot);
    const indexStart = performance.now(), index = buildIndex(snapshot), indexBuildMs = performance.now() - indexStart;
    if (index.sourcePolicy !== 'official') throw new Error('Official evaluation cannot use a test-copy index.');
    const codeFiles = ['src/contracts/canonical.ts', 'src/contracts/primitives.ts', 'src/contracts/domain.ts', 'src/data/records.ts', 'src/data/snapshot.ts',
      'src/evidence/hashing.ts', 'src/evidence/store.ts', 'src/evidence/validate.ts', 'src/retrieval/index.ts', 'src/retrieval/normalize.ts', 'src/retrieval/concepts.ts',
      'src/retrieval/config.ts', 'src/retrieval/select.ts', 'src/retrieval/diagnostics.ts', 'src/evaluation/metrics.ts', 'src/evaluation/retrieval-report.ts'];
    const executableFiles = codeFiles.map(file => file.replace(/^src\//, 'dist/server/').replace(/\.ts$/, '.js'));
    const codeHashes = async (files: string[]) => Object.fromEntries(await Promise.all(files.map(async file => [file, sha256Bytes(await readFile(resolve(projectRoot, file)))])));
    const sourceCodeHashes = await codeHashes(codeFiles), executableHashes = await codeHashes(executableFiles);
    const freeze = createEvaluationFreeze({ queryManifest: queries, labelManifest: labels, config: DEFAULT_RETRIEVAL_CONFIG,
      indexHash: index.indexHash, sourceCodeHashes, executableHashes });
    await save('freeze.json', freeze); // Persisted BEFORE dev rankings, holdout remains sealed.
    const runs: unknown[] = [], summaries: { queryId: string; stage: string; elapsedMs: number; lanes: Record<string, number>; unionCount: number; selectedIds: readonly string[] }[] = [];
    for (const query of queries.queries.filter(q => q.split === 'dev')) {
      const seeds = labels.queries.find(q => q.queryId === query.queryId)!.labels.map(l => l.researcherId);
      let finalTrace: ReturnType<typeof retrieveWithTrace>['trace'] | undefined;
      for (const lanes of [['L0'], ['L0', 'L1'], ['L0', 'L1', 'L2']] as Lane[][]) {
        const stage = lanes.join('_') as 'L0' | 'L0_L1' | 'L0_L1_L2', config = { ...DEFAULT_RETRIEVAL_CONFIG, lanes };
        const input: RunInput = { runId: '11111111-1111-4111-8111-111111111111', companyId: query.companyId, challengeId: query.challengeId,
          datasetCommit: DATASET_COMMIT, promptVersion: 'no-model-task4', configVersion: 'retrieval-v1', mode: 'research' };
        const start = performance.now(), result = retrieveWithTrace(input, index, config), elapsedMs = performance.now() - start;
        if (result.trace.query.querySourceHash !== query.querySourceHash || result.pool.query !== query.queryText) throw new Error('Frozen query and run disagree.');
        for (const e of result.evidence) if (verifyEvidence(e, snapshot).length) throw new Error('Retrieved source failed.');
        const run = { queryId: query.queryId, stage, lanes: result.trace.lanes, unionIds: result.trace.unionIds, selectedIds: result.trace.selectedIds,
          omitted: result.trace.omitted.filter(o => o.reason === 'REVIEW_LIMIT_8').map(({ researcherId, reason }) => ({ researcherId, reason })) };
        runs.push(run); finalTrace = result.trace;
        await save(`${query.queryId}-${stage}.json`, { queryId: query.queryId, stage, freezeHash: freeze.hash, elapsedMs,
          traceHash: hashArtifact(result.trace), ...result });
        summaries.push({ queryId: query.queryId, stage, elapsedMs,
          lanes: Object.fromEntries(Object.entries(result.trace.lanes).map(([lane, details]) => [lane, details.candidateIds.length])),
          unionCount: result.trace.unionIds.length, selectedIds: result.trace.selectedIds });
      }
      if (!finalTrace) throw new Error('No dev comparison stage completed.');
      await save(`${query.queryId}-human-review.json`, manualMaterials(query,
        pooledReferenceCandidates(query.queryId, finalTrace.lanes, seeds), snapshot, index, finalTrace));
    }
    if (hashArtifact(await codeHashes(codeFiles)) !== hashArtifact(sourceCodeHashes)
      || hashArtifact(await codeHashes(executableFiles)) !== hashArtifact(executableHashes)) throw new Error('Source or executable changed during evaluation; report is not a frozen run.');
    const metrics = evaluateRetrievalMetrics({ queryManifest: queries, labelManifest: labels, runs });
    const report = { schemaVersion: 1, scope: 'dev_only', holdoutStatus: 'unopened', freezeHash: freeze.hash,
      matchingQualityStatus: 'pending_human_review_not_accepted', humanJudgedCount: freeze.humanJudgedCount,
      performance: { sourceLoadMs, indexBuildMs, serializedIndexBytes: index.serializedBytes, memoryAfterEvaluation: process.memoryUsage() },
      corpus: index.stats, sourceFiles: snapshot.files, summaries, metrics };
    await save('report.json', report);
    return { output, devQueries: queries.queries.filter(q => q.split === 'dev').length, runs: summaries.length, holdoutStatus: 'unopened', matchingQualityStatus: report.matchingQualityStatus,
      indexBuildMs, serializedIndexBytes: index.serializedBytes };
  } catch (error) {
    await save('failure.json', { status: 'failed', message: error instanceof Error ? error.message : 'Unknown local evaluation failure.' }); throw error;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 4 || args[0] !== '--split' || args[2] !== '--output') throw new Error('Usage: retrieval-report.js --split dev --output artifacts/evaluations/<new-name>');
    console.log(JSON.stringify(await runRetrievalReport({ split: args[1], output: args[3] })));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Evaluation failed.'); process.exitCode = 1; }
}
