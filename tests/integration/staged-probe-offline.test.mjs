import test from 'node:test';
import assert from 'node:assert/strict';
import {createStagedProbeOfflineExecution} from '../../dist/server/evaluation/staged-probe-offline.js';
import {createStagedHarness,sha} from '../fixtures/staged-probe-harness.mjs';

// Actual SDK + original tools, controlled fake HTTP only. Never provider proof.
process.env.MOZAIK_API_KEY='';
const originalFetch=globalThis.fetch;let forbiddenNetworkCalls=0;
test.before(()=>{globalThis.fetch=async()=>{forbiddenNetworkCalls++;throw Error('OFFLINE_FIXTURE_NETWORK_FORBIDDEN');};});
test.after(()=>{globalThis.fetch=originalFetch;assert.equal(forbiddenNetworkCalls,0);});

test('unchanged V3 baseline freshly exposes all three tools on both HTTP stages and maps no tool_choice',async()=>{
 const x=await createStagedHarness({baseline:true});
 try{const outcome=await x.run();assert.equal(outcome.kind,'insufficient');assert.equal(x.http.length,4);
  for(const h of x.http){assert.deepEqual(h.body.tools.map(t=>t.function.name),['read_company_challenge','read_candidate_bundle','read_evidence_record']);assert.equal(h.body.tool_choice,undefined);}
  assert.equal(x.records.filter(r=>r.kind==='native'&&r.type==='function_call.completed').length,4);
  assert.equal(x.manager.snapshot().inFlight,0);
 }finally{x.close();}
});

for(const reverse of [false,true])test(`offline staged composition preserves real native tools Context and original wire receipts: reverse=${reverse}`,async()=>{
 const x=await createStagedHarness({reverse});
 try{const outcome=await x.run();assert.equal(outcome.kind,'insufficient');assert.deepEqual(outcome.reasonCodes,['ADAPTER_PROBE_ONLY_NO_PUBLICATION']);
  assert.equal(x.http.length,4);assert.equal(x.grants.length,4);assert.equal(x.releases.length,4);assert.equal(x.manager.snapshot().inFlight,0);
  assert.equal(x.manager.snapshot().runs[0].attempts,4);assert.ok(x.http.every(h=>h.url==='https://offline.invalid/v1/chat/completions'));
  const inputs=x.records.filter(r=>r.kind==='staged.native.input');assert.equal(inputs.length,4);assert.equal(new Set(inputs.map(r=>r.actor.contextId)).size,2);
  for(const r of inputs){assert.deepEqual(r.nativeTools.map(t=>t.name),['read_company_challenge','read_candidate_bundle']);assert.equal(r.sameToolReferences,true);assert.equal(r.sameContextObject,true);
   assert.ok(r.nativeTools.every(t=>/^[a-f0-9]{64}$/.test(t.schemaSha256)&&/^[a-f0-9]{64}$/.test(t.definitionSha256)));}
  for(const h of x.http){assert.ok(h.actor&&h.requestId&&h.permitId);const first=h.stage==='first';
   assert.deepEqual(h.body.tools?.map(t=>t.function.name)??[],first?['read_company_challenge','read_candidate_bundle']:[]);
   assert.equal(h.body.tool_choice,first?'auto':'none');assert.equal(h.body.parallel_tool_calls,false);assert.equal(h.body.stream,false);assert.equal(h.body.model,'offline_fixture');
   const actual=x.records.filter(r=>r.kind==='wire.request'&&r.requestId===h.requestId),before=x.records.filter(r=>r.kind==='wire.before_stage_projection'&&r.requestId===h.requestId),policy=x.records.filter(r=>r.kind==='staged.http.policy'&&r.requestId===h.requestId);
   assert.equal(actual.length,1);assert.equal(before.length,1);assert.equal(policy.length,1);assert.equal(actual[0].bodySha256,sha(h.rawBody));
   assert.notEqual(before[0].bodySha256,actual[0].bodySha256,'a pre-policy hash cannot pretend to hash the actual transmitted body');
   assert.deepEqual(actual[0].messages,before[0].messages);assert.equal(policy[0].beforeBodySha256,before[0].bodySha256);assert.equal(policy[0].bodySha256,actual[0].bodySha256);
   assert.equal(policy[0].beforeMessagesSha256,sha(JSON.stringify(h.body.messages)));assert.equal(policy[0].messagesSha256,policy[0].beforeMessagesSha256);
   assert.equal(policy[0].unchangedNonToolFields,true);assert.deepEqual(policy[0].actor,h.actor);
   if(!first){const calls=h.body.messages.find(m=>m.role==='assistant'&&m.tool_calls).tool_calls,outputs=h.body.messages.filter(m=>m.role==='tool');assert.equal(calls.length,2);assert.equal(outputs.length,2);
    const native=x.records.filter(r=>r.kind==='native'&&r.actor.contextId===h.actor.contextId);
    calls.forEach((call,i)=>{const start=native.find(r=>r.type==='function_call.started'&&r.callId===call.id),end=native.find(r=>r.type==='function_call.completed'&&r.callId===call.id);
     assert.equal(call.function.arguments&&sha(call.function.arguments),start.argumentsSha256);assert.equal(outputs[i].tool_call_id,call.id);assert.equal(sha(outputs[i].content),end.outputSha256);
     assert.equal(JSON.parse(outputs[i].content).receiptId,end.receipt.receiptId);});
   }
  }
  const answers=x.records.filter(r=>r.type==='model.answer');assert.equal(answers.length,2);
  assert.ok(answers.every(a=>a.answer.receipts[0].toolName===(reverse?'read_candidate_bundle':'read_company_challenge')));
  assert.equal(x.diagnostics.filter(r=>r.stage==='schema_validation'&&r.status==='passed').length,2);
  assert.equal(x.events.some(e=>e.type==='review.completed'||e.type==='artifact.validated'),false);
 }finally{x.close();}
});

for(const fault of ['second_tools','missing_receipt','wrong_receipt','cross_context_receipt','bad_response'])test(`offline staged composition rejects ${fault} without a third request or publication`,async()=>{
 const x=await createStagedHarness({fault});
 try{await assert.rejects(x.run());assert.ok(x.http.length<=4);assert.ok(x.grants.length<=4);assert.equal(x.manager.snapshot().inFlight,0);assert.equal(x.releases.length,x.grants.length);
  const native=x.records.filter(r=>r.kind==='native'&&r.type==='function_call.started');assert.equal(native.length,fault==='bad_response'?0:4);
  const contexts=new Set(x.http.map(h=>h.actor?.contextId));for(const id of contexts)assert.ok(x.http.filter(h=>h.actor?.contextId===id).length<=2);
  assert.equal(x.records.some(r=>r.kind==='native'&&r.type==='model.answer'),false);assert.equal(x.events.some(e=>e.type==='artifact.validated'||e.type==='review.completed'),false);
  if(fault==='second_tools')assert.ok(x.records.some(r=>r.kind==='probe.contract'&&r.code==='PROBE_CONTRACT_SECOND_RESPONSE_TOOLS'));
 }finally{x.close();}
});

test('offline staged violation cancels an actually in-flight sibling fake fetch and releases all granted permits',async()=>{
 const x=await createStagedHarness({fault:'sibling_cancel'});
 try{await assert.rejects(x.run(),/PROBE_CONTRACT_SECOND_RESPONSE_TOOLS/);assert.equal(x.http.length,4);assert.equal(x.siblingAbortObserved,true);
  assert.equal(x.records.filter(r=>r.kind==='native'&&r.type==='function_call.started').length,4);
  assert.equal(x.records.filter(r=>r.kind==='tool.batch'&&r.manifest.phase==='staged').length,2);
  assert.equal(x.grants.length,4);assert.equal(x.releases.length,4);assert.equal(x.manager.snapshot().inFlight,0);assert.equal(x.manager.snapshot().runs[0].pending,0);
 }finally{x.close();}
});

test('offline-only construction rejects live mode real hosts model substitution and missing fake fetch before any request',async()=>{
 const x=await createStagedHarness();
 try{for(const patch of [{runnerMode:'live'},{runnerMode:undefined},{gateway:{...x.common.gateway,baseURL:'https://example.com/v1'}},
  {gateway:{...x.common.gateway,model:'another-model'}},{fetchImpl:undefined}]){
  assert.throws(()=>createStagedProbeOfflineExecution({...x.common,...patch}),/STAGED_PROBE_OFFLINE_/);
 }
 assert.equal(x.grants.length,0);assert.equal(x.http.length,0);
 }finally{x.close();}
});
