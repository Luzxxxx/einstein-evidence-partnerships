// A current-contract regression, not a reclassification of the failed archive.
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {evaluateV4ProbeGate} from '../../dist/server/evaluation/protocol-probe-v4-gate.js';
import {buildV4GateFixture} from '../fixtures/v4-gate.mjs';
const archive='docs/implementation/task-7x-v4-worker-evidence-forward-1793436712982-3d45253e-4dfd-49fc-9aac-c6fbb350d6e4.json';
test('the actual failed offline Windows archive retains confirmed replacement evidence and its original failed gate',async()=>{
 const raw=await readFile(archive),a=JSON.parse(raw.toString('utf8')),c=a.cleanups[0],d=c.descendants[0];
 assert.equal(createHash('sha256').update(raw).digest('hex'),'96c8758d76855a348e0e00f78618890bc3d153e41659fc11ac16565f6616ab4d');
 assert.equal(a.runnerMode,'offline_fixture');assert.equal(a.actualWindowsLifecycle,true);assert.equal(a.providerRequests,0);
 assert.equal(c.confirmed,true);assert.equal(c.rootVerification,'absent');assert.equal(c.exit.exitObserved,true);assert.equal(c.exit.closeObserved,true);assert.deepEqual(c.scanDiagnostics,[]);
 assert.equal(d.verification,'identity_replaced');assert.equal(d.termination,null);assert.equal(d.identity.parentPid,c.identity.pid);
 assert.ok(BigInt(d.identity.creationFileTime)>=BigInt(c.identity.creationFileTime));
 assert.equal(a.strictGate.passed,false);assert.deepEqual(a.strictGate.reasons,['V4_DESCENDANT_IDENTITY_UNCONFIRMED']);
 assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'),createHash('sha256').update(raw).digest('hex'));
});
test('current V4 gate accepts the actual producer identity_replaced status without mutating cleanup evidence',()=>{
 const p=buildV4GateFixture();p.cleanups[0].descendants[0].verification='identity_replaced';
 const before=JSON.stringify(p),r=evaluateV4ProbeGate(p);assert.equal(r.passed,true,JSON.stringify(r));assert.equal(r.liveEligible,false);assert.equal(JSON.stringify(p),before);
});
for(const status of ['unknown','still_present','mismatch'])test('current V4 gate rejects unsupported or unresolved descendant status '+status,()=>{
 const p=buildV4GateFixture();p.cleanups[0].descendants[0].verification=status;
 const r=evaluateV4ProbeGate(p);assert.equal(r.passed,false);assert.ok(r.reasons.includes('V4_DESCENDANT_IDENTITY_UNCONFIRMED'));
});
test('replacement status cannot bypass missing birth, wrong parent, a cleanup hold or a missing close',()=>{
 for(const attack of ['birth','parent','hold','close']){
  const p=buildV4GateFixture();p.cleanups[0].descendants[0].verification='identity_replaced';
  if(attack==='birth')delete p.cleanups[0].descendants[0].identity.creationFileTime;
  if(attack==='parent')p.cleanups[0].descendants[0].identity.parentPid=99999;
  if(attack==='hold')p.safetyHold=true;
  if(attack==='close')p.cleanups[0].exit.closeObserved=false;
  assert.equal(evaluateV4ProbeGate(p).passed,false,attack);
 }
});
