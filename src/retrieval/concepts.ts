import { deepFreeze } from '../data/records.js';
import { normalizeText } from './normalize.js';
export const DICTIONARY_VERSION = 'domain-concepts-v1.1-ai-proposed-unreviewed';
export const CONCEPT_RULES = deepFreeze([
  { expansionId: 'industrial-unlabelled-anomaly', domain: 'industrial_networks', triggers: [['modbus', 'bacnet'], ['unusual behaviour', 'without labelled', 'normal traffic']],
    derivedTerms: ['anomaly detection', 'unsupervised', 'baseline'], documentContext: ['industrial', 'network', 'traffic', 'scada', 'modbus', 'bacnet'] },
  { expansionId: 'serbian-language-variation', domain: 'language', triggers: [['serbian', 'serbian language', 'srpski'], ['search', 'inflection', 'cyrillic', 'latin', 'word forms']],
    derivedTerms: ['morphology', 'morphological', 'lemmatization', 'transliteration'], documentContext: ['serbian', 'language', 'text', 'lexicon', 'nlp', 'linguistic'] },
  { expansionId: 'electronics-changing-board', domain: 'electronics', triggers: [['solder', 'board', 'pcb'], ['changing', 'retraining', 'new board', 'few labelled']],
    derivedTerms: ['few shot', 'domain adaptation', 'continual learning'], documentContext: ['solder', 'electronic', 'board', 'component', 'pcb'] },
  { expansionId: 'firmware-interrupted-update', domain: 'firmware', triggers: [['firmware', 'bootloader'], ['update', 'transfer', 'rollback']],
    derivedTerms: ['secure boot', 'over the air', 'fault tolerance'], documentContext: ['firmware', 'embedded', 'boot', 'update'] },
] as const);
export type Expansion = { expansionId: string; domain: string; sourceFragment: string; derivedTerms: string[]; documentContext: string[];
  provenance: 'ai_proposed_from_dev_requirements'; dictionaryVersion: string };
export function expandConcepts(text: string): Expansion[] {
  const query = ` ${normalizeText(text)} `;
  return CONCEPT_RULES.flatMap(rule => {
    const hits = rule.triggers.map(group => group.find(term => query.includes(` ${normalizeText(term)} `)));
    return hits.every(Boolean) ? [{ expansionId: rule.expansionId, domain: rule.domain, sourceFragment: text,
      derivedTerms: [...rule.derivedTerms], documentContext: [...rule.documentContext],
      provenance: 'ai_proposed_from_dev_requirements' as const, dictionaryVersion: DICTIONARY_VERSION }] : [];
  });
}
