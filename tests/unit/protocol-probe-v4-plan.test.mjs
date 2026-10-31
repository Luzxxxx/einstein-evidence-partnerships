import test from 'node:test';import assert from 'node:assert/strict';
import {validateV4Plan} from '../../dist/server/evaluation/protocol-probe-v4-plan.js';
import {hashArtifact} from '../../dist/server/evidence/hashing.js';
import {buildV4PlanFixture} from '../fixtures/probe-v4-plan.mjs';
const rehash=x=>({...x,hash:hashArtifact(x)});
test('V4 full plan is frozen and probe-only with exact input/source/tool policy bindings',async()=>{
 const p=validateV4Plan(await buildV4PlanFixture());assert.equal(p.scope,'task7x_v4_protocol_only');assert.equal(Object.isFrozen(p),true);
 assert.equal(p.limits.totalRequests,4);assert.equal(p.limits.probeRequests,4);assert.equal(p.limits.perContextRequests,2);
 assert.equal('l05' in p,false);assert.equal(p.probe.toolDefinitions.length,2);assert.equal(p.probe.input.runId,p.probe.runId);
});
for(const fault of ['l05','budget','perContext','mode','inputHash','poolHash','candidate','userTask','instruction','generic','source','tool','runtimeChange','worker'])test('V4 plan rejects '+fault+' despite a self-consistent rehash',async()=>{
 const p=structuredClone(await buildV4PlanFixture());
 if(fault==='l05')p.l05={runId:p.probe.runId};
 if(fault==='budget')p.limits.totalRequests=20;
 if(fault==='perContext')p.limits.perContextRequests=3;
 if(fault==='mode')p.probe.input.mode='research';
 if(fault==='inputHash')p.probe.inputHash='0'.repeat(64);
 if(fault==='poolHash')p.probe.poolHash='0'.repeat(64);
 if(fault==='candidate')p.probe.researcherId='R9999';
 if(fault==='userTask')p.probe.userTask.challengeId='C001-CH2';
 if(fault==='instruction')p.promptContract.probeInstruction+=' weakened';
 if(fault==='generic')p.promptContract.genericDispatchText='Return a proposal';
 if(fault==='source')p.sourceFiles[0].sourceFileSha256='0'.repeat(64);
 if(fault==='tool')p.probe.toolDefinitions[0].name='read_evidence_record';
 if(fault==='runtimeChange')p.approvedRuntimeChanges[0].file='src/model/gateway-runner.ts';
 if(fault==='worker')p.workerPath='dist/server/evaluation/protocol-probe-worker-v3.js';
 assert.throws(()=>validateV4Plan(rehash(p)));
});
