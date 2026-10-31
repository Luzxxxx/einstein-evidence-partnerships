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

// Actual Windows OS/IPC/identity lifecycle, fake HTTP and original source tools.
// The temporary store is a separately labeled offline_fixture, never a recovery
// or a replacement for the historical production store.
const nativeOptions={skip:process.platform!=='win32',timeout:90000};
const workerPath=fileURLToPath(new URL('../fixtures/probe-v3-worker.mjs',import.meta.url));
const snapshotPath=fileURLToPath(new URL('../../reference/einstein-matchmaker-data/',import.meta.url));
const readJson=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const projection=cleanup=>{const{stdout,stderr,...exit}=cleanup.exit;return{...cleanup,exit,outputBytes:{stdout:Buffer.byteLength(stdout),stderr:Buffer.byteLength(stderr)}};};
async function setup(t,mode){
  const root=await mkdtemp(join(tmpdir(),'einstein task7u v3 worker 中文 ')),storeRoot=join(root,'store'),workerCwd=join(root,'isolated cwd with spaces');
  await mkdir(workerCwd);const store=await RunStore.open(storeRoot),evidencePath=join(root,'offline-fixture-evidence.json');
  const limits={...DEFAULT_LIMITS,maxModelRequests:4,runTimeoutMs:60000};
  const scheduler=new Scheduler({store,snapshotPath,runnerMode:'offline_fixture',limits,createHost:callbacks=>new ProcessHost({...callbacks,
    cwd:workerCwd,workerPath,workerArgs:['--mode',mode,'--evidence-path',evidencePath]})});
  t.after(async()=>{
    let closeFailure=null;try{await scheduler.close();}catch{closeFailure='OFFLINE_FIXTURE_CLOSE_FAILED';}
    const records=store.listRuns(),fixture=await readJson(evidencePath),evidence={runnerMode:'offline_fixture',mode,platform:process.platform,
      actualNativeWorkerLifecycle:'task7u_probe_v3',networkTransport:'controlled_fake_fetch',fixturePath:workerPath,isolatedNewWorkerCwd:workerCwd,limits,
      records,events:records.map(r=>({runId:r.runId,events:store.eventsAfter(r.runId,0)})),cleanups:scheduler.cleanupEvidence.map(projection),
      permitSnapshot:scheduler.permits.snapshot(),safetyHold:scheduler.safetyHold,fixture,closeFailure,
      permitAccounting:records.map(record=>verifyPermitSettlement({runId:record.runId,record,events:store.eventsAfter(record.runId,0),
        cleanup:scheduler.cleanupEvidence.find(c=>c.runId===record.runId),snapshot:scheduler.permits.snapshot(),safetyHold:scheduler.safetyHold}))};
    const archive=resolve('docs/implementation',`task-7u-worker-evidence-${mode}-${Date.now()}-${randomUUID()}.json`);
    await writeFile(archive,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(`Immutable offline_fixture Windows evidence: ${archive}`);
    await store.close();
    if(!closeFailure&&scheduler.cleanupEvidence.every(c=>c.confirmed)){
      const target=resolve(root),temporaryRoot=resolve(tmpdir());assert.ok(target.startsWith(temporaryRoot+sep)&&target.includes('einstein task7u v3 worker 中文 '));
      await rm(target,{recursive:true,force:true});
    }
    if(closeFailure)throw Error(closeFailure);
  });
  const input={...inputFixture(),runId:randomUUID(),promptVersion:'offline_fixture_probe_v3',configVersion:'task7u_windows_fixture'};
  const run=await scheduler.submit(input);await scheduler.waitForIdle(45000);
  const record=store.getRun(run.runId),cleanup=scheduler.cleanupEvidence.find(c=>c.runId===run.runId);
  assert.equal(record.runnerMode,'offline_fixture');assert.equal(record.cleanupState,'confirmed');assert.equal(scheduler.safetyHold,false);
  assert.equal(scheduler.permits.snapshot().inFlight,0);assert.ok(cleanup?.confirmed&&cleanup.exit.closeObserved&&cleanup.exit.exitObserved);
  assert.equal(cleanup.rootVerification,'absent');assert.equal(cleanup.identity.parentPid,process.pid);
  assert.ok(cleanup.identity.commandLine.includes(run.runId));
  const fixture=await readJson(evidencePath),events=store.eventsAfter(run.runId,0),terminal=await readJson(join(storeRoot,run.runId,'terminal.json'));
  const grants=events.filter(e=>e.type==='permit.granted').map(e=>e.payload.permitId),releases=events.filter(e=>e.type==='permit.released').map(e=>e.payload.permitId);
  assert.equal(new Set(grants).size,grants.length);assert.equal(new Set(releases).size,releases.length);assert.ok(releases.every(id=>grants.includes(id)));
  assert.equal(scheduler.permits.snapshot().runs.find(r=>r.runId===run.runId).pending,0);
  assert.equal(fixture?.runnerMode,'offline_fixture');assert.equal(fixture.expected.runId,run.runId);
  assert.equal(events.some(e=>e.type==='run.status'&&e.payload.status==='approved'),false);assert.equal(terminal.publication,undefined);
  const settlement=verifyPermitSettlement({runId:run.runId,record,events,cleanup,snapshot:scheduler.permits.snapshot(),terminal,safetyHold:scheduler.safetyHold});
  assert.equal(settlement.valid,true,JSON.stringify(settlement));assert.equal(settlement.fullySettled,true);
  return{record,cleanup,fixture,events,terminal,permits:scheduler.permits.snapshot(),permitAccounting:settlement.permits,permitSettlement:settlement};
}

test('offline_fixture v3 actual Windows worker preserves reverse original tool order through parent permit IPC and confirmed cleanup',nativeOptions,async t=>{
  const x=await setup(t,'reverse_roundtrip');assert.equal(x.record.status,'insufficient');assert.equal(x.fixture.wireCount,4);
  assert.equal(x.events.filter(e=>e.type==='permit.granted').length,4);
  assert.equal(x.permitSettlement.explicitReleaseCount+x.permitSettlement.cleanupReclaimedCount,4,'four uniquely bound grants settle through actual releases or identity-confirmed cleanup; no release is invented');
  assert.equal(x.events.filter(e=>e.type==='model.request.started').length,4);
  assert.equal(x.events.filter(e=>e.type==='model.request.completed').length,4);
  const rows=x.fixture.records;assert.equal(rows.filter(r=>r.kind==='native'&&r.type==='function_call.completed').length,4);
  assert.equal(rows.filter(r=>r.kind==='native'&&r.type==='function_call.started').length,4);
  const answers=rows.filter(r=>r.kind==='native'&&r.type==='model.answer');assert.equal(answers.length,2);
  assert.equal(new Set(answers.map(r=>r.actor.contextId)).size,2);
  for(const answer of answers){assert.equal(answer.answer.receipts[0].toolName,'read_candidate_bundle');assert.equal(answer.answer.receipts[1].toolName,'read_company_challenge');}
  assert.equal(rows.filter(r=>r.kind==='probe.contract'&&r.status==='accepted').length,4);
  assert.equal(x.fixture.diagnostics.filter(r=>r.stage==='schema_validation'&&r.status==='passed').length,2);
  assert.equal(x.permits.runs.find(r=>r.runId===x.record.runId).attempts,4);
});

test('offline_fixture v3 actual Windows worker rejects the whole first four-call batch and aborts its concurrent sibling fetch before native tools',nativeOptions,async t=>{
  const x=await setup(t,'reject_first_four');assert.equal(x.record.status,'failed');assert.ok(x.terminal.outcome.reasonCodes.includes('PROBE_CONTRACT_FIRST_BATCH_COUNT'));
  assert.equal(x.fixture.initialCount,2);assert.equal(x.fixture.wireCount,2);assert.equal(x.fixture.siblingAbortObserved,true);
  assert.equal(x.events.filter(e=>e.type==='permit.granted').length,2);
  // Stop intent can win the race with a real worker release. The accepted
  // Task5 policy then reclaims the remaining reservation after identity cleanup,
  // preserving the actual release event count instead of inventing a receipt.
  assert.equal(x.permitAccounting.length,2);assert.ok(x.permitAccounting.every(p=>['explicit_release','confirmed_cleanup_reclaim'].includes(p.disposition)));
  assert.equal(x.fixture.records.some(r=>r.kind==='native'&&r.type==='function_call.started'),false);
  assert.equal(x.fixture.records.some(r=>r.kind==='tool.batch'),false);
  assert.ok(x.fixture.records.some(r=>r.kind==='probe.contract'&&r.status==='rejected'&&r.code==='PROBE_CONTRACT_FIRST_BATCH_COUNT'));
  assert.equal(x.permits.runs.find(r=>r.runId===x.record.runId).attempts,2);
});
