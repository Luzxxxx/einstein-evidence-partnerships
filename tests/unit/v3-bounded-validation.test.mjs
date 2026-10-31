import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {join,resolve,sep} from 'node:path';import {tmpdir} from 'node:os';
import {validateV3Plan,acquireV3Attempt,runV3Sequence,collectV3ProductFingerprints,verifyV3FrozenSources,verifyV3History} from '../../dist/server/evaluation/v3-bounded-validation.js';
import {hashArtifact,hashRunInput,sha256Bytes} from '../../dist/server/evidence/hashing.js';
import {buildV3PlanFixture} from '../fixtures/v3-plan.mjs';
import {buildV3GateFixture} from '../fixtures/v3-gate.mjs';

test('new executable freeze requires actual V3 policy, contract, full bindings and fixed budgets even after self-rehash',async()=>{
 const p=await buildV3PlanFixture();assert.equal(validateV3Plan(p).scope,'task7v_v3_protocol_then_single_L05');
 for(const edit of [v=>delete v.productFingerprints,v=>delete v.sourceIntegrity,v=>delete v.engineeringGate,
  v=>v.scope='task7t_layered_protocol_then_single_L05',v=>v.probe.contractVersion='protocol-probe-v2',v=>v.probe.contract.firstBatch.count=4,
  v=>v.promptContract.probeInstruction+=' business task',v=>v.promptContract.genericDispatchText='other',v=>v.probe.poolHash='0'.repeat(64),
  v=>v.l05.controlledSeedHash='0'.repeat(64),v=>v.probe.runId='00000000-0000-4000-8000-000000000001',
  v=>v.limits.totalRequests=21,v=>v.limits.probeRequests=5,v=>v.automaticRetry=true,v=>v.showcaseEligible=true]){
   const changed=structuredClone(p);edit(changed);changed.hash=hashArtifact(changed);assert.throws(()=>validateV3Plan(changed));
 }
});
test('same-scope marker is exclusive and remains after a rejected repeat or replacement IDs',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'einstein v3 attempt offline '));t.after(async()=>{const p=resolve(dir);assert.ok(p.startsWith(resolve(tmpdir())+sep)&&p.includes('einstein v3 attempt offline '));await rm(p,{recursive:true,force:true});});
 const p=await buildV3PlanFixture();await acquireV3Attempt(dir,p);const old=await readFile(join(dir,'attempt.json'));await assert.rejects(acquireV3Attempt(dir,p));await assert.rejects(acquireV3Attempt(dir,await buildV3PlanFixture()));assert.deepEqual(await readFile(join(dir,'attempt.json')),old);
});
test('a self-consistent replacement of the frozen interface document cannot pass actual byte preflight',async()=>{
 const p=await buildV3PlanFixture();p.productFingerprints=await collectV3ProductFingerprints();p.hash=hashArtifact(p);await verifyV3FrozenSources(validateV3Plan(p));
 p.promptContract.interfaceContract.text+='\nControlled offline replacement; original file is never edited.';
 p.promptContract.interfaceContract.sha256=sha256Bytes(Buffer.from(p.promptContract.interfaceContract.text,'utf8'));p.hash=hashArtifact(p);
 await assert.rejects(verifyV3FrozenSources(validateV3Plan(p)),/V3_INTERFACE_CONTRACT_CHANGED/);
});
test('the executable freeze cannot omit the full initial business tasks',async()=>{
 const p=await buildV3PlanFixture();delete p.promptContract.initialBusinessTasks;p.hash=hashArtifact(p);assert.throws(()=>validateV3Plan(p));
});
test('history protection must bind the exact original baseline bytes instead of accepting a new store pointer',async()=>{
 const p=await buildV3PlanFixture();p.baseline={file:'docs/implementation/task-7v-baseline.json',sha256:'0'.repeat(64),storeRoot:p.existingAuthorization.storeRoot};p.hash=hashArtifact(p);
 await assert.rejects(verifyV3History(p),/V3_BASELINE_CHANGED/);
});
test('strict full probe failure and misleading booleans cannot start any L05 callback',async()=>{
 const x=buildV3GateFixture(),p=await buildV3PlanFixture(x.runId);let l05=0;
 const result=await runV3Sequence(p,{probe:async()=>({...x,analysis:{passed:true},errorCode:'OFFLINE_FIXTURE_FAILURE'}),l05:async()=>{l05++;throw Error('MUST_NOT_EXECUTE');}});
 assert.equal(l05,0);assert.equal(result.rows[1].status,'unexecuted');assert.ok(result.stopReason);assert.equal(result.totalGranted,4);
});
test('offline fixture success is not live eligibility and cannot launch the real L05 callback',async()=>{
 const x=buildV3GateFixture({runnerMode:'offline_fixture'}),p=await buildV3PlanFixture(x.runId);let count=0;
 const result=await runV3Sequence(p,{probe:async()=>x,l05:async()=>{count++;throw Error('NO_LIVE');}});assert.equal(count,0);assert.equal(result.rows[1].status,'unexecuted');
});
test('unexpected probe exception stops this unique attempt and never retries or leaks its message',async()=>{
 const p=await buildV3PlanFixture();let probe=0,l05=0;const r=await runV3Sequence(p,{probe:async()=>{probe++;throw Error('OFFLINE_FIXTURE_PRIVATE_DETAIL');},l05:async()=>{l05++;throw Error('UNREACHABLE');}});
 assert.equal(probe,1);assert.equal(l05,0);assert.equal(r.rows[1].status,'unexecuted');assert.equal(JSON.stringify(r).includes('PRIVATE_DETAIL'),false);
});

async function matched(){const x=buildV3GateFixture({researcherId:'R1008'}),p=await buildV3PlanFixture(x.runId);x.record.input=p.probe.input;x.record.inputHash=hashRunInput(p.probe.input);return{x,p};}
test('complete controlled live-shaped probe alone permits precisely one L05 callback, then insufficient stops without retry',async()=>{
 const {x,p}=await matched();let count=0;const out=await runV3Sequence(p,{probe:async()=>x,l05:async()=>{count++;return{runId:p.l05.runId,runnerMode:'live',errorCode:null,safetyHold:false,
  record:{runId:p.l05.runId,input:p.l05.input,inputHash:hashRunInput(p.l05.input),status:'insufficient',cleanupState:'confirmed'},
  cleanups:[{runId:p.l05.runId,confirmed:true}],permitSnapshot:{inFlight:0,runs:[{runId:p.l05.runId,attempts:3,inFlight:0,pending:0}]},events:[]};}});
 assert.equal(count,1);assert.equal(out.totalGranted,7);assert.equal(out.stopReason,'L05_TARGET_NOT_ACHIEVED');
});
for(const field of ['datasetCommit','promptVersion','configVersion','mode','inputHash'])test(`frozen full input ${field} mismatch prevents any L05 callback even when four IDs still match`,async()=>{
 const {x,p}=await matched();x.record.input=structuredClone(x.record.input);if(field==='inputHash')x.record.inputHash='0'.repeat(64);else x.record.input[field]=field==='mode'?'research':'different';
 let n=0;const out=await runV3Sequence(p,{probe:async()=>x,l05:async()=>{n++;throw Error('UNREACHABLE');}});assert.equal(n,0);assert.equal(out.rows[1].status,'unexecuted');
});
