import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {analyzeProtocolProbeV2,PROTOCOL_PROBE_V2_POLICY,ProtocolProbeV2AnswerSchema,
  protocolProbeV2PromptHashes,createProtocolProbeV2Runner,createProtocolProbeV2Observer} from '../../dist/server/evaluation/protocol-probe-v2.js';
import {createTaskEngine} from '../../dist/server/runtime/task-context.js';

// Explicit offline_fixture packets/transport only. Never sends an HTTP request.
const hash=s=>createHash('sha256').update(s).digest('hex');
const expected={companyId:'C001',challengeId:'C001-CH1',researcherId:'R0001'};
const actorFor=(runId,role)=>({runId,role,agentId:randomUUID(),taskId:randomUUID(),contextId:randomUUID(),loopId:randomUUID(),attempt:1});
function packet(callCount=2,reverseTools=false){
 const runId=randomUUID(),records=[],events=[];let seq=0,clock=10;
 for(const role of ['proposer','counter-evidence']){
  const actor=actorFor(runId,role),toolNames=['read_company_challenge','read_candidate_bundle'].slice(0,callCount);
  if(reverseTools)toolNames.reverse();
  const calls=toolNames.map((toolName,i)=>{
   const args=toolName==='read_company_challenge'?{runId,companyId:expected.companyId,challengeId:expected.challengeId}:{runId,researcherId:expected.researcherId};
   const output={ok:true,runId,receiptId:randomUUID(),data:toolName==='read_company_challenge'?{challenge:{id:expected.challengeId}}:{profile:{record:{id:expected.researcherId}}}};
   return{callId:`actual_${role}_${i}`,toolName,args,argumentsSha256:hash(JSON.stringify(args)),output,outputSha256:hash(JSON.stringify(output))};});
  const batchId=randomUUID();
  for(const turn of [1,2]){
   const requestId=randomUUID(),permitId=randomUUID(),start=clock++,end=clock++;
   events.push({runId,seq:++seq,type:'permit.granted',payload:{requestId,permitId}});
   events.push({...actor,runId,seq:++seq,type:'model.request.started',payload:{requestId,permitId}});
   records.push({kind:'request',trace:{type:'request.started',actor,requestId,permitId,monotonicMs:start}});
   records.push({kind:'wire.request',actor,requestId,permitId,bodySha256:'c'.repeat(64),messages:turn===1?[]:[
    {role:'assistant',calls:calls.map(c=>({callId:c.callId,toolName:c.toolName,argumentsSha256:c.argumentsSha256,arguments:c.args}))},
    ...calls.map(c=>({role:'tool',callId:c.callId,outputSha256:c.outputSha256,receipt:{ok:true,runId,receiptId:c.output.receiptId,challengeId:c.output.data.challenge?.id??null,researcherId:c.output.data.profile?.record.id??null}}))]});
   if(turn===1)records.push({kind:'tool.batch',manifest:{actor,batchId,phase:'staged',calls:calls.map(c=>({callId:c.callId,toolName:c.toolName,argumentsSha256:c.argumentsSha256,started:false,returned:false}))}});
   records.push({kind:'request',trace:{type:'request.completed',actor,requestId,permitId,monotonicMs:end,diagnostic:{toolCallCount:turn===1?callCount:0}}});
   events.push({...actor,runId,seq:++seq,type:'model.request.completed',payload:{requestId,permitId}});
   events.push({runId,seq:++seq,type:'permit.released',payload:{requestId,permitId}});
   if(turn===1){
    for(const c of calls){records.push({kind:'native',type:'function_call.started',actor,callId:c.callId,toolName:c.toolName,arguments:c.args,argumentsSha256:c.argumentsSha256});
     records.push({kind:'native',type:'function_call.completed',actor,callId:c.callId,outputSha256:c.outputSha256,receipt:{ok:true,runId,receiptId:c.output.receiptId,challengeId:c.output.data.challenge?.id??null,researcherId:c.output.data.profile?.record.id??null}});}
    records.push({kind:'tool.batch',manifest:{actor,batchId,phase:'completed',calls:calls.map(c=>({callId:c.callId,toolName:c.toolName,argumentsSha256:c.argumentsSha256,started:true,returned:true,outputSha256:c.outputSha256}))}});
    records.push({kind:'native',type:'inference.started',actor,contextId:actor.contextId,toolResults:calls.map(c=>({callId:c.callId,outputSha256:c.outputSha256}))});
   }else{
    const answer={runId,challengeId:expected.challengeId,researcherId:expected.researcherId,receipts:calls.map(c=>({toolName:c.toolName,receiptId:c.output.receiptId}))},answerText=JSON.stringify(answer);
    records.push({kind:'answer.diagnostic',stage:'answer_capture',status:'captured',code:'ANSWER_CAPTURED',actor,request:{requestId,permitId},
     capture:{text:answerText,sha256:hash(answerText),byteLength:Buffer.byteLength(answerText),savedByteLength:Buffer.byteLength(answerText),savedSha256:hash(answerText),truncated:false,omissionReason:'none'}});
    records.push({kind:'answer.diagnostic',stage:'json_parse',status:'passed',code:'ANSWER_JSON_PARSED',actor,request:{requestId,permitId}});
    records.push({kind:'answer.diagnostic',stage:'schema_validation',status:'passed',code:'ANSWER_SCHEMA_VALIDATED',actor,request:{requestId,permitId}});
    records.push({kind:'native',type:'model.answer',actor,requestId,permitId,answer,answerText,answerSha256:hash(answerText)});
   }
  }
 }
 return{runId,runnerMode:'live',fixture:'offline_fixture',expected,records,events,safetyHold:false,
  record:{runId,runnerMode:'live',status:'insufficient',cleanupState:'confirmed',input:{runId,companyId:expected.companyId,challengeId:expected.challengeId}},
  cleanups:[{runId,confirmed:true,rootVerification:'absent',scanDiagnostics:[],exit:{exitObserved:true,closeObserved:true,exitCode:0,outputTruncated:false}}],
  permitSnapshot:{inFlight:0,runs:[{runId,attempts:4,inFlight:0,pending:0}]}};
}

test('v2 strict model contract excludes call IDs and freezes full effective prompts',()=>{
 assert.match(PROTOCOL_PROBE_V2_POLICY,/toolName/);assert.match(PROTOCOL_PROBE_V2_POLICY,/receiptId/);
 assert.equal(ProtocolProbeV2AnswerSchema.safeParse(packet().records.find(r=>r.type==='model.answer').answer).success,true);
 const answer=packet().records.find(r=>r.type==='model.answer').answer;answer.receipts[0].callId='1';
 assert.equal(ProtocolProbeV2AnswerSchema.safeParse(answer).success,false,'old ordinal IDs are never rewritten into actual transport IDs');
 const hashes=protocolProbeV2PromptHashes();assert.match(hashes.effectiveProposer,/^[a-f0-9]{64}$/);assert.match(hashes.contract,/^[a-f0-9]{64}$/);
});

test('layered v2 accepts exact transport causality and ordered real model receipts without a callId field',()=>{
 const result=analyzeProtocolProbeV2(packet());assert.equal(result.passed,true,JSON.stringify(result));
 assert.equal(result.transport.passed,true);assert.equal(result.model.passed,true);assert.equal(result.execution.passed,true);
 assert.equal(result.cleanup.confirmed,true);assert.equal(result.evidence.complete,true);assert.equal(result.multiCallBatchCount,2);
});
test('either supplier tool order passes only when stage native Context HTTP model and capture all retain that actual order',()=>{
 const x=packet(2,true),before=JSON.stringify(x);
 assert.equal(x.records.find(r=>r.type==='function_call.started').toolName,'read_candidate_bundle');
 const r=analyzeProtocolProbeV2(x);assert.equal(r.passed,true,JSON.stringify(r));assert.equal(r.transportPassed,true);assert.equal(r.modelReceiptsPassed,true);
 assert.equal(JSON.stringify(x),before,'analysis must never rewrite transport IDs, actual order or answer capture');
});
for(const fault of ['missing_call','duplicate_call','wrong_order','cross_context','wrong_output_hash','missing_wire','wire_order','answer_before_http',
 'wrong_model_order','missing_receipt','duplicate_receipt','forged_receipt','cross_context_receipt','old_ordinal_field','wrong_model_run','wrong_request_actor','wrong_answer_request'])
 test(`v2 rejects ${fault} without altering source evidence or inventing mappings`,()=>{
  const x=packet();const answer=x.records.find(r=>r.type==='model.answer');
  if(fault==='missing_call')x.records.splice(x.records.findIndex(r=>r.type==='function_call.completed'),1);
  if(fault==='duplicate_call')x.records.push(structuredClone(x.records.find(r=>r.type==='function_call.completed')));
  if(fault==='wrong_order')x.records.find(r=>r.type==='function_call.started').callId='other-call';
  if(fault==='cross_context')x.records.find(r=>r.type==='inference.started').actor.contextId=randomUUID();
  if(fault==='wrong_output_hash')x.records.find(r=>r.type==='function_call.completed').outputSha256='0'.repeat(64);
  if(fault==='missing_wire')x.records.find(r=>r.kind==='wire.request'&&r.messages.length).messages.pop();
  if(fault==='wire_order'){const m=x.records.find(r=>r.kind==='wire.request'&&r.messages.length).messages;m.unshift(m.pop());}
  if(fault==='answer_before_http'){const i=x.records.indexOf(answer);x.records.splice(i,1);x.records.splice(x.records.findIndex(r=>r.kind==='wire.request'&&r.messages.length),0,answer);}
  if(fault==='wrong_model_order')answer.answer.receipts.reverse();
  if(fault==='missing_receipt')answer.answer.receipts.pop();
  if(fault==='duplicate_receipt')answer.answer.receipts[1]=structuredClone(answer.answer.receipts[0]);
  if(fault==='forged_receipt')answer.answer.receipts[0].receiptId=randomUUID();
  if(fault==='cross_context_receipt')answer.answer.receipts=x.records.filter(r=>r.type==='model.answer')[1].answer.receipts;
  if(fault==='old_ordinal_field')answer.answer.receipts[0].callId='1';
  if(fault==='wrong_model_run')answer.answer.runId=randomUUID();
  if(fault==='wrong_request_actor')x.records.find(r=>r.kind==='request').trace.actor.runId=randomUUID();
  if(fault==='wrong_answer_request')answer.requestId=randomUUID();
  const before=JSON.stringify(x),out=analyzeProtocolProbeV2(x);assert.equal(out.passed,false,JSON.stringify(out));assert.equal(JSON.stringify(x),before);
 });
test('single-call packets never pass or unlock L05',()=>{const r=analyzeProtocolProbeV2(packet(1));assert.equal(r.passed,false);assert.equal(r.multiCallBatchCount,0);});
for(const fault of ['missing_json_diagnostic','duplicate_json_diagnostic'])test(`v2 evidence requires unique parse-stage acknowledgment: ${fault}`,()=>{
 const x=packet(),i=x.records.findIndex(r=>r.kind==='answer.diagnostic'&&r.stage==='json_parse');
 if(fault==='missing_json_diagnostic')x.records.splice(i,1);else x.records.push(structuredClone(x.records[i]));
 assert.equal(analyzeProtocolProbeV2(x).evidenceComplete,false);
});
test('exit1 is execution failure while actual cleanup remains confirmed',()=>{
 const p=packet();p.cleanups[0].exit.exitCode=1;p.record.status='failed';const r=analyzeProtocolProbeV2(p);
 assert.equal(r.passed,false);assert.equal(r.execution.passed,false);assert.equal(r.cleanup.confirmed,true);
 assert.equal(r.reasons.includes('CLEANUP_UNCONFIRMED'),false);
});
test('clear cleanup cannot conceal missing evidence, write failures, residual permits or hold',()=>{
 for(const edit of [p=>p.records.push({kind:'answer.diagnostic',stage:'evidence_write',code:'ANSWER_EVIDENCE_WRITE_FAILED'}),p=>p.records.pop(),
  p=>p.records.splice(p.records.findIndex(r=>r.kind==='answer.diagnostic'),1),p=>p.safetyHold=true,p=>p.permitSnapshot.inFlight=1,p=>p.permitSnapshot.runs[0].pending=1,p=>p.permitSnapshot.runs[0].attempts=5]){
  const p=packet();edit(p);assert.equal(analyzeProtocolProbeV2(p).passed,false);
 }
});

test('actual SDK offline native batches feed only ordered real UUID receipts to both model Contexts',async()=>{
 const runId=randomUUID(),controller=new AbortController(),records=[],events=[],requests=[],turns=new Map();
 const tools=['read_company_challenge','read_candidate_bundle'].map(toolName=>({type:'function',name:toolName,description:'offline_fixture read-only tool',strict:true,
  parameters:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},
  invoke:async()=>({ok:true,runId,receiptId:randomUUID(),data:toolName==='read_company_challenge'?{challenge:{id:expected.challengeId}}:{profile:{record:{id:expected.researcherId}}}})}));
 const observer=createProtocolProbeV2Observer({apiKey:'offline-fixture-key',record:r=>records.push(r)});
 const engine=createTaskEngine({runId,signal:controller.signal,model:'offline_fixture',tools,adapterProbe:true,adapterProbeInstruction:PROTOCOL_PROBE_V2_POLICY,answerDiagnostics:observer.answerDiagnostics,
  emit:e=>events.push(e),onToolBatch:manifest=>records.push({kind:'tool.batch',manifest}),onNative:observer.native,
  runnerFactory:hooks=>createProtocolProbeV2Runner({gateway:{baseURL:'https://offline.invalid/v1',apiKey:'offline-fixture-key',model:'offline_fixture'},hooks,
   permitClient:{acquire:async()=>({id:randomUUID()}),release:()=>{}},requestTimeoutMs:40000,record:r=>records.push(r),
   trace:observer.trace,fetchImpl:async(_url,init)=>{
    requests.push(JSON.parse(init.body));const body=requests.at(-1),role=JSON.parse(body.messages.find(m=>m.role==='user').content).role,turn=(turns.get(role)??0)+1;turns.set(role,turn);
    if(turn===1)return new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:tools.map((tool,i)=>({id:`supplier_${role}_${i}`,type:'function',function:{name:tool.name,arguments:JSON.stringify({runId})}}))}}]}));
    const outputs=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));assert.equal(outputs.length,2);
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({runId,challengeId:expected.challengeId,researcherId:expected.researcherId,
     receipts:outputs.map((o,i)=>({toolName:tools[i].name,receiptId:o.receiptId}))})}}]}));
   }})});
 try{await Promise.all([engine.startTask('proposer',{role:'proposer'}),engine.startTask('counter-evidence',{role:'counter-evidence'})]);
  assert.equal(requests.length,4);assert.equal(records.filter(r=>r.type==='function_call.completed').length,4);
  const answers=records.filter(r=>r.type==='model.answer');assert.equal(answers.length,2);assert.equal(new Set(answers.map(r=>r.actor.contextId)).size,2);
  for(const answer of answers){assert.equal(ProtocolProbeV2AnswerSchema.safeParse(answer.answer).success,true);assert.equal(JSON.stringify(answer.answer).includes('callId'),false);
   assert.deepEqual(JSON.parse(answer.answerText),answer.answer);assert.equal(hash(answer.answerText),answer.answerSha256);}
 }finally{controller.abort();engine.dispose();}
});
