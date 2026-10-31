import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FunctionCallItem, ModelMessageItem } from '@mozaik-ai/core';
import { createTaskEngine } from '../../dist/server/runtime/task-context.js';
import { isToolBatchBridge } from '../../dist/server/model/tool-batch.js';

// Offline controlled model responses, genuine production task engine/native SDK
// Contexts and tool invocations. No network, real Critic quality or publishing.
const turn=()=>new Promise(r=>setImmediate(r));
function fixture(controller=new AbortController()){
  const events=[],native=[],batches=[],invoked=[],perContext=new Map(),bridges=[];let bothResolve;
  const both=new Promise(r=>{bothResolve=r;}),entered=new Set();
  const tools=['one','two','three'].map((name,index)=>({type:'function',name:`read_${name}`,description:'offline_fixture read',strict:true,
    parameters:{type:'object',properties:{role:{type:'string'}},required:['role'],additionalProperties:false},
    invoke:async args=>{const receipt={fixture:'offline_fixture',role:args.role,index,receiptId:randomUUID()};invoked.push(receipt);return receipt;}}));
  const engine=createTaskEngine({runId:randomUUID(),signal:controller.signal,model:'offline_fixture',tools,emit:e=>events.push(e),
    onNative:(e,a)=>native.push({e,a}),onToolBatch:b=>batches.push(b),runnerFactory:hooks=>{
      assert.equal(isToolBatchBridge(hooks.toolBatchBridge),true,'production factory must receive the installed native batch capability');bridges.push(hooks.toolBatchBridge);
      return{async run(request){const actor=hooks.resolveTask(request.context.id);const n=(perContext.get(request.context.id)??0)+1;perContext.set(request.context.id,n);
        if(n===1){entered.add(actor.role);if(entered.size===2)bothResolve();await both;
          return{items:tools.map((tool,index)=>FunctionCallItem.rehydrate({callId:`original_${index}`,name:tool.name,args:JSON.stringify({role:actor.role})})),tokenUsage:undefined,rowResponse:null};}
        const outputs=request.context.getItems().filter(i=>i.type==='function_call_output').map(i=>JSON.parse(i.output.text));
        assert.deepEqual(outputs.map(o=>o.index),[0,1,2]);assert.ok(outputs.every(o=>o.role===actor.role));
        return{items:[ModelMessageItem.rehydrate({text:JSON.stringify({role:actor.role,receipts:outputs.map(o=>o.receiptId)})})],tokenUsage:undefined,rowResponse:null};
      },async *stream(){throw Error('OFFLINE_FIXTURE_NO_STREAM');}};
    }});
  return{engine,events,native,batches,invoked,perContext,bridges};
}
test('production task engine uses one shared native bridge for two concurrent Agents without dropping or crossing batches',async()=>{
  const x=fixture();try{
    const results=await Promise.all([x.engine.startTask('proposer',{fixture:'offline_fixture'}),x.engine.startTask('counter-evidence',{fixture:'offline_fixture'})]);
    assert.equal(x.bridges.length,1);assert.deepEqual(results.map(x=>x.role).sort(),['counter-evidence','proposer']);
    assert.equal(x.invoked.length,6);assert.equal(x.events.filter(e=>e.type==='function_call.started').length,6);
    assert.equal(x.events.filter(e=>e.type==='function_call.completed').length,6);assert.equal(x.events.filter(e=>e.type==='model.answer').length,2);
    assert.deepEqual([...x.perContext.values()],[2,2]);assert.equal(new Set(results.flatMap(r=>r.receipts)).size,6);
    for(const role of ['proposer','counter-evidence']){
      const own=x.events.filter(e=>e.role===role&&e.type==='function_call.started');assert.deepEqual(own.map(e=>e.payload.callId),['original_0','original_1','original_2']);
      assert.equal(new Set(own.map(e=>e.contextId)).size,1);
    }
    assert.equal(x.events.filter(e=>e.type==='tool.batch.updated'&&e.payload.phase==='staged').length,2);
    assert.equal(x.batches.filter(b=>b.phase==='completed').length,2);
  }finally{x.engine.dispose();}
});
test('production cancellation during genuine Tool.invoke cannot start a queued call or another model turn',async()=>{
  const controller=new AbortController();let enteredResolve,releaseTool;const entered=new Promise(r=>{enteredResolve=r;}),blocked=new Promise(r=>{releaseTool=r;});
  let turns=0,invocations=0;const batches=[];
  const tools=['first','second'].map(name=>({type:'function',name,description:'offline_fixture read',parameters:{type:'object'},strict:true,
    async invoke(){invocations++;enteredResolve();await blocked;return{fixture:'offline_fixture',receiptId:randomUUID()};}}));
  const engine=createTaskEngine({runId:randomUUID(),signal:controller.signal,model:'offline_fixture',tools,emit:()=>{},onToolBatch:b=>batches.push(b),
    runnerFactory:()=>({async run(){turns++;return{items:tools.map(t=>FunctionCallItem.rehydrate({callId:`c_${t.name}`,name:t.name,args:'{}'})),tokenUsage:undefined,rowResponse:null};},async *stream(){}})});
  try{const task=engine.startTask('proposer',{fixture:'offline_fixture'});task.catch(()=>{});let timer;
    try{await Promise.race([entered,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OFFLINE_FIXTURE_TOOL_NOT_ENTERED')),2000);})]);}finally{clearTimeout(timer);}
    controller.abort();await assert.rejects(task,/RUN_ABORTED/);
    releaseTool();await turn();await turn();assert.equal(invocations,1);assert.equal(turns,1);
    const cancelled=batches.find(b=>b.phase==='cancelled');assert.ok(cancelled);assert.equal(cancelled.calls[0].started,true);assert.equal(cancelled.calls[1].started,false);
    assert.ok(cancelled.calls.every(c=>!c.returned));
  }finally{releaseTool();engine.dispose();}
});
