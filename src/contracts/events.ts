import { z } from 'zod';
import {
  AgentRoleSchema, ArtifactIdSchema, HashSchema, JsonValueSchema,
  PositiveCountSchema, TimestampSchema, UuidSchema, VersionSchema,
} from './primitives.js';
import { RawUsageSchema, RunStatusSchema } from './domain.js';

export { AgentRoleSchema } from './primitives.js';

/** References are format-checked here; existence/Run ownership is checked by the transport/store. */
export const ArtifactRefSchema = z.strictObject({ id: ArtifactIdSchema, hash: HashSchema });
export const ArtifactKindSchema = z.enum(['proposal_draft', 'counter_report', 'critic_review']);
export const DiagnosticCodeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,95}$/);
const metadataName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const codes = z.array(DiagnosticCodeSchema).max(32);
// Bounded structural metadata only; never provider text, arguments, headers or unknown names.
export const GatewayDiagnosticSchema = z.strictObject({
  stage: z.enum(['request','permit','fetch','body','http','json','credential','usage','protocol','release','trace','complete']),
  httpStatus: z.int().min(100).max(599).nullable(),
  choiceCount: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  toolCallCount: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  allowedToolNames: z.array(metadataName).max(128), returnedAllowedToolNames: z.array(metadataName).max(128),
  unknownToolNameCount: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  finishReason: z.enum(['stop','length','tool_calls','function_call','content_filter','other']).nullable(),
  finishReasonPresent: z.boolean(), usageStatus: z.enum(['reported','missing','invalid','not_available']),
}).refine(v=>v.returnedAllowedToolNames.every(name=>v.allowedToolNames.includes(name)),
  'Returned tool names must be in the request allowlist.');
export type GatewayDiagnostic = z.infer<typeof GatewayDiagnosticSchema>;

const base = {
  runId: UuidSchema,
  agentId: UuidSchema.optional(),
  role: AgentRoleSchema.optional(),
  loopId: UuidSchema.optional(),
  taskId: UuidSchema.optional(),
  contextId: UuidSchema.optional(),
  attempt: VersionSchema.optional(),
};
const agentContext = {
  ...base, agentId: UuidSchema, role: AgentRoleSchema, loopId: UuidSchema,
  taskId: UuidSchema, contextId: UuidSchema, attempt: VersionSchema,
};

const participant = z.strictObject({ kind: z.literal('participant'), participantId: UuidSchema,
  participantKind: z.enum(['human', 'agent', 'observer']) });
const messageRef = z.strictObject({ kind: z.literal('message_ref'), senderId: UuidSchema,
  messageRef: ArtifactRefSchema });
const loop = z.strictObject({ kind: z.literal('loop'), resultRef: ArtifactRefSchema.optional() });
const toolRef = z.strictObject({ kind: z.literal('tool_ref'), callId: metadataName,
  toolName: metadataName, artifactRef: ArtifactRefSchema });
const answerRef = z.strictObject({ kind: z.literal('answer_ref'), artifactRef: ArtifactRefSchema });
const task = z.strictObject({ kind: z.literal('task') });
const artifactRef = z.strictObject({ kind: z.literal('artifact_ref'), artifactKind: ArtifactKindSchema,
  artifactRef: ArtifactRefSchema, version: VersionSchema });
// Only declared output field names are diagnostic paths. Unknown model keys and
// arbitrary exception messages must never enter persisted events.
export const AnswerIssueFieldSchema = z.enum(['researcherId', 'claims', 'sections', 'id', 'kind', 'text',
  'evidenceIds', 'sourceBindings', 'limitations', 'evidenceId', 'subjectId', 'relation', 'objectId', 'fieldPointer',
  'summary', 'technicalRationale', 'cooperationScope', 'validation', 'constraints', 'unknowns', 'claimIds',
  'checkedFacets', 'checkedCandidates', 'findings', 'noCounterEvidenceFound', 'scope', 'code', 'severity',
  'explanation', 'recheckQuestion', 'verdict', '$unknown']);
export const AnswerIssueCodeSchema = z.enum(['invalid_type', 'too_big', 'too_small', 'invalid_format',
  'not_multiple_of', 'unrecognized_keys', 'invalid_union', 'invalid_key', 'invalid_element', 'invalid_value', 'custom']);
export const AnswerValidationSchema = z.strictObject({
  stage: z.enum(['answer_capture', 'json_parse', 'schema_validation', 'application_validation']),
  requestId: UuidSchema.optional(), permitId: UuidSchema.optional(),
  answerHash: HashSchema.optional(), answerBytes: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  issues: z.array(z.strictObject({
    path: z.array(z.union([AnswerIssueFieldSchema, z.int().nonnegative().max(Number.MAX_SAFE_INTEGER)])).max(16),
    code: AnswerIssueCodeSchema,
    expected: z.enum(['string', 'number', 'boolean', 'array', 'object', 'null', 'undefined', 'bigint', 'symbol', 'function', 'date']).optional(),
    rule: z.enum(['FACT_EVIDENCE_REQUIRED', 'BINDING_OUTSIDE_EVIDENCE', 'EVIDENCE_BINDING_REQUIRED',
      'RELATION_SUBJECT_MISMATCH', 'DRAFT_IDENTITY_MISMATCH', 'DRAFT_CLAIM_REFERENCES', 'DUPLICATE_FINDING_IDS',
      'CLAIM_FINDING_REFERENCES', 'APPROVAL_WITH_BLOCKERS', 'NONAPPROVAL_REQUIRES_BLOCKER',
      'REVISION_REQUIRES_QUESTION', 'COUNTER_CHECKS_REQUIRED', 'EVIDENCE_ID_UNKNOWN',
      'COUNTER_FINDING_SCOPE', 'COUNTER_CLAIM_REFERENCE', 'DUPLICATE_REFERENCE_IDS', 'DUPLICATE_RESEARCHERS']).optional(),
  })).max(24),
});
export type AnswerValidation = z.infer<typeof AnswerValidationSchema>;
const taskFailure = z.strictObject({ kind: z.literal('task'), code: DiagnosticCodeSchema,
  retryable: z.literal(false), validation: AnswerValidationSchema.optional() });
const reviewRef = z.strictObject({ kind: z.literal('review_ref'), reviewRef: ArtifactRefSchema,
  verdict: z.enum(['approve', 'revise', 'insufficient']), draftVersion: VersionSchema });
const request = z.strictObject({ kind: z.literal('request'), requestId: UuidSchema, permitId: UuidSchema,
  diagnostic: GatewayDiagnosticSchema.optional() });
const requestFailure = z.strictObject({ kind: z.literal('request'), requestId: UuidSchema,
  permitId: UuidSchema, code: DiagnosticCodeSchema, retryable: z.literal(false), diagnostic: GatewayDiagnosticSchema.optional() });
const usage = z.strictObject({ kind: z.literal('usage'), usage: RawUsageSchema });
const toolBatch = z.strictObject({ kind: z.literal('tool_batch'), batchId: UuidSchema,
  phase: z.enum(['staged','progress','completed','cancelled','failed']),
  calls: z.array(z.strictObject({ callId: metadataName, toolName: metadataName, argumentsSha256: HashSchema,
    started: z.boolean(), returned: z.boolean(), outputSha256: HashSchema.optional() })).min(1).max(8),
}).superRefine((v,ctx)=>{
  if(new Set(v.calls.map(call=>call.callId)).size!==v.calls.length)
    ctx.addIssue({code:'custom',message:'Batch call IDs must be unique.'});
  if(v.calls.some(call=>(call.returned&&!call.started)||call.returned!==Boolean(call.outputSha256)))
    ctx.addIssue({code:'custom',message:'Returned flags require an actual started invocation and output hash.'});
  if(v.phase==='completed'&&v.calls.some(call=>!call.returned))
    ctx.addIssue({code:'custom',message:'A completed batch requires every returned output.'});
});

// Mozaik names below come from the fixed 4.2.0 EventPublisherLoopVisitor and
// participant/message events. Payloads are deliberately sanitized projections,
// never raw Mozaik inputs/outputs or streamed model reasoning.
const workerVariants = [
  z.strictObject({ ...base, source: z.literal('mozaik'), type: z.literal('participant.joined'), payload: participant }),
  z.strictObject({ ...base, source: z.literal('mozaik'), type: z.literal('participant.left'), payload: participant }),
  z.strictObject({ ...base, source: z.literal('mozaik'), type: z.literal('message.sent'), payload: messageRef }),
  z.strictObject({ ...agentContext, source: z.literal('mozaik'), type: z.literal('message_received.started'), payload: loop }),
  z.strictObject({ ...agentContext, source: z.literal('mozaik'), type: z.literal('message_received.completed'), payload: loop }),
  z.strictObject({ ...agentContext, source: z.literal('mozaik'), type: z.literal('inference.started'), payload: loop }),
  z.strictObject({ ...agentContext, source: z.literal('mozaik'), type: z.literal('inference.completed'), payload: loop }),
  z.strictObject({ ...agentContext, source: z.literal('mozaik'), type: z.literal('function_call.started'), payload: toolRef }),
  z.strictObject({ ...agentContext, source: z.literal('mozaik'), type: z.literal('function_call.completed'), payload: toolRef }),
  z.strictObject({ ...agentContext, source: z.literal('mozaik'), type: z.literal('model.answer'), payload: answerRef }),
  z.strictObject({ ...agentContext, source: z.literal('application'), type: z.literal('task.started'), payload: task }),
  z.strictObject({ ...agentContext, source: z.literal('application'), type: z.literal('task.completed'), payload: artifactRef }),
  z.strictObject({ ...agentContext, source: z.literal('application'), type: z.literal('task.failed'), payload: taskFailure }),
  z.strictObject({ ...agentContext, source: z.literal('application'), type: z.literal('tool.batch.updated'), payload: toolBatch }),
  z.strictObject({ ...agentContext, source: z.literal('application'), type: z.literal('artifact.validated'), payload: artifactRef }),
  z.strictObject({ ...agentContext, role: z.literal('critic'), source: z.literal('application'),
    type: z.literal('review.completed'), payload: reviewRef }),
  z.strictObject({ ...agentContext, source: z.literal('model'), type: z.literal('model.request.started'), payload: request }),
  z.strictObject({ ...agentContext, source: z.literal('model'), type: z.literal('model.request.completed'), payload: request }),
  z.strictObject({ ...agentContext, source: z.literal('model'), type: z.literal('model.request.failed'), payload: requestFailure }),
  z.strictObject({ ...agentContext, source: z.literal('model'), type: z.literal('model.usage'), payload: usage }),
] as const;

const worker = z.discriminatedUnion('type', workerVariants);
const artifactByRole = {
  proposer: 'proposal_draft', 'counter-evidence': 'counter_report', critic: 'critic_review',
} as const;
function roleArtifactIssues(event: {
  type: string;
  role?: z.infer<typeof AgentRoleSchema>;
  payload: { kind: string; artifactKind?: z.infer<typeof ArtifactKindSchema> };
}, ctx: z.RefinementCtx): void {
  if ((event.type === 'task.completed' || event.type === 'artifact.validated')
      && (!event.role || event.payload.artifactKind !== artifactByRole[event.role])) {
    ctx.addIssue({ code: 'custom', path: ['payload', 'artifactKind'],
      message: 'Declared role and artifact kind do not correspond.' });
  }
}
/** Worker cannot claim parent status, sequencing, timestamps or supervisor events. */
export const WorkerEventSchema = JsonValueSchema.pipe(worker).superRefine(roleArtifactIssues);

const supervisorVariants = [
  z.strictObject({ ...base, source: z.literal('supervisor'), type: z.literal('run.status'),
    payload: z.strictObject({ kind: z.literal('run_status'), status: RunStatusSchema, reasonCodes: codes }) }),
  z.strictObject({ ...base, source: z.literal('supervisor'), type: z.literal('worker.spawned'),
    payload: z.strictObject({ kind: z.literal('worker'), pid: PositiveCountSchema }) }),
  z.strictObject({ ...base, source: z.literal('supervisor'), type: z.literal('worker.ready'),
    payload: z.strictObject({ kind: z.literal('worker'), pid: PositiveCountSchema }) }),
  z.strictObject({ ...base, source: z.literal('supervisor'), type: z.literal('worker.exited'),
    payload: z.strictObject({ kind: z.literal('worker'), pid: PositiveCountSchema,
      exitCode: z.int().nullable(), signal: z.enum(['SIGTERM', 'SIGKILL', 'SIGINT']).nullable() }) }),
  z.strictObject({ ...base, source: z.literal('supervisor'), type: z.literal('permit.granted'),
    payload: z.strictObject({ kind: z.literal('permit'), requestId: UuidSchema, permitId: UuidSchema }) }),
  z.strictObject({ ...base, source: z.literal('supervisor'), type: z.literal('permit.denied'),
    payload: z.strictObject({ kind: z.literal('permit'), requestId: UuidSchema, code: DiagnosticCodeSchema }) }),
  z.strictObject({ ...base, source: z.literal('supervisor'), type: z.literal('permit.released'),
    payload: z.strictObject({ kind: z.literal('permit'), permitId: UuidSchema }) }),
  z.strictObject({ ...base, source: z.literal('supervisor'), type: z.literal('event.ignored'),
    payload: z.strictObject({ kind: z.literal('ignored_ref'), reasonCode: DiagnosticCodeSchema,
      contentHash: HashSchema.optional() }) }),
  z.strictObject({ ...base, source: z.literal('supervisor'), type: z.literal('cleanup.completed'),
    payload: z.strictObject({ kind: z.literal('cleanup'), confirmed: z.literal(true) }) }),
  z.strictObject({ ...base, source: z.literal('supervisor'), type: z.literal('cleanup.failed'),
    payload: z.strictObject({ kind: z.literal('cleanup'), confirmed: z.literal(false), code: DiagnosticCodeSchema }) }),
] as const;

const parentEnvelope = { schemaVersion: z.literal(1), seq: PositiveCountSchema,
  at: TimestampSchema, elapsedMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER) };
const storedVariants = [...workerVariants, ...supervisorVariants].map(schema => schema.extend(parentEnvelope));
export const StoredEventSchema = JsonValueSchema.pipe(z.discriminatedUnion('type',
  [storedVariants[0]!, ...storedVariants.slice(1)])).superRefine(roleArtifactIssues);

export const EVENT_SCHEMA_VERSION = 1 as const;
export const WORKER_EVENT_TYPES = Object.freeze(workerVariants.map(schema => schema.shape.type.value));
export const STORED_EVENT_TYPES = Object.freeze(storedVariants.map(schema => schema.shape.type.value));
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;
export type StoredEvent = z.infer<typeof StoredEventSchema>;
