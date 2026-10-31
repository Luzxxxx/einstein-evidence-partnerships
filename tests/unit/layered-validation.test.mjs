import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,relative,isAbsolute} from 'node:path';import {randomUUID} from 'node:crypto';
import {validateLayeredPlan,runLayeredSequence,acquireLayeredAttempt} from '../../dist/server/evaluation/layered-validation.js';
import {hashArtifact} from '../../dist/server/evidence/hashing.js';import {input} from '../fixtures/contracts.mjs';
function plan(){const p=randomUUID(),l=randomUUID(),v={scope:'task7t_layered_protocol_then_single_L05',
 probe:{runId:p,input:{...input(),runId:p,mode:'adversarial'},researcherId:'R1008',contractVersion:'protocol-probe-v2'},
 l05:{runId:l,input:{...input(),runId:l,mode:'adversarial'},variantId:'L05'},
 limits:{probeRequests:4,l05Requests:16,totalRequests:20,requestTimeoutMs:40000,runTimeoutMs:180000,maxConcurrentModelRequests:2},automaticRetry:false,showcaseEligible:false};return{...v,hash:hashArtifact(v)};}
function row(runId,n=4){return{runId,status:'insufficient',record:{runId,runnerMode:'live',status:'insufficient',cleanupState:'confirmed'},
 errorCode:null,safetyHold:false,analysis:{passed:true,transportPassed:true,modelReceiptsPassed:true,evidenceComplete:true,executionPassed:true,cleanupConfirmed:true},
 events:Array.from({length:n},()=>({runId,type:'permit.granted',payload:{requestId:randomUUID(),permitId:randomUUID()}})),
 cleanups:[{runId,confirmed:true,exit:{exitObserved:true,closeObserved:true,exitCode:0}}],permitSnapshot:{inFlight:0,runs:[{runId,attempts:n,inFlight:0,pending:0}]}};}
test('new scope and contract cannot impersonate prior Task7s freeze or expand live budgets',()=>{
 assert.equal(validateLayeredPlan(plan()).probe.contractVersion,'protocol-probe-v2');
 for(const edit of [p=>p.scope='task7s_bounded_protocol_then_single_L05',p=>p.probe.contractVersion='protocol-probe-v1',p=>p.limits.probeRequests=5,
  p=>p.limits.l05Requests=17,p=>p.limits.totalRequests=21,p=>p.automaticRetry=true,p=>p.probe.runId=p.l05.runId,p=>p.l05.input.mode='research']){
  const p=plan();edit(p);p.hash=hashArtifact(p);assert.throws(()=>validateLayeredPlan(p));}
});
test('new independent attempt cannot be replayed with same or replacement Run IDs',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'einstein layered marker '));t.after(async()=>{const rel=relative(resolve(tmpdir()),resolve(dir));assert.ok(!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('einstein layered marker '));await rm(dir,{recursive:true,force:true});});
 const p=plan();await acquireLayeredAttempt(dir,p);const bytes=await readFile(join(dir,'attempt.json'));await assert.rejects(acquireLayeredAttempt(dir,p));await assert.rejects(acquireLayeredAttempt(dir,plan()));assert.deepEqual(await readFile(join(dir,'attempt.json')),bytes);
});
test('only full layered success starts unique L05, with maximum combined twenty new grants',async()=>{
 const p=plan();let count=0;const out=await runLayeredSequence(p,{probe:async()=>row(p.probe.runId),l05:async()=>{count++;const r=row(p.l05.runId,16);r.record.status='approved';r.l05Analysis={structuralChainObserved:true};return r;}});
 assert.equal(count,1);assert.equal(out.totalGranted,20);assert.equal(out.stopReason,null);
});
for(const [name,edit] of Object.entries({transport:r=>r.analysis.transportPassed=false,model:r=>r.analysis.modelReceiptsPassed=false,evidence:r=>r.analysis.evidenceComplete=false,
 execution:r=>r.analysis.executionPassed=false,cleanup:r=>r.cleanups[0].confirmed=false,hold:r=>r.safetyHold=true,request:r=>r.permitSnapshot.inFlight=1,
 pending:r=>r.permitSnapshot.runs[0].pending=1,cross:r=>r.runId=randomUUID(),incomplete:r=>r.analysis.passed=false}))test(`${name} failure creates no L05 callback`,async()=>{
 const p=plan();let count=0;const out=await runLayeredSequence(p,{probe:async()=>{const r=row(p.probe.runId);edit(r);return r;},l05:async()=>{count++;throw Error('MUST_NOT_RUN');}});assert.equal(count,0);assert.equal(out.rows[1].status,'unexecuted');assert.ok(out.stopReason);
});
test('exceptions and v1-only approve stop without retry, later requests or replacement IDs',async()=>{
 const p=plan();let count=0;const out=await runLayeredSequence(p,{probe:async()=>{throw Error('PRIVATE_UNKNOWN_BODY');},l05:async()=>{count++;return row(p.l05.runId);}});
 assert.equal(count,0);assert.equal(JSON.stringify(out).includes('PRIVATE_UNKNOWN_BODY'),false);
 const v1=await runLayeredSequence(p,{probe:async()=>row(p.probe.runId),l05:async()=>{count++;const r=row(p.l05.runId);r.record.status='approved';return r;}});assert.equal(count,1);assert.equal(v1.stopReason,'L05_TARGET_NOT_ACHIEVED');
});
