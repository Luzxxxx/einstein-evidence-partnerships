import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {buildV4PlanFixture} from '../fixtures/probe-v4-plan.mjs';
import {validateV4Plan,v4CandidateFolder,validatePreparedV4Location} from '../../dist/server/evaluation/protocol-probe-v4-plan.js';
import {hashArtifact,sha256Bytes} from '../../dist/server/evidence/hashing.js';
async function prepared(){
 const p=structuredClone(await buildV4PlanFixture()),raw=await readFile('docs/implementation/task-7y-authorization.json'),a=JSON.parse(raw),id=randomUUID();
 p.preparation={schemaVersion:1,task:'Task7y',candidateId:id,candidateFolder:a.candidateRoot+'/'+id,authorizationId:a.authorizationId,
  authorizationFile:'docs/implementation/task-7y-authorization.json',authorizationFileSha256:sha256Bytes(raw),globalAttemptFile:a.globalAttemptFile,
  baselineFile:a.baselineFile,baselineSha256:a.baselineSha256};
 p.engineeringGate={file:p.preparation.candidateFolder+'/engineering.json',sha256:'0'.repeat(64)};p.hash=hashArtifact(p);return p;
}
test('Task7y metadata retains exact V4 protocol while deriving a distinct immutable candidate location',async()=>{
 const p=validateV4Plan(await prepared());assert.equal(p.scope,'task7x_v4_protocol_only');
 assert.equal(p.probe.contractVersion,'protocol-probe-v4-staged');assert.equal(p.limits.totalRequests,4);
 assert.equal(v4CandidateFolder(p),p.preparation.candidateFolder);
 assert.doesNotThrow(()=>validatePreparedV4Location(p,p.preparation.candidateFolder+'/freeze.json'));
 assert.throws(()=>validatePreparedV4Location(p,'docs/implementation/task-7x-live/freeze.json'));
});
for(const fault of ['alternate-attempt','alternate-root','different-candidate','other-gate','extra-budget'])test('prepared V4 metadata rejects '+fault,async()=>{
 const p=await prepared();
 if(fault==='alternate-attempt')p.preparation.globalAttemptFile=p.preparation.candidateFolder+'/attempt.json';
 if(fault==='alternate-root')p.preparation.candidateFolder='docs/implementation/task-7z-live/candidates/'+p.preparation.candidateId;
 if(fault==='different-candidate')p.preparation.candidateId=randomUUID();
 if(fault==='other-gate')p.engineeringGate.file='docs/implementation/task-7x-pre-live-gate.json';
 if(fault==='extra-budget')p.preparation.extraAttempts=4;
 p.hash=hashArtifact(p);assert.throws(()=>validateV4Plan(p));
});
