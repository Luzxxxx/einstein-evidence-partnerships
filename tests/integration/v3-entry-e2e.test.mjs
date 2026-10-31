import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';import {fileURLToPath} from 'node:url';
import {Scheduler} from '../../dist/server/supervisor/scheduler.js';import {ProcessHost} from '../../dist/server/supervisor/process-host.js';import {RunStore} from '../../dist/server/storage/run-store.js';
import {DEFAULT_LIMITS} from '../../dist/server/contracts/config.js';import {sha256Bytes} from '../../dist/server/evidence/hashing.js';
import {evaluateV3ProbeGate} from '../../dist/server/evaluation/protocol-probe-v3-gate.js';import {runV3Sequence} from '../../dist/server/evaluation/v3-bounded-validation.js';
import {buildV3PlanFixture} from '../fixtures/v3-plan.mjs';

// Actual Windows host, parent admission/permit IPC, child bootstrap and NEW
// configureV3Probe. Only model responses are offline_fixture. This independent
// temporary store is never a historical-store recovery, live freeze or attempt.
const native={skip:process.platform!=='win32',timeout:90000};
const workerPath=fileURLToPath(new URL('../fixtures/v3-entry-worker.mjs',import.meta.url));
const snapshotPath=fileURLToPath(new URL('../../reference/einstein-matchmaker-data/',import.meta.url));
const json=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const jsonl=async path=>{try{return(await readFile(path,'utf8')).split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));}catch(e){if(e.code==='ENOENT')return[];throw e;}};
const cleanupRow=cleanup=>{const{stdout,stderr,...exit}=cleanup.exit;return{...cleanup,exit,outputHashes:{stdout:sha256Bytes(Buffer.from(stdout)),stderr:sha256Bytes(Buffer.from(stderr))}};};
async function actualRun(t,mode){
  const freeze=await buildV3PlanFixture(),root=await mkdtemp(join(tmpdir(),'einstein task7v entry 离线 中文 ')),storeRoot=join(root,'offline store'),cwd=join(root,'empty worker cwd'),evidenceFolder=join(root,'worker evidence');
  await mkdir(cwd);await mkdir(evidenceFolder);const planPath=join(root,'offline-fixture-plan.json'),planBytes=Buffer.from(JSON.stringify(freeze));await writeFile(planPath,planBytes,{flag:'wx'});
  const store=await RunStore.open(storeRoot),limits={...DEFAULT_LIMITS,maxModelRequests:4};
  const scheduler=new Scheduler({store,snapshotPath,runnerMode:'offline_fixture',limits,createHost:callbacks=>new ProcessHost({...callbacks,cwd,workerPath,
    workerArgs:['--mode',mode,'--fixture-plan',planPath,'--fixture-plan-hash',sha256Bytes(planBytes),'--fixture-evidence-folder',evidenceFolder]})});
  let row=null,gate=null,sequence=null,l05Calls=0;
  t.after(async()=>{
    let closeFailure=null;try{await scheduler.close();}catch{closeFailure='OFFLINE_FIXTURE_CLOSE_FAILED';}
    const allRecords=[...await jsonl(join(evidenceFolder,'worker-evidence.jsonl')),...await jsonl(join(evidenceFolder,'answer-diagnostics.jsonl'))].sort((a,b)=>a.monotonicMs-b.monotonicMs);
    const evidence={runnerMode:'offline_fixture',mode,actualNativeWorkerLifecycle:'Task7v_configureV3Probe',fixturePath:workerPath,isolatedNewWorkerCwd:cwd,
      plannedRunId:freeze.probe.runId,planHash:freeze.hash,records:store.listRuns(),events:store.listRuns().map(r=>({runId:r.runId,events:store.eventsAfter(r.runId,0)})),
      workerRecords:allRecords,cleanups:scheduler.cleanupEvidence.map(cleanupRow),permitSnapshot:scheduler.permits.snapshot(),safetyHold:scheduler.safetyHold,
      strictGate:gate,sequence,l05Calls,closeFailure};
    const archive=resolve('docs/implementation',`task-7v-e2e-evidence-${mode}-${Date.now()}-${randomUUID()}.json`);
    await writeFile(archive,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(`Immutable offline_fixture Task7v entry evidence: ${archive}`);
    await store.close();if(!closeFailure&&scheduler.cleanupEvidence.every(c=>c.confirmed)){
      const path=resolve(root);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('einstein task7v entry 离线 中文 '));await rm(path,{recursive:true,force:true});}
    if(closeFailure)throw Error(closeFailure);
  });
  await scheduler.submit(freeze.probe.input);await scheduler.waitForIdle(50000);
  const record=store.getRun(freeze.probe.runId),events=store.eventsAfter(freeze.probe.runId,0),terminal=await json(join(storeRoot,freeze.probe.runId,'terminal.json'));
  const workerRecords=[...await jsonl(join(evidenceFolder,'worker-evidence.jsonl')),...await jsonl(join(evidenceFolder,'answer-diagnostics.jsonl'))].sort((a,b)=>a.monotonicMs-b.monotonicMs);
  row={runId:freeze.probe.runId,runnerMode:'offline_fixture',expected:{companyId:freeze.probe.input.companyId,challengeId:freeze.probe.input.challengeId,researcherId:freeze.probe.researcherId},
    effectiveInstructionSha256:freeze.probe.effectiveInstructionSha256,genericDispatchSha256:freeze.promptContract.genericDispatchSha256,records:workerRecords,
    record,events,terminalOutcome:terminal?.outcome??null,cleanups:scheduler.cleanupEvidence.map(cleanupRow),permitSnapshot:scheduler.permits.snapshot(),
    safetyHold:scheduler.safetyHold,errorCode:null,publication:store.getPublication(freeze.probe.runId)??null};
  gate=evaluateV3ProbeGate(row);
  sequence=await runV3Sequence(freeze,{probe:async()=>row,l05:async()=>{l05Calls++;throw Error('OFFLINE_FIXTURE_L05_MUST_NOT_RUN');}});
  assert.equal(record.cleanupState,'confirmed');assert.equal(scheduler.safetyHold,false);assert.equal(row.permitSnapshot.inFlight,0);
  assert.equal(row.permitSnapshot.runs.find(r=>r.runId===row.runId).pending,0);assert.equal(row.publication,null);
  assert.equal(l05Calls,0);assert.equal(sequence.rows[1].status,'unexecuted');assert.equal(gate.liveEligible,false);
  const cleanup=row.cleanups[0];
  assert.ok(cleanup.confirmed&&cleanup.exit.exitObserved&&cleanup.exit.closeObserved);
  assert.equal(cleanup.identity.pid,cleanup.exit.pid);assert.match(cleanup.identity.creationFileTime,/^\d{17,20}$/);assert.equal(cleanup.scanDiagnostics.length,0);
  assert.ok(['absent','identity_replaced'].includes(cleanup.rootVerification),'The registered original identity must be gone; unknown/still_present never qualifies.');
  return{row,gate,freeze,sequence};
}
for(const mode of ['forward','reverse'])test(`offline_fixture actual new V3 entry ${mode} order passes the strict gate with parent facts but never grants live/L05 eligibility`,native,async t=>{
  const x=await actualRun(t,mode);assert.equal(x.gate.passed,true,JSON.stringify(x.gate));assert.equal(x.row.record.status,'insufficient');
  assert.equal(x.row.events.filter(e=>e.type==='permit.granted').length,4);assert.equal(x.row.records.filter(r=>r.kind==='wire.effective_prompt').length,4);
  assert.equal(x.row.records.filter(r=>r.kind==='native'&&r.type==='function_call.completed').length,4);
  assert.ok(x.gate.firstAnalysisOverlapMs>0);assert.equal(x.gate.maxObservedInFlight,2);
  assert.equal(x.gate.permitAccounting.length,4);assert.ok(x.gate.permitAccounting.every(p=>['explicit_release','confirmed_cleanup_reclaim'].includes(p.disposition)));
});
test('offline_fixture actual new V3 entry rejects the entire first four-call batch with zero native tools and zero L05 callback',native,async t=>{
  const x=await actualRun(t,'first_four');assert.equal(x.gate.passed,false);assert.equal(x.row.record.status,'failed');
  assert.ok(x.row.terminalOutcome.reasonCodes.includes('PROBE_CONTRACT_FIRST_BATCH_COUNT'));
  assert.equal(x.row.records.some(r=>r.kind==='native'&&r.type==='function_call.started'),false);
  assert.equal(x.row.records.some(r=>r.kind==='tool.batch'),false);
  assert.equal(x.row.events.filter(e=>e.type==='permit.granted').length,2);assert.equal(x.row.permitSnapshot.runs.find(r=>r.runId===x.row.runId).attempts,2);
  assert.ok(x.row.records.some(r=>r.kind==='probe.contract'&&r.status==='rejected'&&r.code==='PROBE_CONTRACT_FIRST_BATCH_COUNT'));
});
