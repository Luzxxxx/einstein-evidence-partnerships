import { RunInputSchema, CandidatePoolSchema, type SourceRef, type Evidence } from '../contracts/domain.js';
import { assertSnapshot, type DatasetSnapshot } from '../data/snapshot.js';
import { deepFreeze, arrayValue, objectValue, SourceError, type LocatedRecord } from '../data/records.js';
import { resolveField, resolveEvidence, createEvidenceSnapshot } from '../evidence/store.js';
import { hashArtifact, hashCandidatePool, hashSourceRecord, sha256Bytes } from '../evidence/hashing.js';
import { normalizeText, tokenize, latinizeSerbian, NORMALIZATION_VERSION, TRANSLITERATION_VERSION } from './normalize.js';
import { DEFAULT_RETRIEVAL_CONFIG, RetrievalConfigSchema, STOPWORDS, STOPWORDS_VERSION, type Lane, type RetrievalConfig } from './config.js';
import { expandConcepts, DICTIONARY_VERSION, type Expansion } from './concepts.js';
import { fuseRanks, compareIds, type LaneHit } from './select.js';
import { lowRecallReasons } from './diagnostics.js';
export const INDEX_VERSION = 'explicit-source-field-bm25-v1';
type Owner = { researcherId: string; identityRef?: SourceRef; relation: 'profile_field' | 'author_of' | 'project_participant' | 'patent_inventor' };
type FieldDoc = { sourceRef: SourceRef; text: string; owners: Owner[]; weight: number;
  tf: Map<string, number>[]; lengths: number[] };
type PublicDoc = Owner & { sourceRef: SourceRef };
type Backing = { snapshot: DatasetSnapshot; docs: FieldDoc[]; df: Map<string, number>[]; average: number[]; byPerson: Map<string, readonly PublicDoc[]> };
const stores = new WeakMap<object, Backing>(), stops = new Set(STOPWORDS);
function terms(text: string): string[] { return tokenize(text).filter(t => t.length >= 2 && !stops.has(t) && !/^\p{N}+$/u.test(t)); }
const frequencies = (tokens: string[]) => { const map = new Map<string, number>(); for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1); return map; };
function reference(row: LocatedRecord, fieldPointer: string): SourceRef {
  return { file: row.file, recordId: row.recordId, locator: row.locator, fieldPointer, derivedRecordId: row.derivedRecordId };
}
export type RetrievalIndex = Readonly<{ datasetCommit: string; sourcePolicy: DatasetSnapshot['sourcePolicy']; indexVersion: string; indexHash: string; serializedBytes: number;
  stats: Readonly<Record<string, number>>; researcherIds: readonly string[]; getDocuments(id: string): readonly PublicDoc[] }>;

/** All actual records are enumerated. Profile result lists NEVER establish result ownership. */
export function buildIndex(snapshot: DatasetSnapshot): RetrievalIndex {
  assertSnapshot(snapshot);
  const researchers = snapshot.listRecords('researcher'), ids = researchers.map(r => r.recordId), known = new Set(ids);
  if (ids.length !== snapshot.counts.researcher) throw new SourceError('INCOMPLETE_CORPUS', 'source', 'Researcher enumeration does not cover the source snapshot.');
  const docs: FieldDoc[] = [], byPerson = new Map(ids.map(id => [id, [] as PublicDoc[]]));
  const add = (row: LocatedRecord, field: string, owners: Owner[], weight: number) => {
    const sourceRef = reference(row, `/${field}`), resolved = resolveField(sourceRef, snapshot);
    if (!resolved.text.trim() || (Array.isArray(resolved.value) && resolved.value.length === 0) || owners.length === 0) return;
    const reps = [terms(resolved.text), terms(latinizeSerbian(resolved.text))];
    docs.push({ sourceRef, text: resolved.text, owners, weight, tf: reps.map(frequencies), lengths: reps.map(r => r.length) });
    for (const owner of owners) byPerson.get(owner.researcherId)!.push(deepFreeze({ ...owner, sourceRef }));
  };
  for (const r of researchers) for (const [field, weight] of [['fields', 1.8], ['keywords', 1.4], ['bio', 1]] as const)
    add(r, field, [{ researcherId: r.recordId, relation: 'profile_field' }], weight);
  let excludedNullAuthors = 0;
  for (const [kind, relationField, relation, fields] of [
    ['publication', 'authors', 'author_of', ['title', 'abstract', 'keywords']],
    ['project', 'participants', 'project_participant', ['title', 'summary']],
    ['patent', 'inventors', 'patent_inventor', ['title', 'abstract']],
  ] as const) for (const row of snapshot.listRecords(kind)) {
    const owners = new Map<string, Owner>();
    arrayValue(row.record[relationField]).forEach((value, slot) => {
      const rid = objectValue(value).researcher_id;
      if (rid === null) { if (kind === 'publication') excludedNullAuthors++; return; }
      if (typeof rid !== 'string' || !known.has(rid)) throw new SourceError('DANGLING_REFERENCE', 'source', 'Explicit result owner is absent from researcher corpus.');
      if (!owners.has(rid)) owners.set(rid, { researcherId: rid, relation, identityRef: reference(row, `/${relationField}/${slot}/researcher_id`) });
    });
    for (const field of fields) add(row, field, [...owners.values()], field === 'title' ? 1.2 : 1);
  }
  const df = [new Map<string, number>(), new Map<string, number>()], average = [0, 0];
  for (const doc of docs) for (let mode = 0; mode < 2; mode++) {
    average[mode] += doc.lengths[mode];
    for (const token of doc.tf[mode].keys()) df[mode].set(token, (df[mode].get(token) ?? 0) + 1);
  }
  for (let mode = 0; mode < 2; mode++) average[mode] = average[mode] / Math.max(1, docs.length);
  const serialized = { version: INDEX_VERSION, normalization: NORMALIZATION_VERSION, transliteration: TRANSLITERATION_VERSION,
    stopwords: STOPWORDS_VERSION, sourceFiles: snapshot.files, researcherIds: ids,
    documents: docs.map(d => ({ sourceRef: d.sourceRef, text: d.text, owners: d.owners, weight: d.weight,
      frequencies: d.tf.map(map => [...map]), lengths: d.lengths })) };
  const index: RetrievalIndex = Object.freeze({ datasetCommit: snapshot.datasetCommit, sourcePolicy: snapshot.sourcePolicy, indexVersion: INDEX_VERSION,
    indexHash: hashArtifact({ version: INDEX_VERSION, normalization: NORMALIZATION_VERSION, transliteration: TRANSLITERATION_VERSION,
      stopwords: STOPWORDS_VERSION, sourceFiles: snapshot.files, researcherIds: ids, technicalFields: docs.length,
      aggregation: 'max3-field-bm25; field weights profile1.8/1.4/bio1/title1.2/body1' }),
    serializedBytes: Buffer.byteLength(JSON.stringify(serialized)),
    stats: Object.freeze({ researchers: researchers.length, publications: snapshot.counts.publication, projects: snapshot.counts.project,
      patents: snapshot.counts.patent, technicalFields: docs.length, excludedNullAuthors,
      profileOnlyConflicts: snapshot.diagnostics.filter(d => d.code === 'PROFILE_LINK_ASYMMETRY').length }),
    researcherIds: Object.freeze(ids), getDocuments(id: string) { return byPerson.get(id) ?? Object.freeze([]); } });
  for (const rows of byPerson.values()) Object.freeze(rows);
  stores.set(index, { snapshot, docs, df, average, byPerson }); return index;
}

type FieldHit = { document: number; score: number; terms: string[]; lanes: Lane[] };
function scoreLane(state: Backing, lane: Lane, query: string, expansions: Expansion[], config: RetrievalConfig) {
  const mode = lane === 'L1' ? 1 : 0;
  const original = [...new Set(terms(mode ? latinizeSerbian(query) : query))];
  const scores = new Map<string, FieldHit[]>();
  state.docs.forEach((doc, document) => {
    let queryTerms = original;
    if (lane === 'L2') queryTerms = [...new Set(expansions.filter(e => e.documentContext.some(t => doc.tf[0].has(t)))
      .flatMap(e => e.derivedTerms.flatMap(terms)))];
    if (queryTerms.length === 0 || doc.lengths[mode] === 0) return;
    let score = 0; const matched: string[] = [];
    for (const term of queryTerms) {
      const tf = doc.tf[mode].get(term) ?? 0; if (!tf) continue;
      const frequency = state.df[mode].get(term)!;
      const idf = Math.log(1 + (state.docs.length - frequency + 0.5) / (frequency + 0.5));
      score += idf * tf * (config.k1 + 1) / (tf + config.k1 * (1 - config.b + config.b * doc.lengths[mode] / state.average[mode])); matched.push(term);
    }
    if (score <= 0) return;
    for (const owner of doc.owners) {
      const hits = scores.get(owner.researcherId) ?? [];
      hits.push({ document, score: score * doc.weight, terms: matched, lanes: [lane] }); scores.set(owner.researcherId, hits);
    }
  });
  const ranked: LaneHit[] = [];
  for (const [researcherId, fields] of scores) {
    fields.sort((a, b) => b.score - a.score || a.document - b.document);
    ranked.push({ researcherId, score: fields.slice(0, config.maxScoredFields).reduce((sum, f) => sum + f.score, 0) });
  }
  ranked.sort((a, b) => b.score - a.score || compareIds(a.researcherId, b.researcherId));
  return { ranked, fields: scores };
}

export function retrieveWithTrace(rawInput: unknown, index: RetrievalIndex, configuration: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG) {
  const input = RunInputSchema.parse(rawInput), config = RetrievalConfigSchema.parse(configuration), state = stores.get(index);
  if (!state || input.datasetCommit !== index.datasetCommit) throw new SourceError('INVALID_INDEX', 'source', 'Expected an index built from the pinned snapshot.');
  const company = state.snapshot.getRecord('company', input.companyId);
  if (!company) throw new SourceError('COMPANY_NOT_FOUND', 'source', 'Unknown company ID.');
  const challenges = arrayValue(company.record.challenges), slot = challenges.findIndex(c => objectValue(c).id === input.challengeId);
  if (slot < 0) throw new SourceError('CHALLENGE_NOT_FOUND', 'source', 'Unknown challenge for this company.');
  const sourceFields = ['text', 'detail'].map(field => {
    const source = reference(company, `/challenges/${slot}/${field}`), resolved = resolveField(source, state.snapshot);
    if (typeof resolved.value !== 'string') throw new SourceError('INVALID_QUERY_SOURCE', 'source', 'Challenge query must retain original string fields.');
    return { source, value: resolved.value, sha256: sha256Bytes(new TextEncoder().encode(resolved.value)) };
  });
  const query = sourceFields.map(f => f.value).join('\n');
  if (!query.trim()) throw new SourceError('EMPTY_QUERY', 'source', 'Challenge has no original query text.');
  const querySourceHash = hashSourceRecord({ datasetCommit: input.datasetCommit, companyId: input.companyId, challengeId: input.challengeId,
    sourceFields: Object.fromEntries(sourceFields.map((f, i) => [i === 0 ? 'text' : 'detail', { source: f.source, value: f.value,
      excerptSha256: f.sha256, recordSha256: company.recordSha256,
      sourceFileSha256: state.snapshot.files.find(file => file.file === company.file)!.sourceFileSha256 }])) });
  const expansions = config.lanes.includes('L2') ? expandConcepts(query) : [];
  const scored = {} as Record<Lane, ReturnType<typeof scoreLane>>;
  for (const lane of ['L0', 'L1', 'L2'] as const) scored[lane] = config.lanes.includes(lane)
    ? scoreLane(state, lane, query, lane === 'L2' ? expansions : [], config) : { ranked: [], fields: new Map() };
  const fused = fuseRanks({ L0: scored.L0.ranked, L1: scored.L1.ranked, L2: scored.L2.ranked }, config);
  const evidence = new Map<string, Evidence>(), ownership: { researcherId: string; contentEvidenceId: string; identityEvidenceId: string; relation: string }[] = [];
  const addEvidence = (ref: SourceRef) => { const e = resolveEvidence(ref, state.snapshot); evidence.set(e.id, e); return e; };
  const restrictions: { researcherId: string; evidenceId: string | null; sourceRef: SourceRef; originalValue: unknown; originalText: string; status: string }[] = [];
  const candidates = fused.selectedIds.map((rid, rank) => {
    const combined = new Map<number, FieldHit>();
    for (const lane of config.lanes) for (const hit of scored[lane].fields.get(rid) ?? []) {
      const old = combined.get(hit.document);
      combined.set(hit.document, old ? { ...old, score: Math.max(old.score, hit.score), lanes: [...old.lanes, lane], terms: [...new Set([...old.terms, ...hit.terms])] } : { ...hit });
    }
    const hits = [...combined.values()].sort((a, b) => b.score - a.score || a.document - b.document).slice(0, config.maxMatchedFields);
    const ids = new Set<string>(), restrictionRefs: string[] = [];
    const matchedFields = hits.map(hit => {
      const doc = state.docs[hit.document], owner = doc.owners.find(o => o.researcherId === rid)!;
      const content = addEvidence(doc.sourceRef);
      const person = state.snapshot.getRecord('researcher', rid)!;
      const identity = addEvidence(owner.identityRef ?? reference(person, '/id'));
      ids.add(content.id); ids.add(identity.id);
      ownership.push({ researcherId: rid, contentEvidenceId: content.id, identityEvidenceId: identity.id, relation: owner.relation });
      return { sourceRef: doc.sourceRef, terms: hit.terms.slice(0, 128), score: hit.score };
    });
    const person = state.snapshot.getRecord('researcher', rid)!;
    for (const field of ['notes', 'open_to', 'industry_experience']) {
      const ref = reference(person, `/${field}`), full = resolveField(ref, state.snapshot);
      if (!full.text.trim()) {
        restrictions.push({ researcherId: rid, evidenceId: null, sourceRef: ref, originalValue: full.value, originalText: full.text, status: 'empty_original_field' });
        continue;
      }
      const e = addEvidence(ref); restrictionRefs.push(e.id); ids.add(e.id);
      restrictions.push({ researcherId: rid, evidenceId: e.id, sourceRef: ref, originalValue: full.value, originalText: full.text, status: 'original_evidence' });
    }
    return { researcherId: rid, rank: rank + 1, channels: config.lanes.filter(lane => fused.lanes[lane].candidateIds.includes(rid)), matchedFields,
      evidenceIds: [...ids], restrictionRefs, identityFlags: [...new Set(state.snapshot.diagnostics.filter(d => d.recordId === rid || d.relatedId === rid).map(d => d.code))] };
  });
  const nonemptySets = new Set(config.lanes.map(lane => JSON.stringify(fused.lanes[lane].candidateIds)).filter(ids => ids !== '[]'));
  const reasons = lowRecallReasons({ selected: candidates.length, channelCount: nonemptySets.size, missingDetail: !sourceFields[1].value.trim(), expansions: expansions.length });
  const content = { poolVersion: 1, datasetCommit: input.datasetCommit, query, expandedTerms: [...new Set(expansions.flatMap(e => e.derivedTerms))],
    mergedCandidateCount: fused.unionIds.length, candidates, diagnostics: { corpusCounts: { ...index.stats, indexedResearchers: index.researcherIds.length },
      channelStatus: Object.fromEntries((['L0', 'L1', 'L2'] as const).map(lane => [lane, !config.lanes.includes(lane) ? 'unavailable' : fused.lanes[lane].candidateIds.length ? 'available' : 'empty'])),
      facets: expansions.map(e => e.domain), mergedCount: fused.unionIds.length, selectedCount: candidates.length,
      truncated: fused.unionIds.length > candidates.length, lowRecallReasons: reasons, judgedCapture: null } };
  const pool = CandidatePoolSchema.parse({ ...content, poolHash: hashCandidatePool(content) });
  const laneExplanations = Object.fromEntries((['L0', 'L1', 'L2'] as const).map(lane => [lane, fused.lanes[lane].candidateIds.map(researcherId => ({
    researcherId, rawScore: scored[lane].ranked.find(r => r.researcherId === researcherId)!.score, scoreDirection: 'higher_is_better',
    contributingFields: scored[lane].fields.get(researcherId)!.slice(0, config.maxScoredFields).map(hit => {
      const doc = state.docs[hit.document], owner = doc.owners.find(o => o.researcherId === researcherId)!;
      return { sourceRef: doc.sourceRef, identityRef: owner.identityRef ?? reference(state.snapshot.getRecord('researcher', researcherId)!, '/id'),
        relation: owner.relation, terms: hit.terms, fieldScore: hit.score };
    }) }))]));
  const trace = { schemaVersion: 1, sourcePolicy: index.sourcePolicy, poolHash: pool.poolHash, indexHash: index.indexHash, indexVersion: INDEX_VERSION,
    config, configHash: hashArtifact(config), dictionaryVersion: DICTIONARY_VERSION, validationStatus: 'uncalibrated' as const,
    query: { companyId: input.companyId, challengeId: input.challengeId, sourceFields, querySourceHash,
      originalQuery: query, normalizedQuery: normalizeText(query), transliteratedQuery: latinizeSerbian(query), expansions,
      background: ['tech', 'products'].map(field => ({ sourceRef: reference(company, `/${field}`), originalValue: company.record[field], usedForScoring: false })) },
    coverage: { searchedResearchers: index.researcherIds.length, corpusCounts: index.stats,
      perLaneDomain: Object.fromEntries((['L0', 'L1', 'L2'] as const).map(lane => [lane, config.lanes.includes(lane) ? index.researcherIds.length : 0])) },
    lanes: fused.lanes, laneExplanations, fusion: fused.fusion, unionIds: fused.unionIds, selectedIds: fused.selectedIds, omitted: fused.omitted,
    ownership, restrictions, identityDiagnostics: state.snapshot.diagnostics.filter(d => fused.selectedIds.includes(d.recordId) || (d.relatedId && fused.selectedIds.includes(d.relatedId))),
    expansionPasses: config.lanes.includes('L2') ? 1 : 0, expansionTrigger: scored.L0.ranked.length || scored.L1.ranked.length ? 'standard_L2' : 'low_anchor_retry',
    scoreDirection: 'higher_is_better', scoreMeaning: 'uncalibrated_lexical_relevance_only', fusionMethod: 'RRF-k60; ties researcherId; max3 fields per lane',
    anchorMeaning: 'non-stopword lexical heuristic; not independently verified technical relevance',
    evidenceSufficiency: 'not_assessed' };
  return deepFreeze({ pool, trace, evidence: createEvidenceSnapshot([...evidence.values()]) });
}
export function retrieveCandidates(input: unknown, index: RetrievalIndex, config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG) { return retrieveWithTrace(input, index, config).pool; }
