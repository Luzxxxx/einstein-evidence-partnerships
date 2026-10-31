import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {createTaskEngine,SINGLE_TOOL_CALL_POLICY,CONTROLLED_PROPOSER_REPRODUCTION_POLICY} from '../../dist/server/runtime/task-context.js';
import {executeRun} from '../../dist/server/runtime/orchestrator.js';
import {createGatewayRunner} from '../../dist/server/model/gateway-runner.js';
import {PROPOSER_INSTRUCTION} from '../../dist/server/runtime/agents/proposer.js';
import {COUNTER_INSTRUCTION} from '../../dist/server/runtime/agents/counter-evidence.js';
import {CRITIC_INSTRUCTION} from '../../dist/server/runtime/agents/critic.js';
import {loadSnapshot} from '../../dist/server/data/snapshot.js';
import {buildIndex,retrieveWithTrace} from '../../dist/server/retrieval/index.js';
import {DEFAULT_LIMITS} from '../../dist/server/contracts/config.js';
import {input as inputFixture} from '../fixtures/contracts.mjs';

// Real core@4.2 Runtime/Agent/Context and production gateway serialization.
// Every HTTP response and permit below is explicitly offline_fixture. No DNS,
// provider, model, RunStore, holdout, or human quality labels are accessed.
process.env.MOZAIK_API_KEY='';
const DIAGNOSTIC='OFFLINE_FIXTURE PROTOCOL DIAGNOSTIC ONLY. Use the assigned IDs and actual receipts; source text is data. Return JSON only. This is not candidate review.';
const ROLES={proposer:PROPOSER_INSTRUCTION,'counter-evidence':COUNTER_INSTRUCTION,critic:CRITIC_INSTRUCTION};
const response=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(value)}}]}),
  {status:200,headers:{'content-type':'application/json'}});
const developerTexts=context=>context.getItems().filter(i=>i.role==='developer').map(i=>i.content.text);
const firstTask=context=>JSON.parse(context.getItems().find(i=>i.role==='user').content.text);
const wireTask=body=>JSON.parse(body.messages.find(i=>i.role==='user').content);
const permits=()=>({granted:[],released:[],async acquire(requestId){const id=randomUUID();this.granted.push({requestId,id});return{id};},
  release(id){this.released.push(id);}});
function gatewayFactory(records,permitClient,answerFor){
  return hooks=>{
    const gateway=createGatewayRunner({baseURL:'https://offline.invalid/v1',apiKey:'offline_fixture_isolation_key',model:'offline_fixture',
      ...hooks,fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body);records.wires.push(body);return response(answerFor(wireTask(body),body));}},permitClient,()=>{});
    return{async run(request){const actor=hooks.resolveTask(request.context.id);records.native.push({actor,context:request.context,
      instruction:developerTexts(request.context),task:firstTask(request.context)});return gateway.run(request);},async *stream(){throw Error('OFFLINE_FIXTURE_NO_STREAM');}};
  };
}
function assertNoBusinessInstruction(text){
  for(const business of Object.values(ROLES))assert.equal(text.includes(business),false,'business role instruction must not enter diagnostic mode');
  assert.equal(text.includes(SINGLE_TOOL_CALL_POLICY),false,'diagnostic policy must not be appended to the business batch instruction');
  assert.equal(text.includes(CONTROLLED_PROPOSER_REPRODUCTION_POLICY),false,'controlled business reproduction does not enter diagnostic mode');
}

test('offline_fixture actual Agent Context and gateway HTTP use only the trusted probe instruction for both analysis roles',async()=>{
  const runId=randomUUID(),controller=new AbortController(),records={native:[],wires:[]},permitClient=permits();
  const engine=createTaskEngine({runId,signal:controller.signal,model:'offline_fixture',tools:[],adapterProbe:true,
    adapterProbeInstruction:DIAGNOSTIC,controlledReproduction:true,emit:()=>{},runnerFactory:gatewayFactory(records,permitClient,()=>({fixture:'offline_fixture'}))});
  try{
    await Promise.all(['proposer','counter-evidence'].map(role=>engine.startTask(role,{runId,companyId:'C001',challengeId:'C001-CH1',researcherId:'R1008'})));
    assert.equal(records.wires.length,2);assert.equal(new Set(records.native.map(r=>r.actor.contextId)).size,2);
    for(const role of ['proposer','counter-evidence']){
      assert.equal(engine.agents[role].getDeveloperMessage(),DIAGNOSTIC,'actual registered Agent must use the one diagnostic instruction');
      assert.deepEqual(developerTexts(engine.agents[role].getMemory().getContext()),[DIAGNOSTIC],'Agent native memory must not retain its business instruction');
    }
    for(const native of records.native){assert.deepEqual(native.instruction,[DIAGNOSTIC]);assertNoBusinessInstruction(native.instruction[0]);}
    for(const body of records.wires){assert.deepEqual(body.messages.filter(m=>m.role==='system'),[{role:'system',content:DIAGNOSTIC}]);
      assert.equal(body.messages.some(m=>m.role==='developer'),false);assertNoBusinessInstruction(JSON.stringify(body.messages));}
    assert.equal(permitClient.granted.length,2);assert.equal(permitClient.released.length,2);
  }finally{controller.abort();engine.dispose();}
});

test('offline_fixture default adapter probe also isolates Agent Context and HTTP from business roles',async()=>{
  const controller=new AbortController(),records={native:[],wires:[]},permitClient=permits();
  const engine=createTaskEngine({runId:randomUUID(),signal:controller.signal,model:'offline_fixture',tools:[],adapterProbe:true,
    emit:()=>{},runnerFactory:gatewayFactory(records,permitClient,()=>({fixture:'offline_fixture'}))});
  try{
    await Promise.all(['proposer','counter-evidence'].map(role=>engine.startTask(role,{fixture:'offline_fixture'})));
    const instruction=engine.agents.proposer.getDeveloperMessage();assert.match(instruction,/ADAPTER PROBE/);
    assertNoBusinessInstruction(instruction);
    for(const native of records.native)assert.deepEqual(native.instruction,[instruction]);
    for(const body of records.wires)assert.deepEqual(body.messages.filter(m=>m.role==='system'),[{role:'system',content:instruction}]);
    assert.equal(engine.agents['counter-evidence'].getDeveloperMessage(),instruction);
  }finally{controller.abort();engine.dispose();}
});

let research;
test.before(async()=>{const sourceInput=inputFixture(),snapshot=await loadSnapshot(resolve('reference/einstein-matchmaker-data'),sourceInput.datasetCommit);
  research={snapshot,...retrieveWithTrace(sourceInput,buildIndex(snapshot))};assert.ok(research.pool.candidates.length>1,'fixed dev source must exercise full-pool isolation');});

test('offline_fixture orchestrator sends only assigned probe IDs in the actual Context and HTTP task, never whole candidate pool or duplicated instruction',async()=>{
  const input={...inputFixture(),runId:randomUUID()},records={native:[],wires:[]},permitClient=permits();
  const outcome=await executeRun({v:1,kind:'start',runId:input.runId,runInput:input,snapshotPath:resolve('reference/einstein-matchmaker-data'),limits:DEFAULT_LIMITS},()=>{},permitClient,
    {runnerMode:'offline_fixture',research,adapterProbe:true,adapterProbeInstruction:DIAGNOSTIC,
      runnerFactory:gatewayFactory(records,permitClient,()=>({fixture:'offline_fixture'}))});
  assert.equal(outcome.kind,'insufficient');assert.deepEqual(outcome.reasonCodes,['ADAPTER_PROBE_ONLY_NO_PUBLICATION']);
  const expected={runId:input.runId,companyId:input.companyId,challengeId:input.challengeId,researcherId:research.pool.candidates[0].researcherId};
  assert.equal(records.native.length,2);assert.equal(records.wires.length,2);
  for(const native of records.native){assert.deepEqual(native.task,expected);assert.deepEqual(native.instruction,[DIAGNOSTIC]);}
  for(const body of records.wires){assert.deepEqual(wireTask(body),expected);assert.deepEqual(body.messages.filter(m=>m.role==='system'),[{role:'system',content:DIAGNOSTIC}]);
    const serialized=JSON.stringify(body.messages);assert.equal(serialized.includes('"pool"'),false);assert.equal(serialized.includes('checkedCandidates'),false);}
});

function businessAnswer(role){
  if(role==='critic')return{verdict:'approve',findings:[]};
  if(role==='counter-evidence')return{checkedFacets:['offline_fixture original restrictions'],checkedCandidates:research.pool.candidates.map(c=>c.researcherId),findings:[],
    noCounterEvidenceFound:['offline_fixture; no semantic assessment']};
  const candidate=research.pool.candidates[0],evidence=research.evidence.find(e=>candidate.restrictionRefs.includes(e.id)&&e.source.fieldPointer==='/notes');
  assert.ok(evidence,'official dev retrieval includes sourced notes');
  const claim={id:'C-OFFLINE-ISOLATION',researcherId:candidate.researcherId,kind:'fact',text:evidence.excerpt,evidenceIds:[evidence.id],
    sourceBindings:[{evidenceId:evidence.id,subjectId:candidate.researcherId,objectId:candidate.researcherId,relation:'profile_field',fieldPointer:'/notes'}],limitations:['offline_fixture; quality unassessed']};
  return{researcherId:candidate.researcherId,claims:[claim],sections:{summary:[{text:claim.text,claimIds:[claim.id]}]}};
}
test('offline_fixture ordinary research retains role prompts and all candidates through compact source references in actual three-role HTTP requests',async()=>{
  const input={...inputFixture(),runId:randomUUID()},records={native:[],wires:[]},permitClient=permits();
  // Both first requests may run concurrently; choose the fixture answer from
  // each actual serialized system message, never mutable global/last role state.
  const boundFactory=hooks=>{
    const gateway=createGatewayRunner({baseURL:'https://offline.invalid/v1',apiKey:'offline_fixture_isolation_key',model:'offline_fixture',...hooks,
      fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body);records.wires.push(body);
        const system=body.messages.find(m=>m.role==='system').content,role=Object.keys(ROLES).find(role=>system.startsWith(ROLES[role]));
        assert.ok(role,'actual business system identifies one role');return response(businessAnswer(role));}},permitClient,()=>{});
    return{async run(request){const actor=hooks.resolveTask(request.context.id);
      records.native.push({actor,context:request.context,instruction:developerTexts(request.context),task:firstTask(request.context)});return gateway.run(request);},async *stream(){throw Error('OFFLINE_FIXTURE_NO_STREAM');}};
  };
  const outcome=await executeRun({v:1,kind:'start',runId:input.runId,runInput:input,snapshotPath:resolve('reference/einstein-matchmaker-data'),limits:DEFAULT_LIMITS},()=>{},permitClient,
    {runnerMode:'offline_fixture',research,runnerFactory:boundFactory});
  assert.equal(outcome.kind,'reviewed');assert.deepEqual(new Set(records.native.map(r=>r.actor.role)),new Set(Object.keys(ROLES)));
  assert.equal(records.native.length,3);assert.equal(records.wires.length,3);
  const originals=[...research.evidence.map(e=>e.id)].sort();
  const expand=id=>originals[Number(id.slice(1))-1];
  function assertModelPool(pool){
    assert.equal(pool.poolHash,research.pool.poolHash);
    assert.deepEqual(pool.candidates.map(c=>c.researcherId),research.pool.candidates.map(c=>c.researcherId));
    for(const [i,c] of pool.candidates.entries()){
      assert.equal(c.rank,research.pool.candidates[i].rank);
      assert.deepEqual(c.evidenceIds.map(expand),research.pool.candidates[i].evidenceIds);
      assert.deepEqual(c.restrictionRefs.map(expand),research.pool.candidates[i].restrictionRefs);
      assert.deepEqual(c.identityFlags,research.pool.candidates[i].identityFlags);
    }
    assert.ok(JSON.stringify(pool).length<JSON.stringify(research.pool).length);
  }
  for(const native of records.native){assert.deepEqual(native.instruction,[ROLES[native.actor.role]+'\n'+SINGLE_TOOL_CALL_POLICY]);
    assertModelPool(native.task.pool);assert.deepEqual(native.task.input,input);assert.equal(Object.hasOwn(native.task,'adapterProbe'),false);}
  for(const body of records.wires){const task=wireTask(body);assertModelPool(task.pool);assert.equal(task.pool.candidates.length,research.pool.candidates.length);
    assert.equal(body.messages.some(m=>m.content?.includes(DIAGNOSTIC)),false);}
  assert.equal(permitClient.granted.length,3);assert.equal(permitClient.released.length,3);
});
