import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';
import {acquireV4Attempt,runV4Sequence,assertV4DecisionBinding} from '../../dist/server/evaluation/v4-bounded-validation.js';
import {buildV4PlanFixture} from '../fixtures/probe-v4-plan.mjs';
import {validateV4Plan} from '../../dist/server/evaluation/protocol-probe-v4-plan.js';
import {hashArtifact} from '../../dist/server/evidence/hashing.js';
test('V4 one-attempt marker is exclusive fsynced and has only four requests and no L05 allowance',async()=>{
 const p=await buildV4PlanFixture(),folder=await mkdtemp(join(tmpdir(),'einstein task7x marker offline '));
 try{await acquireV4Attempt(folder,p);const marker=JSON.parse(await readFile(join(folder,'attempt.json'),'utf8'));
  assert.equal(marker.maxGrantedRequests,4);assert.equal(marker.probeRunId,p.probe.runId);assert.equal(marker.freezeHash,p.hash);assert.equal(marker.automaticRetry,false);assert.equal('l05RunId'in marker,false);
  await assert.rejects(acquireV4Attempt(folder,p));
 }finally{const target=resolve(folder);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('einstein task7x marker offline '));await rm(target,{recursive:true,force:true});}
});
test('V4 failure callback runs once with no retry and has no conditional L05 route',async()=>{
 const p=await buildV4PlanFixture();let count=0;
 const result=await runV4Sequence(p,async()=>{count++;return{runId:p.probe.runId,runnerMode:'live',record:{runId:p.probe.runId,status:'failed'},events:[],records:[],cleanups:[],permitSnapshot:{inFlight:0,runs:[]},safetyHold:true,errorCode:'OFFLINE_SYNTHETIC_STOP'};});
 assert.equal(count,1);assert.equal(result.passed,false);assert.ok(result.stopReason);assert.equal(result.L05Executed,false);assert.equal(result.totalGranted,0);
});
test('V4 thrown first execution stops once and cannot fall through to another Run',async()=>{
 const p=await buildV4PlanFixture();let count=0;
 const result=await runV4Sequence(p,async()=>{count++;throw Error('OFFLINE_SYNTHETIC_STOP');});
 assert.equal(count,1);assert.equal(result.passed,false);assert.equal(result.L05Executed,false);assert.equal(result.totalGranted,null,'a thrown callback cannot prove that zero requests occurred');
});
test('V4 existing decision validates exact authorization content, not only file digests, before any Store open',async()=>{
 const p=structuredClone(await buildV4PlanFixture()),baseline=JSON.parse(await readFile('docs/implementation/task-7x-baseline.json','utf8'));
 const auth=await readFile('docs/implementation/task-7s-authorization.json'),resolution=await readFile('tests/fixtures/historical-recovery/historical-recovery/897203e4-d779-4c3e-8696-52ce718d537e.resolution.json');
 assert.doesNotThrow(()=>assertV4DecisionBinding(validateV4Plan(p),auth,resolution,baseline.existingAuthorization.sha256,baseline.existingResolution.sha256));
 p.existingAuthorization.authorizedAt='2026-10-31T00:00:00.000Z';p.hash=hashArtifact(p);
 assert.throws(()=>assertV4DecisionBinding(validateV4Plan(p),auth,resolution,baseline.existingAuthorization.sha256,baseline.existingResolution.sha256),/V4_EXISTING_DECISION_CHANGED/);
});
test('V4 missing parent permit snapshot cannot be reported as zero granted attempts',async()=>{
 const p=await buildV4PlanFixture();let calls=0;
 const result=await runV4Sequence(p,async()=>{calls++;return{runId:p.probe.runId,runnerMode:'live',record:{runId:p.probe.runId,status:'failed'},events:[],records:[],cleanups:[],safetyHold:true,errorCode:'OFFLINE_SYNTHETIC_MISSING_LEDGER'};});
 assert.equal(calls,1);assert.equal(result.passed,false);assert.equal(result.totalGranted,null);
});
