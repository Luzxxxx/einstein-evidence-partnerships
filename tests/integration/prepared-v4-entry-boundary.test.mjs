// Real host pre-attempt boundary, isolated offline_fixture evidence only.
import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile,access} from 'node:fs/promises';import {join} from 'node:path';
import {runPreparedV4PreflightBoundary} from '../../dist/server/evaluation/v4-bounded-validation.js';
import {RunStore} from '../../dist/server/storage/run-store.js';import {ProcessHost} from '../../dist/server/supervisor/process-host.js';import {PermitManager} from '../../dist/server/supervisor/permits.js';
import {createPreparedV4Fixture} from '../helpers/prepared-v4-fixture.mjs';
import {hashArtifact} from '../../dist/server/evidence/hashing.js';
const effects={store:0,worker:0,permit:0,fetch:0},saved={store:RunStore.open,worker:ProcessHost.prototype.start,permit:PermitManager.prototype.acquire,fetch:globalThis.fetch};
test.before(()=>{
 RunStore.open=async()=>{effects.store++;throw Error('OFFLINE_FIXTURE_STORE_FORBIDDEN');};
 ProcessHost.prototype.start=function(){effects.worker++;throw Error('OFFLINE_FIXTURE_WORKER_FORBIDDEN');};
 PermitManager.prototype.acquire=function(){effects.permit++;throw Error('OFFLINE_FIXTURE_PERMIT_FORBIDDEN');};
 globalThis.fetch=async()=>{effects.fetch++;throw Error('OFFLINE_FIXTURE_FETCH_FORBIDDEN');};
});
test.after(()=>{RunStore.open=saved.store;ProcessHost.prototype.start=saved.worker;PermitManager.prototype.acquire=saved.permit;globalThis.fetch=saved.fetch;assert.deepEqual(effects,{store:0,worker:0,permit:0,fetch:0});});
async function noAttempt(x){await assert.rejects(access(join(x.root,x.p.preparation.globalAttemptFile)),{code:'ENOENT'});}
function withoutReport(tree,file){return{...tree,project:tree.project.filter(row=>row.file!==file)};}

test('a new candidate cannot reuse the archived assistant-content contract even with coherent hashes',async t=>{
 const x=await createPreparedV4Fixture(t),before=await x.tree();
 const historical=JSON.parse(await readFile('docs/implementation/task-7x-live/freeze.json','utf8'));
 const p=structuredClone(x.p);p.probe.contract=historical.probe.contract;p.probe.contractSha256=hashArtifact(p.probe.contract);p.hash=hashArtifact(p);
 await assert.rejects(runPreparedV4PreflightBoundary(p,x.options),/V4_STAGE_CONTRACT/);
 assert.deepEqual(await x.tree(),before);await noAttempt(x);
});
test('actual host boundary preserves complete configuration failure report before any admission or execution',async t=>{
 const x=await createPreparedV4Fixture(t),before=await x.tree(),expected=(await x.ref(x.candidateFreeze)).sha256;
 await assert.rejects(runPreparedV4PreflightBoundary(x.p,{...x.options,expectedRawFreezeFileSha256:expected,env:{...x.options.env,EINSTEIN_GATEWAY_API_KEY:''}}),e=>e.code==='TASK7Y_PREFLIGHT_FAILED'&&e.reportAlreadySaved===true&&e.preflightReport.checks.find(c=>c.name==='configuration').status==='failed');
 const path=x.candidateFolder+'/failed-execution-preflight.json',report=JSON.parse(await readFile(join(x.root,path),'utf8'));
 assert.equal(report.passed,false);assert.equal(report.phase,'execute');assert.equal(report.checks.find(c=>c.name==='store_file_set').status,'passed');
 assert.deepEqual(withoutReport(await x.tree(),path),before);await noAttempt(x);
});
test('actual host boundary accepts real producer offline material but cannot give it live execution authority',async t=>{
 const x=await createPreparedV4Fixture(t),before=await x.tree(),expected=(await x.ref(x.candidateFreeze)).sha256;
 const report=await runPreparedV4PreflightBoundary(x.p,{...x.options,expectedRawFreezeFileSha256:expected});
 assert.equal(report.passed,true);assert.equal(report.liveEligible,false);assert.equal(report.executionAuthority,false);
 const path=x.candidateFolder+'/execution-preflight.json';assert.deepEqual(JSON.parse(await readFile(join(x.root,path),'utf8')),report);
 assert.deepEqual(withoutReport(await x.tree(),path),before);await noAttempt(x);
});
test('actual host boundary rejects wrong original raw-freeze promise before execution',async t=>{
 const x=await createPreparedV4Fixture(t);
 await assert.rejects(runPreparedV4PreflightBoundary(x.p,{...x.options,expectedRawFreezeFileSha256:'0'.repeat(64)}),e=>e.code==='TASK7Y_PREFLIGHT_FAILED'&&e.preflightReport.checks.find(c=>c.name==='candidate_readback').status==='failed');
 await noAttempt(x);
});
test('diagnostic write failure is an error, preserves the earlier bytes, and cannot advance to admission',async t=>{
 const x=await createPreparedV4Fixture(t),path=join(x.root,x.candidateFolder,'failed-execution-preflight.json'),prior=Buffer.from('explicit offline immutable earlier evidence\n');await writeFile(path,prior,{flag:'wx'});
 await assert.rejects(runPreparedV4PreflightBoundary(x.p,{...x.options,env:{...x.options.env,EINSTEIN_GATEWAY_MODEL:'wrong-model'}}),{code:'EEXIST'});
 assert.deepEqual(await readFile(path),prior);await noAttempt(x);
});
