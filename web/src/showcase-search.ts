import type { Catalog, ShowcaseEntry } from './types.js';

const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Search the saved collection only. Never ranks researchers or changes evidence. */
export function filterShowcaseEntries(entries: readonly ShowcaseEntry[], catalog: Catalog | null, query: string): ShowcaseEntry[] {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    const company = catalog?.companies.find(c => c.id === entry.companyId);
    const challenge = company?.challenges.find(c => c.id === entry.challengeId);
    const text = normalize([entry.companyId, entry.researcherId, entry.challengeId, entry.companyName, company?.name, entry.researcherName, challenge?.text].filter(Boolean).join(' '));
    return terms.every(term => text.includes(term));
  });
}
