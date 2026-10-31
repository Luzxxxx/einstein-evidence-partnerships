import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {canonicalizeArtifact} from '../../dist/server/contracts/canonical.js';
import {createProtocolProbeV4Execution,protocolProbeV4ToolDefinitions} from '../../dist/server/evaluation/protocol-probe-v4.js';
import {createV4EvidenceWriter} from '../../dist/server/evaluation/v4-worker-evidence.js';
import {createV4Harness,sha} from '../fixtures/probe-v4-harness.mjs';

process.env.MOZAIK_API_KEY='';let networkCalls=0;const originalFetch=globalThis.fetch;
test.before(()=>{globalThis.fetch=async()=>{networkCalls++;throw Error('OFFLINE_FIXTURE_NETWORK_FORBIDDEN');};});
test.after(()=>{globalThis.fetch=originalFetch;assert.equal(networkCalls,0);});
const nonPolicy=body=>{const{tools,tool_choice,...rest}=body;return rest;},hash=value=>sha(canonicalizeArtifact(value));
for(const reverse of [false,true])test(`V4 actual SDK controlled roundtrip keeps independent raw request proof: reverse=${reverse}`,async()=>{
 const x=await createV4Harness({reverse});
 try{
  const outcome=await x.run();assert.equal(outcome.kind,'insufficient');assert.deepEqual(outcome.reasonCodes,['ADAPTER_PROBE_ONLY_NO_PUBLICATION']);
  assert.equal(x.http.length,4);assert.equal(x.grants.length,4);assert.equal(x.releases.length,4);assert.equal(x.manager.snapshot().inFlight,0);
  assert.equal(x.manager.snapshot().runs[0].attempts,4);assert.equal(new Set(x.http.map(r=>r.actor.contextId)).size,2);
  for(const h of x.http){
   const first=h.stage==='first',own=r=>r.actor?.contextId===h.actor.contextId&&r.requestId===h.requestId&&r.permitId===h.permitId;
   const before=x.records.filter(r=>r.kind==='v4.http.body'&&r.phase==='before'&&own(r)),actual=x.records.filter(r=>r.kind==='v4.http.body'&&r.phase==='actual'&&own(r));
   assert.equal(before.length,1);assert.equal(actual.length,1);for(const row of [...before,...actual]){assert.equal(row.bodySha256,sha(row.bodyText));assert.equal(row.byteLength,Buffer.byteLength(row.bodyText));assert.ok(Buffer.byteLength(JSON.stringify(row))<=262144);assert.equal(row.stage,h.stage);}
   assert.equal(actual[0].bodyText,h.rawBody);const prior=JSON.parse(before[0].bodyText),sent=JSON.parse(actual[0].bodyText);
   assert.deepEqual(nonPolicy(prior),nonPolicy(sent));assert.equal(JSON.stringify(prior.messages),JSON.stringify(sent.messages));assert.equal(prior.tool_choice,undefined);
   assert.deepEqual(prior.tools.map(t=>t.function.name),['read_company_challenge','read_candidate_bundle']);
   if(first)assert.deepEqual(sent.tools,prior.tools);else assert.equal(Object.hasOwn(sent,'tools'),false);
   assert.equal(sent.tool_choice,first?'auto':'none');assert.equal(sent.model,'offline_fixture');assert.equal(sent.parallel_tool_calls,false);assert.equal(sent.stream,false);
   const native=x.records.filter(r=>r.kind==='staged.native.input'&&own(r)),policy=x.records.filter(r=>r.kind==='staged.http.policy'&&own(r)),wire=x.records.filter(r=>r.kind==='wire.request'&&own(r)),upstream=x.records.filter(r=>r.kind==='wire.before_stage_projection'&&own(r)),prompt=x.records.filter(r=>r.kind==='wire.effective_prompt'&&own(r));
   const fetchStarted=x.records.filter(r=>r.kind==='v4.fetch.started'&&own(r)),headers=x.records.filter(r=>r.kind==='v4.fetch.headers'&&own(r));assert.equal(fetchStarted.length,1);assert.equal(headers.length,1);
   assert.equal(fetchStarted[0].bodySha256,actual[0].bodySha256);assert.equal(headers[0].bodySha256,actual[0].bodySha256);assert.equal(fetchStarted[0].stage,h.stage);assert.equal(headers[0].stage,h.stage);assert.ok(Number.isFinite(fetchStarted[0].fetchMonotonicMs)&&headers[0].fetchMonotonicMs>=fetchStarted[0].fetchMonotonicMs);assert.equal(headers[0].httpStatus,200);
   assert.equal(native.length,1);assert.equal(policy.length,1);assert.equal(wire.length,1);assert.equal(upstream.length,1);assert.equal(prompt.length,1);
   assert.equal(native[0].sameToolReferences,true);assert.equal(native[0].sameContextObject,true);assert.equal(native[0].stage,h.stage);
   const defs=native[0].nativeTools.map(t=>t.definition);assert.equal(defs.length,2);
   defs.forEach((d,i)=>{assert.equal(native[0].nativeTools[i].definitionSha256,hash(d));assert.equal(native[0].nativeTools[i].schemaSha256,hash(d.parameters));assert.deepEqual(prior.tools[i],{type:'function',function:{name:d.name,description:d.description,parameters:d.parameters,strict:d.strict}});});
   assert.equal(policy[0].beforeBodySha256,before[0].bodySha256);assert.equal(policy[0].bodySha256,actual[0].bodySha256);assert.equal(policy[0].beforeToolsSha256,hash(prior.tools));
   assert.equal(policy[0].actualToolsSha256,first?hash(sent.tools):null);assert.equal(policy[0].actualToolsPresent,first);
   assert.equal(upstream[0].bodySha256,before[0].bodySha256);assert.equal(wire[0].bodySha256,actual[0].bodySha256);assert.equal(prompt[0].bodySha256,actual[0].bodySha256);assert.notEqual(wire[0].bodySha256,upstream[0].bodySha256);
   assert.ok(x.records.indexOf(native[0])<x.records.indexOf(before[0]));assert.ok(x.records.indexOf(before[0])<x.records.indexOf(actual[0]));assert.ok(x.records.indexOf(actual[0])<x.records.indexOf(wire[0]));assert.ok(x.records.indexOf(wire[0])<x.records.indexOf(prompt[0]));assert.ok(x.records.indexOf(prompt[0])<x.records.indexOf(policy[0]));assert.ok(x.records.indexOf(policy[0])<x.records.indexOf(fetchStarted[0]));assert.ok(x.records.indexOf(fetchStarted[0])<x.records.indexOf(headers[0]));
   if(!first){const calls=sent.messages.find(m=>m.role==='assistant'&&m.tool_calls).tool_calls,outputs=sent.messages.filter(m=>m.role==='tool');assert.equal(calls.length,2);assert.equal(outputs.length,2);
    calls.forEach((call,i)=>{const nativeCall=x.records.find(r=>r.kind==='native'&&r.type==='function_call.started'&&r.actor.contextId===h.actor.contextId&&r.callId===call.id),nativeOutput=x.records.find(r=>r.kind==='native'&&r.type==='function_call.completed'&&r.actor.contextId===h.actor.contextId&&r.callId===call.id);
     assert.equal(nativeCall.argumentsSha256,sha(call.function.arguments));assert.equal(nativeOutput.outputSha256,sha(outputs[i].content));assert.equal(outputs[i].tool_call_id,call.id);assert.equal(JSON.parse(outputs[i].content).receiptId,nativeOutput.receipt.receiptId);});
   }
  }
  const firstStarts=x.records.filter(r=>r.kind==='v4.fetch.started'&&r.stage==='first'),firstHeaders=x.records.filter(r=>r.kind==='v4.fetch.headers'&&r.stage==='first');
  assert.equal(firstStarts.length,2);assert.equal(firstHeaders.length,2);assert.ok(Math.min(...firstHeaders.map(r=>r.fetchMonotonicMs))-Math.max(...firstStarts.map(r=>r.fetchMonotonicMs))>0,'actual controlled fetch calls overlap, measured after raw evidence preflight, never inferred from Gateway intervals');
  assert.equal(x.records.filter(r=>r.type==='model.answer').length,2);assert.ok(x.records.filter(r=>r.type==='model.answer').every(r=>r.answer.receipts[0].toolName===(reverse?'read_candidate_bundle':'read_company_challenge')));
  assert.equal(x.diagnostics.filter(r=>r.stage==='schema_validation'&&r.status==='passed').length,2);assert.equal(x.events.some(e=>['artifact.validated','review.completed'].includes(e.type)),false);
 }finally{x.close();}
});
for(const fault of ['first_three','second_tools','missing_receipt','wrong_receipt','cross_context_receipt','wrong_order','bad_response'])test(`V4 controlled ${fault} fails closed without further tools, third requests or publication`,async()=>{
 const x=await createV4Harness({fault});try{await assert.rejects(x.run());assert.ok(x.http.length<=4);assert.equal(x.manager.snapshot().inFlight,0);assert.equal(x.releases.length,x.grants.length);
  assert.equal(x.records.filter(r=>r.type==='function_call.started').length,['first_three','bad_response'].includes(fault)?0:4);
  for(const contextId of new Set(x.http.map(r=>r.actor.contextId)))assert.ok(x.http.filter(r=>r.actor.contextId===contextId).length<=2);
  assert.equal(x.records.some(r=>r.type==='model.answer'),false);assert.equal(x.events.some(e=>['artifact.validated','review.completed'].includes(e.type)),false);
  if(fault==='second_tools')assert.ok(x.records.some(r=>r.kind==='probe.contract'&&r.code==='PROBE_CONTRACT_SECOND_RESPONSE_TOOLS'));
 }finally{x.close();}
});
test('V4 violation aborts actually in-flight sibling controlled fetch and releases current reservations',async()=>{
 const x=await createV4Harness({fault:'sibling_cancel'});try{await assert.rejects(x.run(),/PROBE_CONTRACT_SECOND_RESPONSE_TOOLS/);assert.equal(x.siblingAbortObserved,true);assert.equal(x.http.length,4);assert.equal(x.grants.length,4);assert.equal(x.releases.length,4);assert.equal(x.manager.snapshot().inFlight,0);assert.equal(x.manager.snapshot().runs[0].pending,0);}finally{x.close();}
});
test('V4 constructor forbids live injected transport and requires explicit mode and controlled offline transport',async()=>{
 const x=await createV4Harness();try{for(const patch of [{runnerMode:undefined},{runnerMode:'live'},{runnerMode:'live',fetchImpl:undefined},{fetchImpl:undefined},{gateway:{...x.common.gateway,baseURL:'https://example.com/v1'}}])assert.throws(()=>createProtocolProbeV4Execution({...x.common,...patch}),/PROBE_V4_/);assert.equal(x.http.length,0);assert.equal(x.grants.length,0);}finally{x.close();}
});
test('V4 acknowledged evidence failure stops before controlled HTTP and leaves no current reservation',async()=>{
 const x=await createV4Harness({recordSink:row=>{if(row.kind==='v4.http.body')throw Error('fixture_sink_failure_do_not_log');}});
 try{await assert.rejects(x.run(),/ANSWER_EVIDENCE_WRITE_FAILED|GATEWAY_/);assert.equal(x.http.length,0);assert.equal(x.manager.snapshot().inFlight,0);assert.equal(x.releases.length,x.grants.length);assert.equal(x.records.some(r=>r.kind==='wire.request'),false);}finally{x.close();}
});
test('V4 post-invocation evidence failure observes pending rejection and preserves sibling cancellation and current permit cleanup',async()=>{
 const x=await createV4Harness({recordSink:row=>{if(row.kind==='v4.fetch.started')throw Error('fixture_post_invocation_sink_failure_do_not_log');}});
 try{await assert.rejects(x.run());assert.ok(x.http.length>=1&&x.http.length<=2);assert.equal(x.manager.snapshot().inFlight,0);assert.equal(x.releases.length,x.grants.length);assert.equal(x.records.some(r=>r.type==='model.answer'),false);
  for(const h of x.http){const entered=x.transportLifecycle.findIndex(r=>r.kind==='fetch.entered'&&r.permitId===h.permitId),aborted=x.transportLifecycle.findIndex(r=>r.kind==='fetch.aborted'&&r.permitId===h.permitId),released=x.transportLifecycle.findIndex(r=>r.kind==='permit.release'&&r.permitId===h.permitId);assert.ok(entered>=0&&aborted>entered&&released>aborted,'actual pending fetch abort is observed before original permit release');}
 }finally{x.close();}
});
test('V4 preserves ordinary assistant prefaces through native batches and both exact HTTP bodies',async()=>{
 const x=await createV4Harness({fault:'first_preface'});try{const result=await x.run();assert.equal(result.kind,'insufficient');assert.equal(x.http.length,4);
  const finalBodies=x.records.filter(r=>r.kind==='v4.http.body'&&r.stage==='final');assert.equal(finalBodies.length,4);
  for(const row of finalBodies){const b=JSON.parse(row.bodyText);assert.equal(b.messages.find(m=>m.role==='assistant'&&m.tool_calls)?.content,'Ordinary fixture preface.');}
  assert.equal(x.records.filter(r=>r.type==='model.answer').length,2);assert.equal(x.records.some(r=>r.kind==='v4.evidence.rejected'),false);
  assert.equal(x.manager.snapshot().inFlight,0);assert.equal(x.releases.length,x.grants.length);
 }finally{x.close();}
});
for(const fault of ['first_reasoning'])test(`V4 rejects explicitly marked assistant reasoning before capture: ${fault}`,async()=>{
 const x=await createV4Harness({fault});try{await assert.rejects(x.run());assert.equal(x.http.length,2);
  assert.equal(x.records.some(r=>JSON.stringify(r).includes('fixture hidden')||JSON.stringify(r).includes('Ordinary fixture preface.')),false);
  const rejection=x.records.find(r=>r.kind==='v4.evidence.rejected'&&r.reason==='V4_REQUEST_EXPLICIT_REASONING');assert.ok(rejection);assert.equal(rejection.stage,'final');assert.equal(rejection.phase,'before');assert.ok(rejection.actor&&rejection.requestId&&rejection.permitId);assert.equal(Object.hasOwn(rejection,'bodyText'),false);
  assert.equal(x.records.filter(r=>r.type==='function_call.completed'&&r.actor.contextId===rejection.actor.contextId).length,2);
  assert.equal(x.records.some(r=>r.type==='model.answer'),false);assert.equal(x.manager.snapshot().inFlight,0);assert.equal(x.releases.length,x.grants.length);
 }finally{x.close();}
});
test('V4 own request evidence writer rejects clear/escaped/percent credentials, explicit reasoning and cap overflow without unsafe partial records',async()=>{
 for(const text of ['fixture_secret_123','\\u0066ixture_secret_123','fixture%5Fsecret%5F123','plain 50% fixture%5Fsecret%5F123','<think>fixture hidden</think>','{"reasoning_content":"fixture hidden"}','x'.repeat(270000)]){
  const folder=await mkdtemp(join(tmpdir(),'einstein-v4-evidence-'));
  try{const writer=await createV4EvidenceWriter({folder,credential:'fixture_secret_123'});assert.throws(()=>writer.record({kind:'v4.http.body',phase:'before',bodyText:text}),/ANSWER_EVIDENCE_WRITE_FAILED/);
   assert.equal(await readFile(join(folder,'worker-evidence.jsonl'),'utf8'),'');
  }finally{const target=resolve(folder);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('einstein-v4-evidence-'));await rm(target,{recursive:true,force:true});}
 }
});
test('V4 tool definition projection is a frozen source copy, never a Tool replacement',()=>{
 const tools=['read_company_challenge','read_candidate_bundle','read_evidence_record'].map(name=>({type:'function',name,description:'source tool',parameters:{type:'object'},strict:true,invoke:async()=>null}));
 const defs=protocolProbeV4ToolDefinitions(tools);assert.deepEqual(defs.map(d=>d.name),['read_company_challenge','read_candidate_bundle']);assert.equal(Object.isFrozen(defs),true);assert.equal(Object.isFrozen(defs[0].parameters),true);assert.equal(tools[0].parameters.type,'object');assert.equal(Object.hasOwn(defs[0],'invoke'),false);
});
