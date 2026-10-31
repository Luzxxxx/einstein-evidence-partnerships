import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCriticEvalArgs, prepareCriticLivePlan, validateCriticPreLiveGate,
  summarizeCriticRequestIntervals, diffReviewedDrafts, summarizeCriticToolRoundTrips,
} from '../../dist/server/evaluation/run-critic-eval.js';
import { projectCriticNative } from '../../dist/server/evaluation/critic-worker.js';
import { ModelContext, DeveloperMessageItem, UserMessageItem } from '@mozaik-ai/core';
import { createHash } from 'node:crypto';

const hashes = { proposer: 'a'.repeat(64), counter: 'b'.repeat(64), critic: 'c'.repeat(64) };
const fingerprints = [{ file: 'src/evaluation/run-critic-eval.ts', sha256: 'd'.repeat(64) }];

test('Task7 live CLI accepts only explicitly authorized core/three repeats, no accidental resume or extra scope', () => {
  assert.deepEqual(parseCriticEvalArgs(['--suite', 'core', '--repeats', '3']), { suite: 'core', repeats: 3 });
  for (const args of [[], ['--suite','core'], ['--suite','all','--repeats','3'], ['--suite','core','--repeats','4'],
    ['--suite','core','--repeats','3','--resume'], ['--suite','core','--repeats','3','--repeats','3']])
    assert.throws(() => parseCriticEvalArgs(args), /CRITIC_EVAL_SCOPE/);
});
test('all 36 independent Run IDs and budgets are frozen before first model request with L05 first', () => {
  const plan = prepareCriticLivePlan({ model:'fixed-fixture-model', gatewayOrigin:'https://gateway.example',
    promptHashes:hashes, executableHashes:{'dist/server/evaluation/run-critic-eval.js':'d'.repeat(64)},
    productFingerprints:fingerprints, createdAt:'2026-10-31T00:00:00.000Z' });
  assert.equal(plan.runs.length,36); assert.equal(new Set(plan.runs.map(r=>r.runId)).size,36);
  assert.deepEqual(plan.runs.slice(0,3).map(r=>r.variantId),['L05','L05','L05']);
  assert.equal(plan.maxGrantedRequests,576); assert.equal(plan.limits.maxModelRequests,16);
  assert.equal(plan.limits.maxConcurrentModelRequests,2); assert.equal(plan.limits.runTimeoutMs,180000);
  assert.equal(plan.limits.requestTimeoutMs,40000); assert.equal(plan.labels,'draft_not_human_gold');
  assert.equal(plan.retryPolicy,'none'); assert.equal(plan.qualityMetrics,'NA_unadjudicated');
  assert.equal(plan.modelParameters.maxOutputTokens,2048);
});
test('pre-live engineering/review gate and all product fingerprints fail closed on stale or missing proof', () => {
  const gate={task:'Task7',engineeringVerified:true,independentReviewPassed:true,sourceFingerprints:fingerprints};
  assert.doesNotThrow(()=>validateCriticPreLiveGate(gate,fingerprints));
  for(const bad of [null,{}, {...gate,engineeringVerified:false}, {...gate,independentReviewPassed:false},
    {...gate,sourceFingerprints:[{...fingerprints[0],sha256:'0'.repeat(64)}]}])
    assert.throws(()=>validateCriticPreLiveGate(bad,fingerprints),/CRITIC_PRELIVE_GATE/);
});
test('request interval report preserves failures/incomplete requests and measures real client overlap', () => {
  const actor={runId:'x',role:'proposer'}, counter={runId:'x',role:'counter-evidence'};
  const trace=[{type:'request.started',requestId:'a',permitId:'p1',actor,monotonicMs:10,timestamp:'start-a'},
    {type:'request.started',requestId:'b',permitId:'p2',actor:counter,monotonicMs:20,timestamp:'start-b'},
    {type:'request.failed',requestId:'b',permitId:'p2',actor:counter,monotonicMs:40,timestamp:'end-b',code:'TIMEOUT'},
    {type:'request.completed',requestId:'a',permitId:'p1',actor,monotonicMs:50,timestamp:'end-a'},
    {type:'request.started',requestId:'c',permitId:'p3',actor,monotonicMs:60,timestamp:'start-c'}];
  const result=summarizeCriticRequestIntervals(trace);
  assert.equal(result.intervals.length,3); assert.equal(result.firstAnalysisOverlapMs,20);
  assert.equal(result.intervals[1].completion,'failed'); assert.equal(result.intervals[2].completion,'unconfirmed');
  assert.equal(result.failed,1); assert.equal(result.incomplete,1); assert.equal(result.usageStatus,'unknown');
});
test('v1-v2 differences retain complete section/limitation/stage changes rather than comparing version numbers', () => {
  const before={version:1,claims:[{text:'guaranteed',limitations:[]}],sections:{validation:[{text:'none'}]}};
  const after={version:2,claims:[{text:'testable hypothesis',limitations:['transfer unknown']}],sections:{validation:[{text:'measure site false-positive rate'}]}};
  const differences=diffReviewedDrafts(before,after);
  assert.ok(differences.some(d=>d.pointer==='/claims/0/text'));
  assert.ok(differences.some(d=>d.pointer==='/claims/0/limitations/0'));
  assert.ok(differences.some(d=>d.pointer==='/sections/validation/0/text'));
  assert.ok(differences.some(d=>d.pointer==='/version'));
  assert.deepEqual(diffReviewedDrafts(before,structuredClone(before)),[]);
});
test('offline_fixture projector reads actual SDK developer instruction and flags stale frozen prompt without exposing prompt text', () => {
  const instruction='Actual SDK developer text, never a quality label';
  const context=ModelContext.create().addContextItems([DeveloperMessageItem.create(instruction),UserMessageItem.create('Untrusted task source')]);
  const actor={runId:'offline_fixture',role:'critic',agentId:'agent',taskId:'task',contextId:context.id,loopId:'loop',attempt:1};
  const hash=createHash('sha256').update(instruction).digest('hex');
  const projection=projectCriticNative({type:'inference.started',payload:{context}},actor,{effectiveCritic:hash});
  assert.equal(projection.actualInstructionHash,hash);assert.equal(projection.instructionMatches,true);
  assert.equal(JSON.stringify(projection).includes(instruction),false);
  assert.equal(projectCriticNative({type:'inference.started',payload:{context}},actor,{effectiveCritic:'0'.repeat(64)}).instructionMatches,false);
  const output=projectCriticNative({type:'inference.completed',payload:{reasoning:'must not be persisted'}},actor,{});
  assert.equal(JSON.stringify(output).includes('must not be persisted'),false);
});
test('offline_fixture native tool receipt requires matching actor, call and exact result hash in later Context', () => {
  const actor={contextId:'context-one'},other={contextId:'context-two'},records=[
    {kind:'native',type:'function_call.started',actor,callId:'call',toolName:'read_evidence_record'},
    {kind:'native',type:'function_call.completed',actor,callId:'call',outputHash:'exact',output:{ok:true,receiptId:'receipt'}},
    {kind:'native',type:'inference.started',actor:other,contextId:'context-two',toolResults:[{callId:'call',outputHash:'exact'}]},
    {kind:'native',type:'inference.started',actor,contextId:'context-one',toolResults:[{callId:'call',outputHash:'wrong'}]},
  ];
  assert.equal(summarizeCriticToolRoundTrips(records)[0].returnedToSameContext,false);
  records.push({kind:'native',type:'inference.started',actor,contextId:'context-one',toolResults:[{callId:'call',outputHash:'exact'}]});
  const result=summarizeCriticToolRoundTrips(records)[0];assert.equal(result.returnedToSameContext,true);assert.equal(result.invokedBeforeCompletion,true);
});
