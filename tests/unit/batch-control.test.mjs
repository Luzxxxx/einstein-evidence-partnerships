import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ModelContext, UserMessageItem } from '@mozaik-ai/core';
import { runFailStopBatch, batchStopReason } from '../../dist/server/evaluation/batch-control.js';
import { runCriticEvaluation } from '../../dist/server/evaluation/run-critic-eval.js';
import { createGatewayRunner } from '../../dist/server/model/gateway-runner.js';

const plan=()=>[1,2,3].map(repetition=>({runId:randomUUID(),variantId:'OFFLINE_FIXTURE',repetition}));
for(const code of ['GATEWAY_MULTIPLE_TOOL_CALLS','GATEWAY_TOOL_BATCH_LIMIT','GATEWAY_TASK_IDENTITY_INVALID',
  'NATIVE_CONTEXT_MISMATCH','NATIVE_PRODUCER_MISMATCH','TOOL_BATCH_CONTEXT_MISMATCH','INVALID_RUNTIME_RECEIPT']){
  test(`offline_fixture batch ${code} stops all following callbacks and keeps their original IDs unexecuted`,async()=>{
    const planned=plan();let requests=0;
    const result=await runFailStopBatch(planned,async item=>{requests++;return {...item,status:'failed',reasonCodes:[code]};});
    assert.equal(requests,1);assert.ok(result.stopReason);
    assert.deepEqual(result.rows.map(r=>r.runId),planned.map(r=>r.runId));
    assert.deepEqual(result.rows.map(r=>r.status),['failed','unexecuted','unexecuted']);
    assert.equal(result.rows[0].reasonCodes[0],code);
  });
}
test('offline_fixture actual gateway protocol failure sends only one controlled fetch for the entire batch',async()=>{
  const planned=plan();let fetches=0,grants=0;
  const result=await runFailStopBatch(planned,async item=>{
    const context=ModelContext.create().addContextItem(UserMessageItem.create('offline_fixture'));
    const actor={runId:item.runId,agentId:randomUUID(),role:'proposer',loopId:randomUUID(),taskId:randomUUID(),contextId:context.id,attempt:1};
    const runner=createGatewayRunner({baseURL:'https://offline-fixture.invalid/v1',apiKey:'offline-fixture-only',model:'offline_fixture',
      signal:new AbortController().signal,resolveTask:()=>actor,fetchImpl:async()=>{fetches++;return new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,
        tool_calls:['a','b'].map(id=>({id,type:'function',function:{name:'read_fixture',arguments:'{}'}}))}}]}));}},
      {acquire:async()=>{grants++;return{id:randomUUID()};},release:()=>{}},()=>{});
    let failure;try{await runner.run({model:'offline_fixture',context,tools:[{type:'function',name:'read_fixture',description:'offline_fixture',parameters:{type:'object'},strict:true,invoke:async()=>({ok:true})}],streaming:false});}
    catch(error){failure=error.code;}
    return {...item,status:'failed',reasonCodes:[failure]};
  });
  assert.equal(fetches,1);assert.equal(grants,1);assert.equal(result.rows.filter(r=>r.status==='unexecuted').length,2);
});
test('offline_fixture safety hold stops future requests even after a semantically insufficient result',async()=>{
  let calls=0;const rows=await runFailStopBatch(plan(),async item=>{calls++;return{...item,status:'insufficient',reasonCodes:['NO_SUPPORT'],safetyHold:true};});
  assert.equal(calls,1);assert.match(rows.stopReason,/SAFETY_HOLD/);
});
test('valid semantic insufficient is preserved and does not masquerade as a technical fault',async()=>{
  const rows=await runFailStopBatch(plan(),async item=>({...item,status:'insufficient',reasonCodes:['NO_SEMANTIC_SUPPORT']}));
  assert.equal(rows.rows.length,3);assert.ok(rows.rows.every(r=>r.status==='insufficient'));assert.equal(rows.stopReason,null);
});
test('unexpected callback error and cross-Run callback result fail closed without generating replacement IDs',async()=>{
  for(const mode of ['throw','wrong_run']){let calls=0;const planned=plan();const rows=await runFailStopBatch(planned,async item=>{
    calls++;if(mode==='throw')throw Error('private untrusted error text');return{...item,runId:randomUUID(),status:'approved',reasonCodes:[]};});
    assert.equal(calls,1);assert.equal(rows.rows[0].runId,planned[0].runId);assert.equal(rows.rows[0].status,'failed');
    assert.equal(JSON.stringify(rows).includes('private untrusted error text'),false);}
});
test('duplicate planned IDs are rejected before any callback',async()=>{
  const p=plan();p[1].runId=p[0].runId;let calls=0;await assert.rejects(runFailStopBatch(p,async()=>{calls++;return{};}),/DUPLICATE/);assert.equal(calls,0);
});
test('failure diagnostics and raw request codes trigger the exact shared batch stop rule',()=>{
  assert.ok(batchStopReason({status:'failed',reasonCodes:['WORKER_FAILED'],requests:{intervals:[{code:'GATEWAY_MULTIPLE_TOOL_CALLS'}]}}));
  assert.ok(batchStopReason({status:'failed',reasonCodes:['WORKER_FAILED'],events:[{type:'task.failed',payload:{code:'NATIVE_CONTEXT_MISMATCH'}}]}));
});
test('legacy live matrix stays locked before environment lookup, store creation, worker launch or fetch',async()=>{
  let fetches=0;const original=globalThis.fetch;globalThis.fetch=async()=>{fetches++;throw Error('NETWORK_MUST_NOT_RUN');};
  try{await assert.rejects(runCriticEvaluation(['--suite','core','--repeats','3']),/BATCH_LOCKED_PENDING_PROTOCOL_AND_L05_ACCEPTANCE/);}
  finally{globalThis.fetch=original;}assert.equal(fetches,0);
});
