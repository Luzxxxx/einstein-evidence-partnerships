import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { analyzeProtocolProbe, PROTOCOL_PROBE_POLICY, projectProbeWireRequest,
  projectProtocolNative, createProtocolProbeRunner } from '../../dist/server/evaluation/protocol-probe.js';
import { createTaskEngine } from '../../dist/server/runtime/task-context.js';

// Every HTTP/model/analysis packet below is explicitly synthetic offline_fixture.
// These tests do not send a network request or claim actual provider compatibility.
const hash=x=>createHash('sha256').update(x).digest('hex');
const identity=(runId,role)=>({runId,role,agentId:randomUUID(),taskId:randomUUID(),contextId:randomUUID(),loopId:randomUUID(),attempt:1});
const actorKey=a=>JSON.stringify([a.runId,a.role,a.agentId,a.taskId,a.contextId,a.loopId,a.attempt]);
const expected={companyId:'C001',challengeId:'C001-CH1',researcherId:'R0001'};
function packet(callCount=2){
  const runId=randomUUID(),records=[],events=[];let seq=0,clock=10;
  for(const role of ['proposer','counter-evidence']){
    const actor=identity(runId,role),calls=['read_company_challenge','read_candidate_bundle'].slice(0,callCount).map((toolName,index)=>{
      const args=toolName==='read_company_challenge'?{runId,companyId:expected.companyId,challengeId:expected.challengeId}:{runId,researcherId:expected.researcherId};
      const output={ok:true,runId,receiptId:randomUUID(),poolHash:'a'.repeat(64),evidenceSnapshotHash:'b'.repeat(64),data:toolName==='read_company_challenge'
        ?{challenge:{id:expected.challengeId}}:{profile:{record:{id:expected.researcherId}}}};
      return{callId:`${role}_${index}`,toolName,args,argumentsSha256:hash(JSON.stringify(args)),output,outputSha256:hash(JSON.stringify(output))};
    });
    const batchId=randomUUID();
    for(const turn of [1,2]){
      const requestId=randomUUID(),permitId=randomUUID(),start=clock++,end=clock++;
      events.push({runId,seq:++seq,type:'permit.granted',payload:{requestId,permitId}});
      events.push({runId,seq:++seq,type:'model.request.started',payload:{requestId,permitId},...actor});
      records.push({kind:'request',trace:{type:'request.started',actor,requestId,permitId,timestamp:new Date(start).toISOString(),monotonicMs:start}});
      const messages=turn===1?[]:[{role:'assistant',calls:calls.map(c=>({callId:c.callId,toolName:c.toolName,argumentsSha256:c.argumentsSha256,arguments:c.args}))},
        ...calls.map(c=>({role:'tool',callId:c.callId,outputSha256:c.outputSha256,receipt:{ok:true,runId,receiptId:c.output.receiptId,challengeId:c.output.data.challenge?.id??null,researcherId:c.output.data.profile?.record.id??null}}))];
      records.push({kind:'wire.request',actor,requestId,permitId,bodySha256:'c'.repeat(64),messages});
      records.push({kind:'request',trace:{type:'request.completed',actor,requestId,permitId,timestamp:new Date(end).toISOString(),monotonicMs:end,diagnostic:{toolCallCount:turn===1?callCount:0}}});
      events.push({runId,seq:++seq,type:'model.request.completed',payload:{requestId,permitId},...actor});
      events.push({runId,seq:++seq,type:'permit.released',payload:{requestId,permitId}});
      if(turn===1){
        records.push({kind:'tool.batch',manifest:{actor,batchId,phase:'staged',calls:calls.map(c=>({callId:c.callId,toolName:c.toolName,argumentsSha256:c.argumentsSha256,started:false,returned:false}))}});
        for(const c of calls){
          records.push({kind:'native',type:'function_call.started',actor,callId:c.callId,toolName:c.toolName,arguments:c.args,argumentsSha256:c.argumentsSha256});
          records.push({kind:'native',type:'function_call.completed',actor,callId:c.callId,outputSha256:c.outputSha256,receipt:{ok:true,runId,receiptId:c.output.receiptId,challengeId:c.output.data.challenge?.id??null,researcherId:c.output.data.profile?.record.id??null}});
        }
        records.push({kind:'tool.batch',manifest:{actor,batchId,phase:'completed',calls:calls.map(c=>({callId:c.callId,toolName:c.toolName,argumentsSha256:c.argumentsSha256,started:true,returned:true,outputSha256:c.outputSha256}))}});
        records.push({kind:'native',type:'inference.started',actor,contextId:actor.contextId,toolResults:calls.map(c=>({callId:c.callId,outputSha256:c.outputSha256}))});
      }else{
        records.push({kind:'native',type:'model.answer',actor,answer:{runId,challengeId:expected.challengeId,researcherId:expected.researcherId,
          receipts:calls.map(c=>({callId:c.callId,toolName:c.toolName,receiptId:c.output.receiptId}))}});
      }
    }
  }
  return{runId,runnerMode:'live',testFixture:'offline_fixture',expected,records,events,safetyHold:false,
    record:{runId,runnerMode:'live',status:'insufficient',cleanupState:'confirmed',input:{runId,companyId:expected.companyId,challengeId:expected.challengeId}},
    cleanups:[{runId,confirmed:true,exit:{exitObserved:true,closeObserved:true,exitCode:0,outputTruncated:false}}],
    permitSnapshot:{inFlight:0,waiting:0,runs:[{runId,attempts:4,inFlight:0,waiting:0}]}};
}

test('protocol policy asks complete native tool batches and actual receipts, not a proposal or fabricated completion',()=>{
  assert.match(PROTOCOL_PROBE_POLICY,/read_company_challenge/);assert.match(PROTOCOL_PROBE_POLICY,/read_candidate_bundle/);
  assert.match(PROTOCOL_PROBE_POLICY,/same response/i);assert.match(PROTOCOL_PROBE_POLICY,/receiptId/);
  assert.match(PROTOCOL_PROBE_POLICY,/not a proposal/i);
});

test('safe wire projection retains whole original call/result correspondence without source or credential text',()=>{
  const runId=randomUUID(),actor=identity(runId,'proposer'),requestId=randomUUID(),permitId=randomUUID();
  const args={runId,companyId:'C001',challengeId:'C001-CH1'},output={ok:true,runId,receiptId:randomUUID(),data:{challenge:{id:'C001-CH1',text:'SOURCE_BODY_MUST_NOT_BE_EMITTED'}}};
  const projected=projectProbeWireRequest(actor,{requestId,permitId},JSON.stringify({messages:[
    {role:'developer',content:'PRIVATE_SECRET_MUST_NOT_BE_EMITTED'},
    {role:'assistant',content:null,tool_calls:[{id:'actual_call',type:'function',function:{name:'read_company_challenge',arguments:JSON.stringify(args)}}]},
    {role:'tool',tool_call_id:'actual_call',content:JSON.stringify(output)}]}));
  assert.equal(projected.messages[0].calls[0].callId,'actual_call');assert.deepEqual(projected.messages[0].calls[0].arguments,args);
  assert.equal(projected.messages[1].receipt.receiptId,output.receiptId);assert.equal(projected.messages[1].outputSha256,hash(JSON.stringify(output)));
  assert.equal(JSON.stringify(projected).includes('MUST_NOT_BE_EMITTED'),false);
});

test('isolated synthetic packet requires all calls, actual receipts, same Context and post-result HTTP',()=>{
  const input=packet(),result=analyzeProtocolProbe(input);
  assert.equal(result.passed,true,JSON.stringify(result));assert.equal(result.multiCallBatchCount,2);
  assert.equal(result.requests.length,4);assert.equal(result.toolRoundTrips.length,4);assert.equal(result.modelReceiptUse.length,2);
  // The positive packet is a test specimen; it is not an observation of a provider.
  assert.equal(input.testFixture,'offline_fixture');
});

test('real gateway ordering stages supplier batch before completion acknowledgement, then native calls',()=>{
  const input=packet();
  for(const role of ['proposer','counter-evidence']){
    const stagedIndex=input.records.findIndex(r=>r.kind==='tool.batch'&&r.manifest.phase==='staged'&&r.manifest.actor.role===role);
    const endIndex=input.records.findIndex(r=>r.kind==='request'&&r.trace.type==='request.completed'&&r.trace.actor.role===role);
    const [staged]=input.records.splice(stagedIndex,1);input.records.splice(endIndex,0,staged);
  }
  assert.equal(analyzeProtocolProbe(input).passed,true,'toResponse.stage precedes release/trace completed in installed product adapter');
});

test('single-call success remains unverified and cannot unlock L05',()=>{
  const result=analyzeProtocolProbe(packet(1));assert.equal(result.passed,false);
  assert.equal(result.multiCallBatchCount,0);assert.ok(result.reasons.includes('SUPPLIER_MULTI_CALL_NOT_OBSERVED'));
});

for(const fault of ['missing_call','duplicate_call','wrong_order','cross_context','wrong_output_hash','forged_receipt','missing_wire_result','wrong_wire_order','answer_before_http','wrong_request_actor'])test(`offline protocol proof rejects ${fault}`,()=>{
  const input=packet();
  if(fault==='missing_call')input.records.splice(input.records.findIndex(r=>r.type==='function_call.completed'),1);
  if(fault==='duplicate_call'){const row=input.records.find(r=>r.type==='function_call.completed');input.records.push(structuredClone(row));}
  if(fault==='wrong_order'){
    const starts=input.records.filter(r=>r.type==='function_call.started');[starts[0].callId,starts[1].callId]=[starts[1].callId,starts[0].callId];
  }
  if(fault==='cross_context')input.records.find(r=>r.type==='inference.started').actor.contextId=randomUUID();
  if(fault==='wrong_output_hash')input.records.find(r=>r.type==='function_call.completed').outputSha256='0'.repeat(64);
  if(fault==='forged_receipt')input.records.find(r=>r.type==='model.answer').answer.receipts[0].receiptId=randomUUID();
  if(fault==='missing_wire_result')input.records.find(r=>r.kind==='wire.request'&&r.messages.length).messages.pop();
  if(fault==='wrong_wire_order'){const messages=input.records.find(r=>r.kind==='wire.request'&&r.messages.length).messages;messages.unshift(messages.pop());}
  if(fault==='answer_before_http'){
    const answerIndex=input.records.findIndex(r=>r.type==='model.answer'),wireIndex=input.records.findIndex(r=>r.kind==='wire.request'&&r.messages.length);
    const [answer]=input.records.splice(answerIndex,1);input.records.splice(wireIndex,0,answer);
  }
  if(fault==='wrong_request_actor')input.records.find(r=>r.kind==='request').trace.actor.runId=randomUUID();
  const result=analyzeProtocolProbe(input);assert.equal(result.passed,false,JSON.stringify(result));
});

for(const fault of ['request_failure','unclean','hold','permit_residual','budget','offline_mode'])test(`offline protocol proof stops on ${fault}`,()=>{
  const input=packet();
  if(fault==='request_failure')input.records.find(r=>r.kind==='request'&&r.trace.type==='request.completed').trace.type='request.failed';
  if(fault==='unclean')input.cleanups[0].confirmed=false;
  if(fault==='hold')input.safetyHold=true;
  if(fault==='permit_residual')input.permitSnapshot.inFlight=1;
  if(fault==='budget')input.permitSnapshot.runs[0].attempts=5;
  if(fault==='offline_mode')input.runnerMode='offline_fixture';
  assert.equal(analyzeProtocolProbe(input).passed,false);
});

test('genuine SDK Engine and gateway echo complete actual offline tool receipts through two native Contexts',async()=>{
  const records=[],events=[],runId=randomUUID(),controller=new AbortController(),permits=[];
  const tools=['read_company_challenge','read_candidate_bundle'].map(name=>({type:'function',name,description:'offline_fixture read-only source',strict:true,
    parameters:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false},
    invoke:async()=>({ok:true,runId,receiptId:randomUUID(),data:name==='read_company_challenge'?{challenge:{id:'C001-CH1'}}:{profile:{record:{id:'R0001'}}}})}));
  let http=0;const turns=new Map();
  const engine=createTaskEngine({runId,signal:controller.signal,model:'offline_fixture',tools,adapterProbe:true,adapterProbeInstruction:PROTOCOL_PROBE_POLICY,
    emit:e=>events.push(e),onToolBatch:manifest=>records.push({kind:'tool.batch',manifest}),onNative:(e,a)=>records.push(projectProtocolNative(e,a)),
    runnerFactory:hooks=>createProtocolProbeRunner({gateway:{baseURL:'https://offline.invalid/v1',apiKey:'offline-fixture-key',model:'offline_fixture'},
      hooks,permitClient:{acquire:async()=>{const id=randomUUID();permits.push(id);return{id};},release:()=>{}},
      record:r=>records.push(r),requestTimeoutMs:40000,
      fetchImpl:async(_url,init)=>{http++;const body=JSON.parse(init.body),user=JSON.parse(body.messages.find(m=>m.role==='user').content),role=user.role;
        const turn=(turns.get(role)??0)+1;turns.set(role,turn);
        if(turn===1){assert.ok(body.messages.find(m=>m.role==='system').content.includes(PROTOCOL_PROBE_POLICY));
          return new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:tools.map((t,i)=>({id:`${role}_${i}`,type:'function',function:{name:t.name,arguments:JSON.stringify({runId})}}))}}]}));}
        const outputs=body.messages.filter(m=>m.role==='tool').map(m=>({callId:m.tool_call_id,...JSON.parse(m.content)}));
        assert.equal(outputs.length,2);assert.equal(new Set(outputs.map(o=>o.receiptId)).size,2);
        const answer={runId,challengeId:'C001-CH1',researcherId:'R0001',receipts:outputs.map((o,i)=>({callId:o.callId,toolName:tools[i].name,receiptId:o.receiptId}))};
        return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(answer)}}]}));
      }})});
  try{const answers=await Promise.all([engine.startTask('proposer',{role:'proposer'}),engine.startTask('counter-evidence',{role:'counter-evidence'})]);
    assert.equal(http,4);assert.equal(permits.length,4);assert.equal(answers.length,2);
    assert.equal(records.filter(r=>r.type==='function_call.completed').length,4);
    assert.equal(records.filter(r=>r.kind==='wire.request'&&r.messages.some(m=>m.role==='tool')).length,2);
    assert.equal(new Set(records.filter(r=>r.type==='model.answer').map(r=>r.actor.contextId)).size,2);
    for(const answer of records.filter(r=>r.type==='model.answer')){
      assert.equal(typeof answer.answerText,'string','strict final JSON must be preserved verbatim, not reconstructed later');
      assert.equal(hash(answer.answerText),answer.answerSha256);assert.deepEqual(JSON.parse(answer.answerText),answer.answer);
      assert.equal(answer.answerText.includes('offline-fixture-key'),false);
      assert.deepEqual(Object.keys(JSON.parse(answer.answerText)).sort(),['challengeId','receipts','researcherId','runId']);
    }
  }finally{controller.abort();engine.dispose();}
});
