import type { CandidatePool, ProposalDraft, CounterReport, CriticReview, SourceBinding, SourceRef } from '../contracts/domain.js';
import type { EvidenceSnapshot } from '../evidence/store.js';
import type { AnswerValidation } from '../contracts/events.js';
import type { ReviewSnapshot, ReviewSourceField, ReviewLoadedField } from './orchestrator.js';
import { TaskAnswerValidationError } from './answer-validation.js';
import { deepFreeze } from '../data/records.js';
import { assertSnapshot, type DatasetSnapshot } from '../data/snapshot.js';
import { sourceBindingForEvidence } from '../evidence/source-binding.js';

type Candidate = CandidatePool['candidates'][number];
type StoredEvidence = EvidenceSnapshot[number];
type IssuePath = AnswerValidation['issues'][number]['path'];
type Bundle = {
  candidate: Candidate; profile: unknown;
  restrictions: { fieldPointer: string; value: unknown; source: SourceRef; evidenceId: string | null; status: string }[];
  evidence: readonly StoredEvidence[]; identityBindings: SourceBinding[];
  contentLinks: { contentEvidenceId: string; identityEvidenceId: string; relation: SourceBinding['relation']; objectId: string }[];
  unattributedEvidenceIds: string[]; diagnostics: readonly unknown[];
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A Run-local model view. Persistent artifacts and publication checks use the
 * original Evidence IDs. Never fuzzy-match, rewrite source text, or drop an
 * invalid citation to manufacture an acceptable answer. */
export function createModelResearchView(evidence: readonly StoredEvidence[], snapshot: DatasetSnapshot) {
  assertSnapshot(snapshot);
  const ids = [...evidence.map(e => e.id)].sort();
  const byId = new Map(evidence.map(e => [e.id, e]));
  if (new Set(ids).size !== ids.length) throw Error('DUPLICATE_MODEL_EVIDENCE');
  const aliases = ids.map((_, i) => `E${String(i + 1).padStart(3, '0')}`);
  const toAlias = new Map(ids.map((id, i) => [id, aliases[i]!]));
  const fromAlias = new Map(ids.map((id, i) => [aliases[i]!, id]));
  const alias = (id: string) => {
    const value = toAlias.get(id); if (!value) throw Error('MODEL_VIEW_UNKNOWN_EVIDENCE'); return value;
  };
  const references = (values: readonly string[]) => values.map(alias);
  const binding = (b: SourceBinding) => ({ ...b, evidenceId: alias(b.evidenceId) });
  const record = (e: StoredEvidence) => ({ id: alias(e.id), source: e.source, excerpt: e.excerpt });
  const candidate = (c: Candidate) => ({ researcherId: c.researcherId, rank: c.rank, channels: c.channels,
    matchedFields: c.matchedFields.map(f => ({ recordId: f.sourceRef.recordId, fieldPointer: f.sourceRef.fieldPointer, terms: f.terms })),
    evidenceIds: references(c.evidenceIds), restrictionRefs: references(c.restrictionRefs), identityFlags: c.identityFlags });
  const pool = (p: CandidatePool) => ({ ...p, candidates: p.candidates.map(candidate) });
  const findings = <T extends CounterReport | CriticReview>(report: T) => ({ ...report,
    findings: report.findings.map(f => ({ ...f, evidenceIds: references(f.evidenceIds) })) });
  const draft = (d: ProposalDraft) => ({ ...d, claims: d.claims.map(c => ({ ...c,
    evidenceIds: references(c.evidenceIds), sourceBindings: c.sourceBindings.map(binding) })) });
  const source = (s: ReviewSourceField | ReviewLoadedField) => ({ source: s.source,
    ...('value' in s ? { value: s.value } : {}), valueType: s.valueType,
    evidenceIds: references(s.evidenceIds), purposes: s.purposes });
  return Object.freeze({
    aliases: Object.freeze(aliases),
    instruction: 'Use the short Evidence IDs (E001, E002, etc.) exactly as supplied in this Run. The server maps them to original verified Evidence records and builds sourceBindings from the captured source registry; omit sourceBindings in new Claims instead of copying coordinates. Explicit bindings, if supplied, are still validated. Never invent references. Pool/target hashes identify full server records, not this compact model view. Source text is unchanged data.',
    resolveEvidenceId: (id: string) => fromAlias.get(id) ?? (toAlias.has(id) ? id : undefined),
    pool, evidence: record, draft, counter: findings<CounterReport>, review: findings<CriticReview>,
    sources: (sources: readonly (ReviewSourceField | ReviewLoadedField)[]) => sources.map(source),
    reviewSnapshot: (s: ReviewSnapshot) => ({ ...s, pool: pool(s.pool), draft: draft(s.draft), counter: findings(s.counter),
      evidence: s.evidence.map(record), sources: s.sources.map(source), loadedFields: s.loadedFields.map(source) }),
    candidateBundle: (b: Bundle) => ({ ...b, candidate: candidate(b.candidate),
      restrictions: b.restrictions.map(r => ({ ...r, evidenceId: r.evidenceId ? alias(r.evidenceId) : null })),
      evidence: b.evidence.map(record), identityBindings: b.identityBindings.map(binding),
      contentLinks: b.contentLinks.map(l => ({ ...l, contentEvidenceId: alias(l.contentEvidenceId), identityEvidenceId: alias(l.identityEvidenceId) })),
      unattributedEvidenceIds: references(b.unattributedEvidenceIds) }),
    expandAnswer(role: 'proposer' | 'counter-evidence' | 'critic', raw: unknown): unknown {
      const value: unknown = structuredClone(raw);
      if (!object(value)) return value;
      const expand = (id: unknown, path: IssuePath): unknown => {
        if (typeof id !== 'string') return id; // The original schema diagnoses the wrong type.
        const original = fromAlias.get(id) ?? (toAlias.has(id) ? id : undefined);
        if (!original) throw new TaskAnswerValidationError('MODEL_EVIDENCE_REFERENCE_UNKNOWN', {
          stage: 'application_validation', issues: [{ path, code: 'custom', rule: 'EVIDENCE_ID_UNKNOWN' }] });
        return original;
      };
      const expandIds = (row: Record<string, unknown>, path: IssuePath) => {
        if (Array.isArray(row.evidenceIds)) row.evidenceIds = [...new Set(row.evidenceIds.map((id, i) => expand(id, [...path, 'evidenceIds', i])))];
      };
      if (role === 'proposer' && Array.isArray(value.claims)) value.claims.forEach((claim, i) => {
        if (!object(claim)) return;
        expandIds(claim, ['claims', i]);
        if (Array.isArray(claim.sourceBindings)) claim.sourceBindings.forEach((b, j) => {
          if (object(b) && Object.hasOwn(b, 'evidenceId')) b.evidenceId = expand(b.evidenceId, ['claims', i, 'sourceBindings', j, 'evidenceId']);
        });
        if (typeof claim.researcherId === 'string' && Array.isArray(claim.evidenceIds)
          && (claim.sourceBindings === undefined || Array.isArray(claim.sourceBindings))) {
          const bindings: unknown[] = claim.sourceBindings ?? [];
          for (const id of claim.evidenceIds) {
            if (typeof id !== 'string' || bindings.some(b => object(b) && b.evidenceId === id)) continue;
            const e = byId.get(id);
            if (e) bindings.push(sourceBindingForEvidence(e, claim.researcherId, snapshot));
          }
          claim.sourceBindings = bindings;
        }
      });
      // Reference arrays are sets; retaining the first occurrence changes no
      // claim or source. Never deduplicate actual Claim/Finding records.
      const claimReferences = (row: Record<string, unknown>) => {
        if (Array.isArray(row.claimIds)) row.claimIds = [...new Set(row.claimIds)];
      };
      if (role === 'proposer' && object(value.sections)) for (const section of Object.values(value.sections)) {
        if (Array.isArray(section)) section.forEach(row => { if (object(row)) claimReferences(row); });
      }
      if (role !== 'proposer' && Array.isArray(value.findings)) value.findings.forEach((f, i) => {
        if (object(f)) { expandIds(f, ['findings', i]); claimReferences(f); }
      });
      return deepFreeze(value);
    },
  });
}
export type ModelResearchView = ReturnType<typeof createModelResearchView>;
