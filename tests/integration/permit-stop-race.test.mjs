import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {resolve,join,sep} from 'node:path';
import {Scheduler} from '../../dist/server/supervisor/scheduler.js';import {RunStore} from '../../dist/server/storage/run-store.js';
import {DEFAULT_LIMITS} from '../../dist/server/contracts/config.js';import {input as inputFixture} from '../fixtures/contracts.mjs';

// Actual Scheduler/PermitManager and durable temporary RunStore; Host transport
// and identity evidence below are explicitly synthetic offline_fixture doubles.
// No OS worker, model, network, historical Store, or production policy is used.
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error('OFFLINE_FIXTURE_BARRIER_TIMEOUT');await delay(5);}}
class BarrierHost{
 constructor(callbacks,confirmed){this.callbacks=callbacks;this.confirmed=confirmed;this.handles=[];this.cleanupStarted=deferred();this.cleanupGate=deferred();}
 start(input){
  const identity={pid:780001+this.handles.length,creationFileTime:'134378991358375532',executablePath:'C:\\offline_fixture\\node.exe',
   parentPid:process.pid,commandLine:'C:\\offline_fixture\\node.exe offline_fixture --supervisor-run-id '+input.runId};
  const child={pid:identity.pid+100,creationFileTime:'134378991358599766',executablePath:'C:\\offline_fixture\\conhost.exe',parentPid:identity.pid,commandLine:'offline_fixture known descendant'};
  const closed=deferred(),h={runId:input.runId,pid:identity.pid,identity:Promise.resolve(identity),ready:new Promise(()=>{}),closed:closed.promise,messages:[],
   send:message=>{h.messages.push(message);return true;},inspectDescendants:async()=>[child],
   terminate:async()=>{this.cleanupStarted.resolve();await this.cleanupGate.promise;
    const exit={runId:input.runId,pid:identity.pid,exitCode:0,signal:null,exitObserved:true,closeObserved:true,spawnError:false,stdout:'',stderr:'',outputTruncated:false};
    closed.resolve(exit);this.callbacks.onExit(input.runId,exit);
    return{runId:input.runId,confirmed:this.confirmed,scope:'registered_identities_only_no_job_object',identity,rootVerification:'absent',termination:null,exit,
     descendants:[{identity:child,termination:null,verification:this.confirmed?'absent':'unknown'}],
     scanDiagnostics:this.confirmed?[]:[{pid:child.pid,stage:'offline_fixture',code:'CONTROLLED_IDENTITY_UNKNOWN'}],unobservedDescendantsNotGuaranteed:true};
   }};
  this.handles.push(h);return h;
 }
 emit(runId,message){this.callbacks.onMessage(runId,message);}
}
async function controlledRun(t,mode,confirmed=true){
 const root=await mkdtemp(join(tmpdir(),'einstein task7w controlled permit race ')),storeRoot=join(root,'offline store');
 const blocked=deferred(),writerGate=deferred();let armWrite=false,host,observation;
 const store=await RunStore.open(storeRoot,{fault:async point=>{if(armWrite&&point==='events:beforeRename'){armWrite=false;blocked.resolve();await writerGate.promise;}}});
 const scheduler=new Scheduler({store,snapshotPath:resolve('reference/einstein-matchmaker-data'),runnerMode:'offline_fixture',limits:DEFAULT_LIMITS,
  createHost:callbacks=>{host=new BarrierHost(callbacks,confirmed);return host;}});
 t.after(async()=>{
  writerGate.resolve();host?.cleanupGate.resolve();let closeFailure=null;try{await scheduler.close();}catch{closeFailure='OFFLINE_FIXTURE_CLOSE_FAILED';}
  const archive={runnerMode:'offline_fixture',hostIdentityEvidence:'synthetic_controlled_host_not_actual_OS_verification',actualProductionControl:'Scheduler PermitManager RunStore',
   mode,observation,records:store.listRuns(),events:store.listRuns().map(r=>({runId:r.runId,events:store.eventsAfter(r.runId,0)})),cleanups:scheduler.cleanupEvidence,
   permitSnapshot:scheduler.permits.snapshot(),safetyHold:scheduler.safetyHold,closeFailure};
  const file=resolve('docs/implementation','task-7w-permit-race-controlled-'+mode+'-'+Date.now()+'-'+randomUUID()+'.json');
  await writeFile(file,JSON.stringify(archive,null,2)+'\n',{flag:'wx'});console.log('Immutable offline_fixture controlled race: '+file);await store.close();
  const path=resolve(root);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('einstein task7w controlled permit race '));await rm(path,{recursive:true,force:true});
  if(closeFailure)throw Error(closeFailure);
 });
 const run=await scheduler.submit({...inputFixture(),runId:randomUUID()});host.emit(run.runId,{v:1,kind:'ready',runId:run.runId});await scheduler.drain();
 const grants=[];
 for(let n=0;n<4;n++){
  const requestId=randomUUID();host.emit(run.runId,{v:1,kind:'permit.request',runId:run.runId,requestId});
  await until(()=>host.handles[0].messages.some(m=>m.kind==='permit.granted'&&m.requestId===requestId));
  const grant=host.handles[0].messages.find(m=>m.kind==='permit.granted'&&m.requestId===requestId);grants.push(grant);
  if(n<3){host.emit(run.runId,{v:1,kind:'permit.release',runId:run.runId,permitId:grant.permitId});await scheduler.drain();}
 }
 const queued=confirmed?null:await scheduler.submit({...inputFixture(),runId:randomUUID()});
 const last=grants.at(-1),outcome={v:1,kind:'outcome',runId:run.runId,typedOutcome:{runId:run.runId,kind:'insufficient',reasonCodes:['OFFLINE_FIXTURE_STOP_RACE']}};
 if(mode==='release_before_outcome'){
  host.emit(run.runId,{v:1,kind:'permit.release',runId:run.runId,permitId:last.permitId});await scheduler.drain();
  host.emit(run.runId,outcome);await host.cleanupStarted.promise;
 }else{
  // Persisting a duplicate-ready diagnostic holds the real serial writer. The
  // release arrives first but cannot execute; outcome reserves volatile stop
  // intent immediately. Once unblocked, the queued release is genuinely late.
  armWrite=true;host.emit(run.runId,{v:1,kind:'ready',runId:run.runId});await blocked.promise;
  host.emit(run.runId,{v:1,kind:'permit.release',runId:run.runId,permitId:last.permitId});host.emit(run.runId,outcome);
  await host.cleanupStarted.promise;writerGate.resolve();
  await until(()=>store.eventsAfter(run.runId,0).some(e=>e.type==='event.ignored'&&e.payload.reasonCode==='LATE_WORKER_MESSAGE'));
 }
 const beforeCleanup=scheduler.permits.snapshot();assert.equal(beforeCleanup.runs.find(r=>r.runId===run.runId).attempts,4);
 assert.equal(beforeCleanup.inFlight,mode==='release_before_outcome'?0:1,'stop intent cannot reclaim an outstanding request before cleanup');
 host.cleanupGate.resolve();await scheduler.drain();
 const record=store.getRun(run.runId),events=store.eventsAfter(run.runId,0),cleanup=scheduler.cleanupEvidence.find(c=>c.runId===run.runId),snapshot=scheduler.permits.snapshot();
 const terminal=JSON.parse(await readFile(join(storeRoot,run.runId,'terminal.json'),'utf8'));
 observation={runId:run.runId,record,events,cleanup,snapshot,terminal,beforeCleanup,queuedBeforeClose:queued?scheduler.getRun(queued.runId):null};
 return{runId:run.runId,record,events,cleanup,snapshot,terminal,safetyHold:scheduler.safetyHold,host,scheduler,queued};
}

test('controlled Scheduler accepts all four explicit releases when the last release persists before outcome',async t=>{
 const x=await controlledRun(t,'release_before_outcome');assert.equal(x.events.filter(e=>e.type==='permit.granted').length,4);
 assert.equal(x.events.filter(e=>e.type==='permit.released').length,4);assert.equal(x.snapshot.inFlight,0);assert.equal(x.record.cleanupState,'confirmed');
 const{verifyPermitSettlement}=await import('../helpers/permit-settlement.mjs'),result=verifyPermitSettlement(x);
 assert.equal(result.valid,true,JSON.stringify(result));assert.equal(result.explicitReleaseCount,4);assert.equal(result.cleanupReclaimedCount,0);
 assert.equal(x.snapshot.runs[0].attempts,4);
});
test('controlled Scheduler outcome intent overtakes the queued last release and cleanup settles the fourth reservation',async t=>{
 const x=await controlledRun(t,'queued_release_overtaken');assert.equal(x.events.filter(e=>e.type==='permit.granted').length,4);
 assert.equal(x.events.filter(e=>e.type==='permit.released').length,3,'the controlled stop intent genuinely overtakes exactly the queued fourth release');
 const{verifyPermitSettlement}=await import('../helpers/permit-settlement.mjs'),result=verifyPermitSettlement(x);
 assert.equal(result.valid,true,JSON.stringify(result));assert.equal(result.explicitReleaseCount,3);assert.equal(result.cleanupReclaimedCount,1);
 assert.equal(result.permits.length,4);assert.equal(result.fullySettled,true);
 assert.equal(x.snapshot.inFlight,0);assert.equal(x.snapshot.runs[0].attempts,4);
});
test('controlled Scheduler unconfirmed descendant blocks cleanup reclamation and retains the outstanding reservation',async t=>{
 const x=await controlledRun(t,'queued_release_unknown_cleanup',false);assert.equal(x.safetyHold,true);assert.equal(x.record.cleanupState,'unconfirmed');
 assert.equal(x.events.filter(e=>e.type==='permit.released').length,3);assert.equal(x.snapshot.inFlight,1);assert.equal(x.snapshot.runs[0].attempts,4);
 const{verifyPermitSettlement}=await import('../helpers/permit-settlement.mjs'),result=verifyPermitSettlement(x);
 assert.equal(result.valid,false);assert.equal(result.cleanupReclaimedCount,0);assert.equal(result.unconfirmedCount,1);
 assert.equal(x.host.handles.length,1);assert.equal(x.scheduler.getRun(x.queued.runId).status,'queued');
 assert.equal(x.snapshot.runs.some(r=>r.runId===x.queued.runId),false);await assert.rejects(x.scheduler.submit({...inputFixture(),runId:randomUUID()}),e=>e.code==='RUN_SAFETY_HOLD');
});
