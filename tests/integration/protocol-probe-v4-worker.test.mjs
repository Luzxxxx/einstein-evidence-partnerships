import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';import {fileURLToPath} from 'node:url';
import {Scheduler} from '../../dist/server/supervisor/scheduler.js';import {ProcessHost} from '../../dist/server/supervisor/process-host.js';import {RunStore} from '../../dist/server/storage/run-store.js';
import {DEFAULT_LIMITS} from '../../dist/server/contracts/config.js';import {sha256Bytes} from '../../dist/server/evidence/hashing.js';
import {evaluateV4ProbeGate} from '../../dist/server/evaluation/protocol-probe-v4-gate.js';
import {buildV4PlanFixture} from '../fixtures/probe-v4-plan.mjs';
import {verifyPermitSettlement} from '../helpers/permit-settlement.mjs';

// Actual Windows process/IPC/identity cleanup for NEW V4 configure entry. Only
// provider responses are controlled offline_fixture; the historical Store is
// never opened/restored/replaced or used for fixture admission.
const native={skip:process.platform!=='win32',timeout:90000},workerPath=fileURLToPath(new URL('../fixtures/probe-v4-entry-worker.mjs',import.meta.url)),snapshotPath=fileURLToPath(new URL('../../reference/einstein-matchmaker-data/',import.meta.url));
const json=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const jsonl=async path=>{try{return(await readFile(path,'utf8')).split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));}catch(e){if(e.code==='ENOENT')return[];throw e;}};
// Polling accepts only complete record frames. A concurrently
// appended tail is retried, while final evidence above remains strict JSONL.
const completeJsonl=async path=>{try{const text=await readFile(path,'utf8'),lines=text.split(/\r?\n/);lines.pop();return lines.filter(Boolean).map(s=>JSON.parse(s));}catch(e){if(e.code==='ENOENT')return[];throw e;}};
const cleanupRow=cleanup=>{const{stdout,stderr,...exit}=cleanup.exit;return{...cleanup,exit,outputHashes:{stdout:sha256Bytes(Buffer.from(stdout)),stderr:sha256Bytes(Buffer.from(stderr))}};};
async function actualRun(t,mode){
 const freeze=await buildV4PlanFixture(),root=await mkdtemp(join(tmpdir(),'einstein task7x V4 离线 中文 ')),storeRoot=join(root,'offline store'),cwd=join(root,'empty worker cwd'),folder=join(root,'worker evidence');
 await mkdir(cwd);await mkdir(folder);const planPath=join(root,'offline-fixture-plan.json'),bytes=Buffer.from(JSON.stringify(freeze));await writeFile(planPath,bytes,{flag:'wx'});
 const store=await RunStore.open(storeRoot),limits={...DEFAULT_LIMITS,maxModelRequests:4};let scheduler,gate=null,row=null,settlement=null;
 t.after(async()=>{
  let closeFailure=null;try{await scheduler?.close();}catch{closeFailure='OFFLINE_FIXTURE_CLOSE_FAILED';}
  const records=store.listRuns(),all=[...await jsonl(join(folder,'worker-evidence.jsonl')),...await jsonl(join(folder,'answer-diagnostics.jsonl'))].sort((a,b)=>a.monotonicMs-b.monotonicMs);
  const evidence={runnerMode:'offline_fixture',actualWindowsLifecycle:true,providerRequests:0,transport:'controlled_fake_fetch',mode,workerPath,cwd,planHash:freeze.hash,records,
   events:records.map(r=>({runId:r.runId,events:store.eventsAfter(r.runId,0)})),terminals:await Promise.all(records.map(async r=>({runId:r.runId,terminal:await json(join(storeRoot,r.runId,'terminal.json'))}))),workerRecords:all,
   cleanups:scheduler?.cleanupEvidence.map(cleanupRow)??[],permitSnapshot:scheduler?.permits.snapshot()??null,safetyHold:scheduler?.safetyHold??null,strictGate:gate,permitSettlement:settlement,constructorCompleted:Boolean(scheduler),closeFailure};
  const archive=resolve('docs/implementation',`task-7x-v4-worker-evidence-${mode}-${Date.now()}-${randomUUID()}.json`);await writeFile(archive,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(`Immutable offline_fixture V4 Windows evidence: ${archive}`);
  await store.close();if(!closeFailure&&scheduler&&scheduler.cleanupEvidence.every(c=>c.confirmed)){const path=resolve(root);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('einstein task7x V4 离线 中文 '));await rm(path,{recursive:true,force:true});}if(closeFailure)throw Error(closeFailure);
 });
 scheduler=new Scheduler({store,snapshotPath,runnerMode:'offline_fixture',limits,createHost:callbacks=>new ProcessHost({...callbacks,cwd,workerPath,workerArgs:['--mode',mode,'--validation-freeze',planPath,'--validation-freeze-hash',sha256Bytes(bytes),'--fixture-evidence-folder',folder]})});
 await scheduler.submit(freeze.probe.input);
 if(mode==='parent_cancel'){
  const until=Date.now()+15000;let ready=false;
  while(Date.now()<until){
   const rows=await completeJsonl(join(folder,'worker-evidence.jsonl'));if(rows.filter(r=>r.kind==='v4.fetch.started'&&r.stage==='first').length===2){ready=true;break;}
   const current=store.getRun(freeze.probe.runId);if(['approved','failed','cancelled','insufficient'].includes(current.status))assert.fail(`Parent-cancel fixture ended as ${current.status} before two actual pending fetch invocations`);
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(ready,true,'wait for actual controlled fetch entry; never time cancellation by a guessed delay');await scheduler.cancel(freeze.probe.runId);
 }
 await scheduler.waitForIdle(55000);
 const record=store.getRun(freeze.probe.runId),events=store.eventsAfter(freeze.probe.runId,0),terminal=await json(join(storeRoot,freeze.probe.runId,'terminal.json'));
 const all=[...await jsonl(join(folder,'worker-evidence.jsonl')),...await jsonl(join(folder,'answer-diagnostics.jsonl'))].sort((a,b)=>a.monotonicMs-b.monotonicMs),cleanups=scheduler.cleanupEvidence.map(cleanupRow),permitSnapshot=scheduler.permits.snapshot();
 row={runId:freeze.probe.runId,runnerMode:'offline_fixture',expected:{companyId:freeze.probe.input.companyId,challengeId:freeze.probe.input.challengeId,researcherId:freeze.probe.researcherId},
  expectedInput:freeze.probe.input,expectedModel:freeze.model,expectedToolDefinitions:freeze.probe.toolDefinitions,expectedWorkerPath:workerPath,
  expectedFreezeHash:freeze.hash,expectedRawFreezeFileSha256:sha256Bytes(bytes),expectedPoolHash:freeze.probe.poolHash,expectedEvidenceSnapshotHash:freeze.probe.evidenceSnapshotHash,expectedSourceFiles:freeze.sourceFiles,expectedContractSha256:freeze.probe.contractSha256,
  effectiveInstructionText:freeze.probe.effectiveInstructionText,effectiveInstructionSha256:freeze.probe.effectiveInstructionSha256,genericDispatchSha256:freeze.promptContract.genericDispatchSha256,
  records:all,record,events,terminalOutcome:terminal?.outcome??null,cleanups,permitSnapshot,safetyHold:scheduler.safetyHold,errorCode:record.status==='failed'?terminal?.outcome.reasonCodes[0]??'WORKER_FAILED':null,publication:store.getPublication(record.runId)??null};
 gate=evaluateV4ProbeGate(row);settlement=verifyPermitSettlement({runId:record.runId,record,events,cleanup:scheduler.cleanupEvidence[0],snapshot:permitSnapshot,terminal,safetyHold:scheduler.safetyHold});
 assert.equal(record.cleanupState,'confirmed');assert.equal(scheduler.safetyHold,false);assert.equal(permitSnapshot.inFlight,0);assert.equal(permitSnapshot.runs.find(r=>r.runId===record.runId).pending,0);assert.equal(settlement.valid,true,JSON.stringify(settlement));
 assert.equal(row.publication,null);assert.equal(gate.liveEligible,false);assert.equal(events.some(e=>['artifact.validated','review.completed'].includes(e.type)),false);return{row,gate,freeze,settlement};
}
for(const mode of ['forward','reverse'])test(`offline_fixture V4 Windows entry ${mode} proves actual staged body/native/parent/cleanup chain`,native,async t=>{
 const x=await actualRun(t,mode);assert.equal(x.row.record.status,'insufficient');assert.equal(x.gate.passed,true,JSON.stringify(x.gate));assert.equal(x.row.records.filter(r=>r.kind==='v4.http.body').length,8);assert.equal(x.row.events.filter(e=>e.type==='permit.granted').length,4);assert.equal(x.settlement.chargedAttempts,4);assert.equal(x.row.records.filter(r=>r.type==='model.answer').length,2);
});
test('offline_fixture V4 Windows entry rejects second-response tools before native invoke and settles original permits after identity cleanup',native,async t=>{
 const x=await actualRun(t,'second_tools');assert.equal(x.row.record.status,'failed');assert.equal(x.gate.passed,false);assert.equal(x.row.records.filter(r=>r.type==='function_call.started').length,4);assert.equal(x.row.records.filter(r=>r.type==='model.answer').length,0);assert.equal(x.settlement.chargedAttempts,4);assert.ok(x.row.records.some(r=>r.kind==='probe.contract'&&r.code==='PROBE_CONTRACT_SECOND_RESPONSE_TOOLS'));
});
test('offline_fixture V4 Windows parent cancel crosses real IPC while both actual controlled fetches are pending',native,async t=>{
 const x=await actualRun(t,'parent_cancel');assert.equal(x.row.record.status,'cancelled');assert.equal(x.row.terminalOutcome.kind,'cancelled');assert.equal(x.gate.passed,false);
 assert.equal(x.row.records.filter(r=>r.kind==='v4.fetch.started').length,2);assert.equal(x.row.records.filter(r=>r.kind==='v4.fetch.headers').length,0);assert.equal(x.row.records.filter(r=>r.type==='function_call.started'||r.type==='model.answer').length,0);
 assert.equal(x.row.events.filter(e=>e.type==='permit.granted').length,2);assert.equal(x.settlement.chargedAttempts,2);assert.equal(x.settlement.permits.length,2);assert.ok(x.settlement.permits.every(p=>['explicit_release','confirmed_cleanup_reclaim'].includes(p.disposition)));
});
