// Explicit offline_fixture copies of the actual approved v1/v2 policies and
// failure archive. These are policy/atomic-marker checks, never a full readiness
// decision, original Store.open, model run or historical result reclassification.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,access} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';import {join,resolve,dirname,sep} from 'node:path';import {tmpdir} from 'node:os';
import * as policy from '../../dist/server/evaluation/prepared-v4-policy.js';
import * as host from '../../dist/server/evaluation/v4-bounded-validation.js';
import {hashArtifact,hashRunInput} from '../../dist/server/evidence/hashing.js';
import {buildV4PlanFixture} from '../fixtures/probe-v4-plan.mjs';

const v1File='docs/implementation/task-7y-authorization.json',v2File='docs/implementation/task-7y-authorization-v2.json';
const baselineFile='docs/implementation/task-7y-baseline.json',globalFile='docs/implementation/task-7y-live/attempt.json';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function policies(){const one=await readFile(v1File),two=await readFile(v2File);return{one,two,v1:JSON.parse(one),v2:JSON.parse(two)};}
async function present(file){try{await access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function isolated(t){
 const root=await mkdtemp(join(tmpdir(),'einstein task7y policy v2 offline_fixture '));
 t.after(async()=>{const target=resolve(root);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('einstein task7y policy v2 offline_fixture '));await rm(target,{recursive:true,force:true});});
 const original=await policies(),baseline=await readFile(baselineFile),evidenceFile=original.v2.scopeExtension.evidence.file,evidence=await readFile(evidenceFile);
 for(const[file,bytes]of[[v1File,original.one],[v2File,original.two],[baselineFile,baseline],[evidenceFile,evidence]]){
  await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),bytes,{flag:'wx'});
 }
 const id=randomUUID(),meta={schemaVersion:1,task:'Task7y',candidateId:id,candidateFolder:'docs/implementation/task-7y-live/candidates/'+id,
  authorizationId:original.v2.authorizationId,authorizationFile:v2File,authorizationFileSha256:sha(original.two),globalAttemptFile:globalFile,
  baselineFile,baselineSha256:sha(baseline)};
 return{root,...original,meta,evidenceFile,evidence};
}
async function updateV2Copy(s,change){
 const value=JSON.parse(await readFile(join(s.root,v2File),'utf8'));change(value);const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');
 await writeFile(join(s.root,v2File),bytes);s.meta.authorizationFileSha256=sha(bytes);return value;
}
function verifier(){assert.equal(typeof policy.verifyTask7yAuthorizationFile,'function','policy raw-file verifier must exist outside assert.rejects');return policy.verifyTask7yAuthorizationFile;}
async function rejectPolicy(s){const verify=verifier();await assert.rejects(verify(s.root,s.meta));assert.equal(await present(join(s.root,globalFile)),false);}

test('Task7y v1 stays valid and v2 adds exactly the two approved Gate paths without another budget',async()=>{
 const{v1,v2}=await policies();assert.equal(policy.Task7yAuthorizationSchema.safeParse(v1).success,true);
 const parsed=policy.Task7yAuthorizationSchema.safeParse(v2);assert.equal(parsed.success,true,JSON.stringify(parsed.error));assert.deepEqual(parsed.data,v2);
 assert.equal(v2.approvedRuntimeChanges.length,8);assert.deepEqual(v2.approvedRuntimeChanges.slice(0,6),v1.approvedRuntimeChanges);
 assert.deepEqual(v2.approvedRuntimeChanges.slice(6).map(r=>r.file),['src/evaluation/protocol-probe-v4-gate.ts','dist/server/evaluation/protocol-probe-v4-gate.js']);
 assert.equal(v2.authorizationId,v1.authorizationId);assert.equal(v2.globalAttemptFile,v1.globalAttemptFile);assert.deepEqual(v2.limits,v1.limits);
});

for(const[name,change]of[
 ['unapproved runtime path',v=>{v.approvedRuntimeChanges[7].file='src/model/gateway-runner.ts';}],
 ['duplicate runtime path',v=>{v.approvedRuntimeChanges[7].file=v.approvedRuntimeChanges[6].file;}],
 ['missing eighth approved path',v=>{v.approvedRuntimeChanges.pop();}],
 ['larger request budget',v=>{v.limits.maxGrantedRequests=8;}],
 ['second Run',v=>{v.limits.runs=2;}],
 ['new authorization identity',v=>{v.authorizationId=randomUUID();}],
 ['candidate-local global attempt',v=>{v.globalAttemptFile='docs/implementation/task-7y-live/candidates/other/attempt.json';}],
 ['L05 scope',v=>{v.L05Authorized=true;}],
 ['unapproved extension',v=>{v.scopeExtension.userApproved=false;}],
])test(`Task7y v2 schema refuses ${name}`,async()=>{
 const{v2}=await policies();change(v2);assert.equal(policy.Task7yAuthorizationSchema.safeParse(v2).success,false);
});

test('Task7y v2 raw verifier rechecks the original v1 and exact failure archive without modifying either',async t=>{
 const s=await isolated(t),verify=verifier(),actual=await verify(s.root,s.meta);
 assert.equal(actual.policyVersion,'task7y-user-2026-10-31-v2');assert.equal(actual.authorizationId,s.v1.authorizationId);assert.equal(actual.globalAttemptFile,globalFile);
 assert.deepEqual(await readFile(join(s.root,v1File)),s.one);assert.deepEqual(await readFile(join(s.root,s.evidenceFile)),s.evidence);
 assert.equal(await present(join(s.root,globalFile)),false);
});

test('Task7y v2 cannot replace the pinned predecessor digest even after its own raw metadata hash is refreshed',async t=>{
 const s=await isolated(t);await updateV2Copy(s,v=>{v.supersedes.sha256='0'.repeat(64);});await rejectPolicy(s);
});

test('Task7y predecessor raw whitespace change is rejected rather than canonicalized away',async t=>{
 const s=await isolated(t);await writeFile(join(s.root,v1File),Buffer.concat([s.one,Buffer.from(' ')]));await rejectPolicy(s);
});

test('Task7y v2 rejects an altered predecessor policy even when supersedes and v2 raw hashes are coherently rewritten',async t=>{
 const s=await isolated(t),v1=structuredClone(s.v1);v1.globalAttemptFile='docs/implementation/task-7z-live/attempt.json';
 const changed=Buffer.from(JSON.stringify(v1)+'\n');await writeFile(join(s.root,v1File),changed);
 await updateV2Copy(s,v=>{v.supersedes.sha256=sha(changed);});await rejectPolicy(s);
});

test('Task7y v2 rejects a failure-archive digest change despite coherent current policy raw hash',async t=>{
 const s=await isolated(t);await updateV2Copy(s,v=>{v.scopeExtension.evidence.sha256='1'.repeat(64);});await rejectPolicy(s);
});

test('Task7y failure archive remains raw immutable evidence rather than normalized pass data',async t=>{
 const s=await isolated(t);await writeFile(join(s.root,s.evidenceFile),Buffer.concat([s.evidence,Buffer.from(' ')]));await rejectPolicy(s);
});

test('Task7y policy raw verifier refuses a third policy path even for identical v2 bytes',async t=>{
 const s=await isolated(t),third='docs/implementation/task-7y-other-policy.json';await writeFile(join(s.root,third),s.two,{flag:'wx'});
 s.meta.authorizationFile=third;await rejectPolicy(s);
});

test('Task7y policy filename and policy version cannot be crossed',async t=>{
 const s=await isolated(t);await writeFile(join(s.root,v2File),s.one);s.meta.authorizationFileSha256=sha(s.one);await rejectPolicy(s);
});

test('Task7y v1-created global marker still blocks a new immutable v2 candidate',async t=>{
 const s=await isolated(t);assert.equal(typeof host.acquireTask7yAttempt,'function');verifier();
 const base=await buildV4PlanFixture();
 async function atomicCandidate(version){
  const p=structuredClone(base),auth=version===1?s.v1:s.v2,authRaw=version===1?s.one:s.two,runId=randomUUID(),candidateId=randomUUID(),candidateFolder='docs/implementation/task-7y-live/candidates/'+candidateId;
  p.probe.runId=runId;p.probe.input.runId=runId;p.probe.inputHash=hashRunInput(p.probe.input);p.probe.userTask.runId=runId;
  p.preparation={...s.meta,candidateId,candidateFolder,authorizationFile:version===1?v1File:v2File,authorizationFileSha256:sha(authRaw)};
  p.engineeringSourceCommit=auth.baselineHead;p.engineeringGate={file:candidateFolder+'/engineering.json',sha256:'0'.repeat(64)};p.hash=hashArtifact(p);
  await mkdir(join(s.root,candidateFolder),{recursive:true});const raw=Buffer.from(JSON.stringify(p,null,2)+'\n');await writeFile(join(s.root,candidateFolder,'freeze.json'),raw,{flag:'wx'});
  return{plan:p,rawFreezeFileSha256:sha(raw),root:s.root};
 }
 // Atomic reservation only, not a claim that v1 permits the new runtime or
 // passes complete preflight. No runtime, Store, permit or HTTP follows it.
 const old=await atomicCandidate(1),next=await atomicCandidate(2);await host.acquireTask7yAttempt(old);
 const before=await readFile(join(s.root,globalFile));await assert.rejects(host.acquireTask7yAttempt(next));
 assert.deepEqual(await readFile(join(s.root,globalFile)),before);assert.equal(await present(join(s.root,next.plan.preparation.candidateFolder,'attempt.json')),false);
 const marker=JSON.parse(before);assert.equal(marker.authorizationId,s.v1.authorizationId);assert.equal(marker.maxGrantedRequests,4);assert.equal(marker.probeRunId,old.plan.probe.runId);
});
