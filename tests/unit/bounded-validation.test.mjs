import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireBoundedAttempt,runConditionalValidation,validateBoundedPlan,finalizeBoundedEvidence} from '../../dist/server/evaluation/bounded-validation.js';
import {hashArtifact} from '../../dist/server/evidence/hashing.js';
import {input} from '../fixtures/contracts.mjs';

// Offline control/IO fixtures only; no worker, store, key or model is opened here.
function plan(){const p=randomUUID(),l=randomUUID();const x={scope:'task7s_bounded_protocol_then_single_L05',
 probe:{runId:p,input:{...input(),runId:p,mode:'adversarial'},researcherId:'R0001'},
 l05:{runId:l,input:{...input(),runId:l,mode:'adversarial'},variantId:'L05'},
 limits:{probeRequests:4,l05Requests:16,totalRequests:20,requestTimeoutMs:40000,runTimeoutMs:180000,maxConcurrentModelRequests:2},
 automaticRetry:false,showcaseEligible:false};return {...x,hash:hashArtifact(x)};}
function result(runId,grants=4,valid=true){return{runId,analysis:{valid},errorCode:null,safetyHold:false,
 events:Array.from({length:grants},(_,i)=>({runId,type:'permit.granted',payload:{requestId:randomUUID(),permitId:randomUUID()},seq:i+1})),
 permitSnapshot:{inFlight:0,runs:[{runId,attempts:grants,inFlight:0,pending:0}]},cleanups:[{runId,confirmed:true}],record:{runId,status:'insufficient',cleanupState:'confirmed'}};}

test('frozen plan is exactly one probe and one distinct adversarial L05 with 4/16/20 hard limits',()=>{
 assert.equal(validateBoundedPlan(plan()).limits.totalRequests,20);
 for(const edit of [x=>x.probe.runId=x.l05.runId,x=>x.l05.variantId='L01',x=>x.l05.input.mode='research',
  x=>x.limits.probeRequests=5,x=>x.limits.l05Requests=17,x=>x.limits.totalRequests=21,
  x=>x.limits.maxConcurrentModelRequests=3,x=>x.automaticRetry=true,x=>x.showcaseEligible=true,x=>x.hash='f'.repeat(64)]){
  const x=plan();edit(x);assert.throws(()=>validateBoundedPlan(x));
 }
});

test('exclusive durable attempt marker refuses duplicate invocation and keeps original frozen identity',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'einstein bounded marker '));t.after(async()=>{const r=relative(resolve(tmpdir()),resolve(folder));assert.ok(!isAbsolute(r)&&!r.startsWith('..')&&r.startsWith('einstein bounded marker '));await rm(folder,{recursive:true,force:true});});
 const p=plan();await acquireBoundedAttempt(folder,p);const before=await readFile(join(folder,'attempt.json'));
 await assert.rejects(acquireBoundedAttempt(folder,p));await assert.rejects(acquireBoundedAttempt(folder,plan()));
 assert.deepEqual(await readFile(join(folder,'attempt.json')),before);const marker=JSON.parse(before);assert.equal(marker.freezeHash,p.hash);assert.equal(marker.probeRunId,p.probe.runId);assert.equal(marker.l05RunId,p.l05.runId);
});

test('only complete protocol success permits exactly one L05 callback, combined grants never include old history',async()=>{
 const p=plan(),calls=[];const out=await runConditionalValidation(p,{probe:async()=>{calls.push('probe');return result(p.probe.runId);},
  l05:async()=>{calls.push('L05');return result(p.l05.runId,16);}});
 assert.deepEqual(calls,['probe','L05']);assert.equal(out.totalGranted,20);assert.equal(out.rows.length,2);assert.equal(out.rows[1].runId,p.l05.runId);
});

test('protocol failure, single-call unverified, identity error, hold, cleanup and permit residual all stop before L05',async t=>{
 for(const [name,edit] of Object.entries({protocol:r=>r.analysis.valid=false,single:r=>{r.analysis.valid=false;r.analysis.multiCallObserved=false;},
  identity:r=>r.runId=randomUUID(),error:r=>r.errorCode='CONTEXT_MISMATCH',hold:r=>r.safetyHold=true,
  cleanup:r=>r.cleanups[0].confirmed=false,residual:r=>r.permitSnapshot.inFlight=1,budget:r=>r.events.push({...r.events[0],payload:{requestId:randomUUID(),permitId:randomUUID()}}),
  duplicate:r=>r.events[1]=structuredClone(r.events[0]),wrong_snapshot:r=>r.permitSnapshot.runs[0].runId=randomUUID()}))await t.test(name,async()=>{
  const p=plan();let count=0;const out=await runConditionalValidation(p,{probe:async()=>{const r=result(p.probe.runId);edit(r);return r;},l05:async()=>{count++;throw Error('MUST_NOT_EXECUTE');}});
  assert.equal(count,0);assert.equal(out.rows[1].status,'unexecuted');assert.equal(out.rows[1].runId,p.l05.runId);assert.ok(out.stopReason);
 });
});

test('probe or L05 exception never retries or creates replacement IDs',async()=>{
 const p=plan();let probes=0,l05=0;const out=await runConditionalValidation(p,{probe:async()=>{probes++;throw Error('PRIVATE_PROVIDER_TEXT');},l05:async()=>{l05++;return{};}});
 assert.equal(probes,1);assert.equal(l05,0);assert.equal(out.rows[0].runId,p.probe.runId);assert.equal(out.rows[1].runId,p.l05.runId);assert.equal(JSON.stringify(out).includes('PRIVATE_PROVIDER_TEXT'),false);
 const second=await runConditionalValidation(p,{probe:async()=>result(p.probe.runId),l05:async()=>{l05++;throw Error('PRIVATE_PROVIDER_TEXT');}});
 assert.equal(l05,1);assert.ok(second.stopReason);assert.equal(second.rows.length,2);
});

test('actual PermitManager snapshot shape has per-Run pending, no invented global waiting field',async()=>{
 const p=plan();let count=0;
 const actualResult=id=>({...result(id),permitSnapshot:{inFlight:0,runs:[{runId:id,attempts:4,inFlight:0,pending:0,stopped:true,stopCode:'WORKER_OUTCOME'}]}});
 const out=await runConditionalValidation(p,{probe:async()=>actualResult(p.probe.runId),l05:async()=>{count++;return actualResult(p.l05.runId);}});
 assert.equal(count,1);assert.equal(out.rows[1].runId,p.l05.runId);
});

test('close or integrity failure still saves safe stop summary, never loses final evidence to an early throw',async()=>{
 for(const failure of ['close','integrity']){
  let saved;const outcome=await finalizeBoundedEvidence({close:async()=>{if(failure==='close')throw Error('BOUNDED_STORE_CLOSE_FAILED');},
   verify:async()=>{if(failure==='integrity')throw Error('BOUNDED_HISTORY_CHANGED');},save:async value=>{saved=value;},summary:{scope:'offline_fixture',errorCode:null}});
  assert.ok(saved);assert.equal(outcome,saved);assert.equal(saved.historyUnchanged,failure!=='integrity');
  assert.equal(saved.errorCode,failure==='close'?'BOUNDED_STORE_CLOSE_FAILED':'BOUNDED_HISTORY_CHANGED');
 }
});

test('a rejected probe ledger still reports all observed grants rather than zeroing failed usage',async()=>{
 const p=plan();const out=await runConditionalValidation(p,{probe:async()=>result(p.probe.runId,5),l05:async()=>{throw Error('UNEXECUTED');}});
 assert.equal(out.totalGranted,5);assert.equal(out.rows[1].status,'unexecuted');
});
