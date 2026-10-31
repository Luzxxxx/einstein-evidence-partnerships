import type { SourceBinding } from '../contracts/domain.js';
import type { DatasetSnapshot } from '../data/snapshot.js';
import { arrayValue, objectValue } from '../data/records.js';
import { resolveField, type EvidenceSnapshot } from './store.js';

/** Coordinates are deterministic application data. Identity relations require
 * an explicit ID in the exact original relation field; other fields remain
 * contextual source_field facts and provide no researcher-ownership proof. */
export function sourceBindingForEvidence(e: EvidenceSnapshot[number], researcherId: string, snapshot: DatasetSnapshot): SourceBinding {
  const source = e.source, base = { evidenceId: e.id, fieldPointer: source.fieldPointer };
  if (source.file === 'data/researchers.json' && source.recordId === researcherId)
    return { ...base, relation: 'profile_field', subjectId: researcherId, objectId: researcherId };
  const relation = source.file === 'data/publications.jsonl' ? { field: 'authors', name: 'author_of' as const }
    : source.file === 'data/projects.json' ? { field: 'participants', name: 'project_participant' as const }
    : source.file === 'data/patents.json' ? { field: 'inventors', name: 'patent_inventor' as const } : undefined;
  const tokens = source.fieldPointer.split('/').slice(1).map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (relation && !source.codePointRange && tokens[0] === relation.field) {
    const value = resolveField(source, snapshot).value;
    const explicit = tokens.length === 1 ? arrayValue(value).some(v => objectValue(v).researcher_id === researcherId)
      : tokens.length === 2 && /^(0|[1-9]\d*)$/.test(tokens[1]!) ? objectValue(value).researcher_id === researcherId
      : tokens.length === 3 && /^(0|[1-9]\d*)$/.test(tokens[1]!) && tokens[2] === 'researcher_id' && value === researcherId;
    if (explicit) return { ...base, relation: relation.name, subjectId: researcherId, objectId: source.recordId };
  }
  return { ...base, relation: 'source_field', subjectId: source.recordId, objectId: source.recordId };
}
