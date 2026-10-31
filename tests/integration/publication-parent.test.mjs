import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Scheduler } from '../../dist/server/supervisor/scheduler.js';
import { RunStore } from '../../dist/server/storage/run-store.js';
import { loadSnapshot } from '../../dist/server/data/snapshot.js';
import { resolveEvidence } from '../../dist/server/evidence/store.js';
import { hashArtifact, hashRunInput, hashCandidatePool, hashEvidenceSnapshot } from '../../dist/server/evidence/hashing.js';
import { buildReviewSnapshot } from '../../dist/server/runtime/orchestrator.js';
import { input, pool as poolFixture } from '../fixtures/contracts.mjs';

// Deterministic transport fault injection, NOT real OS/model evidence.
const snapshotPath = resolve('reference/einstein-matchmaker-data');
const snapshot = await loadSnapshot(snapshotPath, input().datasetCommit);
function artifacts(i) {
  const r = snapshot.getRecord('researcher','R1008');
  const e = resolveEvidence({ file:r.file,recordId:r.recordId,locator:r.locator,fieldPointer:'/name',derivedRecordId:false },snapshot);
  const pool = poolFixture(); pool.candidates[0].evidenceIds=[e.id]; pool.candidates[0].matchedFields[0].sourceRef=e.source;
  pool.poolHash=hashCandidatePool(pool); const evidence=[e], evidenceSnapshotHash=hashEvidenceSnapshot(evidence);
  const draft={runId:i.runId,inputHash:hashRunInput(i),pair:{companyId:i.companyId,researcherId:'R1008'},challengeId:i.challengeId,
    version:1,poolVersion:pool.poolVersion,poolHash:pool.poolHash,evidenceSnapshotHash,
    claims:[{id:'cl_profile',researcherId:'R1008',kind:'fact',text:e.excerpt,evidenceIds:[e.id],sourceBindings:[{evidenceId:e.id,subjectId:'R1008',relation:'profile_field',objectId:'R1008',fieldPointer:'/name'}],limitations:['offline_fixture only']}],
    sections:{summary:[{text:'offline_fixture summary',claimIds:['cl_profile']}],constraints:[{text:'Preserved review restriction',claimIds:['cl_profile']}]}};
  draft.draftHash=hashArtifact(draft);
  const counter={id:'counter_fixture',runId:i.runId,inputHash:draft.inputHash,version:1,poolVersion:pool.poolVersion,poolHash:pool.poolHash,
    checkedFacets:['name'],checkedCandidates:['R1008'],findings:[],noCounterEvidenceFound:['offline_fixture only']};counter.hash=hashArtifact(counter);
  const actor={role:'critic',agentId:randomUUID(),taskId:randomUUID(),contextId:randomUUID(),attempt:1};
  const target={inputHash:draft.inputHash,poolVersion:pool.poolVersion,poolHash:pool.poolHash,counterReportHash:counter.hash,draftVersion:1,draftHash:draft.draftHash,evidenceSnapshotHash};
  const review={id:'review_fixture',runId:i.runId,version:1,verdict:'approve',findings:[],target};review.hash=hashArtifact(review);
  return {draft,counter,review,expectation:{actor,reviewVersion:1,target},research:{snapshot,pool,evidence}};
}
async function setup(t,options={}) {
  const root=await mkdtemp(join(tmpdir(),'einstein task7 parent 中文 '));
  const store=await RunStore.open(root,{fault:options.fault,publicationSnapshot:async()=>snapshot});
  let callbacks,cleanupRelease; const cleanupBarrier=options.cleanupWait?new Promise(r=>{cleanupRelease=r;}):Promise.resolve();
  const handles=[];
  const i={...input(),runId:randomUUID(),mode:options.mode??'adversarial'},a=artifacts(i);
  const scheduler=new Scheduler({store,snapshotPath,runnerMode:'offline_fixture',publicationContext:async()=>a.research,
    createHost:c=>{callbacks=c;return{start(value){const h={runId:value.runId,pid:990001+handles.length,ready:Promise.resolve(),identity:Promise.resolve(null),closed:new Promise(()=>{}),send:()=>true,
      terminate:async()=>{await cleanupBarrier;return{runId:value.runId,confirmed:options.confirmed??true,reason:'offline_fixture',exit:{runId:value.runId,pid:990001,exitObserved:true,closeObserved:true,exitCode:0}};}};handles.push(h);return h;}};}});
  t.after(async()=>{cleanupRelease?.();try{await scheduler.close();}catch{assert.equal(scheduler.safetyHold,true);}await store.close();});
  await scheduler.submit(i);
  const send=m=>callbacks.onMessage(i.runId,{v:1,runId:i.runId,...m});
  const event=e=>send({kind:'event',nativeOrAppEvent:{runId:i.runId,...e}});
  function produce(role,artifact,kind,identity={},joinAgent=true){
    const actor={runId:i.runId,role,agentId:identity.agentId??randomUUID(),taskId:identity.taskId??randomUUID(),contextId:identity.contextId??randomUUID(),loopId:randomUUID(),attempt:1,...identity};
    if(joinAgent)event({source:'mozaik',type:'participant.joined',role,agentId:actor.agentId,payload:{kind:'participant',participantId:actor.agentId,participantKind:'agent'}});
    event({...actor,source:'application',type:'task.started',payload:{kind:'task'}});
    event({...actor,source:'mozaik',type:'model.answer',payload:{kind:'answer_ref',artifactRef:{id:'answer_fixture',hash:'a'.repeat(64)}}});
    send({kind:'artifact',typedArtifact:{kind,artifact}});
    const ref={id:kind==='proposal_draft'?`draft_${artifact.version}`:artifact.id,hash:artifact.draftHash??artifact.hash};
    for(const type of ['artifact.validated','task.completed'])event({...actor,source:'application',type,payload:{kind:'artifact_ref',artifactKind:kind,artifactRef:ref,version:artifact.version}});
    return actor;
  }
  function full({omitCounter=false,wrongActor=false,beforeOutcome,duplicateAgent}={}){
    const proposer=produce('proposer',a.draft,'proposal_draft',duplicateAgent==='proposer'?{agentId:a.expectation.actor.agentId}:{});
    if(!omitCounter)produce('counter-evidence',a.counter,'counter_report',duplicateAgent==='counter-evidence'?{agentId:a.expectation.actor.agentId}:{});
    send({kind:'review.dispatch',expectation:a.expectation,snapshotHash:hashArtifact(buildReviewSnapshot({...a.research,input:i,draft:a.draft,counter:a.counter}))});
    const who=produce('critic',a.review,'critic_review',wrongActor?{...a.expectation.actor,taskId:randomUUID()}:a.expectation.actor);
    event({...who,source:'application',type:'review.completed',payload:{kind:'review_ref',reviewRef:{id:a.review.id,hash:a.review.hash},verdict:'approve',draftVersion:1}});
    beforeOutcome?.(proposer);
    send({kind:'outcome',typedOutcome:{runId:i.runId,kind:'reviewed',draft:a.draft,counter:a.counter,review:a.review,reasonCodes:[]}});
  }
  return{root,store,scheduler,i,a,send,event,produce,full,handles,release:()=>cleanupRelease?.()};
}
test('parent publishes exact approved diagnostic snapshot only after gate, confirmed cleanup and atomic persistence',async t=>{
  const x=await setup(t);x.full();await x.scheduler.waitForIdle();
  assert.equal(x.store.getRun(x.i.runId).status,'approved');
  const publication=x.store.getPublication(x.i.runId);assert.equal(publication.mode,'adversarial');assert.equal(publication.formalProposal,null);
  assert.deepEqual(JSON.parse(publication.renderedDraft),x.a.draft);
  const bundle=JSON.parse(await readFile(join(x.root,x.i.runId,'terminal.json'),'utf8'));assert.equal(bundle.record.status,'approved');
  assert.equal(bundle.publication.renderedDraft,publication.renderedDraft);
  await x.scheduler.close();await x.store.close();const reopened=await RunStore.open(x.root,{publicationSnapshot:async()=>snapshot});
  assert.equal(reopened.safetyHold,false);assert.equal(reopened.getRun(x.i.runId).status,'approved');await reopened.close();
});
for(const fault of ['terminal:beforeWrite','terminal:beforeSync','terminal:beforeRename'])test(`publication write failure ${fault} never exposes approved or a proposal`,async t=>{
  let armed=false;const x=await setup(t,{fault:p=>{if(armed&&p===fault)throw Error('OFFLINE_DISK_FAULT');}});armed=true;x.full();await x.scheduler.drain();
  assert.notEqual(x.store.getRun(x.i.runId).status,'approved');assert.equal(x.store.getPublication(x.i.runId),undefined);assert.equal(x.scheduler.safetyHold,true);
});
test('unconfirmed cleanup denies publication, retains safety hold and blocks next admission',async t=>{
  const x=await setup(t,{confirmed:false});const q={...x.i,runId:randomUUID()};await x.scheduler.submit(q);x.full();await x.scheduler.drain();
  assert.notEqual(x.store.getRun(x.i.runId).status,'approved');assert.equal(x.store.getPublication(x.i.runId),undefined);assert.equal(x.scheduler.safetyHold,true);assert.equal(x.handles.length,1);
});
test('cancel while approved worker cleanup is pending wins before atomic publication',async t=>{
  const x=await setup(t,{cleanupWait:true});x.full();const cancelled=x.scheduler.cancel(x.i.runId);x.release();await cancelled;await x.scheduler.drain();
  assert.equal(x.store.getRun(x.i.runId).status,'cancelled');assert.equal(x.store.getPublication(x.i.runId),undefined);
});
for(const when of ['terminal:beforeWrite','terminal:beforeSync','terminal:beforeRename'])test(`cancel during publication persistence ${when} cannot leave approved`,async t=>{
  let x,armed=false; x=await setup(t,{fault:p=>{if(armed&&p===when){armed=false;void x.scheduler.cancel(x.i.runId);}}});armed=true;x.full();await x.scheduler.drain();
  assert.equal(x.store.getRun(x.i.runId).status,'cancelled');assert.equal(x.store.getPublication(x.i.runId),undefined);
});
for(const variant of ['missingCounter','wrongActor','bareReviewed'])test(`parent refuses ${variant} even with hash-valid worker outcome`,async t=>{
  const x=await setup(t);if(variant==='bareReviewed')x.send({kind:'outcome',typedOutcome:{runId:x.i.runId,kind:'reviewed',draft:x.a.draft,counter:x.a.counter,review:x.a.review,reasonCodes:[]}});else x.full({omitCounter:variant==='missingCounter',wrongActor:variant==='wrongActor'});
  await x.scheduler.waitForIdle();assert.notEqual(x.store.getRun(x.i.runId).status,'approved');assert.equal(x.store.getPublication(x.i.runId),undefined);
});
test('duplicate/late approval and outcome do not publish twice or reopen cancelled Run',async t=>{
  const x=await setup(t);x.full();await x.scheduler.waitForIdle();const before=x.store.getPublication(x.i.runId);x.full();await x.scheduler.drain();
  assert.deepEqual(x.store.getPublication(x.i.runId),before);assert.equal(x.store.getRun(x.i.runId).status,'approved');
});
test('parent cannot publish old v1 after accepting an unrequested second Proposer task and changed v2',async t=>{
  const x=await setup(t);x.full({beforeOutcome:p=>{
    const v2=structuredClone(x.a.draft);v2.version=2;v2.sections.summary[0].text='Changed later draft requires its own independent review';v2.draftHash=hashArtifact(v2);
    x.produce('proposer',v2,'proposal_draft',{agentId:p.agentId,taskId:randomUUID(),contextId:randomUUID(),attempt:2},false);
  }});await x.scheduler.waitForIdle();assert.notEqual(x.store.getRun(x.i.runId).status,'approved');assert.equal(x.store.getPublication(x.i.runId),undefined);
});
for(const role of ['proposer','counter-evidence'])test(`parent rejects ${role} and Critic sharing the same Agent identity`,async t=>{
  const x=await setup(t);x.full({duplicateAgent:role});await x.scheduler.waitForIdle();assert.notEqual(x.store.getRun(x.i.runId).status,'approved');assert.equal(x.store.getPublication(x.i.runId),undefined);
});

for(const variant of ['loadedFields','sources'])test(`recovery rejects corrupted persisted Critic ${variant} proof independently of still-valid artifact hashes`,async t=>{
  const x=await setup(t);x.full();await x.scheduler.waitForIdle();
  assert.equal(x.store.getRun(x.i.runId).status,'approved','valid diagnostic control publishes before corruption');
  const terminalPath=join(x.root,x.i.runId,'terminal.json');
  const bundle=JSON.parse(await readFile(terminalPath,'utf8'));
  if(variant==='loadedFields')bundle.publication.proof.reviewSnapshot.loadedFields[0].fieldHash='0'.repeat(64);
  else bundle.publication.proof.reviewSnapshot.sources[0].value='OFFLINE_FIXTURE_TAMPERED_SOURCE_COPY';
  // Only this explicitly-created test Run output is modified, never official data.
  await x.scheduler.close();await x.store.close();
  const {writeFile}=await import('node:fs/promises');await writeFile(terminalPath,JSON.stringify(bundle)+'\n');
  const reopened=await RunStore.open(x.root,{publicationSnapshot:async()=>snapshot});
  try{
    assert.equal(reopened.safetyHold,true,'load manifest must be deterministically reconstructed, not accepted as arbitrary JSON');
    assert.equal(reopened.getPublication(x.i.runId),undefined);
    assert.notEqual(reopened.getRun(x.i.runId)?.status,'approved');
    assert.ok(reopened.diagnostics.some(issue=>issue.code==='INVALID_RUN_STORAGE'));
  }finally{await reopened.close();}
});

for(const field of ['agentId','taskId','contextId'])test(`recovery rejects forged Critic ${field} mirrored across all approval metadata but absent from native task history`,async t=>{
  const x=await setup(t);x.full();await x.scheduler.waitForIdle();
  assert.equal(x.store.getRun(x.i.runId).status,'approved','valid diagnostic control publishes before corruption');
  const terminalPath=join(x.root,x.i.runId,'terminal.json');
  const bundle=JSON.parse(await readFile(terminalPath,'utf8'));
  const originalEvents=await readFile(join(x.root,x.i.runId,'events.jsonl'),'utf8');
  const originalArtifacts=structuredClone(bundle.artifacts);
  const forged=randomUUID();
  bundle.publication.proof.actor[field]=forged;
  bundle.publication.proof.reviewedRecord.reviewExpectation.actor[field]=forged;
  bundle.record.reviewExpectation.actor[field]=forged;
  // Every artifact/hash, original record.json and native event remains intact.
  // Matching copies of attacker-controlled metadata do not authenticate a task.
  await x.scheduler.close();await x.store.close();
  const {writeFile}=await import('node:fs/promises');await writeFile(terminalPath,JSON.stringify(bundle)+'\n');
  assert.equal(await readFile(join(x.root,x.i.runId,'events.jsonl'),'utf8'),originalEvents);
  assert.deepEqual(bundle.artifacts,originalArtifacts);
  const reopened=await RunStore.open(x.root,{publicationSnapshot:async()=>snapshot});
  try{
    assert.equal(reopened.safetyHold,true,'approval actor must bind to the archived real task sequence');
    assert.equal(reopened.getPublication(x.i.runId),undefined);
    assert.notEqual(reopened.getRun(x.i.runId)?.status,'approved');
    assert.ok(reopened.diagnostics.some(issue=>issue.code==='INVALID_RUN_STORAGE'));
  }finally{await reopened.close();}
});

for(const kind of ['proposal_draft','counter_report','critic_review'])test(`recovery rejects missing exact archived ${kind} even when outcome and source proof remain valid`,async t=>{
  const x=await setup(t);x.full();await x.scheduler.waitForIdle();
  assert.equal(x.store.getRun(x.i.runId).status,'approved','valid diagnostic control publishes before corruption');
  const terminalPath=join(x.root,x.i.runId,'terminal.json');
  const bundle=JSON.parse(await readFile(terminalPath,'utf8'));
  const originalOutcome=structuredClone(bundle.outcome);
  const before=bundle.artifacts.length;
  bundle.artifacts=bundle.artifacts.filter(a=>a.kind!==kind);
  assert.equal(bundle.artifacts.length,before-1,'one actual required artifact removed');
  assert.deepEqual(bundle.outcome,originalOutcome,'outcome still has its valid exact hashes and full contents');
  await x.scheduler.close();await x.store.close();
  const {writeFile}=await import('node:fs/promises');await writeFile(terminalPath,JSON.stringify(bundle)+'\n');
  const reopened=await RunStore.open(x.root,{publicationSnapshot:async()=>snapshot});
  try{
    assert.equal(reopened.safetyHold,true,'recovery must enforce the same exact-artifact requirement as commit');
    assert.equal(reopened.getPublication(x.i.runId),undefined);
    assert.notEqual(reopened.getRun(x.i.runId)?.status,'approved');
    assert.ok(reopened.diagnostics.some(issue=>issue.code==='INVALID_RUN_STORAGE'));
  }finally{await reopened.close();}
});

test('recovery rejects Counter without completed task receipt even with intact artifact, source proof and final Critic',async t=>{
  const x=await setup(t);x.full();await x.scheduler.waitForIdle();
  assert.equal(x.store.getRun(x.i.runId).status,'approved','valid diagnostic control publishes before corruption');
  const eventsPath=join(x.root,x.i.runId,'events.jsonl');
  const log=(await readFile(eventsPath,'utf8')).trimEnd().split('\n').map(JSON.parse);
  const completed=log.find(e=>e.type==='task.completed'&&e.role==='counter-evidence');
  assert.ok(completed,'there is one real offline-fixture Counter completion to remove');
  // Keep every sequence, actor, Run binding and event count. This replacement is
  // valid metadata, but it no longer proves completion of the Counter task.
  completed.source='mozaik';completed.type='inference.completed';completed.payload={kind:'loop'};
  const {StoredEventSchema}=await import('../../dist/server/contracts/events.js');
  for(const e of log)StoredEventSchema.parse(e);
  await x.scheduler.close();await x.store.close();
  const {writeFile}=await import('node:fs/promises');await writeFile(eventsPath,log.map(e=>JSON.stringify(e)+'\n').join(''));
  const reopened=await RunStore.open(x.root,{publicationSnapshot:async()=>snapshot});
  try{
    assert.equal(reopened.safetyHold,true,'the independent Counter must be backed by its completed task sequence');
    assert.equal(reopened.getPublication(x.i.runId),undefined);
    assert.notEqual(reopened.getRun(x.i.runId)?.status,'approved');
    assert.ok(reopened.diagnostics.some(issue=>issue.code==='INVALID_RUN_STORAGE'));
  }finally{await reopened.close();}
});
