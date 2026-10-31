import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RunStore} from '../../dist/server/storage/run-store.js';
import {HISTORICAL_RECOVERY_SCOPE} from '../../dist/server/storage/historical-recovery.js';
import {PermitManager} from '../../dist/server/supervisor/permits.js';
import {hashRunInput,sha256Bytes} from '../../dist/server/evidence/hashing.js';
import {record,input,ids} from '../fixtures/contracts.mjs';

// Explicit synthetic offline copies; no actual historical store is written.
const fixed={runId:'897203e4-d779-4c3e-8696-52ce718d537e',requestId:'fbb7f42d-4112-45b6-a7e8-e3dda1f35f11',permitId:'91c620fb-0ace-4612-b6f7-caea267cfc90'};
const observedAt='2026-10-31T03:00:00.000Z',now=()=>Date.parse(observedAt);
const hash=bytes=>sha256Bytes(bytes),stores=new Set();
async function opened(root,options={}){const s=await RunStore.open(root,{now,...options});stores.add(s);return s;}
async function fixture(t){
 const base=await mkdtemp(join(tmpdir(),'einstein historical recovery ')),root=join(base,'原 store'),archive=join(base,'readonly archive');
 await mkdir(archive);t.after(async()=>{for(const s of stores){await s.close();stores.delete(s);}const rel=relative(resolve(tmpdir()),resolve(base));assert.ok(!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('einstein historical recovery '));await rm(base,{recursive:true,force:true});});
 let s=await opened(root);let r={...record(),runId:fixed.runId,input:{...input(),runId:fixed.runId},runnerMode:'offline_fixture'};r.inputHash=hashRunInput(r.input);await s.createRun(r);
 const grant={schemaVersion:1,runId:fixed.runId,seq:1,at:observedAt,elapsedMs:0,source:'supervisor',type:'permit.granted',payload:{kind:'permit',requestId:fixed.requestId,permitId:fixed.permitId}};
 await s.appendEvent(grant);r={...s.getRun(fixed.runId),status:'failed',cleanupState:'unconfirmed'};
 await s.commitOutcome({runId:fixed.runId,kind:'failed',reasonCodes:['OFFLINE_FIXTURE']},r);await s.close();
 const rootIdentity={pid:28704,parentPid:17368,creationFileTime:'134378825786040155',executablePath:'C:/fixture/node.exe',commandLine:'offline_fixture'};
 const childIdentity={pid:14440,parentPid:28704,creationFileTime:'134378825786093425',executablePath:'C:/fixture/conhost.exe',commandLine:'offline_fixture'};
 const diagnostic={pid:30656,code:'DESCENDANT_IDENTITY_UNCONFIRMED',stage:'native_identity'};
 const cleanup={confirmed:false,identity:rootIdentity,descendants:[{identity:childIdentity,verification:'absent',termination:null}],scanDiagnostics:[diagnostic],exit:{exitObserved:true,closeObserved:true,exitCode:1}};
 const result={runId:fixed.runId,record:r,status:'failed',events:[grant],cleanups:[cleanup],storeRoot:root,
  permitSnapshot:{inFlight:1,runs:[{runId:fixed.runId,inFlight:1,attempts:1}]},requests:{intervals:[{...fixed,completion:'failed',code:'GATEWAY_ABORTED',endedAt:observedAt}]}};
 const resultPath=join(archive,'result.json'),freezePath=join(archive,'freeze.json'),evidencePath=join(archive,'evidence.json');
 await writeFile(resultPath,JSON.stringify(result)+'\n');await writeFile(freezePath,JSON.stringify({runnerMode:'offline_fixture',runs:[{runId:fixed.runId}]})+'\n');
 const terminalPath=join(root,fixed.runId,'terminal.json'),terminalSha256=hash(await readFile(terminalPath)),resultSha256=hash(await readFile(resultPath));
 const observations=[{pid:28704,nativeStatus:'absent',nativeCreationFileTime:null,nativeErrorCode:87,cimStatus:'absent',cimCreationFileTime:null},
  {pid:14440,nativeStatus:'present',nativeCreationFileTime:'134378834867661863',nativeErrorCode:null,cimStatus:'present',cimCreationFileTime:'134378834867661860'},
  {pid:30656,nativeStatus:'unknown',nativeCreationFileTime:null,nativeErrorCode:5,cimStatus:'present',cimCreationFileTime:'134378808173647910',parentPid:28704}];
 const evidence={scope:'append_only_read_only_historical_recovery_evidence_not_recovery_authorization',observedAt,storeRoot:root,observations,
  assessments:[{runId:fixed.runId,resultPath,resultSha256,terminalPath,terminalSha256,diagnostic,rootIdentity,knownDescendants:cleanup.descendants,
   originalCleanupState:'unconfirmed',heldReservations:1,unmatchedPermits:[{requestId:fixed.requestId,permitId:fixed.permitId}],currentObservation:observations[2],
   assessment:{pid:30656,originalIdentityMissing:true,nativeIdentityUnknown:true,birthConflict:false,currentAssociation:'excluded_by_cim_birth_current_only',historicalCleanupState:'unconfirmed',automaticRecoveryAllowed:false}}],
  originalHoldPreserved:true,originalPermitSnapshotPreserved:true,recoveryExecuted:false,processesTerminated:0,storesCreated:0,modelRequests:0};
 await writeFile(evidencePath,JSON.stringify(evidence)+'\n');
 const policy={policyVersion:'task7-single-history-risk-v1',authorizedBy:'user',authorizedAt:observedAt,storeRoot:root,...fixed,
  acceptedRisks:['historical_identity_missing','native_identity_unknown','unknown_descendants'],
  originalFiles:{recordSha256:hash(await readFile(join(root,fixed.runId,'record.json'))),eventsSha256:hash(await readFile(join(root,fixed.runId,'events.jsonl'))),terminalSha256,
   result:{path:resultPath,sha256:resultSha256},freeze:{path:freezePath,sha256:hash(await readFile(freezePath))}},evidence:{path:evidencePath,sha256:hash(await readFile(evidencePath))}};
 const paths=[join(root,fixed.runId,'record.json'),join(root,fixed.runId,'events.jsonl'),terminalPath,resultPath,freezePath,evidencePath];
 const originals=await Promise.all(paths.map(p=>readFile(p)));
 return{root,base,policy,paths,originals,result,evidence,evidencePath,resultPath,async unchanged(){for(let i=0;i<paths.length;i++)assert.deepEqual(await readFile(paths[i]),originals[i]);},
  async editEvidence(edit){const copy=structuredClone(evidence);edit(copy);await writeFile(evidencePath,JSON.stringify(copy)+'\n');policy.evidence.sha256=hash(await readFile(evidencePath));}};
}

test('exact manual resolution removes only admission effect and leaves failed/unconfirmed bytes and diagnostic',async t=>{
 assert.deepEqual(HISTORICAL_RECOVERY_SCOPE,fixed);const f=await fixture(t),s=await opened(f.root,{historicalRecovery:f.policy});
 assert.equal(s.safetyHold,true);assert.deepEqual(s.unresolvedDiagnostics.map(d=>d.code),['UNCONFIRMED_CLEANUP']);
 const resolution=await s.applyHistoricalRecovery();assert.equal(resolution.policyVersion,f.policy.policyVersion);assert.equal(resolution.historicalCleanupConfirmed,false);
 assert.equal(s.safetyHold,false);assert.equal(s.getRun(fixed.runId).status,'failed');assert.equal(s.getRun(fixed.runId).cleanupState,'unconfirmed');
 assert.equal(s.diagnostics.some(d=>d.code==='UNCONFIRMED_CLEANUP'),true);assert.deepEqual(s.unresolvedDiagnostics,[]);assert.equal(s.historicalResolutions.length,1);
 assert.ok(Object.isFrozen(s.historicalResolutions)&&Object.isFrozen(resolution));await f.unchanged();
});

test('exact duplicate including concurrent recovery is idempotent and persists through restart with explicit policy',async t=>{
 const f=await fixture(t);let s=await opened(f.root,{historicalRecovery:f.policy});const [a,b]=await Promise.all([s.applyHistoricalRecovery(),s.applyHistoricalRecovery()]);assert.deepEqual(a,b);
 const directory=join(f.root,'historical-recovery'),names=await readdir(directory);assert.equal(names.length,1);assert.ok(names[0].endsWith('.resolution.json'));const bytes=await readFile(join(directory,names[0]));
 await s.close();s=await opened(f.root,{historicalRecovery:f.policy});assert.equal(s.safetyHold,false);assert.equal(s.historicalResolutions.length,1);assert.deepEqual(await s.applyHistoricalRecovery(),a);
 assert.deepEqual(await readFile(join(directory,names[0])),bytes);await f.unchanged();
});

test('restart without trusted matching policy does not trust a self-authorizing resolution',async t=>{
 const f=await fixture(t);let s=await opened(f.root,{historicalRecovery:f.policy});await s.applyHistoricalRecovery();await s.close();s=await opened(f.root);
 assert.equal(s.safetyHold,true);assert.equal(s.historicalResolutions.length,0);await assert.rejects(s.applyHistoricalRecovery());await f.unchanged();
});

test('each original hash and evidence hash must match before recovery',async t=>{
 for(const field of ['recordSha256','eventsSha256','terminalSha256','result','freeze','evidence'])await t.test(field,async t=>{
  const f=await fixture(t),policy=structuredClone(f.policy);if(field==='evidence')policy.evidence.sha256='a'.repeat(64);else if(['result','freeze'].includes(field))policy.originalFiles[field].sha256='a'.repeat(64);else policy.originalFiles[field]='a'.repeat(64);
  const s=await opened(f.root,{historicalRecovery:policy});await assert.rejects(s.applyHistoricalRecovery());assert.equal(s.safetyHold,true);assert.equal(s.historicalResolutions.length,0);await f.unchanged();
 });
});

test('incorrect run request permit policy or store binding cannot recover the fixed history',async t=>{
 for(const key of ['runId','requestId','permitId','policyVersion','storeRoot'])await t.test(key,async t=>{
  const f=await fixture(t),policy=structuredClone(f.policy);policy[key]=key==='policyVersion'?'other-policy':key==='storeRoot'?f.base:ids.otherRun;
  const s=await opened(f.root,{historicalRecovery:policy});await assert.rejects(s.applyHistoricalRecovery());assert.equal(s.safetyHold,true);assert.equal(s.historicalResolutions.length,0);await f.unchanged();
 });
});

test('write failure and incomplete crash artifacts retain blocking across restart without changing history',async t=>{
 for(const point of ['recovery:beforeWrite','recovery:beforeSync','recovery:beforeRename'])await t.test(point,async t=>{
  const f=await fixture(t);let s=await opened(f.root,{historicalRecovery:f.policy,fault:p=>{if(p===point)throw Error('OFFLINE_FIXTURE_WRITE_FAILURE');}});
  await assert.rejects(s.applyHistoricalRecovery());assert.equal(s.safetyHold,true);assert.equal(s.historicalResolutions.length,0);await s.close();
  s=await opened(f.root,{historicalRecovery:f.policy});assert.equal(s.safetyHold,true);assert.equal(s.historicalResolutions.length,0);await f.unchanged();
 });
});

test('orphan pending resolution cannot be silently ignored or auto-completed on restart',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'historical-recovery'));await writeFile(join(f.root,'historical-recovery',fixed.runId+'.pending'),'partial offline_fixture');
 const s=await opened(f.root,{historicalRecovery:f.policy});assert.equal(s.safetyHold,true);await assert.rejects(s.applyHistoricalRecovery());assert.equal(s.historicalResolutions.length,0);await f.unchanged();
});

test('durable rename survives a simulated interruption before in-memory application, while current process remains held',async t=>{
 const f=await fixture(t);let s=await opened(f.root,{historicalRecovery:f.policy,fault:p=>{if(p==='recovery:afterRename')throw Error('OFFLINE_FIXTURE_COMMITTED_INTERRUPTION');}});
 await assert.rejects(s.applyHistoricalRecovery());assert.equal(s.safetyHold,true);assert.equal(s.historicalResolutions.length,0);await s.close();
 // This models the commit/application boundary, not recovery of a real crash-left lock.
 s=await opened(f.root,{historicalRecovery:f.policy});assert.equal(s.safetyHold,false);assert.equal(s.historicalResolutions.length,1);assert.equal((await readdir(join(f.root,'historical-recovery'))).length,1);await f.unchanged();
});

test('crash-left writer lock remains blocking and is never removed by recovery policy',async t=>{
 const f=await fixture(t),lockPath=join(f.root,'writer.lock'),bytes=Buffer.from(JSON.stringify({schemaVersion:1,pid:2147483000,nonce:randomUUID(),createdAt:observedAt,scope:'offline_fixture_crash_lock'})+'\n');
 await writeFile(lockPath,bytes);await assert.rejects(opened(f.root,{historicalRecovery:f.policy}),e=>e.code==='STORE_LOCKED');assert.deepEqual(await readFile(lockPath),bytes);await f.unchanged();
});

test('an unrelated unfinished/unknown-cleanup Run or unknown store entry remains blocked and cannot be cleared by this policy',async t=>{
 for(const other of ['unfinished','other-unconfirmed','unknown'])await t.test(other,async t=>{
  const f=await fixture(t);if(other!=='unknown'){const s=await opened(f.root);/* hold prevents writes, use explicitly marked raw test copy */await s.close();
   await mkdir(join(f.root,ids.otherRun));const r={...record(),runId:ids.otherRun,input:{...input(),runId:ids.otherRun},runnerMode:'offline_fixture'};r.inputHash=hashRunInput(r.input);await writeFile(join(f.root,ids.otherRun,'record.json'),JSON.stringify({schemaVersion:1,record:r})+'\n');
   if(other==='other-unconfirmed')await writeFile(join(f.root,ids.otherRun,'terminal.json'),JSON.stringify({schemaVersion:1,record:{...r,status:'failed',cleanupState:'unconfirmed'},outcome:{runId:ids.otherRun,kind:'failed',reasonCodes:['OFFLINE_FIXTURE']},eventCount:0,artifacts:[]})+'\n');}
  else await writeFile(join(f.root,'unknown-fixture-file'),'offline_fixture');
  const s=await opened(f.root,{historicalRecovery:f.policy});await assert.rejects(s.applyHistoricalRecovery());assert.equal(s.safetyHold,true);assert.equal(s.unresolvedDiagnostics.some(d=>d.runId!==fixed.runId),true);await f.unchanged();
 });
});

test('tampered committed resolution or changed original bytes fails closed after restart',async t=>{
 for(const attack of ['resolution','original'])await t.test(attack,async t=>{
  const f=await fixture(t);let s=await opened(f.root,{historicalRecovery:f.policy});await s.applyHistoricalRecovery();await s.close();
  if(attack==='resolution'){const p=join(f.root,'historical-recovery',fixed.runId+'.resolution.json'),v=JSON.parse(await readFile(p,'utf8'));v.permitId=ids.otherRun;await writeFile(p,JSON.stringify(v)+'\n');}
  else await writeFile(f.resultPath,(await readFile(f.resultPath,'utf8'))+' ');
  s=await opened(f.root,{historicalRecovery:f.policy});assert.equal(s.safetyHold,true);assert.equal(s.historicalResolutions.length,0);
 });
});

test('a durable exception does not cover a different unknown cleanup found on the next startup',async t=>{
 const f=await fixture(t);let s=await opened(f.root,{historicalRecovery:f.policy});await s.applyHistoricalRecovery();await s.close();
 const r={...record(),runId:ids.otherRun,input:{...input(),runId:ids.otherRun},runnerMode:'offline_fixture'};r.inputHash=hashRunInput(r.input);await mkdir(join(f.root,ids.otherRun));
 await writeFile(join(f.root,ids.otherRun,'record.json'),JSON.stringify({schemaVersion:1,record:r})+'\n');
 await writeFile(join(f.root,ids.otherRun,'terminal.json'),JSON.stringify({schemaVersion:1,record:{...r,status:'failed',cleanupState:'unconfirmed'},outcome:{runId:ids.otherRun,kind:'failed',reasonCodes:['OFFLINE_FIXTURE']},eventCount:0,artifacts:[]})+'\n');
 s=await opened(f.root,{historicalRecovery:f.policy});assert.equal(s.historicalResolutions.length,1);assert.equal(s.safetyHold,true);
 assert.deepEqual(s.unresolvedDiagnostics.map(d=>({code:d.code,runId:d.runId})),[{code:'UNCONFIRMED_CLEANUP',runId:ids.otherRun}]);
 await assert.rejects(s.applyHistoricalRecovery());assert.equal(s.safetyHold,true);await f.unchanged();
});

test('an idempotent replay discovering changed bound bytes immediately restores a current safety hold',async t=>{
 const f=await fixture(t),s=await opened(f.root,{historicalRecovery:f.policy});await s.applyHistoricalRecovery();assert.equal(s.safetyHold,false);
 await writeFile(f.resultPath,(await readFile(f.resultPath,'utf8'))+' ');await assert.rejects(s.applyHistoricalRecovery());assert.equal(s.safetyHold,true);
 assert.ok(s.unresolvedDiagnostics.some(d=>d.code==='HISTORICAL_RECOVERY_VALIDATION_FAILED'));
});

test('evidence conflicts extra unresolved identities and stale observation cannot be accepted',async t=>{
 for(const attack of ['chronology','native-conflict','extra-issue','known-root-alive','stale'])await t.test(attack,async t=>{
  const f=await fixture(t);await f.editEvidence(e=>{
   if(attack==='chronology')e.observations[2].cimCreationFileTime='134378825786040156';
   if(attack==='native-conflict'){e.observations[2].nativeStatus='present';e.observations[2].nativeCreationFileTime='134378900000000000';}
   if(attack==='extra-issue')e.assessments.push({...e.assessments[0],diagnostic:{...e.assessments[0].diagnostic,pid:30660}});
   if(attack==='known-root-alive'){e.observations[0].nativeStatus='present';e.observations[0].nativeCreationFileTime=e.assessments[0].rootIdentity.creationFileTime;}
   if(attack==='stale')e.observedAt='2026-10-30T03:00:00.000Z';
  });const s=await opened(f.root,{historicalRecovery:f.policy});await assert.rejects(s.applyHistoricalRecovery());assert.equal(s.safetyHold,true);assert.equal(s.historicalResolutions.length,0);
 });
});

test('historical reservation never decrements a current manager or releases another Run',async t=>{
 const f=await fixture(t),manager=new PermitManager();t.after(()=>manager.dispose());manager.registerRun(ids.otherRun,Date.now()+120000);const permit=await manager.acquire(ids.otherRun,randomUUID());const before=manager.snapshot();
 const s=await opened(f.root,{historicalRecovery:f.policy});await s.applyHistoricalRecovery();assert.deepEqual(manager.snapshot(),before);assert.equal(manager.release(ids.otherRun,permit.id),true);
 const restarted=new PermitManager();t.after(()=>restarted.dispose());assert.equal(restarted.snapshot().inFlight,0);await f.unchanged();
});
