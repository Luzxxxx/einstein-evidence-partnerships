import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ModelMessageItem } from '@mozaik-ai/core';
import { z } from 'zod';
import { createTaskEngine } from '../../dist/server/runtime/task-context.js';
import { ClaimSchema } from '../../dist/server/contracts/domain.js';
import { CounterReportSchema } from '../../dist/server/contracts/domain.js';
import { parseTaskAnswer } from '../../dist/server/runtime/answer-validation.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadSnapshot } from '../../dist/server/data/snapshot.js';
import { buildIndex, retrieveWithTrace } from '../../dist/server/retrieval/index.js';
import { createModelResearchView } from '../../dist/server/runtime/model-research-view.js';
import { input as fixtureInput } from '../fixtures/contracts.mjs';

// Production parsing path: no answerDiagnostics option or controlled draft seed.
function fixture(t, text, parse, allowAnswerFormatting = false) {
  const events = [], request = { requestId: randomUUID(), permitId: randomUUID() };
  const controller = new AbortController();
  const engine = createTaskEngine({ runId: randomUUID(), signal: controller.signal, model: 'offline_fixture', tools: [],
    emit: e => events.push(e), parseAnswer: (_role, value) => parse(value), allowAnswerFormatting,
    runnerFactory: () => ({ async run() { return { items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse: request }; }, async *stream() {} }) });
  t.after(() => { controller.abort(); engine.dispose(); });
  return { events, request, engine };
}
const missingBinding = { claims: [{ id: 'claim_fixture', researcherId: 'R1008', kind: 'fact', text: 'offline_fixture', evidenceIds: ['ev_fixture'], limitations: [] }] };

test('normal native answer preserves JSON failure stage and original request without storing raw text', async t => {
  const f = fixture(t, 'private-invalid-json', value => value);
  await assert.rejects(f.engine.startTask('proposer', {}), /ANSWER_JSON_PARSE_FAILED/);
  const failed = f.events.find(e => e.type === 'task.failed');
  assert.equal(failed.role, 'proposer');
  assert.equal(failed.payload.validation.stage, 'json_parse');
  assert.equal(failed.payload.validation.requestId, f.request.requestId);
  assert.match(failed.payload.validation.answerHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(f.events).includes('private-invalid-json'), false);
});

test('normal native answer records precise missing field path and type', async t => {
  const f = fixture(t, JSON.stringify(missingBinding), value => z.strictObject({ claims: z.array(ClaimSchema) }).parse(value));
  await assert.rejects(f.engine.startTask('proposer', {}), /ANSWER_SCHEMA_INVALID/);
  const validation = f.events.find(e => e.type === 'task.failed').payload.validation;
  assert.equal(validation.stage, 'schema_validation');
  assert.ok(validation.issues.some(i => JSON.stringify(i.path) === '["claims",0,"sourceBindings"]' && i.code === 'invalid_type' && i.expected === 'array'));
});

test('normal native answer identifies source-binding refinements without replacing them with success', async t => {
  const body = structuredClone(missingBinding); body.claims[0].sourceBindings = [];
  const f = fixture(t, JSON.stringify(body), value => z.strictObject({ claims: z.array(ClaimSchema) }).parse(value));
  await assert.rejects(f.engine.startTask('proposer', {}), /ANSWER_SCHEMA_INVALID/);
  const issues = f.events.find(e => e.type === 'task.failed').payload.validation.issues;
  assert.ok(issues.some(i => i.rule === 'EVIDENCE_BINDING_REQUIRED'));
});

test('normal native answer keeps application/source rejection code and omits arbitrary extra keys', async t => {
  const secret = 'sk-offlineFixturePrivateValue123456789';
  const f = fixture(t, JSON.stringify({ [secret]: secret }), value => z.strictObject({}).parse(value));
  await assert.rejects(f.engine.startTask('proposer', {}), /ANSWER_SCHEMA_INVALID/);
  assert.equal(JSON.stringify(f.events).includes(secret), false);
  const domain = fixture(t, '{}', () => { throw Error('CLAIM_SOURCE_BINDING_FAILED'); });
  await assert.rejects(domain.engine.startTask('proposer', {}), /CLAIM_SOURCE_BINDING_FAILED/);
  assert.equal(domain.events.find(e => e.type === 'task.failed').payload.validation.stage, 'application_validation');
});

test('normal native answer still accepts the original valid structured result', async t => {
  const f = fixture(t, '{"ok":true}', value => z.strictObject({ ok: z.literal(true) }).parse(value));
  assert.deepEqual(await f.engine.startTask('proposer', {}), { ok: true });
  assert.equal(f.events.some(e => e.type === 'task.failed'), false);
});

test('research formatting accepts trailing commas and a whole JSON fence while preserving string contents', async t => {
  const value = { claims: [{ text: 'literal ,} and ,] and escaped " quote', limitations: ['unknown'] }] };
  const text = '```json\n' + JSON.stringify(value).replace('["unknown"]}', '["unknown",],}') + '\n```';
  const f = fixture(t, text, v => v, true);
  assert.deepEqual(await f.engine.startTask('proposer', {}), value);
  const strict = fixture(t, text, v => v);
  await assert.rejects(strict.engine.startTask('proposer', {}), /ANSWER_JSON_PARSE_FAILED/);
});

test('research formatting never fills missing values, fixes broken JSON, or bypasses schema/source checks', async t => {
  for (const text of ['{"x":,}', '{"x":[1,,]}', '{"x":[,]}', '{"x":1', 'Here is the answer: {"x":1}']) {
    const f = fixture(t, text, v => v, true);
    await assert.rejects(f.engine.startTask('proposer', {}), /ANSWER_JSON_PARSE_FAILED/);
  }
  const f = fixture(t, '{"ok":false,}', v => z.strictObject({ ok: z.literal(true) }).parse(v), true);
  await assert.rejects(f.engine.startTask('proposer', {}), /ANSWER_SCHEMA_INVALID/);
});

const counterSchema=z.strictObject(Object.fromEntries(['checkedFacets','checkedCandidates','findings','noCounterEvidenceFound'].map(key=>[key,CounterReportSchema.shape[key]])));
const splitCounter={checkedFacets:['literal } { and escaped " remain intact'],checkedCandidates:['R0976'],findings:[],noCounterEvidenceFound:['offline_fixture']};
const splitText=body=>Object.entries(body).map(([key,value])=>JSON.stringify({[key]:value})).join('\n\n');
test('actual captured split Counter answer passes native parsing only after lossless envelope assembly',async t=>{
 const captured=JSON.parse(readFileSync(new URL('../fixtures/counter-split-json-live.json',import.meta.url),'utf8'));
 assert.equal(createHash('sha256').update(captured.text).digest('hex'),captured.answerSha256);
 const run={...fixtureInput(),companyId:'C036',challengeId:'C036-CH1',mode:'research'};
 const snapshot=await loadSnapshot(resolve('reference/einstein-matchmaker-data'),run.datasetCommit);
 const research=retrieveWithTrace(run,buildIndex(snapshot)),view=createModelResearchView(research.evidence,snapshot);
 // Same production alias expansion and existing exact-reference deduplication
 // precede domain validation; no Claim or Finding record is discarded.
 const f=fixture(t,captured.text,value=>counterSchema.parse(view.expandAnswer('counter-evidence',value)),true);
 const value=await f.engine.startTask('counter-evidence',{});
 assert.deepEqual(value.checkedCandidates,['R0976','R0715','R0926','R0426','R0172','R0786','R1044','R0084']);
 assert.ok(value.findings.length>0);assert.ok(value.checkedFacets.length>0);
 const strict=fixture(t,captured.text,value=>value,false);await assert.rejects(strict.engine.startTask('counter-evidence',{}),/ANSWER_JSON_PARSE_FAILED/);
});
test('four complete disjoint Counter fields preserve all values, strings and findings unchanged',()=>{
 assert.deepEqual(parseTaskAnswer(splitText(splitCounter),null,v=>counterSchema.parse(v),true),splitCounter);
});
test('fragment compatibility rejects duplicates, missing fields, alternatives, prose and incomplete objects',()=>{
 const valid=splitText(splitCounter),parts=valid.split('\n\n');
 for(const text of [parts.slice(1).join('\n'),valid+'\n'+parts[0],JSON.stringify(splitCounter)+'\n'+JSON.stringify(splitCounter),'Answer:\n'+valid,valid+' done',valid.slice(0,-1),parts.map((p,i)=>i===0?'{"checkedFacets":[],"checkedFacets":["replaced"]}':p).join('\n'),splitText({...splitCounter,extra:true}),'{"researcherId":"R0976"}\n{"claims":[]}\n{"sections":{}}'])
  assert.throws(()=>parseTaskAnswer(text,null,v=>v,true),/ANSWER_JSON_PARSE_FAILED/);
});
test('fragment compatibility still rejects invalid domain types and source failures',()=>{
 assert.throws(()=>parseTaskAnswer(splitText({...splitCounter,checkedCandidates:'R0976'}),null,v=>counterSchema.parse(v),true),/ANSWER_SCHEMA_INVALID/);
 assert.throws(()=>parseTaskAnswer(splitText(splitCounter),null,()=>{throw Error('COUNTER_REFERENCE_FAILED');},true),/COUNTER_REFERENCE_FAILED/);
});
