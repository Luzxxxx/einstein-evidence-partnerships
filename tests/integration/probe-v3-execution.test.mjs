import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {createProtocolProbeV3Execution} from '../../dist/server/evaluation/protocol-probe-v3.js';
import {PROTOCOL_PROBE_V3_INSTRUCTION} from '../../dist/server/evaluation/probe-contract-guard.js';
import {executeRun} from '../../dist/server/runtime/orchestrator.js';
import {loadSnapshot} from '../../dist/server/data/snapshot.js';
import {buildIndex,retrieveWithTrace} from '../../dist/server/retrieval/index.js';
import {DEFAULT_LIMITS} from '../../dist/server/contracts/config.js';
import {input as inputFixture} from '../fixtures/contracts.mjs';

// offline_fixture only: actual SDK, original source tools and production gateway
// serializer are exercised. No provider, real credential, RunStore or holdout.
process.env.MOZAIK_API_KEY='';
let research;
test.before(async()=>{const input=inputFixture(),snapshot=await loadSnapshot(resolve('reference/einstein-matchmaker-data'),input.datasetCommit);
  research={snapshot,...retrieveWithTrace(input,buildIndex(snapshot))};});
const key='offline_fixture_v3_execution_key';
const response=message=>new Response(JSON.stringify({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message:{role:'assistant',...message}}]}),
  {status:200,headers:{'content-type':'application/json'}});
const readTask=body=>JSON.parse(body.messages.find(m=>m.role==='user').content);
function fixture({reverse=false,fault,recordFault}={}){
  const input={...inputFixture(),runId:randomUUID()},controller=new AbortController(),records=[],diagnostics=[],events=[],wires=[],grants=[],releases=[],rejectedCallIds=[];
  const expected={runId:input.runId,companyId:input.companyId,challengeId:input.challengeId,researcherId:research.pool.candidates[0].researcherId};
  const permitClient={async acquire(requestId,signal){assert.equal(signal.aborted,false);const id=randomUUID();grants.push({requestId,id});return{id};},release(id){releases.push(id);}};
  const fetchImpl=async(_url,init)=>{
    const body=JSON.parse(init.body);wires.push(body);
    assert.deepEqual(readTask(body),expected,'actual HTTP carries only the factory-bound IDs');
    assert.deepEqual(body.messages.filter(m=>m.role==='system'),[{role:'system',content:PROTOCOL_PROBE_V3_INSTRUCTION}]);
    const outputs=body.messages.filter(m=>m.role==='tool');
    if(!outputs.length){
      let tools=reverse?['read_candidate_bundle','read_company_challenge']:['read_company_challenge','read_candidate_bundle'];
      if(fault==='first_four')tools=[...tools,'read_candidate_bundle','read_candidate_bundle'];
      return response({content:null,tool_calls:tools.map(name=>({id:'offline_'+randomUUID(),type:'function',function:{name,arguments:JSON.stringify(name==='read_company_challenge'
        ?{runId:input.runId,companyId:input.companyId,challengeId:input.challengeId}:{runId:input.runId,researcherId:expected.researcherId})}}))});
    }
    if(fault==='second_tool'){
      const id='rejected_'+randomUUID();rejectedCallIds.push(id);
      return response({content:null,tool_calls:[{id,type:'function',function:{name:'read_candidate_bundle',arguments:JSON.stringify({runId:input.runId,researcherId:expected.researcherId})}}]});
    }
    const calls=body.messages.find(m=>m.role==='assistant'&&m.tool_calls).tool_calls;
    const receipts=outputs.map((output,i)=>{const actual=JSON.parse(output.content);assert.equal(actual.ok,true);assert.equal(actual.runId,input.runId);
      assert.equal(output.tool_call_id,calls[i].id);return{toolName:calls[i].function.name,receiptId:actual.receiptId};});
    const answer={runId:input.runId,challengeId:input.challengeId,researcherId:expected.researcherId,receipts};
    if(fault==='forged_receipt')answer.receipts[0].receiptId=randomUUID();
    if(fault==='credential_reflection')answer.untrustedExtra=key;
    return response({content:JSON.stringify(answer)});
  };
  const make=(overrides={})=>createProtocolProbeV3Execution({input,research,gateway:{baseURL:'https://offline.invalid/v1',apiKey:key,model:'offline_fixture'},
    permitClient,runnerMode:'offline_fixture',signal:controller.signal,record:row=>{if(recordFault?.(row))throw Error('untrusted arbitrary sink detail');records.push(row);},
    writeDiagnostic:async row=>{diagnostics.push(row);},fetchImpl,...overrides});
  const run=(execution=make(),runInput=input)=>executeRun({v:1,kind:'start',runId:runInput.runId,runInput,snapshotPath:resolve('reference/einstein-matchmaker-data'),limits:DEFAULT_LIMITS},
    event=>events.push(event),permitClient,execution);
  return{input,controller,records,diagnostics,events,wires,grants,releases,expected,rejectedCallIds,make,run};
}

for(const reverse of [false,true])test(`offline_fixture v3 production execution factory wires both real native Contexts, tools, guard, safe answers and HTTP receipts; reverse=${reverse}`,async()=>{
  const x=fixture({reverse});
  try{
    const outcome=await x.run();assert.equal(outcome.kind,'insufficient');assert.deepEqual(outcome.reasonCodes,['ADAPTER_PROBE_ONLY_NO_PUBLICATION']);
    assert.equal(x.wires.length,4);assert.equal(x.grants.length,4);assert.equal(x.releases.length,4);
    const native=x.records.filter(r=>r.kind==='native'),completed=native.filter(r=>r.type==='function_call.completed');
    assert.equal(native.filter(r=>r.type==='function_call.started').length,4);assert.equal(completed.length,4);
    const answers=native.filter(r=>r.type==='model.answer');assert.equal(answers.length,2);assert.equal(new Set(answers.map(r=>r.actor.contextId)).size,2);
    assert.deepEqual(new Set(answers.map(r=>r.actor.role)),new Set(['proposer','counter-evidence']));
    for(const answer of answers){
      assert.deepEqual(answer.answer.receipts,completed.filter(r=>r.actor.contextId===answer.actor.contextId).map(r=>({
        toolName:native.find(s=>s.type==='function_call.started'&&s.callId===r.callId&&s.actor.contextId===r.actor.contextId).toolName,receiptId:r.receipt.receiptId})));
      assert.equal(answer.actor.runId,x.input.runId);assert.equal(answer.answer.researcherId,x.expected.researcherId);
      for(const stage of ['answer_capture','json_parse','schema_validation'])assert.equal(x.diagnostics.filter(r=>r.actor?.contextId===answer.actor.contextId&&r.stage===stage).length,1);
    }
    const decisions=x.records.filter(r=>r.kind==='probe.contract');assert.equal(decisions.length,4);assert.ok(decisions.every(r=>r.status==='accepted'));
    assert.equal(x.records.filter(r=>r.kind==='wire.request').length,4);assert.equal(x.records.filter(r=>r.kind==='tool.batch'&&r.manifest.phase==='completed').length,2);
    assert.equal(x.events.some(e=>(e.role==='critic'&&!['participant.joined','participant.left'].includes(e.type))
      ||e.type==='artifact.validated'||e.type==='review.completed'),false,'the fixed Critic may register, but never starts inference or review in this probe');
  }finally{x.controller.abort();}
});

test('offline_fixture v3 factory rejects original four-call response before any native tool or extra request',async()=>{
  const x=fixture({fault:'first_four'});
  try{await assert.rejects(x.run(),/PROBE_CONTRACT_FIRST_BATCH_COUNT/);
    assert.ok(x.wires.length>=1&&x.wires.length<=2);assert.equal(x.grants.length,x.wires.length);assert.equal(x.releases.length,x.grants.length);
    assert.equal(x.records.some(r=>r.kind==='native'&&r.type==='function_call.started'),false);
    assert.equal(x.records.some(r=>r.kind==='tool.batch'),false,'rejected original batch never reaches stage/native execution');
    assert.ok(x.records.some(r=>r.kind==='probe.contract'&&r.status==='rejected'&&r.code==='PROBE_CONTRACT_FIRST_BATCH_COUNT'));
  }finally{x.controller.abort();}
});

test('offline_fixture v3 factory rejects second-response tools before those original calls invoke and never issues a third Context request',async()=>{
  const x=fixture({fault:'second_tool'});
  try{await assert.rejects(x.run(),/PROBE_CONTRACT_SECOND_RESPONSE_TOOLS/);
    assert.ok(x.wires.length>=2&&x.wires.length<=4);assert.equal(x.grants.length,x.wires.length);assert.equal(x.releases.length,x.grants.length);
    assert.ok(x.rejectedCallIds.length>0);assert.equal(x.records.some(r=>r.kind==='native'&&r.type==='function_call.started'&&x.rejectedCallIds.includes(r.callId)),false);
    assert.ok(x.records.filter(r=>r.kind==='native'&&r.type==='function_call.started').length<=4);
    assert.ok(x.records.some(r=>r.kind==='probe.contract'&&r.status==='rejected'&&r.code==='PROBE_CONTRACT_SECOND_RESPONSE_TOOLS'));
  }finally{x.controller.abort();}
});

test('offline_fixture v3 factory cannot turn a fake receipt into a native final answer or publication',async()=>{
  const x=fixture({fault:'forged_receipt'});
  try{await assert.rejects(x.run(),/PROBE_CONTRACT_FINAL_RECEIPTS_INVALID/);
    assert.equal(x.records.some(r=>r.kind==='native'&&r.type==='model.answer'),false);
    assert.equal(x.events.some(e=>e.type==='artifact.validated'||e.type==='review.completed'),false);
    assert.ok(x.records.some(r=>r.kind==='probe.contract'&&r.code==='PROBE_CONTRACT_FINAL_RECEIPTS_INVALID'));
    assert.ok(x.wires.length<=4);assert.equal(x.releases.length,x.grants.length);
  }finally{x.controller.abort();}
});

test('offline_fixture v3 factory retains the earlier gateway credential-reflection rejection without bypassing it for guard capture',async()=>{
  const x=fixture({fault:'credential_reflection'});
  try{await assert.rejects(x.run(),/GATEWAY_SECRET_REFLECTED/);
    assert.equal(JSON.stringify([...x.records,...x.diagnostics,...x.events]).includes(key),false);
    assert.ok(x.records.some(r=>r.kind==='request'&&r.trace.type==='request.failed'&&r.trace.code==='GATEWAY_SECRET_REFLECTED'));
    assert.equal(x.records.some(r=>r.kind==='probe.contract'&&r.turn===2),false,'rejected provider envelope never becomes a guard-accepted inference');
    assert.equal(x.records.some(r=>r.kind==='native'&&r.type==='model.answer'),false);
  }finally{x.controller.abort();}
});

test('offline_fixture v3 factory binds its captured Run before permit and refuses a mismatched start without HTTP',async()=>{
  const x=fixture();
  try{const execution=x.make();await assert.rejects(x.run(execution,{...x.input,runId:randomUUID()}),/PROBE_V3_RUN_BINDING_INVALID/);
    assert.equal(x.grants.length,0);assert.equal(x.wires.length,0);assert.equal(x.releases.length,0);
  }finally{x.controller.abort();}
});

test('offline_fixture v3 factory rejects a substituted pool and forbids fake transport being labeled live',()=>{
  const x=fixture(),pool=structuredClone(research.pool);pool.poolHash='0'.repeat(64);
  assert.throws(()=>x.make({research:{...research,pool}}),/POOL_BINDING_FAILED/);
  assert.throws(()=>x.make({runnerMode:'live'}),/PROBE_V3_FIXTURE_MODE_REQUIRED/);
  assert.equal(x.grants.length,0);assert.equal(x.wires.length,0);
});

test('offline_fixture v3 factory native evidence sink failure is controlled and stops before HTTP',async()=>{
  const x=fixture({recordFault:row=>row.kind==='native'&&row.type==='inference.started'});
  try{await assert.rejects(x.run(),/ANSWER_EVIDENCE_WRITE_FAILED/);
    assert.equal(x.grants.length,0);assert.equal(x.wires.length,0);
    assert.equal(JSON.stringify(x.records).includes('untrusted arbitrary sink detail'),false);
  }finally{x.controller.abort();}
});

test('offline_fixture v3 factory refuses an async record sink instead of ignoring its rejected Promise and completing successfully',async()=>{
  const x=fixture();
  try{const execution=x.make({record:async()=>{throw Error('OFFLINE_FIXTURE_ASYNC_RECORD_REJECTION');}});
    await assert.rejects(x.run(execution),/ANSWER_EVIDENCE_WRITE_FAILED/);
    assert.equal(x.grants.length,0);assert.equal(x.wires.length,0);assert.equal(x.releases.length,0);
  }finally{x.controller.abort();}
});
