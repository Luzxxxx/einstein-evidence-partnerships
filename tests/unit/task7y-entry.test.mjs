// offline_fixture atomic-admission tests only. No full-preflight acceptance,
// original Store.open, worker, permit, HTTP, recovery or live authority.
import test,{beforeEach} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';import {join,resolve,sep} from 'node:path';import {tmpdir} from 'node:os';
import * as host from '../../dist/server/evaluation/v4-bounded-validation.js';
import {hashArtifact,hashRunInput} from '../../dist/server/evidence/hashing.js';
import {buildV4PlanFixture} from '../fixtures/probe-v4-plan.mjs';

const globalFile='docs/implementation/task-7y-live/attempt.json',authFile='docs/implementation/task-7y-authorization.json',baselineFile='docs/implementation/task-7y-baseline.json';
const sha=b=>createHash('sha256').update(b).digest('hex');
// An absent interface is an engineering failure, never a successful security
// rejection hidden inside assert.rejects in a negative test.
beforeEach(()=>assert.equal(typeof host.acquireTask7yAttempt,'function','new fixed-global admission export is required'));
let basePromise;
async function base(){return structuredClone(await(basePromise??=buildV4PlanFixture()));}
async function present(file){try{await access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function isolated(t){
 const root=await mkdtemp(join(tmpdir(),'einstein task7y atomic offline_fixture '));
 t.after(async()=>{const target=resolve(root);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('einstein task7y atomic offline_fixture '));await rm(target,{recursive:true,force:true});});
 const authRaw=await readFile(authFile),baselineRaw=await readFile(baselineFile),authorization=JSON.parse(authRaw);
 await mkdir(join(root,'docs/implementation/task-7y-live/candidates'),{recursive:true});
 await writeFile(join(root,authFile),authRaw,{flag:'wx'});await writeFile(join(root,baselineFile),baselineRaw,{flag:'wx'});
 return{root,authRaw,baselineRaw,authorization};
}
async function candidate(sandbox){
 const plan=await base(),runId=randomUUID(),candidateId=randomUUID(),candidateFolder='docs/implementation/task-7y-live/candidates/'+candidateId;
 plan.probe.runId=runId;plan.probe.input.runId=runId;plan.probe.inputHash=hashRunInput(plan.probe.input);plan.probe.userTask.runId=runId;
 plan.engineeringSourceCommit=sandbox.authorization.baselineHead;
 plan.preparation={schemaVersion:1,task:'Task7y',candidateId,candidateFolder,authorizationId:sandbox.authorization.authorizationId,
  authorizationFile:authFile,authorizationFileSha256:sha(sandbox.authRaw),globalAttemptFile:globalFile,baselineFile,baselineSha256:sha(sandbox.baselineRaw)};
 const engineering=Buffer.from(JSON.stringify({fixture:'offline_fixture_atomic_attempt_only_not_full_preflight'})+'\n');
 plan.engineeringGate={file:candidateFolder+'/engineering.json',sha256:sha(engineering)};plan.hash=hashArtifact(plan);
 await mkdir(join(sandbox.root,candidateFolder));await writeFile(join(sandbox.root,plan.engineeringGate.file),engineering,{flag:'wx'});
 const raw=Buffer.from(JSON.stringify(plan,null,2)+'\n');await writeFile(join(sandbox.root,candidateFolder,'freeze.json'),raw,{flag:'wx'});
 return{plan,rawFreezeFileSha256:sha(raw),root:sandbox.root};
}
async function resealControlledCopy(c,folder=c.plan.preparation.candidateFolder){
 c.plan.hash=hashArtifact(c.plan);const raw=Buffer.from(JSON.stringify(c.plan,null,2)+'\n');
 // Deliberate attack copy only; production candidates are never rewritten.
 await writeFile(join(c.root,folder,'freeze.json'),raw);c.rawFreezeFileSha256=sha(raw);
}
const acquire=value=>{assert.equal(typeof host.acquireTask7yAttempt,'function','new fixed-global admission export is required');return host.acquireTask7yAttempt(value);};
async function rejectWithoutMarker(sandbox,options){await assert.rejects(async()=>acquire(options));assert.equal(await present(join(sandbox.root,globalFile)),false);}

test('Task7y reserves only the fixed global marker, binding exact candidate/raw bytes and four-request policy',async t=>{
 const s=await isolated(t),c=await candidate(s);await acquire(c);
 const marker=JSON.parse(await readFile(join(s.root,globalFile),'utf8'));
 assert.equal(marker.probeRunId,c.plan.probe.runId);assert.equal(marker.freezeHash,c.plan.hash);
 assert.equal(marker.rawFreezeFileSha256,c.rawFreezeFileSha256);assert.equal(marker.candidateId,c.plan.preparation.candidateId);
 assert.equal(marker.authorizationId,s.authorization.authorizationId);assert.equal(marker.sourceCommit,c.plan.engineeringSourceCommit);
 assert.equal(marker.maxGrantedRequests,4);assert.equal(marker.perContextRequests,2);assert.equal(marker.automaticRetry,false);
 assert.equal('l05RunId'in marker,false);assert.equal(await present(join(s.root,c.plan.preparation.candidateFolder,'attempt.json')),false);
});

test('Task7y reentry preserves the first global marker byte for byte',async t=>{
 const s=await isolated(t),c=await candidate(s);await acquire(c);const before=await readFile(join(s.root,globalFile));
 await assert.rejects(async()=>acquire(c));assert.deepEqual(await readFile(join(s.root,globalFile)),before);
});

test('Task7y another immutable candidate cannot renew the one global opportunity',async t=>{
 const s=await isolated(t),a=await candidate(s),b=await candidate(s);await acquire(a);const before=await readFile(join(s.root,globalFile));
 await assert.rejects(async()=>acquire(b));assert.deepEqual(await readFile(join(s.root,globalFile)),before);
 assert.equal(await present(join(s.root,b.plan.preparation.candidateFolder,'attempt.json')),false);
});

test('Task7y concurrent candidates have exactly one wx winner',async t=>{
 const s=await isolated(t),a=await candidate(s),b=await candidate(s),results=await Promise.allSettled([Promise.resolve().then(()=>acquire(a)),Promise.resolve().then(()=>acquire(b))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const marker=JSON.parse(await readFile(join(s.root,globalFile),'utf8'));
 const winner=results[0].status==='fulfilled'?a:b;assert.equal(marker.probeRunId,winner.plan.probe.runId);assert.equal(marker.candidateId,winner.plan.preparation.candidateId);
});

for(const raw of ['', '{"partial":'])test(`Task7y preexisting ${raw?'truncated':'empty'} global marker survives restart-like reentry and blocks every candidate`,async t=>{
 const s=await isolated(t),a=await candidate(s),b=await candidate(s);await writeFile(join(s.root,globalFile),raw,{flag:'wx'});
 for(const c of[a,b])await assert.rejects(async()=>acquire(c));assert.equal(await readFile(join(s.root,globalFile),'utf8'),raw);
});

test('Task7y cannot redirect the global attempt into its candidate directory',async t=>{
 const s=await isolated(t),c=await candidate(s);c.plan.preparation.globalAttemptFile=c.plan.preparation.candidateFolder+'/attempt.json';await resealControlledCopy(c);
 await rejectWithoutMarker(s,c);assert.equal(await present(join(s.root,c.plan.preparation.globalAttemptFile)),false);
});

for(const [name,change]of[
 ['candidate folder traversal',c=>{c.plan.preparation.candidateFolder='../alternate';}],
 ['candidate identity/folder mismatch',c=>{c.plan.preparation.candidateId=randomUUID();}],
 ['authorization identity',c=>{c.plan.preparation.authorizationId=randomUUID();}],
 ['authorization raw digest',c=>{c.plan.preparation.authorizationFileSha256='0'.repeat(64);}],
 ['Y baseline raw digest',c=>{c.plan.preparation.baselineSha256='1'.repeat(64);}],
])test(`Task7y rejects changed ${name} before reserving global authorization`,async t=>{
 const s=await isolated(t),c=await candidate(s),original=c.plan.preparation.candidateFolder;change(c);await resealControlledCopy(c,original);await rejectWithoutMarker(s,c);
});

test('Task7y supplied raw-freeze digest must match actual immutable candidate bytes',async t=>{
 const s=await isolated(t),c=await candidate(s);c.rawFreezeFileSha256='2'.repeat(64);await rejectWithoutMarker(s,c);
});

test('Task7y candidate bytes changed after preparation cannot consume the global opportunity',async t=>{
 const s=await isolated(t),c=await candidate(s),file=join(s.root,c.plan.preparation.candidateFolder,'freeze.json');
 await writeFile(file,Buffer.concat([await readFile(file),Buffer.from(' ')]));await rejectWithoutMarker(s,c);
});

test('Task7y corrupted authorization file fails without creating any new reservation',async t=>{
 const s=await isolated(t),c=await candidate(s);await writeFile(join(s.root,authFile),'{"offline_fixture":"tampered"}\n');await rejectWithoutMarker(s,c);
});

test('Task7y existing directory at the fixed marker is an I/O failure, never an alternate-path fallback',async t=>{
 const s=await isolated(t),c=await candidate(s);await mkdir(join(s.root,globalFile));await assert.rejects(async()=>acquire(c));
 assert.equal(await present(join(s.root,c.plan.preparation.candidateFolder,'attempt.json')),false);
 assert.deepEqual(await readFile(join(s.root,authFile)),s.authRaw);
});
