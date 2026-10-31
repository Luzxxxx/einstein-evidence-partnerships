import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {analyzeProtocolProbeV3} from '../../dist/server/evaluation/protocol-probe-analysis-v3.js';

// Explicit offline_fixture evidence packets. No worker, store or HTTP execution.
const sha=text=>createHash('sha256').update(text).digest('hex');
const expected={companyId:'C001',challengeId:'C001-CH1',researcherId:'R0001'};
const actorFor=(runId,role)=>({runId,role,agentId:randomUUID(),taskId:randomUUID(),contextId:randomUUID(),loopId:randomUUID(),attempt:1});
function packet(options={}){
 const runId=randomUUID(),records=[],events=[],allCalls=[];let seq=0,clock=1,attempts=0;
 const actors=['proposer','counter-evidence'].map(role=>actorFor(runId,role));
 for(const actor of actors){
  const batches=actor.role==='counter-evidence'?(options.counterBatches??[['challenge','R0001']]):[['challenge','R0001']];
  const completed=[],history=[];let finalRequest;
  records.push({kind:'native',type:'inference.started',actor,contextId:actor.contextId,toolResults:[]});
  for(let turn=0;turn<=batches.length;turn++){
   if(turn===batches.length&&options.stopCounter&&actor.role==='counter-evidence')break;
   const requestId=randomUUID(),permitId=randomUUID();attempts++;
   records.push({kind:'request',trace:{type:'request.started',actor,requestId,permitId,monotonicMs:clock++}});
   events.push({runId,seq:++seq,type:'permit.granted',payload:{requestId,permitId}});
   events.push({...actor,seq:++seq,type:'model.request.started',payload:{requestId,permitId}});
   records.push({kind:'wire.request',actor,requestId,permitId,bodySha256:'a'.repeat(64),messages:structuredClone(history)});
   let batch;
   if(turn<batches.length){
    batch={actor,batchId:randomUUID(),phase:'staged',calls:batches[turn].map((item,i)=>{
     const toolName=item==='challenge'?'read_company_challenge':'read_candidate_bundle';
     const args=item==='challenge'?{runId,companyId:expected.companyId,challengeId:expected.challengeId}:{runId,researcherId:item};
     const receipt={ok:true,runId,receiptId:randomUUID(),challengeId:item==='challenge'?expected.challengeId:null,researcherId:item==='challenge'?null:item};
     const callId=options.sharedCallIds?`supplier_${turn}_${i}`:`supplier_${actor.role}_${turn}_${i}`;
     return{callId,toolName,argumentsSha256:sha(JSON.stringify(args)),arguments:args,outputSha256:sha(JSON.stringify(receipt)),receipt,started:false,returned:false};
    })};
    records.push({kind:'tool.batch',manifest:structuredClone(batch)});
   }
   records.push({kind:'request',trace:{type:'request.completed',actor,requestId,permitId,monotonicMs:clock++,diagnostic:{toolCallCount:batch?.calls.length??0}}});
   events.push({...actor,seq:++seq,type:'model.request.completed',payload:{requestId,permitId}});
   events.push({runId,seq:++seq,type:'permit.released',payload:{requestId,permitId}});
   finalRequest={requestId,permitId};
   if(!batch)continue;
   for(const c of batch.calls){
    records.push({kind:'native',type:'function_call.started',actor,callId:c.callId,toolName:c.toolName,arguments:c.arguments,argumentsSha256:c.argumentsSha256});
    records.push({kind:'native',type:'function_call.completed',actor,callId:c.callId,outputSha256:c.outputSha256,receipt:c.receipt});
    completed.push(c);allCalls.push({...c,actor,batchId:batch.batchId});
   }
   records.push({kind:'tool.batch',manifest:{...batch,phase:'completed',calls:batch.calls.map(c=>({...c,started:true,returned:true}))}});
   history.push({role:'assistant',calls:batch.calls.map(c=>({callId:c.callId,toolName:c.toolName,argumentsSha256:c.argumentsSha256,arguments:c.arguments}))},
    ...batch.calls.map(c=>({role:'tool',callId:c.callId,outputSha256:c.outputSha256,receipt:c.receipt})));
   records.push({kind:'native',type:'inference.started',actor,contextId:actor.contextId,toolResults:completed.map(c=>({callId:c.callId,outputSha256:c.outputSha256}))});
  }
  if(!(options.stopCounter&&actor.role==='counter-evidence')){
   const answer={runId,challengeId:expected.challengeId,researcherId:expected.researcherId,receipts:completed.map(c=>({toolName:c.toolName,receiptId:c.receipt.receiptId}))};
   const answerText=JSON.stringify(answer),capture={text:answerText,sha256:sha(answerText),byteLength:Buffer.byteLength(answerText),savedByteLength:Buffer.byteLength(answerText),savedSha256:sha(answerText),truncated:false,omissionReason:'none'};
   for(const [stage,status,code] of [['answer_capture','captured','ANSWER_CAPTURED'],['json_parse','passed','ANSWER_JSON_PARSED'],['schema_validation','passed','ANSWER_SCHEMA_VALIDATED']])
    records.push({kind:'answer.diagnostic',stage,status,code,actor,request:finalRequest,...(stage==='answer_capture'?{capture}:{})});
   records.push({kind:'native',type:'model.answer',actor,...finalRequest,answer,answerText,answerSha256:sha(answerText)});
  }
 }
 return{runId,runnerMode:'live',fixture:'offline_fixture',expected,records,events,actors,allCalls,safetyHold:false,
  stopReasonCodes:options.stopCounter?['PROTOCOL_PROBE_CONTEXT_REQUEST_LIMIT']:[],
  record:{runId,runnerMode:'live',status:options.stopCounter?'failed':'insufficient',cleanupState:'confirmed',input:{runId,...expected}},
  cleanups:[{runId,confirmed:true,exit:{exitObserved:true,closeObserved:true,exitCode:options.stopCounter?1:0}}],
  permitSnapshot:{inFlight:0,runs:[{runId,attempts,inFlight:0,pending:0}]}};
}
const counterBatches=out=>out.batches.filter(b=>b.actor.role==='counter-evidence');
const faultCodes=out=>out.directBindingCorruption.map(f=>f.code);

test('v3 normal packet independently verifies original calls, native Context, next HTTP and model receipt use',()=>{
 const p=packet(),before=JSON.stringify(p),r=analyzeProtocolProbeV3(p);
 assert.equal(r.analysisVersion,'protocol-probe-analysis-v3');assert.equal(r.historicalReclassification,false);assert.equal(r.publicationAuthority,false);
 assert.equal(r.taskContract.valid,true,JSON.stringify(r));assert.equal(r.native.status,'verified');assert.equal(r.context.status,'verified');assert.equal(r.http.status,'verified');
 assert.equal(r.directBindingCorruption.length,0);assert.equal(r.unobserved.length,0);assert.equal(r.modelReceiptUse.length,2);
 assert.ok(r.modelReceiptUse.every(a=>a.status==='verified'));assert.equal(JSON.stringify(p),before,'analysis is immutable');assert.ok(Object.isFrozen(r));
});

test('an empty observation set is incomplete rather than vacuously verified',()=>{
 for(const mode of ['none','requests_only']){
  const p=packet();p.records=mode==='none'?[]:p.records.filter(r=>r.kind==='request');p.events=[];p.record.status='failed';p.permitSnapshot.runs[0].attempts=0;
  const r=analyzeProtocolProbeV3(p);assert.equal(r.native.status,'incomplete',mode);assert.equal(r.context.status,'incomplete');assert.equal(r.http.status,'incomplete');
  assert.equal(r.native.completedCalls,0);assert.equal(r.directBindingCorruption.length,0);assert.equal(r.taskContract.valid,false);
  assert.ok(r.unobserved.some(f=>f.code==='BATCH_OBSERVATIONS_NOT_OBSERVED'));
 }
});

test('same actor multiple batches map their own receipts and cumulative HTTP history groups without array zipping',()=>{
 const p=packet({counterBatches:[['challenge','R0001','R0002'],['R0003']]}),r=analyzeProtocolProbeV3(p),b=counterBatches(r);
 assert.deepEqual(b.map(x=>x.callCount),[3,1]);assert.deepEqual(b.map(x=>x.httpHistoryGroupIndex),[0,1]);
 assert.equal(r.native.status,'verified',JSON.stringify(r));assert.equal(r.context.status,'verified');assert.equal(r.http.status,'verified');
 assert.equal(r.directBindingCorruption.length,0,'extra legal reads are task violations, not forged outputs');
 assert.equal(r.taskContract.valid,false);assert.ok(r.taskContract.violations.some(x=>x.code==='PROBE_REQUIRED_TOOL_BATCH_VIOLATION'));
 for(const batch of b)for(const c of batch.calls){const actual=p.allCalls.find(x=>x.batchId===batch.batchId&&x.callId===c.originalCallId);
  assert.equal(c.receiptId,actual.receipt.receiptId);assert.equal(c.outputSha256,actual.outputSha256);assert.equal(c.httpStatus,'verified');}
});

test('original call IDs reused by different full actor identities remain isolated',()=>{
 const r=analyzeProtocolProbeV3(packet({sharedCallIds:true}));assert.equal(r.directBindingCorruption.length,0);assert.equal(r.http.status,'verified');
 const [a,b]=r.batches;assert.equal(a.calls[0].originalCallId,b.calls[0].originalCallId);assert.notEqual(a.calls[0].receiptId,b.calls[0].receiptId);
});

test('stopped last batch records unobserved next HTTP without fabricated receipt/hash corruption',()=>{
 const p=packet({counterBatches:[['challenge','R0001','R0002'],['R0003','R0004']],stopCounter:true}),r=analyzeProtocolProbeV3(p),b=counterBatches(r);
 assert.equal(r.native.status,'verified');assert.equal(r.context.status,'verified');assert.equal(r.http.status,'incomplete');assert.equal(r.directBindingCorruption.length,0);
 assert.deepEqual(b.map(x=>x.httpStatus),['verified','not_observed_after_stop']);assert.equal(b[1].nextHttpRequestId,null);
 assert.equal(r.modelReceiptUse.find(a=>a.actor.role==='counter-evidence').status,'not_observed');
 assert.ok(r.unobserved.some(x=>x.code==='NEXT_HTTP_NOT_OBSERVED_AFTER_STOP'));assert.equal(r.execution.cleanupConfirmed,true);assert.equal(r.execution.status,'failed');
});

for(const fault of ['output_hash','receipt_run','receipt_id','args_hash','native_order','duplicate_native','cross_actor_native','source_request_actor','source_request_id','done_actor'])
 test(`v3 directly identifies ${fault} without borrowing another batch or actor`,()=>{
  const p=packet({counterBatches:[['challenge','R0001'],['R0002']]}),counter=p.actors[1];
  const staged=p.records.filter(x=>x.kind==='tool.batch'&&x.manifest.phase==='staged'&&x.manifest.actor.role===counter.role);
  const id=staged[1].manifest.calls[0].callId,start=p.records.find(x=>x.type==='function_call.started'&&x.callId===id),end=p.records.find(x=>x.type==='function_call.completed'&&x.callId===id);
  if(fault==='output_hash')end.outputSha256='0'.repeat(64);
  if(fault==='receipt_run')end.receipt={...end.receipt,runId:randomUUID()};
  if(fault==='receipt_id')end.receipt={...end.receipt,receiptId:randomUUID()};
  if(fault==='args_hash')start.argumentsSha256='0'.repeat(64);
  if(fault==='native_order'){const i=p.records.indexOf(start),j=p.records.indexOf(end);[p.records[i],p.records[j]]=[p.records[j],p.records[i]];}
  if(fault==='duplicate_native')p.records.splice(p.records.indexOf(end),0,structuredClone(end));
  if(fault==='cross_actor_native')end.actor={...end.actor,contextId:p.actors[0].contextId};
  if(fault==='source_request_actor'){const i=p.records.indexOf(staged[1]);const prior=p.records.slice(0,i).filter(x=>x.kind==='request'&&x.trace.type==='request.started').at(-1);prior.trace.actor={...prior.trace.actor,attempt:2};}
  if(fault==='source_request_id'){const i=p.records.indexOf(staged[1]);const after=p.records.slice(i).find(x=>x.kind==='request'&&x.trace.type==='request.completed');after.trace.requestId=randomUUID();}
  if(fault==='done_actor'){const done=p.records.find(x=>x.kind==='tool.batch'&&x.manifest.phase==='completed'&&x.manifest.batchId===staged[1].manifest.batchId);done.manifest.actor={...done.manifest.actor,runId:randomUUID()};}
  const r=analyzeProtocolProbeV3(p);assert.ok(r.directBindingCorruption.length>0,JSON.stringify(r));assert.equal(r.taskContract.valid,false);
 });

for(const fault of ['wire_call_order','wire_tool_order','wire_hash','wire_receipt','wire_args','history_group_swap','wire_actor','context_hash','context_actor','context_order'])
 test(`v3 locates actual ${fault} corruption in cumulative groups`,()=>{
  const p=packet({counterBatches:[['challenge','R0001'],['R0002','R0003']]}),actor=p.actors[1];
  const wires=p.records.filter(x=>x.kind==='wire.request'&&x.actor.role===actor.role),last=wires.at(-1),groups=last.messages.filter(x=>x.role==='assistant'),tools=last.messages.filter(x=>x.role==='tool');
  const contexts=p.records.filter(x=>x.type==='inference.started'&&x.actor.role===actor.role&&x.toolResults.length),context=contexts.at(-1);
  if(fault==='wire_call_order')groups[1].calls.reverse();
  if(fault==='wire_tool_order'){const i=last.messages.indexOf(tools[2]),j=last.messages.indexOf(tools[3]);[last.messages[i],last.messages[j]]=[last.messages[j],last.messages[i]];}
  if(fault==='wire_hash')tools[2].outputSha256='f'.repeat(64);
  if(fault==='wire_receipt')tools[2].receipt={...tools[2].receipt,receiptId:randomUUID()};
  if(fault==='wire_args')groups[1].calls[0].arguments={...groups[1].calls[0].arguments,researcherId:'R9999'};
  if(fault==='history_group_swap'){const first=last.messages.splice(0,3);last.messages.push(...first);}
  if(fault==='wire_actor')last.actor={...last.actor,taskId:randomUUID()};
  if(fault==='context_hash')context.toolResults[2].outputSha256='e'.repeat(64);
  if(fault==='context_actor')context.actor={...context.actor,attempt:2};
  if(fault==='context_order')context.toolResults.reverse();
  const r=analyzeProtocolProbeV3(p);assert.ok(r.directBindingCorruption.length>0,`${fault}: ${JSON.stringify(r)}`);
 });

test('missing observations remain incomplete, never become proof of binding corruption',()=>{
 for(const edit of [p=>p.records.splice(p.records.findIndex(x=>x.type==='function_call.completed'),1),p=>p.records.splice(p.records.findIndex(x=>x.type==='inference.started'&&x.toolResults.length),1),
  p=>p.records.splice(p.records.findIndex(x=>x.kind==='wire.request'&&x.messages.length),1)]){
  const p=packet();edit(p);const r=analyzeProtocolProbeV3(p);assert.ok(r.unobserved.length>0);assert.equal(r.directBindingCorruption.length,0,JSON.stringify(r));
 }
});

for(const fault of ['next_wire_request_id','next_wire_permit_id','next_response_actor','next_response_permit_id','source_wire_request_id'])
 test(`v3 distinguishes observed ${fault} contradiction from an absent record`,()=>{
  const p=packet(),counter=p.actors[1],wires=p.records.filter(r=>r.kind==='wire.request'&&r.actor.role===counter.role),wire=fault==='source_wire_request_id'?wires[0]:wires.at(-1);
  const response=p.records.find(r=>r.kind==='request'&&r.trace.type==='request.completed'&&r.trace.requestId===wire.requestId);
  if(fault==='next_wire_request_id'||fault==='source_wire_request_id')wire.requestId=randomUUID();
  if(fault==='next_wire_permit_id')wire.permitId=randomUUID();
  if(fault==='next_response_actor')response.trace.actor={...response.trace.actor,attempt:2};
  if(fault==='next_response_permit_id')response.trace.permitId=randomUUID();
  const r=analyzeProtocolProbeV3(p);assert.ok(r.directBindingCorruption.length>0,JSON.stringify(r));
 });

test('missing final HTTP completion is incomplete even when its outgoing tool projection is intact',()=>{
 const p=packet(),wire=p.records.filter(r=>r.kind==='wire.request').at(-1),i=p.records.findIndex(r=>r.kind==='request'&&r.trace.type==='request.completed'&&r.trace.requestId===wire.requestId);
 p.records.splice(i,1);const r=analyzeProtocolProbeV3(p);assert.equal(r.http.status,'incomplete');assert.equal(r.directBindingCorruption.length,0);
 assert.ok(r.unobserved.some(f=>f.code==='NEXT_HTTP_COMPLETION_NOT_OBSERVED'));
});

test('final model receipt mismatch is a model/task finding and does not rewrite valid native or wire output',()=>{
 const p=packet(),answer=p.records.find(x=>x.type==='model.answer');answer.answer.receipts[0].receiptId=randomUUID();
 const r=analyzeProtocolProbeV3(p);assert.equal(r.modelReceiptUse[0].status,'invalid');assert.equal(r.native.status,'verified');assert.equal(r.http.status,'verified');
 assert.equal(r.directBindingCorruption.length,0);assert.ok(r.taskContract.violations.some(x=>x.code==='MODEL_RECEIPT_USE_MISMATCH'));
});

test('historical Task7t read-only v3 analysis maps all eleven real calls and retains unobserved last HTTP and failed result',async()=>{
 const root='docs/implementation/task-7t-live',freeze=JSON.parse(await readFile(root+'/freeze.json','utf8')),dir=root+'/runs/'+freeze.probe.runId;
 const [rawResult,rawNative,rawDiagnostics]=await Promise.all(['result.json','worker-evidence.jsonl','answer-diagnostics.jsonl'].map(n=>readFile(dir+'/'+n)));
 const result=JSON.parse(rawResult),native=rawNative.toString('utf8').trim().split('\n').map(JSON.parse),diagnostics=rawDiagnostics.toString('utf8').trim().split('\n').map(JSON.parse);
 const r=analyzeProtocolProbeV3({...result,records:[...native,...diagnostics],expected:{companyId:freeze.probe.input.companyId,challengeId:freeze.probe.input.challengeId,researcherId:freeze.probe.researcherId},stopReasonCodes:result.terminalOutcome?.reasonCodes??[]});
 assert.equal(r.historicalReclassification,false);assert.equal(result.analysis.passed,false);assert.equal(result.record.status,'failed');
 assert.deepEqual(r.batches.map(b=>b.callCount),[2,4,5]);assert.equal(r.native.completedCalls,11);assert.equal(r.native.status,'verified',JSON.stringify(r));assert.equal(r.context.status,'verified');
 assert.equal(r.directBindingCorruption.length,0,JSON.stringify(faultCodes(r)));assert.equal(r.http.status,'incomplete');assert.equal(r.batches.filter(b=>b.httpStatus==='verified').length,2);
 const last=counterBatches(r).at(-1);assert.equal(last.httpStatus,'not_observed_after_stop');assert.equal(last.nextHttpRequestId,null);
 for(const batch of r.batches){const stage=native.find(x=>x.kind==='tool.batch'&&x.manifest.phase==='staged'&&x.manifest.batchId===batch.batchId),done=native.find(x=>x.kind==='tool.batch'&&x.manifest.phase==='completed'&&x.manifest.batchId===batch.batchId);
  for(const c of batch.calls){assert.ok(stage.manifest.calls.some(x=>x.callId===c.originalCallId));const end=native.find(x=>x.type==='function_call.completed'&&x.actor.contextId===batch.actor.contextId&&x.callId===c.originalCallId);
   assert.equal(c.receiptId,end.receipt.receiptId);assert.equal(c.outputSha256,end.outputSha256);assert.equal(c.outputSha256,done.manifest.calls.find(x=>x.callId===c.originalCallId).outputSha256);}}
 assert.equal(r.modelReceiptUse.find(a=>a.actor.role==='proposer').status,'verified');assert.equal(r.modelReceiptUse.find(a=>a.actor.role==='counter-evidence').status,'not_observed');
 assert.equal(r.taskContract.valid,false);assert.equal(r.execution.cleanupConfirmed,true);assert.equal(r.execution.status,'failed');
 assert.ok((await readFile(dir+'/result.json')).equals(rawResult));assert.ok((await readFile(dir+'/worker-evidence.jsonl')).equals(rawNative));assert.ok((await readFile(dir+'/answer-diagnostics.jsonl')).equals(rawDiagnostics));
});
