import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { analyzeProbe } from '../../scripts/verify-task6-live.mjs';

// Synthetic parser fixtures ONLY, never evidence of an actual network request or OS process.
function fixture() {
  const runId=randomUUID(),native=[],requests=[],events=[];let seq=0;
  for(const [n,role] of ['proposer','counter-evidence'].entries()){
    const actor={runId,role,agentId:randomUUID(),taskId:randomUUID(),contextId:randomUUID(),loopId:randomUUID(),attempt:1};
    const callId='synthetic_call_'+n,receiptId=randomUUID(),outputHash=String(n+1).repeat(64);
    native.push({type:'function_call.started',actor,callId,toolName:'read_company_challenge'},
      {type:'function_call.completed',actor,callId,outputHash,receipt:{ok:true,runId,receiptId,challengeId:'C001-CH1'}},
      {type:'context.tool_result',actor,callId,outputHash,receiptId},
      {type:'model.answer',actor,answer:{runId,receiptId,challengeId:'C001-CH1'}});
    for(let turn=0;turn<2;turn++){
      const requestId=randomUUID(),permitId=randomUUID(),start=turn*100+n*10;
      requests.push({type:'request.started',actor,requestId,permitId,monotonicMs:start},
        {type:'request.completed',actor,requestId,permitId,monotonicMs:start+50});
      events.push({seq:++seq,type:'permit.granted',payload:{requestId,permitId}},
        {seq:++seq,type:'model.request.started',...actor,payload:{requestId,permitId}});
    }
  }
  return {runId,challengeId:'C001-CH1',runnerMode:'live',record:{runId,runnerMode:'live',status:'insufficient',cleanupState:'confirmed'},
    cleanup:{runId,confirmed:true,exit:{exitObserved:true,closeObserved:true,exitCode:0}},diagnostic:{native,requests},events};
}
test('synthetic parser control accounts actual interval intersection and exact tool-result round trip',()=>{
  const r=analyzeProbe(fixture());assert.equal(r.valid,true);assert.equal(r.firstRequestOverlapMs,40);assert.equal(r.requests.length,4);assert.equal(r.toolRoundTrips.length,2);
});
test('parser cross-checks parent Run/runner label and actual successful exit rather than trusting a top-level live tag',()=>{
  for(const mutation of [x=>{x.record.runnerMode='offline_fixture';},x=>{x.record.runId=randomUUID();},
    x=>{x.cleanup.runId=randomUUID();},x=>{x.cleanup.exit.exitObserved=false;},x=>{x.cleanup.exit.exitCode=1;}]){
    const f=fixture();mutation(f);assert.equal(analyzeProbe(f).valid,false);
  }
});
test('parser rejects missing receipt, invented completion, zero overlap and fixture runner labels',()=>{
  for(const mutation of [x=>{x.diagnostic.native.find(e=>e.type==='model.answer').answer.receiptId=randomUUID();},
    x=>{x.diagnostic.requests=x.diagnostic.requests.filter(e=>e.type!=='request.completed');},
    x=>{for(const e of x.diagnostic.requests)if(e.actor.role==='counter-evidence')e.monotonicMs+=1000;},
    x=>{x.runnerMode='offline_fixture';},x=>{x.record.status='approved';},
    x=>{x.diagnostic.native.find(e=>e.type==='context.tool_result').outputHash='0'.repeat(64);},
    x=>{x.cleanup.confirmed=false;}]) {const f=fixture();mutation(f);assert.equal(analyzeProbe(f).valid,false);}
});
