import { z } from 'zod';

export const DEFAULT_LIMITS = Object.freeze({ maxModelRequests: 16, requestTimeoutMs: 40_000,
  runTimeoutMs: 180_000, maxActiveRuns: 1, maxQueuedRuns: 3, queueTimeoutMs: 120_000,
  maxConcurrentModelRequests: 2, maxReviewCandidates: 8, maxRevisions: 1 });
export const LimitsSchema = z.strictObject({
  maxModelRequests: z.int().min(1).max(16), requestTimeoutMs: z.int().min(1).max(40_000),
  // Parent-owned explicit isolation-test/config override; normal admission defaults to one.
  runTimeoutMs: z.int().min(1).max(180_000), maxActiveRuns: z.int().min(1).max(2),
  maxQueuedRuns: z.int().min(0).max(3), queueTimeoutMs: z.int().min(1).max(120_000),
  maxConcurrentModelRequests: z.int().min(1).max(2), maxReviewCandidates: z.int().min(1).max(8),
  maxRevisions: z.literal(1),
}).refine(limits => limits.requestTimeoutMs <= limits.runTimeoutMs,
  'A request deadline cannot exceed the Run deadline.');
export type Limits = z.infer<typeof LimitsSchema>;
