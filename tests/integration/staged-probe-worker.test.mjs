import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Scheduler} from '../../dist/server/supervisor/scheduler.js';
import {ProcessHost} from '../../dist/server/supervisor/process-host.js';
import {RunStore} from '../../dist/server/storage/run-store.js';
import {DEFAULT_LIMITS} from '../../dist/server/contracts/config.js';
import {input as inputFixture} from '../fixtures/contracts.mjs';
import {verifyPermitSettlement} from '../helpers/permit-settlement.mjs';

// Actual Windows process/IPC, offline_fixture fake fetch only. This temporary
// store never opens, restores, replaces or clears the historical product store.
const options={skip:process.platform!=='win32',timeout:90000};
const workerPath=fileURLToPath(new URL('../fixtures/staged-probe-worker.mjs',import.meta.url));
const snapshotPath=fileURLToPath(new URL('../../reference/einstein-matchmaker-data/',import.meta.url));
const readJson=async p=>{try{return JSON.parse(await readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const cleanupProjection=c=>{const{stdout,stderr,...exit}=c.exit;return{...c,exit,outputBytes:{stdout:Buffer.byteLength(stdout),stderr:Buffer.byteLength(stderr)}};};
async function setup(t,mode){
 const fixtureRoot=await mkdtemp(join(tmpdir(),'einstein task7w staged worker 中文 ')),storeRoot=join(fixtureRoot,'store'),cwd=join(fixtureRoot,'isolated cwd with spaces');
 await mkdir(cwd);const store=await RunStore.open(storeRoot),evidencePath=join(fixtureRoot,'offline-fixture-evidence.json');
 const limits={...DEFAULT_LIMITS,maxModelRequests:4};let scheduler;
 // Register before constructing the host: even a future invalid worker entry
 // gets an immutable failure audit. Its temporary files remain for diagnosis.
 t.after(async()=>{
  let closeFailure=null;try{await scheduler?.close();}catch{closeFailure='OFFLINE_FIXTURE_CLOSE_FAILED';}
  const records=store.listRuns(),archive=resolve('docs/implementation',`task-7w-worker-evidence-${mode}-${Date.now()}-${randomUUID()}.json`);
  const terminals=await Promise.all(records.map(async record=>({runId:record.runId,terminal:await readJson(join(storeRoot,record.runId,'terminal.json'))})));
  const snapshot=scheduler?.permits.snapshot()??null,safetyHold=scheduler?.safetyHold??null,cleanups=scheduler?.cleanupEvidence??[];
  const evidence={runnerMode:'offline_fixture',actualWindowsLifecycle:true,transport:'controlled_fake_fetch',providerRequests:0,mode,workerPath,cwd,limits,records,
   events:records.map(r=>({runId:r.runId,events:store.eventsAfter(r.runId,0)})),terminals,cleanups:cleanups.map(cleanupProjection),snapshot,safetyHold,
   permitAccounting:records.map(record=>verifyPermitSettlement({runId:record.runId,record,events:store.eventsAfter(record.runId,0),
    cleanup:cleanups.find(c=>c.runId===record.runId),snapshot,safetyHold,terminal:terminals.find(t=>t.runId===record.runId)?.terminal})),
   fixture:await readJson(evidencePath),closeFailure,constructorCompleted:Boolean(scheduler)};
  await writeFile(archive,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(`Immutable offline_fixture staged Windows evidence: ${archive}`);
  await store.close();
  if(!closeFailure&&scheduler&&scheduler.cleanupEvidence.every(c=>c.confirmed)){
   const target=resolve(fixtureRoot),temp=resolve(tmpdir());assert.ok(target.startsWith(temp+sep)&&target.includes('einstein task7w staged worker 中文 '));
   await rm(target,{recursive:true,force:true});
  }
  if(closeFailure)throw Error(closeFailure);
 });
 scheduler=new Scheduler({store,snapshotPath,runnerMode:'offline_fixture',limits,
  createHost:callbacks=>new ProcessHost({...callbacks,workerPath,cwd,workerArgs:['--mode',mode,'--evidence-path',evidencePath]})});
 const input={...inputFixture(),runId:randomUUID(),promptVersion:'offline_fixture_staged_probe',configVersion:'task7w_windows_fixture'};
 const submitted=await scheduler.submit(input);await scheduler.waitForIdle(60000);
 const record=store.getRun(submitted.runId),cleanup=scheduler.cleanupEvidence.find(c=>c.runId===record.runId),fixture=await readJson(evidencePath),events=store.eventsAfter(record.runId,0);
 assert.equal(record.runnerMode,'offline_fixture');assert.equal(record.cleanupState,'confirmed');assert.equal(scheduler.safetyHold,false);
 assert.equal(cleanup?.confirmed,true);assert.equal(cleanup.rootVerification,'absent');assert.equal(cleanup.exit.exitObserved,true);assert.equal(cleanup.exit.closeObserved,true);
 assert.equal(cleanup.identity.parentPid,process.pid);assert.ok(cleanup.identity.commandLine.includes(record.runId));assert.equal(cleanup.scanDiagnostics.length,0);
 assert.equal(scheduler.permits.snapshot().inFlight,0);assert.equal(scheduler.permits.snapshot().runs.find(r=>r.runId===record.runId).pending,0);
 assert.equal(fixture?.runnerMode,'offline_fixture');assert.equal(fixture?.providerRequests,0);assert.equal(fixture?.expected.runId,record.runId);
 assert.equal(store.getPublication(record.runId),undefined);assert.equal(events.some(e=>e.type==='review.completed'||e.type==='artifact.validated'),false);
 const terminal=await readJson(join(storeRoot,record.runId,'terminal.json'));
 const settlement=verifyPermitSettlement({runId:record.runId,record,events,cleanup,terminal,snapshot:scheduler.permits.snapshot(),safetyHold:scheduler.safetyHold});
 assert.equal(settlement.valid,true,JSON.stringify(settlement));assert.equal(settlement.fullySettled,true);
 return{record,cleanup,fixture,events,terminal,settlement,accounting:settlement.permits,attempts:scheduler.permits.snapshot().runs.find(r=>r.runId===record.runId).attempts};
}
test('offline_fixture staged Windows worker preserves reverse native order and real parent permits while final HTTP forbids tools',options,async t=>{
 const x=await setup(t,'reverse');assert.equal(x.record.status,'insufficient');assert.equal(x.fixture.http.length,4);assert.equal(x.attempts,4);
 assert.equal(x.fixture.records.filter(r=>r.type==='function_call.completed').length,4);assert.equal(x.fixture.records.filter(r=>r.type==='model.answer').length,2);
 assert.equal(x.fixture.records.filter(r=>r.kind==='staged.http.policy'&&r.stage==='final'&&r.toolChoice==='none'&&r.actualToolNames.length===0).length,2);
 assert.ok(x.fixture.records.filter(r=>r.type==='model.answer').every(r=>r.answer.receipts[0].toolName==='read_candidate_bundle'));
});
test('offline_fixture staged Windows worker blocks all second-response tools before a new invoke and cleans up failed worker',options,async t=>{
 const x=await setup(t,'second_tools');assert.equal(x.record.status,'failed');assert.equal(x.fixture.http.length,4);assert.equal(x.attempts,4);
 assert.equal(x.fixture.records.filter(r=>r.type==='function_call.started').length,4);assert.equal(x.fixture.records.filter(r=>r.kind==='tool.batch'&&r.manifest.phase==='staged').length,2);
 assert.ok(x.fixture.records.some(r=>r.kind==='probe.contract'&&r.code==='PROBE_CONTRACT_SECOND_RESPONSE_TOOLS'));
 assert.equal(x.fixture.records.filter(r=>r.type==='model.answer').length,0);assert.equal(x.accounting.length,4);
 assert.ok(x.accounting.every(a=>['explicit_release','confirmed_cleanup_reclaim'].includes(a.disposition)));
});
