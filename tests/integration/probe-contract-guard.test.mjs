import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createTaskEngine} from '../../dist/server/runtime/task-context.js';
import {createGatewayRunner} from '../../dist/server/model/gateway-runner.js';
import {ToolBatchError} from '../../dist/server/model/tool-batch.js';
import {PermitManager} from '../../dist/server/supervisor/permits.js';

// All responses use offline_fixture through the actual gateway, Runtime,
// Agent, Context, Tool.invoke and PermitManager. No actual network or store.
const evidence=[];
const names=['read_company_challenge','read_candidate_bundle'];
const tick=()=>new Promise(r=>setImmediate(r));
const response=message=>new Response(JSON.stringify({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message:{role:'assistant',...message}}]}),{status:200});
function fixture({guard,sequence,holdPermitRole,instruction}={}) {
  const expected={runId:randomUUID(),companyId:'C001',challengeId:'C001-CH1',researcherId:'R1008'};
  const external=new AbortController(),manager=new PermitManager();manager.registerRun(expected.runId,Date.now()+10000);
  const rows=[],invoked=[],turns=new Map(),contexts=new Map();let inspectCount=0;
  let resolveGrants;const bothGranted=new Promise(r=>{resolveGrants=r;}),held=[];
  const log=(kind,extra={})=>rows.push({kind,atMs:performance.now(),...extra});
  const tools=names.map(name=>({type:'function',name,description:'offline_fixture read-only receipt',strict:true,parameters:{type:'object'},
    async invoke(args){const receiptId=randomUUID();invoked.push({name,args,receiptId});log('tool.invoke',{name,args,receiptId});
      return {ok:true,runId:expected.runId,receiptId,data:name===names[0]?{challenge:{id:expected.challengeId}}:{profile:{record:{id:expected.researcherId}}}};}}));
  const calls=(order=names,patch={})=>order.map((name,i)=>({id:`call_${i}_${randomUUID().replaceAll('-','')}`,type:'function',function:{name,arguments:JSON.stringify({...(
    name===names[0]?{runId:expected.runId,companyId:expected.companyId,challengeId:expected.challengeId}:{runId:expected.runId,researcherId:expected.researcherId}),...patch})}}));
  const final=body=>({content:JSON.stringify({runId:expected.runId,challengeId:expected.challengeId,researcherId:expected.researcherId,
    receipts:body.messages.filter(m=>m.role==='tool').map(m=>{const output=JSON.parse(m.content),call=body.messages.flatMap(x=>x.tool_calls??[]).find(x=>x.id===m.tool_call_id);return{toolName:call.function.name,receiptId:output.receiptId};})})});
  const rawGuard=guard?.(expected,{credential:'offline_fixture_guard',maxCaptureBytes:8192});
  const inferenceGuard=rawGuard?{inspect(...args){inspectCount++;log('guard.inspect');return rawGuard.inspect(...args);}}:undefined;
  const scope=new AsyncLocalStorage();let engine;
  engine=createTaskEngine({runId:expected.runId,signal:external.signal,model:'offline_fixture',tools,adapterProbe:true,
    adapterProbeInstruction:instruction??'OFFLINE_FIXTURE single protocol diagnostic. Only exact assigned IDs and real receipts. No business task.',
    inferenceGuard,emit:event=>log('event',{event}),onToolBatch:manifest=>log('batch',{manifest}),
    runnerFactory:hooks=>{const gateway=createGatewayRunner({baseURL:'https://offline.invalid/v1',apiKey:'offline_fixture_guard',model:'offline_fixture',...hooks,
      fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body),actor=scope.getStore();assert.ok(actor);
        const n=(turns.get(actor.contextId)??0)+1;turns.set(actor.contextId,n);log('http.started',{actor,turn:n});
        const message=await sequence({body,actor,n,calls,final,expected,signal:init.signal,log,bothGranted});log('http.response',{actor,turn:n});return response(message);}},
      {async acquire(requestId,signal){const p=await manager.acquire(expected.runId,requestId);log('permit.granted',{requestId,permitId:p.id});
        if(rows.filter(r=>r.kind==='permit.granted').length===2)resolveGrants();
        if(scope.getStore()?.role===holdPermitRole)return await new Promise(r=>{held.push(()=>r(p));});return p;
      },release(permitId){manager.release(expected.runId,permitId);log('permit.released',{permitId});}},
      trace=>log('trace',{trace}));return{run:request=>scope.run(hooks.resolveTask(request.context.id),()=>gateway.run(request)),async *stream(){throw Error('OFFLINE_FIXTURE_NO_STREAM');}};},
    onNative:(event,actor)=>{if(event.type==='inference.started'){const context=event.payload.context;contexts.set(context.id,{actor,context});}log('native',{actor,type:event.type});}});
  return {expected,engine,external,manager,rows,invoked,turns,contexts,get inspectCount(){return inspectCount;},
    get contractDecisions(){return rawGuard?.decisions;},
    async run(roles=['proposer']){return Promise.allSettled(roles.map(role=>engine.startTask(role,expected)));},
    releaseHeldPermits(){for(const r of held.splice(0))r();},
    async close(name){for(const r of held.splice(0))r();await tick();await tick();const snapshot=manager.snapshot();evidence.push({fixture:'offline_fixture',name,runId:expected.runId,rows,invocations:invoked.length,snapshot});engine.dispose();external.abort();manager.dispose();}};
}
const denyWhen=predicate=>()=>({inspect(input,output,actor){if(predicate(output,actor))throw new ToolBatchError('PROBE_CONTRACT_TEST_REJECTED');}});

test('full-output trusted control boundary rejects first four calls before any native invocation',async()=>{
  const x=fixture({guard:denyWhen(o=>o.items.filter(i=>i.type==='function_call').length===4),sequence:({n,calls,final,body})=>n===1?{content:null,tool_calls:calls([...names,...names])}:final(body)});
  try{const out=await x.run();assert.equal(x.invoked.length,0);assert.equal(out[0].status,'rejected');assert.match(out[0].reason.message,/PROBE_CONTRACT_TEST_REJECTED/);
    assert.equal(x.turns.size,1);assert.deepEqual([...x.turns.values()],[1]);assert.equal(x.inspectCount,1);assert.equal(x.manager.snapshot().inFlight,0);
    assert.equal(x.rows.filter(r=>r.kind==='batch'&&r.manifest.phase==='staged').length,0);
  }finally{await x.close('first_four_control');}
});

test('trusted boundary rejects second tool batch in entirety after valid first native batch',async()=>{
  const counts=new Map();const x=fixture({guard:()=>({inspect(input,output,actor){const n=(counts.get(actor.contextId)??0)+1;counts.set(actor.contextId,n);if(n===2&&output.items.some(i=>i.type==='function_call'))throw new ToolBatchError('PROBE_CONTRACT_SECOND_RESPONSE_TOOLS');}}),
    sequence:({n,calls,final,body})=>n<3?{content:null,tool_calls:calls()}:final(body)});
  try{const out=await x.run();assert.equal(out[0].status,'rejected');assert.equal(x.invoked.length,2);assert.deepEqual([...x.turns.values()],[2]);assert.equal(x.inspectCount,2);assert.equal(x.manager.snapshot().inFlight,0);
  }finally{await x.close('second_tools_control');}
});

test('real concurrent SDK violation aborts an already issued sibling fetch and returns both permits',async()=>{
  let entered=0,ready;const both=new Promise(r=>{ready=r;});
  const x=fixture({guard:denyWhen(o=>o.items.filter(i=>i.type==='function_call').length===4),sequence:async({actor,n,calls,signal,log,body,final})=>{
    if(n>1)return final(body);entered++;if(entered===2)ready();await both;
    if(actor.role==='proposer')return{content:null,tool_calls:calls([...names,...names])};
    return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve({content:null,tool_calls:calls()}),500);
      signal.addEventListener('abort',()=>{clearTimeout(timer);log('sibling.fetch.aborted',{actor});reject(Error('OFFLINE_FIXTURE_ABORT'));},{once:true});});}});
  try{const out=await x.run(['proposer','counter-evidence']);await tick();assert.ok(out.every(r=>r.status==='rejected'));assert.equal(x.invoked.length,0);
    assert.equal(x.rows.filter(r=>r.kind==='http.started').length,2);assert.equal(x.rows.filter(r=>r.kind==='sibling.fetch.aborted').length,1);
    assert.equal(x.manager.snapshot().inFlight,0);assert.equal(x.manager.snapshot().runs[0].attempts,2);assert.equal(x.rows.filter(r=>r.kind==='permit.released').length,2);
  }finally{await x.close('concurrent_guard_control');}
});

test('production probe contract exact targets, both legal orders and strict real receipts use genuine SDK',async()=>{
  const {createProbeContractGuard,PROTOCOL_PROBE_V3_INSTRUCTION,protocolProbeV3Preview}=await import('../../dist/server/evaluation/probe-contract-guard.js');
  for(const order of [names,[...names].reverse()]){
    const x=fixture({guard:createProbeContractGuard,instruction:PROTOCOL_PROBE_V3_INSTRUCTION,sequence:({n,calls,body,final,expected})=>{
      const preview=protocolProbeV3Preview(expected);assert.deepEqual(body.messages.filter(m=>m.role==='system').map(m=>m.content),[preview.developerContext]);
      assert.deepEqual(JSON.parse(body.messages.find(m=>m.role==='user').content),preview.userTask);
      return n===1?{content:null,tool_calls:calls(order)}:final(body);}});
    try{const out=await x.run(['proposer','counter-evidence']);assert.ok(out.every(r=>r.status==='fulfilled'));assert.equal(x.invoked.length,4);
      for(const {context}of x.contexts.values())assert.deepEqual(context.getItems().filter(i=>i.role==='developer').map(i=>i.content.text),[PROTOCOL_PROBE_V3_INSTRUCTION]);
      assert.equal(x.inspectCount,4);assert.equal(x.manager.snapshot().inFlight,0);
    }finally{await x.close('valid_'+order[0]);}
  }
});

test('production double violation cancels Run with exact cause and counts only two already issued HTTPs',async()=>{
  const {createProbeContractGuard}=await import('../../dist/server/evaluation/probe-contract-guard.js');
  let entered=0,ready;const both=new Promise(r=>{ready=r;});const x=fixture({guard:createProbeContractGuard,sequence:async({calls})=>{if(++entered===2)ready();await both;return{content:null,tool_calls:calls([...names,...names])};}});
  try{const out=await x.run(['proposer','counter-evidence']);await tick();assert.ok(out.every(r=>r.status==='rejected'&&r.reason.message==='PROBE_CONTRACT_FIRST_BATCH_COUNT'));
    assert.equal(x.invoked.length,0);assert.equal(x.rows.filter(r=>r.kind==='http.started').length,2);assert.equal(x.manager.snapshot().runs[0].attempts,2);assert.equal(x.manager.snapshot().inFlight,0);
  }finally{await x.close('production_double_violation');}
});

test('guard cancellation releases an actually reserved late grant without issuing its fetch',async()=>{
  const {createProbeContractGuard}=await import('../../dist/server/evaluation/probe-contract-guard.js');const x=fixture({guard:createProbeContractGuard,holdPermitRole:'counter-evidence',
    sequence:async({calls,bothGranted})=>{await bothGranted;return{content:null,tool_calls:calls([...names,...names])};}});
  try{const out=await x.run(['proposer','counter-evidence']);assert.ok(out.every(r=>r.status==='rejected'));x.releaseHeldPermits();await tick();await tick();
    assert.equal(x.invoked.length,0);assert.equal(x.rows.filter(r=>r.kind==='http.started').length,1);assert.equal(x.manager.snapshot().runs[0].attempts,2);
    assert.equal(x.rows.filter(r=>r.kind==='permit.released').length,2);assert.equal(x.manager.snapshot().inFlight,0);
  }finally{await x.close('late_reserved_grant');}
});

test('async guard rejection is observed and cannot escape as unhandled or execute native tools',async()=>{
  const x=fixture({guard:()=>({async inspect(){throw Error('OFFLINE_FIXTURE_GUARD_REJECT');}}),sequence:({calls})=>({content:null,tool_calls:calls()})});
  try{const out=await x.run();assert.equal(out[0].status,'rejected');assert.equal(out[0].reason.message,'TOOL_BATCH_ASYNC_GUARD_FORBIDDEN');assert.equal(x.invoked.length,0);await tick();
  }finally{await x.close('async_guard_config_rejected');}
});

for(const [name,text]of [['malformed_json','{'],['schema_failure','{"extra":"safe failed answer"}'],['over_byte_limit','x'.repeat(9000)]])test(`pre-native ${name} retains safe failure capture and exact request attribution`,async()=>{
  const {createProbeContractGuard}=await import('../../dist/server/evaluation/probe-contract-guard.js');const x=fixture({guard:createProbeContractGuard,
    sequence:({n,calls})=>n===1?{content:null,tool_calls:calls()}:{content:text}});
  try{const out=await x.run();assert.equal(out[0].status,'rejected');const d=x.contractDecisions.find(d=>d.status==='rejected');assert.ok(d);
    assert.equal(d.capture.sha256,createHash('sha256').update(text).digest('hex'));assert.equal(d.capture.byteLength,Buffer.byteLength(text));
    assert.equal(d.capture.truncated,text.length>8192);assert.equal(d.capture.text,text.slice(0,8192));
    const last=x.rows.filter(r=>r.kind==='trace'&&r.trace.type==='request.started').at(-1).trace;
    assert.equal(d.request.requestId,last.requestId);assert.equal(d.request.permitId,last.permitId);assert.deepEqual(d.actor,last.actor);
    assert.equal(x.rows.filter(r=>r.kind==='native'&&r.type==='model.answer').length,0);
  }finally{await x.close(name+'_capture');}
});

test('pre-native identity rejection does not retain final body as an authenticated answer',async()=>{
  const {createProbeContractGuard}=await import('../../dist/server/evaluation/probe-contract-guard.js');const x=fixture({
    guard:(e,o)=>createProbeContractGuard({...e,runId:randomUUID()},o),sequence:()=>({content:'UNCONFIRMED_ANSWER_BODY'})});
  try{const out=await x.run();assert.equal(out[0].status,'rejected');const d=x.contractDecisions.find(r=>r.status==='rejected');assert.equal(d.code,'PROBE_CONTRACT_IDENTITY_INVALID');
    assert.equal(d.capture,undefined);assert.equal(JSON.stringify(x.contractDecisions).includes('UNCONFIRMED_ANSWER_BODY'),false);
  }finally{await x.close('identity_no_capture');}
});

for(const [name,edit] of Object.entries({wrongRun:c=>{const a=JSON.parse(c[0].function.arguments);a.runId=randomUUID();c[0].function.arguments=JSON.stringify(a);},
  wrongCandidate:c=>{c[1].function.arguments=JSON.stringify({runId:JSON.parse(c[1].function.arguments).runId,researcherId:'R0001'});},
  missingId:c=>{c[0].function.arguments='{}';},duplicateTool:c=>{c[1].function.name=c[0].function.name;c[1].function.arguments=c[0].function.arguments;},
  missingTool:c=>{c.pop();},extraCalls:c=>{c.push(...c.map((x,i)=>({...x,id:'extra_'+i})));}}))test(`production whole-batch reject ${name} executes zero tools`,async()=>{
    const {createProbeContractGuard}=await import('../../dist/server/evaluation/probe-contract-guard.js');const x=fixture({guard:createProbeContractGuard,
      sequence:({n,calls,body,final})=>{if(n>1)return final(body);const c=calls();edit(c);return{content:null,tool_calls:c};}});
    try{const out=await x.run();assert.equal(out[0].status,'rejected');assert.match(out[0].reason.message,/^PROBE_CONTRACT_/);assert.equal(x.invoked.length,0);assert.deepEqual([...x.turns.values()],[1]);assert.equal(x.manager.snapshot().inFlight,0);
    }finally{await x.close(name);}
  });

for(const attack of ['second_tools','forged_receipt','wrong_order','wrong_context','extra_schema'])test(`production contract rejects ${attack} without another tool or HTTP`,async()=>{
  const {createProbeContractGuard}=await import('../../dist/server/evaluation/probe-contract-guard.js');const x=fixture({guard:createProbeContractGuard,sequence:({n,calls,body,final})=>{
    if(n===1)return{content:null,tool_calls:calls()};if(attack==='second_tools')return{content:null,tool_calls:calls()};
    const m=final(body),a=JSON.parse(m.content);if(attack==='forged_receipt')a.receipts[0].receiptId=randomUUID();if(attack==='wrong_order')a.receipts.reverse();
    if(attack==='wrong_context')a.runId=randomUUID();if(attack==='extra_schema')a.approved=true;return{content:JSON.stringify(a)};}});
  try{const out=await x.run();assert.equal(out[0].status,'rejected');assert.match(out[0].reason.message,/^PROBE_CONTRACT_/);assert.equal(x.invoked.length,2);assert.deepEqual([...x.turns.values()],[2]);assert.equal(x.manager.snapshot().inFlight,0);
  }finally{await x.close(attack);}
});

test.after(async()=>{const file=`docs/implementation/task-7u-guard-evidence-${Date.now()}-${randomUUID()}.json`;await writeFile(file,JSON.stringify({runnerMode:'offline_fixture',liveRequests:0,cases:evidence},null,2)+'\n',{flag:'wx'});console.log(file);});
