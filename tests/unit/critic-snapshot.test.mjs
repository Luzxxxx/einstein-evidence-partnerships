import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ModelMessageItem } from '@mozaik-ai/core';
import { buildReviewSnapshot, ArtifactCoordinator, executeRun } from '../../dist/server/runtime/orchestrator.js';
import { loadSnapshot } from '../../dist/server/data/snapshot.js';
import { resolveEvidence } from '../../dist/server/evidence/store.js';
import { hashArtifact, hashCandidatePool, hashEvidenceSnapshot, hashRunInput, hashSourceRecord } from '../../dist/server/evidence/hashing.js';
import { DEFAULT_LIMITS } from '../../dist/server/contracts/config.js';
import { input as inputFixture, pool as poolFixture } from '../fixtures/contracts.mjs';

// Actual fixed C001 source records, with an explicitly controlled offline_fixture
// proposal body. No retrieval labels, holdout input, API or model-quality gold.
const input = {...inputFixture(), mode:'adversarial'};
const snapshot = await loadSnapshot(resolve('reference/einstein-matchmaker-data'), input.datasetCommit);
function evidence(kind,id,fieldPointer,range) {
  const row=snapshot.getRecord(kind,id);
  return resolveEvidence({file:row.file,recordId:id,locator:row.locator,fieldPointer,
    derivedRecordId:row.derivedRecordId,...(range?{codePointRange:range}:{})},snapshot);
}
const notes=evidence('researcher','R1008','/notes',[0,30]);
const abstract=evidence('publication','SYN-PUB-00492','/abstract',[0,40]);
const authors=evidence('publication','SYN-PUB-00492','/authors');
const evidenceList=[notes,abstract,authors];
const pool=poolFixture();pool.candidates[0].evidenceIds=evidenceList.map(e=>e.id);
pool.candidates[0].restrictionRefs=[notes.id];pool.candidates[0].matchedFields[0].sourceRef=abstract.source;
pool.poolHash=hashCandidatePool(pool);
const research={snapshot,pool,evidence:evidenceList};
const claim={id:'C-NOTES',researcherId:'R1008',kind:'fact',text:notes.excerpt,evidenceIds:[notes.id],
  sourceBindings:[{evidenceId:notes.id,subjectId:'R1008',objectId:'R1008',relation:'profile_field',fieldPointer:'/notes'}],limitations:['offline_fixture; semantic support unassessed']};
const proposerBody={researcherId:'R1008',claims:[claim],sections:{summary:[{text:claim.text,claimIds:[claim.id]}]}};
const counterBody={checkedFacets:['notes and explicit identity'],checkedCandidates:['R1008'],findings:[],
  noCounterEvidenceFound:['offline_fixture, not a semantic observation']};
function actor(runId,role,attempt=1,agentId=randomUUID()) {return {runId,role,attempt,agentId,taskId:randomUUID(),contextId:randomUUID(),loopId:randomUUID()};}
function products(runInput=input) {
  const coordinator=new ArtifactCoordinator({...research,input:runInput});
  const p=actor(runInput.runId,'proposer'),c=actor(runInput.runId,'counter-evidence');
  coordinator.bind(p);coordinator.accept('proposer',proposerBody,p);
  coordinator.bind(c);coordinator.accept('counter-evidence',counterBody,c);
  return {coordinator,p,c,draft:coordinator.draft,counter:coordinator.counter};
}
function snapshotOf(productsValue=products(),override={}) {
  return buildReviewSnapshot({input,...research,draft:productsValue.draft,counter:productsValue.counter,...override});
}

test('Critic snapshot loads complete originals, precise dispatch target and immutable manifest, not only excerpts',()=>{
  const productsValue=products(),review=snapshotOf(productsValue);
  assert.deepEqual(review.draft,productsValue.draft);assert.deepEqual(review.counter,productsValue.counter);
  assert.deepEqual(review.evidence,evidenceList);
  assert.deepEqual(review.target,{inputHash:hashRunInput(input),poolVersion:pool.poolVersion,poolHash:pool.poolHash,
    counterReportHash:productsValue.counter.hash,draftVersion:1,draftHash:productsValue.draft.draftHash,evidenceSnapshotHash:hashEvidenceSnapshot(evidenceList)});
  const fullNotes=review.sources.find(s=>s.source.recordId==='R1008'&&s.source.fieldPointer==='/notes');
  assert.equal(fullNotes.value,snapshot.getRecord('researcher','R1008').record.notes);
  assert.ok(fullNotes.value.length>notes.excerpt.length);assert.equal(fullNotes.source.codePointRange,undefined);
  const fullAbstract=review.sources.find(s=>s.source.recordId==='SYN-PUB-00492'&&s.source.fieldPointer==='/abstract');
  assert.equal(fullAbstract.value,snapshot.getRecord('publication','SYN-PUB-00492').record.abstract);
  const fullAuthors=review.sources.find(s=>s.source.recordId==='SYN-PUB-00492'&&s.source.fieldPointer==='/authors');
  assert.deepEqual(fullAuthors.value,snapshot.getRecord('publication','SYN-PUB-00492').record.authors);
  assert.ok(review.sources.some(s=>s.source.recordId==='C001'&&s.source.fieldPointer==='/challenges/0'));
  assert.ok(review.sources.some(s=>s.source.recordId==='R1008'&&s.source.fieldPointer==='/open_to'));
  assert.equal(review.loadedFields.length,review.sources.length);
  for(const entry of review.loadedFields){
    const source=review.sources.find(s=>JSON.stringify(s.source)===JSON.stringify(entry.source));
    assert.ok(source);assert.equal(entry.fieldHash,hashSourceRecord(source.value));
    assert.equal(entry.recordSha256,snapshot.locateRecord(entry.source).recordSha256);
    assert.equal(entry.sourceFileSha256,snapshot.files.find(f=>f.file===entry.source.file).sourceFileSha256);
    assert.equal(Object.hasOwn(entry,'value'),false,'manifest records loaded content hash, not a second text copy');
  }
  assert.ok(Object.isFrozen(review)&&Object.isFrozen(review.sources)&&Object.isFrozen(review.sources[0]));
  assert.throws(()=>{review.sources[0].value='overwrite';},TypeError);
  assert.equal(review.checks.semanticSupport,'unassessed');
});

test('Critic snapshot validates hashes, source bindings, complete Counter coverage and exact Run before dispatch',()=>{
  const value=products();
  assert.throws(()=>snapshotOf(value,{draft:{...value.draft,draftHash:'0'.repeat(64)}}),/REVIEW_DRAFT_HASH_FAILED/);
  assert.throws(()=>snapshotOf(value,{counter:{...value.counter,hash:'0'.repeat(64)}}),/REVIEW_COUNTER_HASH_FAILED/);
  assert.throws(()=>snapshotOf(value,{draft:{...value.draft,runId:randomUUID()}}),/REVIEW_RUN_BINDING_FAILED/);
  const incomplete={...value.counter,checkedCandidates:['R0001']};incomplete.hash=hashArtifact(incomplete);
  assert.throws(()=>snapshotOf(value,{counter:incomplete}),/COUNTER_COVERAGE_FAILED/);
  const wrong=structuredClone(value.draft);wrong.claims[0].sourceBindings[0].fieldPointer='/bio';wrong.draftHash=hashArtifact(wrong);
  assert.throws(()=>snapshotOf(value,{draft:wrong}),/CLAIM_SOURCE_BINDING_FAILED/);
});

test('dispatch receipt binds real Critic identity and captured snapshot before inference and acceptance',async()=>{
  const runInput={...input,runId:randomUUID()},dispatches=[],completions=[],contexts=[];let nativeCriticStarted=false;
  const result=await executeRun({v:1,kind:'start',runId:runInput.runId,runInput,snapshotPath:resolve('reference/einstein-matchmaker-data'),limits:DEFAULT_LIMITS},()=>{},
    {acquire:async()=>{throw Error('OFFLINE_NO_NETWORK');},release(){}},
    {runnerMode:'offline_fixture',research,onReviewDispatch:value=>dispatches.push(value),onReviewResult:value=>completions.push(value),
      runnerFactory:hooks=>({async run(request){const owner=hooks.resolveTask(request.context.id);contexts.push(request.context);
        if(owner.role==='critic'){
          nativeCriticStarted=true;assert.equal(dispatches.length,1);const dispatch=dispatches[0];
          assert.equal(dispatch.actor.contextId,request.context.id);assert.equal(dispatch.actor.taskId,owner.taskId);
          assert.equal(dispatch.expectation.actor.contextId,request.context.id);assert.equal(dispatch.expectation.actor.role,'critic');
          assert.equal(dispatch.snapshot.target.draftHash,dispatch.expectation.target.draftHash);
          const task=JSON.parse(request.context.getItems().find(i=>i.role==='user').content.text);
          assert.deepEqual(task.reviewSnapshot,dispatch.snapshot);assert.ok(task.reviewSnapshot.sources.some(s=>s.source.fieldPointer==='/authors'));
          assert.equal(Object.hasOwn(task,'labels'),false);assert.equal(Object.hasOwn(task,'expectedFinding'),false);
        }
        const value=owner.role==='proposer'?proposerBody:owner.role==='counter-evidence'?counterBody:{verdict:'approve',findings:[]};
        return {items:[ModelMessageItem.rehydrate({text:JSON.stringify(value)})],tokenUsage:undefined,rowResponse:null};},async *stream(){}})});
  assert.equal(nativeCriticStarted,true);assert.equal(result.kind,'reviewed');assert.equal(completions.length,1);
  assert.equal(completions[0].actor.taskId,dispatches[0].actor.taskId);assert.deepEqual(completions[0].review,result.review);
  assert.equal(new Set(contexts.map(c=>c.id)).size,3);
  for(const context of contexts){
    const instruction=context.getItems().find(item=>item.role==='developer').content.text;
    assert.ok(instruction.includes('at most eight calls')&&instruction.includes('one call at a time')&&instruction.includes('never invent tool receipts'),
      'every actual native role receives the bounded serial execution policy; the mechanism is independently tested through real SDK tool states');
    assert.equal(instruction.includes('This first Proposer task is controlled artifact transcription'),false);
  }
});

test('unchanged Counter keeps exact v1 identity/hash while meaningful v2 is independently redispatched',async()=>{
  const runInput={...input,runId:randomUUID()},dispatches=[],counterArtifacts=[],criticTasks=[];
  const result=await executeRun({v:1,kind:'start',runId:runInput.runId,runInput,snapshotPath:resolve('reference/einstein-matchmaker-data'),limits:DEFAULT_LIMITS},()=>{},
    {acquire:async()=>{throw Error('OFFLINE_NO_NETWORK');},release(){}},
    {runnerMode:'offline_fixture',research,controlledSeed:{proposerBody},onReviewDispatch:value=>dispatches.push(value),onArtifact:item=>{if(item.kind==='counter_report')counterArtifacts.push(item.artifact);},
      runnerFactory:hooks=>({async run(request){const owner=hooks.resolveTask(request.context.id);let value;
        const instruction=request.context.getItems().find(item=>item.role==='developer').content.text;
        assert.equal(instruction.includes('This first Proposer task is controlled artifact transcription'),owner.role==='proposer'&&owner.attempt===1,
          'fixed reproduction override applies only to controlled first Proposer task, never the revision or independent roles');
        if(owner.role==='proposer')value=owner.attempt===1?proposerBody:{...proposerBody,sections:{summary:[{text:claim.text+' Targeted offline revision records validation uncertainty.',claimIds:[claim.id]}],validation:[{text:'Confirm data-sharing agreement before validation.',claimIds:[claim.id]}]}};
        else if(owner.role==='counter-evidence')value=counterBody;
        else {criticTasks.push(owner);value=owner.attempt===1?{verdict:'revise',findings:[{id:'F-FIXTURE',scope:'claim',claimIds:[claim.id],evidenceIds:[notes.id],code:'OFFLINE_TARGETED_RECHECK',severity:'blocking',explanation:'Offline protocol scenario; no model quality assertion.',recheckQuestion:'Record the validation condition.'}]}:{verdict:'approve',findings:[]};}
        return {items:[ModelMessageItem.rehydrate({text:JSON.stringify(value)})],tokenUsage:undefined,rowResponse:null};},async *stream(){}})});
  assert.equal(result.kind,'reviewed');assert.equal(result.draft.version,2);assert.equal(counterArtifacts.length,1);
  assert.equal(result.counter.version,1);assert.equal(dispatches[0].snapshot.counter.hash,dispatches[1].snapshot.counter.hash);
  assert.deepEqual(dispatches[0].snapshot.counter,dispatches[1].snapshot.counter);
  assert.notEqual(dispatches[0].expectation.target.draftHash,dispatches[1].expectation.target.draftHash);
  assert.equal(criticTasks[0].agentId,criticTasks[1].agentId);assert.notEqual(criticTasks[0].contextId,criticTasks[1].contextId);
  assert.notEqual(criticTasks[0].taskId,criticTasks[1].taskId);assert.equal(dispatches[1].expectation.actor.attempt,2);
});

test('controlled v1 is an actual native Proposer response, preserved exactly and absent from independent Critic instructions',async()=>{
  const runInput={...input,runId:randomUUID()},roles=[];
  const result=await executeRun({v:1,kind:'start',runId:runInput.runId,runInput,snapshotPath:resolve('reference/einstein-matchmaker-data'),limits:DEFAULT_LIMITS},()=>{},
    {acquire:async()=>{throw Error('OFFLINE_NO_NETWORK');},release(){}},
    {runnerMode:'offline_fixture',research,controlledSeed:{proposerBody},runnerFactory:hooks=>({async run(request){
      const owner=hooks.resolveTask(request.context.id),task=JSON.parse(request.context.getItems().find(item=>item.role==='user').content.text);roles.push(owner.role);
      const instruction=request.context.getItems().find(item=>item.role==='developer').content.text;
      assert.equal(instruction.includes('This first Proposer task is controlled artifact transcription'),owner.role==='proposer');
      if(owner.role==='proposer')assert.deepEqual(task.controlledDraftInput,proposerBody);
      else assert.equal(Object.hasOwn(task,'controlledDraftInput'),false,'no reproduction instruction in Counter or Critic data');
      if(owner.role==='critic')assert.equal(Object.hasOwn(task.reviewSnapshot,'expectedFinding'),false);
      const value=owner.role==='proposer'?proposerBody:owner.role==='counter-evidence'?counterBody:{verdict:'approve',findings:[]};
      return {items:[ModelMessageItem.rehydrate({text:JSON.stringify(value)})],tokenUsage:undefined,rowResponse:null};},async *stream(){}})});
  assert.equal(result.kind,'reviewed');assert.deepEqual(new Set(roles),new Set(['proposer','counter-evidence','critic']));
  assert.deepEqual(result.draft.claims,proposerBody.claims);assert.deepEqual(result.draft.sections,proposerBody.sections);
});

test('controlled v1 alteration fails rather than silently repairing, accepting or retrying the attack',async()=>{
  const runInput={...input,runId:randomUUID()},roles=[];
  const changed=structuredClone(proposerBody);changed.claims[0].text+=' unrequested edit';
  await assert.rejects(executeRun({v:1,kind:'start',runId:runInput.runId,runInput,snapshotPath:resolve('reference/einstein-matchmaker-data'),limits:DEFAULT_LIMITS},()=>{},
    {acquire:async()=>{throw Error('OFFLINE_NO_NETWORK');},release(){}},
    {runnerMode:'offline_fixture',research,controlledSeed:{proposerBody},runnerFactory:hooks=>({async run(request){
      const owner=hooks.resolveTask(request.context.id);roles.push(owner.role);
      const value=owner.role==='proposer'?changed:counterBody;
      return {items:[ModelMessageItem.rehydrate({text:JSON.stringify(value)})],tokenUsage:undefined,rowResponse:null};},async *stream(){}})}),/CONTROLLED_SEED_NOT_PRESERVED/);
  assert.equal(roles.filter(role=>role==='proposer').length,1);assert.equal(roles.includes('critic'),false);
});

test('controlled v1 cannot enter ordinary research mode or the unrelated adapter probe',async()=>{
  let calls=0;
  for(const [mode,adapterProbe] of [['research',false],['adversarial',true]]){
    const runInput={...input,runId:randomUUID(),mode};
    await assert.rejects(executeRun({v:1,kind:'start',runId:runInput.runId,runInput,snapshotPath:resolve('reference/einstein-matchmaker-data'),limits:DEFAULT_LIMITS},()=>{},
      {acquire:async()=>{throw Error('OFFLINE_NO_NETWORK');},release(){}},
      {runnerMode:'offline_fixture',research,controlledSeed:{proposerBody},adapterProbe,
        runnerFactory:()=>{calls++;throw Error('MUST_NOT_RUN');}}),/CONTROLLED_SEED_REQUIRES_ADVERSARIAL_MODE/);
  }
  assert.equal(calls,0);
});
