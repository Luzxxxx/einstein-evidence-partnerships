// offline_fixture: actual Scheduler/Store and HTTP, deterministic transport double.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../../dist/server/storage/run-store.js';
import { Scheduler } from '../../dist/server/supervisor/scheduler.js';
import { startLocalService } from '../../dist/server/server/service.js';
import { snapshot, snapshotPath } from '../helpers/task8-fixture.mjs';
import { input } from '../fixtures/contracts.mjs';
import { hashRunInput } from '../../dist/server/evidence/hashing.js';

test('recovered unfinished archive reports interruption and stops SSE without fabricating a terminal result',async t=>{
 const root=await mkdtemp(join(tmpdir(),'einstein held archive offline_fixture '));let store=await RunStore.open(root);const i={...input(),runId:randomUUID(),mode:'research'};
 await store.createRun({runId:i.runId,input:i,inputHash:hashRunInput(i),runnerMode:'offline_fixture',status:'queued',createdAt:'2026-10-31T10:00:00.000Z',revisionCount:0,cleanupState:'not_started',lastSeq:0});
 await store.close();store=await RunStore.open(root);
 const scheduler=new Scheduler({store,snapshotPath,runnerMode:'offline_fixture',createHost:()=>({start(){throw Error('NO_WORKER_EXPECTED');}})});
 const app=await startLocalService({store,scheduler,snapshot,snapshotPath,port:0,modelConfigured:()=>true});
 t.after(async()=>{await assert.rejects(app.close(),/SERVICE_SAFETY_HOLD/);await store.close();});
 const catalog=await(await fetch(app.url+'/api/catalog')).json();assert.equal(catalog.newRunsAvailable,false);
 const history=await(await fetch(app.url+'/api/runs')).json();assert.equal(history.blockedByService,true);assert.deepEqual(history.blockedRunIds,[i.runId]);
 const detail=await(await fetch(app.url+'/api/runs/'+i.runId)).json();assert.equal(detail.progress.blockedByService,true);assert.equal(detail.progress.terminal,false);assert.equal(detail.run.status,'queued');
 const stream=await fetch(app.url+'/api/runs/'+i.runId+'/events',{signal:AbortSignal.timeout(2000)});assert.equal(await stream.text(),'');
 assert.equal((await fetch(app.url+'/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({companyId:'C001',challengeId:'C001-CH1'})})).status,503);
 assert.equal(store.getTerminal(i.runId),undefined);assert.equal(store.safetyHold,true);
});

test('GET Run exposes saved terminal reasons without deriving a subtype from generic Trace failure',async t=>{
 const root=await mkdtemp(join(tmpdir(),'einstein task9 reasons offline_fixture '));
 const store=await RunStore.open(root,{publicationSnapshot:async()=>snapshot});let callbacks;
 const scheduler=new Scheduler({store,snapshotPath,runnerMode:'offline_fixture',createHost:c=>(callbacks=c,{start:i=>({runId:i.runId,pid:990084,ready:Promise.resolve(),identity:Promise.resolve(null),closed:new Promise(()=>{}),send:()=>true,terminate:async()=>({runId:i.runId,confirmed:true,scope:'registered_identities_only_no_job_object',unobservedDescendantsNotGuaranteed:true,identity:null,rootVerification:'absent',termination:null,scanDiagnostics:[],descendants:[],exit:{runId:i.runId,pid:990084,exitObserved:true,closeObserved:true,spawnError:false,exitCode:0,signal:null,stdout:'',stderr:'',outputTruncated:false}})})})});
 const app=await startLocalService({store,scheduler,snapshot,snapshotPath,port:0,modelConfigured:()=>false});
 t.after(async()=>{await app.close();await store.close();});
 const record=await scheduler.submit({...input(),runId:randomUUID()});
 const initial=await(await fetch(app.url+'/api/runs/'+record.runId)).json();assert.deepEqual(initial.progress.reasonCodes,[]);
 callbacks.onMessage(record.runId,{v:1,runId:record.runId,kind:'outcome',typedOutcome:{runId:record.runId,kind:'failed',reasonCodes:['INVALID_TASK_ANSWER']}});
 await scheduler.waitForIdle();
 const detail=await(await fetch(app.url+'/api/runs/'+record.runId)).json();
 assert.equal(detail.run.status,'failed');assert.deepEqual(detail.progress.reasonCodes,['INVALID_TASK_ANSWER']);
 assert.deepEqual(store.getTerminal(record.runId).outcome.reasonCodes,['INVALID_TASK_ANSWER']);
 assert.equal(scheduler.permits.snapshot().inFlight,0);
});
