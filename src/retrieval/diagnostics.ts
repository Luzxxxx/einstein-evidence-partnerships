export function lowRecallReasons(options: { selected: number; channelCount: number; missingDetail: boolean; expansions: number }) {
  return [...(options.selected === 0 ? ['NO_TECHNICAL_ANCHOR'] : []), ...(options.channelCount < 2 ? ['NARROW_CHANNEL_COVERAGE'] : []),
    ...(options.selected > 0 ? ['SEMANTIC_SUPPORT_UNASSESSED', 'RELEVANCE_UNCALIBRATED', 'LEXICAL_ANCHOR_ONLY_UNVERIFIED'] : []),
    ...(options.missingDetail ? ['QUERY_DETAIL_EMPTY'] : []), ...(options.expansions === 0 ? ['NO_DOMAIN_EXPANSION_APPLICABLE'] : [])];
}
