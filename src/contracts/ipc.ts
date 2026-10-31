import { z } from 'zod';
import { JsonValueSchema, UuidSchema, HashSchema } from './primitives.js';
import { LimitsSchema } from './config.js';
import {
  RunInputSchema, RunOutcomeSchema, ProposalDraftSchema, CounterReportSchema, CriticReviewSchema, ReviewExpectationSchema,
} from './domain.js';
import { DiagnosticCodeSchema, WorkerEventSchema } from './events.js';

export const IPC_VERSION = 1 as const;
export const TypedArtifactSchema = JsonValueSchema.pipe(z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('proposal_draft'), artifact: ProposalDraftSchema }),
  z.strictObject({ kind: z.literal('counter_report'), artifact: CounterReportSchema }),
  z.strictObject({ kind: z.literal('critic_review'), artifact: CriticReviewSchema }),
]));

const envelope = { v: z.literal(IPC_VERSION), runId: UuidSchema };
// This is a trusted-control path declaration only. Filesystem containment and
// worker ownership belong to Task 3/5, not browser-safe schema validation.
const snapshotPath = z.string().min(1).max(4096).refine(path => path.trim().length > 0 && !path.includes('\0'));
const parent = z.discriminatedUnion('kind', [
  z.strictObject({ ...envelope, kind: z.literal('start'), runInput: RunInputSchema,
    snapshotPath, limits: LimitsSchema }),
  z.strictObject({ ...envelope, kind: z.literal('permit.granted'), requestId: UuidSchema, permitId: UuidSchema }),
  z.strictObject({ ...envelope, kind: z.literal('permit.denied'), requestId: UuidSchema, code: DiagnosticCodeSchema }),
  z.strictObject({ ...envelope, kind: z.literal('cancel'), reason: DiagnosticCodeSchema }),
]).superRefine((message, ctx) => {
  if (message.kind === 'start' && message.runInput.runId !== message.runId) {
    ctx.addIssue({ code: 'custom', path: ['runInput', 'runId'], message: 'Start contains a different Run identity.' });
  }
});

/** Only the parent transport may send these messages; format is not sender authentication. */
export const ParentToWorkerMessageSchema = JsonValueSchema.pipe(parent);

const worker = z.discriminatedUnion('kind', [
  z.strictObject({ ...envelope, kind: z.literal('ready') }),
  // Application-captured native Critic dispatch, never a field supplied by a model.
  z.strictObject({ ...envelope, kind: z.literal('review.dispatch'), expectation: ReviewExpectationSchema, snapshotHash: HashSchema }),
  z.strictObject({ ...envelope, kind: z.literal('event'), nativeOrAppEvent: WorkerEventSchema }),
  z.strictObject({ ...envelope, kind: z.literal('artifact'), typedArtifact: TypedArtifactSchema }),
  z.strictObject({ ...envelope, kind: z.literal('permit.request'), requestId: UuidSchema }),
  z.strictObject({ ...envelope, kind: z.literal('permit.release'), permitId: UuidSchema }),
  z.strictObject({ ...envelope, kind: z.literal('outcome'), typedOutcome: RunOutcomeSchema }),
]).superRefine((message, ctx) => {
  const innerRunId = message.kind === 'event' ? message.nativeOrAppEvent.runId
    : message.kind === 'artifact' ? message.typedArtifact.artifact.runId
    : message.kind === 'outcome' ? message.typedOutcome.runId
    : message.runId;
  if (innerRunId !== message.runId) {
    ctx.addIssue({ code: 'custom', message: 'Worker message contains cross-Run metadata or artifacts.' });
  }
});

/** Strict metadata/artifact contracts; transport must still authenticate the spawned worker. */
export const WorkerToParentMessageSchema = z.preprocess((value, ctx) => {
  // Prevalidate the complete input before nested schemas touch it. A pipe's
  // recursive JsonValue input type cannot represent nested ZodPipe inputs,
  // but this does not relax any accepted fields or the final union output.
  const json = JsonValueSchema.safeParse(value);
  if (!json.success) {
    ctx.addIssue({ code: 'custom', message: 'Expected strict finite JSON for worker IPC.' });
    return z.NEVER;
  }
  return json.data;
}, worker);
export type TypedArtifact = z.infer<typeof TypedArtifactSchema>;
export type ParentToWorkerMessage = z.infer<typeof ParentToWorkerMessageSchema>;
export type WorkerToParentMessage = z.infer<typeof WorkerToParentMessageSchema>;
