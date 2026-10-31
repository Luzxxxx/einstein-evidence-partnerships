import { canonicalizeArtifact } from '../contracts/canonical.js';
import { EvidenceSchema, ProposalDraftSchema, type Evidence, type SourceBinding } from '../contracts/domain.js';
import { assertSnapshot, type DatasetSnapshot } from '../data/snapshot.js';
import { SourceError, arrayValue, objectValue, type RecordObject } from '../data/records.js';
import { hashEvidenceSnapshot } from './hashing.js';
import { createEvidenceSnapshot, resolveEvidence, resolveField, type DeepReadonly } from './store.js';

export type ValidationIssue = Readonly<{ category: 'source' | 'location' | 'relation' | 'insufficient' | 'semantic_review';
  severity: 'error' | 'warning' | 'info'; code: string; message: string; claimId?: string; evidenceId?: string }>;
function sourceIssue(error: unknown, evidenceId?: string): ValidationIssue {
  return { category: error instanceof SourceError ? error.category : 'source', severity: 'error',
    code: error instanceof SourceError ? error.code : 'INVALID_EVIDENCE', message: error instanceof SourceError ? error.message : 'Invalid Evidence contract.',
    ...(evidenceId ? { evidenceId } : {}) };
}
/** Re-resolve all source coordinates from the immutable snapshot; IDs alone prove nothing. */
export function verifyEvidence(value: unknown, snapshot: DatasetSnapshot): ValidationIssue[] {
  try {
    assertSnapshot(snapshot); canonicalizeArtifact(value);
    const e = EvidenceSchema.parse(value);
    if (e.datasetCommit !== snapshot.datasetCommit) throw new SourceError('DATASET_COMMIT_MISMATCH', 'source', 'Evidence belongs to a different dataset commit.');
    const expected = resolveEvidence(e.source, snapshot);
    const issues: ValidationIssue[] = [];
    if (e.id !== expected.id) issues.push({ category: 'location', severity: 'error', code: 'EVIDENCE_ID_MISMATCH',
      message: 'Evidence ID differs from its application-generated source/content identity.', evidenceId: e.id });
    for (const key of ['sourceFileSha256', 'recordSha256', 'excerptSha256', 'excerpt'] as const)
      if (e[key] !== expected[key]) issues.push({ category: key === 'sourceFileSha256' || key === 'recordSha256' ? 'source' : 'location',
        severity: 'error', code: key === 'excerpt' ? 'EXCERPT_MISMATCH' : `${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}_MISMATCH`,
        message: `Declared ${key} differs from its resolved original source.`, evidenceId: e.id });
    return issues;
  } catch (error) { return [sourceIssue(error)]; }
}

function participantIssue(record: RecordObject, field: string, subjectId: string, pointer: string): string | undefined {
  const tokens = pointer.split('/').slice(1).map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  // Membership elsewhere in the record cannot authorize an unrelated Evidence field.
  if (tokens[0] !== field) return 'RELATION_FIELD_MISMATCH';
  const participants = arrayValue(record[field]);
  if (!participants.some(p => objectValue(p).researcher_id === subjectId)) return 'EXPLICIT_PARTICIPANT_ID_MISSING';
  if (tokens.length > 1) {
    const index = Number(tokens[1]);
    if (!Number.isSafeInteger(index) || !participants[index] || objectValue(participants[index]).researcher_id !== subjectId)
      return 'PARTICIPANT_SLOT_MISMATCH';
  }
  return undefined;
}

function bindingIssue(binding: SourceBinding, e: DeepReadonly<Evidence>, snapshot: DatasetSnapshot): string | undefined {
  const field = resolveField(e.source, snapshot), row = field.located;
  if (binding.fieldPointer !== e.source.fieldPointer) return 'BINDING_FIELD_MISMATCH';
  const recordId = binding.relation === 'source_field' || binding.relation === 'challenge_field' ? binding.subjectId : binding.objectId;
  if (recordId !== row.recordId) return 'BINDING_RECORD_MISMATCH';
  switch (binding.relation) {
    case 'profile_field': return row.file === 'data/researchers.json' && binding.subjectId === row.recordId ? undefined : 'PROFILE_ID_MISMATCH';
    case 'author_of': return row.file === 'data/publications.jsonl'
      ? participantIssue(row.record, 'authors', binding.subjectId, binding.fieldPointer) : 'RELATION_SOURCE_KIND_MISMATCH';
    case 'project_participant': return row.file === 'data/projects.json'
      ? participantIssue(row.record, 'participants', binding.subjectId, binding.fieldPointer) : 'RELATION_SOURCE_KIND_MISMATCH';
    case 'patent_inventor': return row.file === 'data/patents.json'
      ? participantIssue(row.record, 'inventors', binding.subjectId, binding.fieldPointer) : 'RELATION_SOURCE_KIND_MISMATCH';
    case 'challenge_field': {
      if (row.file !== 'data/companies.json') return 'RELATION_SOURCE_KIND_MISMATCH';
      const tokens = binding.fieldPointer.split('/');
      if (tokens[1] !== 'challenges' || !/^(0|[1-9]\d*)$/.test(tokens[2] ?? '')) return 'CHALLENGE_FIELD_MISMATCH';
      const challenge = arrayValue(row.record.challenges)[Number(tokens[2])];
      return challenge && objectValue(challenge).id === binding.objectId ? undefined : 'CHALLENGE_ID_MISMATCH';
    }
    case 'source_field': return undefined; // Only a record/field fact; NO candidate identity proof.
  }
}

/** Read-only current-Run Evidence snapshot is supplied explicitly, never looked up in mutable state.
 * Zero errors means source/declared structural checks passed, NOT semantic support or publication permission. */
export function validateClaimSources(draft: unknown, snapshot: DatasetSnapshot, evidenceList: unknown): ValidationIssue[] {
  try {
    assertSnapshot(snapshot); canonicalizeArtifact(draft);
    const d = ProposalDraftSchema.parse(draft), evidence = createEvidenceSnapshot(evidenceList), issues: ValidationIssue[] = [];
    if (hashEvidenceSnapshot(evidence) !== d.evidenceSnapshotHash)
      issues.push({ category: 'source', severity: 'error', code: 'EVIDENCE_SNAPSHOT_HASH_MISMATCH', message: 'Draft does not bind the supplied current Evidence snapshot.' });
    const byId = new Map(evidence.map(e => [e.id, e]));
    const invalid = new Set<string>();
    for (const e of evidence) {
      const failures = verifyEvidence(e, snapshot); issues.push(...failures);
      if (failures.length) invalid.add(e.id);
    }
    if (!snapshot.getRecord('company', d.pair.companyId)
      || !arrayValue(snapshot.getRecord('company', d.pair.companyId)!.record.challenges).some(c => objectValue(c).id === d.challengeId))
      issues.push({ category: 'relation', severity: 'error', code: 'DRAFT_CHALLENGE_MISSING', message: 'Draft company/challenge is absent from the source snapshot.' });
    for (const claim of d.claims) {
      if (!snapshot.getRecord('researcher', claim.researcherId)) issues.push({ category: 'relation', severity: 'error', code: 'RESEARCHER_NOT_FOUND', message: 'Claim researcher ID does not exist.', claimId: claim.id });
      for (const id of claim.evidenceIds) if (!byId.has(id)) issues.push({ category: 'location', severity: 'error', code: 'EVIDENCE_NOT_FOUND', message: 'Claim references missing Evidence.', claimId: claim.id, evidenceId: id });
      for (const binding of claim.sourceBindings) {
        const e = byId.get(binding.evidenceId); if (!e || invalid.has(e.id)) continue;
        const code = bindingIssue(binding, e, snapshot);
        if (code) { issues.push({ category: 'relation', severity: 'error', code, message: 'Declared source relation does not match its original record/field.', claimId: claim.id, evidenceId: e.id }); continue; }
        if (binding.relation === 'source_field' && binding.objectId === binding.subjectId)
          issues.push({ category: 'insufficient', severity: 'warning', code: 'CONTEXT_ONLY_NO_CANDIDATE_RELATION',
            message: 'This is only a source-record field fact; no candidate ownership or technical support has been established.', claimId: claim.id, evidenceId: e.id });
        if (binding.relation === 'source_field' && binding.objectId !== binding.subjectId) {
          // A contextual link may only cite a candidate when an explicit same-record identity
          // relation is also declared and actually valid. Never infer this edge from prose/name.
          const explicit = claim.sourceBindings.some(b => b.evidenceId === binding.evidenceId
            && ['author_of', 'profile_field', 'project_participant', 'patent_inventor'].includes(b.relation)
            && b.subjectId === binding.objectId && bindingIssue(b, e, snapshot) === undefined);
          if (!explicit) issues.push({ category: 'insufficient', severity: 'error', code: 'CANDIDATE_RELATION_UNPROVEN', message: 'source_field proves only its record field, not the candidate relationship.', claimId: claim.id, evidenceId: e.id });
        }
        for (const diagnostic of snapshot.diagnostics.filter(diag => diag.recordId === e.source.recordId))
          issues.push({ category: 'insufficient', severity: 'warning', code: diagnostic.code, message: diagnostic.message, claimId: claim.id, evidenceId: e.id });
      }
      issues.push({ category: 'semantic_review', severity: 'info', code: 'SEMANTIC_SUPPORT_UNASSESSED',
        message: 'Technical relevance and natural-language entailment require the later independent Critic.', claimId: claim.id });
    }
    return issues;
  } catch (error) { return [sourceIssue(error)]; }
}
