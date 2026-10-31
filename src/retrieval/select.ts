import { RetrievalConfigSchema, type RetrievalConfig, type Lane } from './config.js';
export type LaneHit = { researcherId: string; score: number };
export const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function fuseRanks(input: Record<Lane, LaneHit[]>, configuration: RetrievalConfig) {
  const config = RetrievalConfigSchema.parse(configuration);
  const lanes = {} as Record<Lane, { candidateIds: string[]; allRankedIds: string[] }>;
  const merged = new Map<string, { researcherId: string; score: number; laneRanks: Partial<Record<Lane, number>> }>();
  const omitted: { researcherId: string; reason: string; lane?: Lane }[] = [];
  for (const lane of ['L0', 'L1', 'L2'] as const) {
    const ranked = config.lanes.includes(lane) ? [...input[lane]].sort((a, b) => b.score - a.score || compareIds(a.researcherId, b.researcherId)) : [];
    if (ranked.some(hit => !Number.isFinite(hit.score) || hit.score <= 0) || new Set(ranked.map(h => h.researcherId)).size !== ranked.length)
      throw new Error('Invalid or duplicate lane scores.');
    const ids = ranked.map(h => h.researcherId), selected = ids.slice(0, config.maxPerLane);
    lanes[lane] = { candidateIds: selected, allRankedIds: ids };
    ids.slice(config.maxPerLane).forEach(researcherId => omitted.push({ researcherId, reason: 'LANE_LIMIT_40', lane }));
    selected.forEach((researcherId, i) => {
      const row = merged.get(researcherId) ?? { researcherId, score: 0, laneRanks: {} };
      row.score += 1 / (config.rrfK + i + 1); row.laneRanks[lane] = i + 1; merged.set(researcherId, row);
    });
  }
  const fusion = [...merged.values()].sort((a, b) => b.score - a.score || compareIds(a.researcherId, b.researcherId));
  if (fusion.length > config.maxMerged) throw new Error('Merged candidate budget exceeded.');
  const unionIds = fusion.map(r => r.researcherId), selectedIds = unionIds.slice(0, config.maxSelected);
  unionIds.slice(config.maxSelected).forEach(researcherId => omitted.push({ researcherId, reason: 'REVIEW_LIMIT_8' }));
  return { lanes, fusion, unionIds, selectedIds, omitted };
}
