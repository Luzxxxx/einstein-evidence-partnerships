import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  WorkerEventSchema, StoredEventSchema, ArtifactRefSchema, WORKER_EVENT_TYPES, STORED_EVENT_TYPES,
} from '../../dist/server/contracts/events.js';
import {
  ParentToWorkerMessageSchema, WorkerToParentMessageSchema, TypedArtifactSchema,
} from '../../dist/server/contracts/ipc.js';
import { DEFAULT_LIMITS } from '../../dist/server/contracts/config.js';
import { ids, h, input, draft, counter, review } from '../fixtures/contracts.mjs';

const requestId = '66666666-6666-4666-8666-666666666666';
const permitId = '77777777-7777-4777-8777-777777777777';
const loopId = '88888888-8888-4888-8888-888888888888';
const ref = () => ({ id: 'answer-1', hash: h(1) });
const context = () => ({ runId: ids.run, agentId: ids.agent, role: 'proposer',
  loopId, taskId: ids.task, contextId: ids.context, attempt: 1 });
const native = () => ({ ...context(), source: 'mozaik', type: 'inference.started', payload: { kind: 'loop' } });
const stored = () => ({ ...native(), schemaVersion: 1, seq: 1,
  at: '2026-10-30T10:00:00.000Z', elapsedMs: 0 });
const start = () => ({ v: 1, kind: 'start', runId: ids.run, runInput: input(),
  snapshotPath: 'C:\\本地 数据\\einstein snapshot', limits: structuredClone(DEFAULT_LIMITS) });
const artifact = () => ({ v: 1, kind: 'artifact', runId: ids.run,
  typedArtifact: { kind: 'proposal_draft', artifact: draft() } });

function rejects(schema, value, description) {
  assert.equal(schema.safeParse(value).success, false, description);
}

test('WorkerEvent contains correlated native metadata but no parent-assigned envelope fields', () => {
  assert.deepEqual(WorkerEventSchema.parse(native()), native());
  for (const [key, value] of [['seq', 1], ['at', '2026-10-30T10:00:00.000Z'],
    ['elapsedMs', 0], ['schemaVersion', 1]]) {
    rejects(WorkerEventSchema, { ...native(), [key]: value }, key);
  }
});

test('source, type, payload kind and role form an exact allowlist', () => {
  for (const change of [
    { source: 'supervisor' }, { source: 'application' }, { source: 'unknown' },
    { type: 'agent.loop.started' }, { type: 'run.approved' },
    { role: 'coordinator' }, { role: 'assistant' }, { payload: { kind: 'anything' } },
  ]) rejects(WorkerEventSchema, { ...native(), ...change }, JSON.stringify(change));
  const incomplete = native(); delete incomplete.loopId;
  rejects(WorkerEventSchema, incomplete, 'native loop metadata needs loopId');
});

test('native messages, tools and answers expose references instead of raw content', () => {
  const valid = [
    { runId: ids.run, source: 'mozaik', type: 'participant.joined',
      payload: { kind: 'participant', participantId: ids.agent, participantKind: 'agent' } },
    { runId: ids.run, source: 'mozaik', type: 'message.sent',
      payload: { kind: 'message_ref', senderId: ids.agent, messageRef: ref() } },
    { ...context(), source: 'mozaik', type: 'function_call.started',
      payload: { kind: 'tool_ref', callId: 'call_1', toolName: 'get_evidence', artifactRef: ref() } },
    { ...context(), source: 'mozaik', type: 'function_call.completed',
      payload: { kind: 'tool_ref', callId: 'call_1', toolName: 'get_evidence', artifactRef: ref() } },
    { ...context(), source: 'mozaik', type: 'model.answer', payload: { kind: 'answer_ref', artifactRef: ref() } },
  ];
  for (const event of valid) assert.deepEqual(WorkerEventSchema.parse(event), event);
  for (const key of ['arguments', 'output', 'answer', 'Authorization', 'rawResponse', 'reasoning_content', 'approved']) {
    const event = structuredClone(valid.at(-1)); event.payload[key] = 'untrusted body';
    rejects(WorkerEventSchema, event, key);
  }
  rejects(WorkerEventSchema, { ...context(), source: 'mozaik', type: 'inference.stream',
    payload: { kind: 'stream', reasoning_content: 'secret reasoning' } });
});

test('reference IDs accept domain artifact IDs and reject path/URL/unknown metadata', () => {
  for (const id of ['e-1', 'review_2', ids.run]) assert.equal(ArtifactRefSchema.parse({ id, hash: h(2) }).id, id);
  for (const id of ['', '../file', 'https://example.invalid', 'key with spaces']) rejects(ArtifactRefSchema, { id, hash: h(2) });
  rejects(ArtifactRefSchema, { ...ref(), rawResponse: {} });
  rejects(ArtifactRefSchema, { id: 'e-1', hash: 'A'.repeat(64) });
});

test('model usage preserves unknown token counts and rejects negative/fractional or extra fields', () => {
  const event = { ...context(), source: 'model', type: 'model.usage',
    payload: { kind: 'usage', usage: { source: 'gateway_reported', requestId, promptTokens: 10 } } };
  assert.deepEqual(WorkerEventSchema.parse(event), event);
  assert.equal('completionTokens' in WorkerEventSchema.parse(event).payload.usage, false);
  for (const count of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
    const bad = structuredClone(event); bad.payload.usage.totalTokens = count;
    rejects(WorkerEventSchema, bad, String(count));
  }
  const bad = structuredClone(event); bad.payload.usage.Authorization = 'forbidden';
  rejects(WorkerEventSchema, bad);
});

test('every worker event type has a valid strict metadata DTO with its exact source', () => {
  const events = [];
  for (const type of ['participant.joined', 'participant.left']) events.push({ runId: ids.run,
    source: 'mozaik', type, payload: { kind: 'participant', participantId: ids.agent, participantKind: 'agent' } });
  events.push({ runId: ids.run, source: 'mozaik', type: 'message.sent',
    payload: { kind: 'message_ref', senderId: ids.agent, messageRef: ref() } });
  for (const type of ['message_received.started', 'message_received.completed', 'inference.started', 'inference.completed']) {
    events.push({ ...context(), source: 'mozaik', type, payload: { kind: 'loop' } });
  }
  for (const type of ['function_call.started', 'function_call.completed']) events.push({ ...context(), source: 'mozaik', type,
    payload: { kind: 'tool_ref', callId: 'call_1', toolName: 'get_evidence', artifactRef: ref() } });
  events.push({ ...context(), source: 'mozaik', type: 'model.answer', payload: { kind: 'answer_ref', artifactRef: ref() } });
  events.push({ ...context(), source: 'application', type: 'task.started', payload: { kind: 'task' } });
  for (const type of ['task.completed', 'artifact.validated']) events.push({ ...context(), source: 'application', type,
    payload: { kind: 'artifact_ref', artifactKind: 'proposal_draft', artifactRef: ref(), version: 1 } });
  events.push({ ...context(), source: 'application', type: 'task.failed',
    payload: { kind: 'task', code: 'INVALID_ARTIFACT', retryable: false } });
  events.push({ ...context(), source: 'application', type: 'tool.batch.updated',
    payload: { kind:'tool_batch',batchId:ids.run,phase:'staged',calls:[{
      callId:'call_1',toolName:'read_evidence',argumentsSha256:h(1),started:false,returned:false,
    }] } });
  events.push({ ...context(), role: 'critic', source: 'application', type: 'review.completed',
    payload: { kind: 'review_ref', reviewRef: ref(), verdict: 'approve', draftVersion: 1 } });
  for (const type of ['model.request.started', 'model.request.completed']) events.push({ ...context(), source: 'model', type,
    payload: { kind: 'request', requestId, permitId } });
  events.push({ ...context(), source: 'model', type: 'model.request.failed',
    payload: { kind: 'request', requestId, permitId, code: 'REQUEST_TIMEOUT', retryable: false } });
  events.push({ ...context(), source: 'model', type: 'model.usage',
    payload: { kind: 'usage', usage: { source: 'gateway_reported', requestId } } });
  assert.deepEqual(events.map(event => event.type).sort(), [...WORKER_EVENT_TYPES].sort());
  assert.equal(events.length, 20);
  for (const event of events) {
    assert.deepEqual(WorkerEventSchema.parse(event), event, event.type);
    rejects(WorkerEventSchema, { ...event, source: 'unknown' }, `${event.type} source`);
    rejects(WorkerEventSchema, { ...event, payload: { ...event.payload, rawResponse: {} } }, `${event.type} payload`);
    const parentEnvelope = { ...event, schemaVersion: 1, seq: 1, at: '2026-10-30T10:00:00.000Z', elapsedMs: 0 };
    assert.deepEqual(StoredEventSchema.parse(parentEnvelope), parentEnvelope);
  }
});

test('batch metadata cannot duplicate calls, invent returns or assert incomplete completion',()=>{
  const base={...context(),source:'application',type:'tool.batch.updated',payload:{kind:'tool_batch',batchId:ids.run,phase:'staged',
    calls:[{callId:'call_1',toolName:'read_evidence',argumentsSha256:h(1),started:false,returned:false}]}};
  assert.deepEqual(WorkerEventSchema.parse(base),base);
  const wrong=[];
  let x=structuredClone(base);x.payload.calls.push({...x.payload.calls[0]});wrong.push(x);
  x=structuredClone(base);x.payload.calls[0].returned=true;x.payload.calls[0].outputSha256=h(2);wrong.push(x);
  x=structuredClone(base);x.payload.phase='completed';wrong.push(x);
  x=structuredClone(base);x.payload.calls[0].outputSha256=h(2);wrong.push(x);
  x=structuredClone(base);x.payload.calls=Array.from({length:9},(_,n)=>({...x.payload.calls[0],callId:`call_${n}`}));wrong.push(x);
  x=structuredClone(base);x.payload.calls[0].arguments='private source text';wrong.push(x);
  for(const event of wrong)rejects(WorkerEventSchema,event);
});

test('safe gateway structure DTO rejects returned names outside its request allowlist',()=>{
  const e={...context(),source:'model',type:'model.request.failed',payload:{kind:'request',requestId,permitId,code:'GATEWAY_UNKNOWN_TOOL',retryable:false,
    diagnostic:{stage:'protocol',httpStatus:200,choiceCount:1,toolCallCount:1,allowedToolNames:['read_evidence'],returnedAllowedToolNames:[],
      unknownToolNameCount:1,finishReason:'tool_calls',finishReasonPresent:true,usageStatus:'missing'}}};
  assert.deepEqual(WorkerEventSchema.parse(e),e);
  const bad=structuredClone(e);bad.payload.diagnostic.returnedAllowedToolNames=['unknown_provider_text'];rejects(WorkerEventSchema,bad);
});

test('only StoredEvent admits supervisor status and parent seq/time fields', () => {
  assert.deepEqual(StoredEventSchema.parse(stored()), stored());
  const event = { schemaVersion: 1, runId: ids.run, seq: 2, at: '2026-10-30T10:00:00.001Z', elapsedMs: 1,
    source: 'supervisor', type: 'run.status', payload: { kind: 'run_status', status: 'approved', reasonCodes: [] } };
  assert.deepEqual(StoredEventSchema.parse(event), event);
  const { schemaVersion, seq, at, elapsedMs, ...workerAttempt } = event;
  rejects(WorkerEventSchema, workerAttempt);
  for (const change of [
    { seq: 0 }, { seq: 1.5 }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { elapsedMs: -1 },
    { at: '2026-10-30T18:00:00+08:00' }, { at: 'not a date' }, { schemaVersion: 2 }, { approved: true },
  ]) rejects(StoredEventSchema, { ...stored(), ...change }, JSON.stringify(change));
});

test('all ten supervisor events are parent-only metadata projections', () => {
  const payloads = {
    'run.status': { kind: 'run_status', status: 'researching', reasonCodes: [] },
    'worker.spawned': { kind: 'worker', pid: 1234 },
    'worker.ready': { kind: 'worker', pid: 1234 },
    'worker.exited': { kind: 'worker', pid: 1234, exitCode: 0, signal: null },
    'permit.granted': { kind: 'permit', requestId, permitId },
    'permit.denied': { kind: 'permit', requestId, code: 'RUN_TERMINAL' },
    'permit.released': { kind: 'permit', permitId },
    'event.ignored': { kind: 'ignored_ref', reasonCode: 'STALE_EVENT', contentHash: h(2) },
    'cleanup.completed': { kind: 'cleanup', confirmed: true },
    'cleanup.failed': { kind: 'cleanup', confirmed: false, code: 'CLEANUP_UNCONFIRMED' },
  };
  assert.equal(Object.keys(payloads).length + WORKER_EVENT_TYPES.length, STORED_EVENT_TYPES.length);
  for (const [type, payload] of Object.entries(payloads)) {
    const event = { schemaVersion: 1, runId: ids.run, seq: 1, at: '2026-10-30T10:00:00.000Z', elapsedMs: 0,
      source: 'supervisor', type, payload };
    assert.deepEqual(StoredEventSchema.parse(event), event, type);
    const { schemaVersion, seq, at, elapsedMs, ...workerAttempt } = event;
    rejects(WorkerEventSchema, workerAttempt, type);
    rejects(WorkerToParentMessageSchema, { v: 1, kind: 'event', runId: ids.run, nativeOrAppEvent: workerAttempt }, type);
  }
});

test('application completion/validation artifact kinds must correspond to the declared role', () => {
  const roles = { proposer: 'proposal_draft', 'counter-evidence': 'counter_report', critic: 'critic_review' };
  for (const type of ['task.completed', 'artifact.validated']) {
    for (const [role, expectedKind] of Object.entries(roles)) {
      for (const artifactKind of Object.values(roles)) {
        const event = { ...context(), role, source: 'application', type,
          payload: { kind: 'artifact_ref', artifactKind, artifactRef: ref(), version: 1 } };
        const parentEvent = { ...event, schemaVersion: 1, seq: 1, at: '2026-10-30T10:00:00.000Z', elapsedMs: 0 };
        const expected = artifactKind === expectedKind;
        assert.equal(WorkerEventSchema.safeParse(event).success, expected, `${type}: ${role} -> ${artifactKind}`);
        assert.equal(StoredEventSchema.safeParse(parentEvent).success, expected, `stored ${type}: ${role} -> ${artifactKind}`);
      }
    }
  }
});

test('metadata contracts reject Date, undefined and body-bearing extras instead of stripping them', () => {
  rejects(StoredEventSchema, { ...stored(), at: new Date() });
  rejects(WorkerEventSchema, { ...native(), unsupported: undefined });
  const withGetter = native();
  Object.defineProperty(withGetter.payload, 'Authorization', { enumerable: true, get() { throw new Error('getter must not run'); } });
  assert.doesNotThrow(() => rejects(WorkerEventSchema, withGetter));
  for (const key of ['env', 'headers', 'apiKey', 'rawReasoning']) rejects(WorkerEventSchema, { ...native(), [key]: {} });
});

test('parent messages are versioned strict control DTOs and start binds its inner runId', () => {
  const valid = [start(),
    { v: 1, kind: 'permit.granted', runId: ids.run, requestId, permitId },
    { v: 1, kind: 'permit.denied', runId: ids.run, requestId, code: 'RUN_REQUEST_LIMIT' },
    { v: 1, kind: 'cancel', runId: ids.run, reason: 'USER_CANCELLED' }];
  for (const message of valid) assert.deepEqual(ParentToWorkerMessageSchema.parse(message), message);
  const wrong = start(); wrong.runInput.runId = ids.otherRun;
  rejects(ParentToWorkerMessageSchema, wrong);
  for (const key of ['apiKey', 'env', 'headers', 'overridePath', 'approved', 'rawReasoning']) {
    rejects(ParentToWorkerMessageSchema, { ...start(), [key]: 'injected' }, key);
  }
  rejects(ParentToWorkerMessageSchema, { ...start(), snapshotPath: '' });
  rejects(ParentToWorkerMessageSchema, { ...start(), snapshotPath: 'bad\0path' });
  rejects(ParentToWorkerMessageSchema, { ...start(), v: 2 });
});

test('worker ready, permit and event messages bind run identity and reject parent-only messages', () => {
  const valid = [
    { v: 1, kind: 'ready', runId: ids.run },
    { v: 1, kind: 'permit.request', runId: ids.run, requestId },
    { v: 1, kind: 'permit.release', runId: ids.run, permitId },
    { v: 1, kind: 'event', runId: ids.run, nativeOrAppEvent: native() },
  ];
  for (const message of valid) assert.deepEqual(WorkerToParentMessageSchema.parse(message), message);
  const wrong = structuredClone(valid.at(-1)); wrong.nativeOrAppEvent.runId = ids.otherRun;
  rejects(WorkerToParentMessageSchema, wrong);
  rejects(WorkerToParentMessageSchema, { v: 1, kind: 'permit.granted', runId: ids.run, requestId, permitId });
  rejects(WorkerToParentMessageSchema, { v: 1, kind: 'ready', runId: ids.run, seq: 1 });
  rejects(WorkerToParentMessageSchema, { v: 1, kind: 'start', runId: ids.run, env: {} });
  rejects(WorkerToParentMessageSchema, { v: 1, kind: 'unknown', runId: ids.run });
  const missing = { v: 1, kind: 'ready' };
  rejects(WorkerToParentMessageSchema, missing);
});

test('typed artifacts accept the three corresponding domain schemas without opaque passthrough', () => {
  for (const typedArtifact of [
    { kind: 'proposal_draft', artifact: draft() },
    { kind: 'counter_report', artifact: counter() },
    { kind: 'critic_review', artifact: review() },
  ]) {
    assert.deepEqual(TypedArtifactSchema.parse(typedArtifact), typedArtifact);
    const message = { v: 1, kind: 'artifact', runId: ids.run, typedArtifact };
    assert.deepEqual(WorkerToParentMessageSchema.parse(message), message);
  }
  rejects(TypedArtifactSchema, { kind: 'proposal_draft', artifact: review() });
  rejects(TypedArtifactSchema, { kind: 'raw_response', artifact: { arbitrary: 'body' } });
  rejects(WorkerToParentMessageSchema, { ...artifact(), fields: { approved: true } });
  const wrong = artifact(); wrong.typedArtifact.artifact.runId = ids.otherRun;
  rejects(WorkerToParentMessageSchema, wrong);
  const extra = artifact(); extra.typedArtifact.artifact.rawResponse = 'untrusted';
  rejects(WorkerToParentMessageSchema, extra);
});

test('worker outcome is a typed candidate result, not authority to mark a run approved', () => {
  const message = { v: 1, kind: 'outcome', runId: ids.run,
    typedOutcome: { runId: ids.run, kind: 'insufficient', reasonCodes: ['EVIDENCE_INCOMPLETE'] } };
  assert.deepEqual(WorkerToParentMessageSchema.parse(message), message);
  const wrong = structuredClone(message); wrong.typedOutcome.runId = ids.otherRun;
  rejects(WorkerToParentMessageSchema, wrong);
  const approved = structuredClone(message); approved.typedOutcome.kind = 'approved';
  rejects(WorkerToParentMessageSchema, approved);
  rejects(WorkerToParentMessageSchema, { ...message, approved: true });
});

test('reviewed worker outcome carries typed same-Run artifacts but never a publication flag', () => {
  const message = { v: 1, kind: 'outcome', runId: ids.run, typedOutcome: { runId: ids.run, kind: 'reviewed',
    draft: draft(), counter: counter(), review: review(), reasonCodes: [] } };
  assert.deepEqual(WorkerToParentMessageSchema.parse(message), message);
  const crossRun = structuredClone(message); crossRun.typedOutcome.review.runId = ids.otherRun;
  rejects(WorkerToParentMessageSchema, crossRun);
  const body = structuredClone(message); body.typedOutcome.rawReasoning = 'forbidden';
  rejects(WorkerToParentMessageSchema, body);
  const forged = structuredClone(message); forged.typedOutcome.approved = true;
  rejects(WorkerToParentMessageSchema, forged);
});

test('strict worker IPC prevalidation rejects nested accessor payloads without invoking them', () => {
  const message = { v: 1, kind: 'event', runId: ids.run, nativeOrAppEvent: native() };
  Object.defineProperty(message.nativeOrAppEvent.payload, 'headers', {
    enumerable: true, get() { throw new Error('must never invoke getters'); },
  });
  assert.doesNotThrow(() => rejects(WorkerToParentMessageSchema, message));
});

test('event/IPC source modules stay browser-safe and do not read configuration or credentials', async () => {
  for (const name of ['events', 'ipc']) {
    const source = await readFile(new URL(`../../src/contracts/${name}.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"]node:|process\s*\.|import\s*\(\s*['"]node:|\.env(?:\.|['"])/);
  }
});
