import { z } from 'zod';
import { deepFreeze } from '../data/records.js';
export const RetrievalConfigSchema = z.strictObject({ version: z.literal('retrieval-v1'),
  lanes: z.array(z.enum(['L0', 'L1', 'L2'])).min(1).max(3).refine(v => v[0] === 'L0' && new Set(v).size === v.length),
  maxPerLane: z.literal(40), maxMerged: z.literal(120), maxSelected: z.literal(8),
  maxMatchedFields: z.literal(12), maxScoredFields: z.literal(3), k1: z.literal(1.2), b: z.literal(0.75), rrfK: z.literal(60) });
export const DEFAULT_RETRIEVAL_CONFIG = deepFreeze({ version: 'retrieval-v1' as const, lanes: ['L0', 'L1', 'L2'] as ('L0' | 'L1' | 'L2')[],
  maxPerLane: 40 as const, maxMerged: 120 as const, maxSelected: 8 as const, maxMatchedFields: 12 as const,
  maxScoredFields: 3 as const, k1: 1.2 as const, b: 0.75 as const, rrfK: 60 as const });
export type RetrievalConfig = z.infer<typeof RetrievalConfigSchema>;
export type Lane = 'L0' | 'L1' | 'L2';
// Versioned engineering stop list, not a calibrated semantic relevance threshold.
export const STOPWORDS_VERSION = 'generic-and-function-words-v1';
export const STOPWORDS = Object.freeze(('a an the and or of to in on for from with by as at is are was were be been being it its we our us you your they their this that these those ' +
  'have has had do does did not no without can could would should will may might must need needs want wants like use uses used using also more most many much some any ' +
  'one two three each every other into out over under about between during than then which what when where how who there here such only already still currently ' +
  'data software machine learning model models system systems research project projects work working technology technical method methods approach approaches solution solutions ' +
  'company companies client clients customer customers product products engineer engineering team new small large different several time years results problem problems make get ' +
  'university universities faculty department professor student students researcher researchers science scientific collaboration partner expertise experience institute institution novi sad serbia').split(/\s+/));
