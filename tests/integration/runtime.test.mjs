import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ModelMessageItem, SemanticEvent, FunctionCallItem } from '@mozaik-ai/core';
import { createTaskEngine, createTaskContext } from '../../dist/server/runtime/task-context.js';
import { executeRun, ArtifactCoordinator } from '../../dist/server/runtime/orchestrator.js';
import { loadSnapshot } from '../../dist/server/data/snapshot.js';
import { buildIndex, retrieveWithTrace } from '../../dist/server/retrieval/index.js';
import { hashRunInput, hashCandidatePool } from '../../dist/server/evidence/hashing.js';
import { DEFAULT_LIMITS } from '../../dist/server/contracts/config.js';
import { createResearchTools } from '../../dist/server/runtime/tools.js';
import { input } from '../fixtures/contracts.mjs';
import { resolve } from 'node:path';

process.env.MOZAIK_API_KEY = ''; // disable optional native cloud telemetry, no credential lookup
const run = () => ({...input(),runId:randomUUID()});
const output = value => ({items:[ModelMessageItem.rehydrate({text:JSON.stringify(value)})],tokenUsage:undefined,rowResponse:null});
const emit = () => {};
const unusedPermits = {acquire:async()=>{throw Error('NO_NETWORK_IN_NATIVE_FIXTURE');},release:()=>{}};
for (const [adapterProbe, expectedLimit] of [[false, 8192], [true, 2048]]) {
  test(`native SDK output budget supports complete business JSON; probe=${adapterProbe}`, async () => {
    const requests = [];
    const engine = createTaskEngine({ runId: randomUUID(), signal: new AbortController().signal,
      model: 'deepseek-flash', tools: [], emit, adapterProbe,
      runnerFactory: () => ({ async run(request) { requests.push(request); return output({ ok: true }); },
        async *stream() { throw Error('NO_STREAM'); } }) });
    try {
      assert.deepEqual(await engine.startTask('counter-evidence', { task: 'offline_fixture' }), { ok: true });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].maxOutputTokens, expectedLimit);
      assert.equal(requests[0].reasoningEffort, adapterProbe ? undefined : 'none');
    } finally { engine.dispose(); }
  });
}
let research;
test.before(async()=>{const snapshot=await loadSnapshot(resolve('reference/einstein-matchmaker-data'),input().datasetCommit);
  research={snapshot,...retrieveWithTrace(input(),buildIndex(snapshot))};});
function answer(role, revision=1) {
  if(role==='critic')return {verdict:'approve',findings:[]};
  if(role==='counter-evidence')return {checkedFacets:['original restrictions'],checkedCandidates:research.pool.candidates.map(c=>c.researcherId),findings:[],noCounterEvidenceFound:['OFFLINE_FIXTURE_ONLY_NOT_SEMANTIC_ASSESSMENT']};
  const c=research.pool.candidates[0],e=research.evidence.find(e=>c.restrictionRefs.includes(e.id)&&e.source.fieldPointer==='/notes');
  assert.ok(e);
  const id='claim_fixture_'+revision;
  return {researcherId:c.researcherId,claims:[{id,researcherId:c.researcherId,kind:'fact',text:e.excerpt,evidenceIds:[e.id],
    sourceBindings:[{evidenceId:e.id,subjectId:c.researcherId,relation:'profile_field',objectId:c.researcherId,fieldPointer:e.source.fieldPointer}],limitations:['offline_fixture; no semantic quality claim']}],
    sections:{summary:[{text:e.excerpt,claimIds:[id]}]}};
}

test('real SDK task contexts are fresh, native loops overlap behind a two-agent barrier, Critic waits for products', async()=>{
  const events=[],entered=new Set(),identities=[],contexts=[];let release;
  const both=new Promise(r=>{release=r;});
  const i=run();
  const result=await executeRun({v:1,kind:'start',runId:i.runId,runInput:i,snapshotPath:resolve('reference/einstein-matchmaker-data'),limits:DEFAULT_LIMITS},e=>events.push(e),unusedPermits,
    {research,runnerMode:'offline_fixture',runnerFactory:hooks=>({
      async run(request){const actor=hooks.resolveTask(request.context.id);identities.push(actor);contexts.push(request.context);
        const assigned = JSON.parse(request.context.getItems().find(item => item.role === 'user').content.text);
        const required = { proposer: ['researcherId', 'claims', 'sections'],
          'counter-evidence': ['checkedFacets', 'checkedCandidates', 'findings', 'noCounterEvidenceFound'],
          critic: ['verdict', 'findings'] }[actor.role];
        assert.deepEqual(assigned.outputContract.schema.required, required);
        assert.equal(assigned.outputContract.schema.additionalProperties, false);
        if(actor.role!=='critic'){entered.add(actor.role);if(entered.size===2)release();await both;assert.equal(entered.size,2);}
        else assert.ok(events.filter(e=>e.type==='task.completed').length>=2);
        return output(answer(actor.role,actor.attempt));},async *stream(){throw Error('NO_STREAM');}})});
  assert.equal(result.kind,'reviewed');assert.equal(result.review.verdict,'approve');
  assert.equal(new Set(identities.map(a=>a.agentId)).size,3);assert.equal(new Set(identities.map(a=>a.contextId)).size,3);
  assert.equal(new Set(identities.map(a=>a.taskId)).size,3);assert.ok(identities.every(a=>a.runId===i.runId));
  assert.ok(events.some(e=>e.source==='mozaik'&&e.type==='model.answer'));
  assert.equal(events.filter(e=>e.type==='participant.joined').length,4);
  assert.deepEqual(new Set(events.filter(e=>e.type==='participant.joined'&&e.payload.participantKind==='agent').map(e=>e.role)),new Set(['proposer','counter-evidence','critic']));
  assert.equal(events.filter(e=>e.type==='participant.left'&&e.payload.participantKind==='agent').length,3);
  assert.ok(events.every(e=>e.runId===i.runId));assert.ok(contexts.every(c=>c.getItems().filter(it=>it.role==='developer').length===1));
  assert.equal(result.draft.inputHash,hashRunInput(i));
});

test('native State/Context and agent memory are isolated per Run; task completion is asynchronous',async()=>{
  const controller=new AbortController(),events=[];
  const factory=hooks=>({run:async()=>output({fixture:'offline_fixture'}),async *stream(){}});
  const a=createTaskEngine({runId:run().runId,signal:controller.signal,tools:[],model:'offline_fixture',runnerFactory:factory,emit:e=>events.push(e)});
  const b=createTaskEngine({runId:run().runId,signal:controller.signal,tools:[],model:'offline_fixture',runnerFactory:factory,emit});
  assert.notEqual(a.state,b.state);assert.notEqual(a.agents.proposer,b.agents.proposer);
  assert.notEqual(a.agents.proposer.getMemory().getContext().id,b.agents.proposer.getMemory().getContext().id);
  assert.notEqual(createTaskContext('instruction',{x:1}).id,createTaskContext('instruction',{x:1}).id);
  let complete=false;const pending=a.startTask('proposer',{fixture:true}).then(v=>{complete=true;return v;});
  assert.equal(complete,false);assert.throws(()=>a.startTask('proposer',{}),/TASK_BUSY/);
  await pending;assert.equal(events.filter(e=>e.type==='model.answer').length,1);
  const first=a.history[0];await a.startTask('proposer',{fixture:true},2);assert.notEqual(first.contextId,a.history[1].contextId);
  assert.throws(()=>a.startTask('proposer',{},3),/TASK_ATTEMPT_LIMIT/);
});

test('native producer and loop ownership reject injected completion without accepting an artifact',async()=>{
  let finish;const gate=new Promise(r=>{finish=r;});const i=run();
  const engine=createTaskEngine({runId:i.runId,signal:new AbortController().signal,tools:[],model:'offline_fixture',emit,
    runnerFactory:()=>({run:async()=>{await gate;return output({fixture:true});},async *stream(){}})});
  const pending=engine.startTask('proposer',{});const rejected=assert.rejects(pending,/NATIVE_PRODUCER_MISMATCH/);
  engine.runtime.resolveRuntime().publish(new SemanticEvent('model.answer',randomUUID(),new Date(),{loopId:randomUUID(),answer:ModelMessageItem.rehydrate({text:'{}'})}));
  finish();await rejected;
});

test('actual native Tool.invoke produces function events and its output reenters the same task Context',async()=>{
  const i=run(),signal=new AbortController().signal,events=[];let receipt,callId;
  const engine=createTaskEngine({runId:i.runId,signal,tools:createResearchTools({...research,input:i,signal}),model:'offline_fixture',emit:e=>events.push(e),
    runnerFactory:hooks=>({async run(request){const actor=hooks.resolveTask(request.context.id),result=request.context.getItems().find(it=>it.type==='function_call_output');
      if(!result){callId='native_'+randomUUID();return {items:[FunctionCallItem.rehydrate({callId,name:'read_company_challenge',args:JSON.stringify({runId:i.runId,companyId:i.companyId,challengeId:i.challengeId})})],tokenUsage:undefined,rowResponse:null};}
      assert.equal(result.callId,callId);const data=JSON.parse(result.output.text);assert.equal(data.ok,true);assert.equal(data.runId,i.runId);receipt=data.receiptId;
      assert.ok(request.context.getItems().some(it=>it.type==='function_call'&&it.callId===result.callId));
      return output({runId:actor.runId,receiptId:receipt});},async *stream(){}})});
  assert.deepEqual(await engine.startTask('proposer',{fixture:'offline_fixture'}),{runId:i.runId,receiptId:receipt});
  assert.equal(events.filter(e=>e.type==='function_call.started').length,1);assert.equal(events.filter(e=>e.type==='function_call.completed').length,1);
});

test('reentrant native duplicate completion is rejected before a second answer can settle',async()=>{
  let engine,injected=false;
  engine=createTaskEngine({runId:run().runId,signal:new AbortController().signal,tools:[],model:'offline_fixture',emit,
    runnerFactory:()=>({run:async()=>output({fixture:true}),async *stream(){}}),
    onNative:event=>{if(event.type==='model.answer'&&!injected){injected=true;engine.runtime.resolveRuntime().publish(event);}}});
  await assert.rejects(engine.startTask('proposer',{}),/DUPLICATE_COMPLETION/);
});

test('same producer and loop cannot forge an answer absent from actual inference and Context',async()=>{
  let engine,finish,injected=false;const gate=new Promise(r=>{finish=r;});
  engine=createTaskEngine({runId:run().runId,signal:new AbortController().signal,tools:[],model:'offline_fixture',emit,
    runnerFactory:()=>({run:async()=>{await gate;return output({real:true});},async *stream(){}}),
    onNative:(event,actor)=>{if(event.type==='inference.started'&&!injected){injected=true;
      engine.runtime.resolveRuntime().publish(new SemanticEvent('model.answer',actor.agentId,new Date(),{loopId:actor.loopId,answer:ModelMessageItem.rehydrate({text:'{"forged":true}'})}));}}});
  try {await assert.rejects(engine.startTask('proposer',{}),/NATIVE_ANSWER_UNPROVEN/);}finally{finish();}
});

test('native runner failure rejects application task without fabricating an answer or leaving rejection unhandled',async()=>{
  const events=[];const engine=createTaskEngine({runId:run().runId,signal:new AbortController().signal,tools:[],model:'offline_fixture',emit:e=>events.push(e),
    runnerFactory:()=>({run:async()=>{throw Error('synthetic runner failure');},async *stream(){}})});
  let timer;try {await assert.rejects(Promise.race([engine.startTask('proposer',{}),new Promise((_,j)=>{timer=setTimeout(()=>j(Error('APPLICATION_TASK_STILL_PENDING')),1000);})]),/MODEL_INFERENCE_FAILED/);}
  finally {clearTimeout(timer);}
  assert.equal(events.filter(e=>e.type==='model.answer').length,0);assert.ok(events.some(e=>e.type==='task.failed'));
});

test('coordinator rejects early reviews, wrong producer/Run, duplicate completion and second recheck',()=>{
  const i=run(),c=new ArtifactCoordinator({input:i,pool:research.pool,evidence:research.evidence,snapshot:research.snapshot});
  const actor=(role,attempt=1)=>({runId:i.runId,role,agentId:randomUUID(),loopId:randomUUID(),taskId:randomUUID(),contextId:randomUUID(),attempt});
  assert.throws(()=>c.accept('critic',answer('critic'),actor('critic')),/CRITIC_PREREQUISITES/);
  const proposer=actor('proposer');c.bind(proposer);
  assert.throws(()=>c.accept('proposer',answer('proposer'),{...proposer,agentId:randomUUID()}),/PRODUCER_MISMATCH/);
  assert.throws(()=>c.accept('proposer',answer('proposer'),{...proposer,runId:randomUUID()}),/RUN_MISMATCH/);
  c.accept('proposer',answer('proposer'),proposer);
  assert.throws(()=>c.accept('proposer',answer('proposer'),proposer),/DUPLICATE_COMPLETION/);
  assert.throws(()=>c.bind({...actor('proposer'),agentId:proposer.agentId}),/TASK_REENTRY/);
  assert.throws(()=>c.bind({...actor('proposer'),attempt:3}),/REVISION_LIMIT/);
});

test('Counter rejection distinguishes unknown Evidence, scope and unseen claim references',()=>{
  for (const scenario of ['evidence', 'scope', 'claim']) {
    const i=run(),c=new ArtifactCoordinator({input:i,...research});
    const actor={runId:i.runId,role:'counter-evidence',agentId:randomUUID(),loopId:randomUUID(),taskId:randomUUID(),contextId:randomUUID(),attempt:1};
    c.bind(actor);
    const body=answer('counter-evidence');
    body.findings=[{id:'finding_fixture',scope:scenario==='scope'?'claim':'run',claimIds:scenario==='evidence'?[]:['unseen_claim'],
      evidenceIds:scenario==='evidence'?['unknown_evidence']:[],code:'FIXTURE_CHECK',severity:'advisory',explanation:'offline_fixture'}];
    assert.throws(()=>c.accept('counter-evidence',body,actor),error=>{
      assert.equal(error.code,'COUNTER_REFERENCE_FAILED');
      const rule={evidence:'EVIDENCE_ID_UNKNOWN',scope:'COUNTER_FINDING_SCOPE',claim:'COUNTER_CLAIM_REFERENCE'}[scenario];
      assert.ok(error.validation.issues.some(i=>i.rule===rule));
      assert.equal(JSON.stringify(error.validation).includes('unknown_evidence'),false);
      return true;
    });
    assert.equal(c.counter,undefined);
  }
});

test('a version increment alone cannot pass the changed-draft recheck condition',()=>{
  const i=run(),c=new ArtifactCoordinator({input:i,...research});
  const actor=(role,agentId=randomUUID(),attempt=1)=>({runId:i.runId,role,agentId,loopId:randomUUID(),taskId:randomUUID(),contextId:randomUUID(),attempt});
  const p=actor('proposer'),b=actor('counter-evidence'),k=actor('critic');
  c.bind(p);c.accept('proposer',answer('proposer'),p);c.bind(b);c.accept('counter-evidence',answer('counter-evidence'),b);
  c.bind(k);c.accept('critic',{verdict:'revise',findings:[{id:'fixture_blocker',scope:'claim',claimIds:['claim_fixture_1'],evidenceIds:[],code:'FIXTURE_RECHECK',severity:'blocking',explanation:'offline fixture protocol recheck',recheckQuestion:'Reinspect the original restriction.'}]},k);
  c.recheck();const p2=actor('proposer',p.agentId,2);c.bind(p2);
  assert.throws(()=>c.accept('proposer',answer('proposer'),p2),/UNCHANGED_REVISION/);
});

test('two explicit Critic revise verdicts stop after one targeted recheck with a fixed pool and fresh task contexts',async()=>{
  const i=run(),actors=[],events=[];
  const result=await executeRun({v:1,kind:'start',runId:i.runId,runInput:i,snapshotPath:resolve('reference/einstein-matchmaker-data'),limits:DEFAULT_LIMITS},e=>events.push(e),unusedPermits,
    {research,runnerMode:'offline_fixture',runnerFactory:hooks=>({async run(request){const actor=hooks.resolveTask(request.context.id);actors.push(actor);
      if(actor.role!=='critic')return output(answer(actor.role,actor.attempt));
      return output({verdict:'revise',findings:[{id:'fixture_revise_'+actor.attempt,scope:'claim',claimIds:['claim_fixture_'+actor.attempt],evidenceIds:[],code:'FIXTURE_RECHECK',severity:'blocking',explanation:'offline protocol scenario only',recheckQuestion:'Inspect original notes; no semantic quality claim.'}]});},async *stream(){}})});
  assert.equal(result.kind,'insufficient');assert.ok(result.reasonCodes.includes('REVIEW_NOT_APPROVED_OR_RECHECK_EXHAUSTED'));
  for(const role of ['proposer','critic']){const tasks=actors.filter(a=>a.role===role);assert.equal(tasks.length,2);assert.equal(tasks[0].agentId,tasks[1].agentId);assert.notEqual(tasks[0].contextId,tasks[1].contextId);assert.notEqual(tasks[0].taskId,tasks[1].taskId);}
  assert.equal(actors.filter(a=>a.role==='counter-evidence').length,1);assert.equal(actors.length,5);
  assert.equal(events.filter(e=>e.type==='review.completed'&&e.payload.verdict==='revise').length,2);
});

test('explicitly marked empty-pool fixture returns insufficient without tools or inference',async()=>{
  const i=run(),base={...research.pool,candidates:[],mergedCandidateCount:0,
    diagnostics:{...research.pool.diagnostics,mergedCount:0,selectedCount:0,truncated:false}};
  const pool={...base,poolHash:hashCandidatePool(base)};let requests=0;
  const result=await executeRun({v:1,kind:'start',runId:i.runId,runInput:i,snapshotPath:resolve('reference/einstein-matchmaker-data'),limits:DEFAULT_LIMITS},emit,unusedPermits,
    {runnerMode:'offline_fixture',research:{snapshot:research.snapshot,pool,evidence:[]},runnerFactory:()=>{requests++;throw Error('MUST_NOT_RUN');}});
  assert.equal(result.kind,'insufficient');assert.equal(requests,0);
});
