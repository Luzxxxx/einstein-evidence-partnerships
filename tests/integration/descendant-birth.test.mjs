import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// OFFLINE_FIXTURE: only CIM enumeration/native-child permission faults are
// synthetic. Root workers, StartTime queries, production scan classification,
// stop barrier, identity-safe termination and actual OS exits are real.
const originalExecFile=childProcess.execFile;
const scenarios=new Map(),gates=new Map(),scans=[],cleanups=[],controls=[];
const unavailablePid=2147483000;
const ps=value=>`'${String(value).replaceAll("'","''")}'`;
const row=({pid,parentPid,birth,executablePath='synthetic offline_fixture',commandLine='synthetic CIM entry only'})=>
  `[pscustomobject]@{ProcessId=${pid};ParentProcessId=${parentPid};CreationDate=${birth===null?'$null':`[DateTime]::FromFileTimeUtc([long]'${birth}')`};ExecutablePath=${ps(executablePath)};CommandLine=${ps(commandLine)}}`;
const intercepted=function(path,args,options,callback){
  const at=args.indexOf('-EncodedCommand'),script=at<0?'':Buffer.from(args[at+1],'base64').toString('utf16le');
  if(!script.includes('$all=@(Get-CimInstance Win32_Process)'))return originalExecFile(path,args,options,callback);
  const rootPid=Number(script.match(/\$p=\[Diagnostics.Process\]::GetProcessById\((\d+)\)/)[1]);
  const scenario=scenarios.get(rootPid);let nextScript=script;
  if(scenario){
    nextScript=`function Get-CimInstance { @(${scenario.rows.map(row).join(';')}) };`+nextScript;
    if(scenario.permissionFault){
      const marker='$q=[Diagnostics.Process]::GetProcessById([int]$c.ProcessId);';
      assert.ok(nextScript.includes(marker),'production native-child branch must be faulted, not replaced by a preset scan result');
      nextScript=nextScript.replace(marker,"throw [System.UnauthorizedAccessException]::new('OFFLINE_FIXTURE_PERMISSION_DENIED');");
    }
  }
  const next=[...args];next[at+1]=Buffer.from(nextScript,'utf16le').toString('base64');
  return originalExecFile(path,next,options,(error,stdout,stderr)=>{
    let result;try{result=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());}catch{}
    scans.push({rootPid,scenario:scenario?.name??'actual_os',result,error:error?.message??null});
    const gate=gates.get(rootPid);
    if(gate&&!gate.release){gate.release=()=>callback(error,stdout,stderr);gate.observed();return;}
    callback(error,stdout,stderr);
  });
};
intercepted[promisify.custom]=(path,args,options)=>new Promise((yes,no)=>intercepted(path,args,options,(error,stdout,stderr)=>error?no(error):yes({stdout,stderr})));
childProcess.execFile=intercepted;syncBuiltinESMExports();
const {ProcessHost}=await import('../../dist/server/supervisor/process-host.js');
const {Scheduler}=await import('../../dist/server/supervisor/scheduler.js');
const {RunStore}=await import('../../dist/server/storage/run-store.js');
const {DEFAULT_LIMITS}=await import('../../dist/server/contracts/config.js');
const {input}=await import('../fixtures/contracts.mjs');
const worker=fileURLToPath(new URL('../fixtures/offline-worker.mjs',import.meta.url));
const snapshotPath=resolve('reference/einstein-matchmaker-data');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(promise,ms=20000){let timer;try{return await Promise.race([promise,new Promise((_,no)=>{timer=setTimeout(()=>no(Error('OFFLINE_FIXTURE_DEADLINE')),ms);})]);}finally{clearTimeout(timer);}}
async function start(t,mode='wait'){
  const faults=[],h=new ProcessHost({workerPath:worker,workerArgs:['--mode',mode],onFault:(_id,code)=>faults.push(code)}).start({...input(),runId:randomUUID()},snapshotPath,DEFAULT_LIMITS);
  t.after(async()=>{gates.get(h.pid)?.release?.();scenarios.delete(h.pid);gates.delete(h.pid);const c=await bounded(h.terminate('BIRTH_TEST_TEARDOWN'));if(!cleanups.includes(c))cleanups.push(c);});
  await bounded(h.ready);const identity=await h.identity;assert.ok(identity);return{h,identity,faults};
}
function latest(h){return scans.filter(s=>s.rootPid===h.pid).at(-1);}

test('CIM birth preceding verified root excludes a historical ParentPID edge before inaccessible native lookup',async t=>{
  const {h,identity,faults}=await start(t);
  const oldBirth=String(BigInt(identity.creationFileTime)-10_000_000n);
  scenarios.set(h.pid,{name:'historical_parent_pid_root',rows:[{pid:unavailablePid,parentPid:h.pid,birth:oldBirth},
    {pid:unavailablePid-4,parentPid:unavailablePid,birth:String(BigInt(identity.creationFileTime)+10_000_000n)}]});
  await bounded(h.inspectDescendants());const scan=latest(h);
  assert.equal(scan.result.known,true,'reliable older birth disproves this current-root edge even when PID cannot be queried');
  assert.deepEqual(scan.result.identities,[]);assert.equal(faults.includes('DESCENDANT_SCAN_UNCONFIRMED'),false);
  const exclusion=scan.result.diagnostics.find(d=>d.code==='CIM_PRECEDES_VERIFIED_PARENT');assert.ok(exclusion);
  assert.equal(exclusion.pid,unavailablePid);assert.equal(exclusion.parentPid,h.pid);
  assert.equal(exclusion.cimCreationFileTime,oldBirth);assert.equal(exclusion.parentCreationFileTime,identity.creationFileTime);
  assert.equal(scan.result.diagnostics.some(d=>d.pid===unavailablePid-4),false,'excluded ancestor must not make its children part of the current tree');
  const c=await bounded(h.terminate('HISTORICAL_PARENT_EDGE_EXCLUDED'));cleanups.push(c);assert.equal(c.confirmed,true);
  assert.equal(c.descendants.some(d=>d.identity.pid===unavailablePid),false);
  controls.push({case:'synthetic_CIM_birth_before_real_root',scan,cleanupConfirmed:c.confirmed});
});

test('CIM birth preceding verified immediate parent excludes a stale edge even when newer than root',async t=>{
  const {h,identity}=await start(t,'child');
  const actual=await bounded(h.inspectDescendants()),parent=actual.find(r=>r.commandLine.includes('detached-child'));assert.ok(parent);
  const intermediate=String((BigInt(identity.creationFileTime)+BigInt(parent.creationFileTime))/2n);
  assert.ok(BigInt(intermediate)>BigInt(identity.creationFileTime)&&BigInt(intermediate)<BigInt(parent.creationFileTime));
  scenarios.set(h.pid,{name:'historical_parent_pid_direct_parent',rows:[{...parent,birth:parent.creationFileTime},
    {pid:unavailablePid,parentPid:parent.pid,birth:intermediate}]});
  await bounded(h.inspectDescendants());const scan=latest(h);
  assert.equal(scan.result.known,true,'root-only chronology is insufficient for a stale immediate-parent PID');
  assert.ok(scan.result.identities.some(r=>r.pid===parent.pid));assert.equal(scan.result.identities.some(r=>r.pid===unavailablePid),false);
  const exclusion=scan.result.diagnostics.find(d=>d.pid===unavailablePid&&d.code==='CIM_PRECEDES_VERIFIED_PARENT');assert.ok(exclusion);
  assert.equal(exclusion.parentPid,parent.pid);assert.equal(exclusion.parentCreationFileTime,parent.creationFileTime);
  const c=await bounded(h.terminate('DIRECT_PARENT_EDGE_EXCLUDED'));cleanups.push(c);assert.equal(c.confirmed,true);
  assert.ok(c.descendants.some(d=>d.identity.pid===parent.pid&&['absent','identity_replaced'].includes(d.verification)));
  controls.push({case:'synthetic_old_direct_edge_real_detached_parent',scan,cleanupConfirmed:c.confirmed});
});

for(const scenario of ['missing_time','permission_denied','near_boundary_permission'])test(`${scenario} cannot be treated as historical exclusion or nonexistence`,async t=>{
  const {h,identity,faults}=await start(t);
  const birth=scenario==='missing_time'?null:String(BigInt(identity.creationFileTime)+(scenario==='near_boundary_permission'?-1n:1n));
  scenarios.set(h.pid,{name:scenario,permissionFault:scenario!=='missing_time',rows:[{pid:unavailablePid,parentPid:h.pid,birth}]});
  await bounded(h.inspectDescendants());const scan=latest(h);
  assert.equal(scan.result.known,false);assert.deepEqual(scan.result.identities,[]);assert.ok(faults.includes('DESCENDANT_SCAN_UNCONFIRMED'));
  assert.equal(scan.result.diagnostics.some(d=>d.code==='CIM_PRECEDES_VERIFIED_PARENT'),false);
  assert.ok(scan.result.diagnostics.some(d=>d.stage===(scenario==='missing_time'?'cim_creation_date':'native_identity')&&d.code==='DESCENDANT_IDENTITY_UNCONFIRMED'));
  scenarios.delete(h.pid);await bounded(h.inspectDescendants());assert.equal(latest(h).result.known,true);
  const c=await bounded(h.terminate('UNKNOWN_BIRTH_IDENTITY_HOLD'));cleanups.push(c);
  assert.equal(c.confirmed,false,'ordinary successful rescan cannot clear prior unknown identity');
  assert.equal(c.descendants.some(d=>d.identity.pid===unavailablePid),false);
});

test('CIM/native birth disagreement from simulated PID reuse stays unknown and never adopts the mismatched identity',async t=>{
  const {h,identity}=await start(t,'child');
  const actual=await bounded(h.inspectDescendants()),child=actual.find(r=>r.commandLine.includes('detached-child'));assert.ok(child);
  const staleBirth=String((BigInt(identity.creationFileTime)+BigInt(child.creationFileTime))/2n);
  scenarios.set(h.pid,{name:'CIM_snapshot_PID_reuse_before_native_query',rows:[{...child,birth:staleBirth}]});
  await bounded(h.inspectDescendants());const scan=latest(h);
  assert.equal(scan.result.known,false);assert.deepEqual(scan.result.identities,[]);
  assert.ok(scan.result.diagnostics.some(d=>d.pid===child.pid&&d.stage==='birth_comparison'&&d.code==='BIRTH_METADATA_MISMATCH'));
  const c=await bounded(h.terminate('SIMULATED_PID_REUSE_HOLD'));cleanups.push(c);assert.equal(c.confirmed,false);
  assert.ok(c.descendants.some(d=>d.identity.pid===child.pid&&d.identity.creationFileTime===child.creationFileTime),
    'the separately registered original actual child remains identity-safe cleanup evidence');
});

test('stopping waits for an in-flight proven-old-edge scan rather than bypassing its classification',async t=>{
  const {h,identity}=await start(t);let observed;
  const pendingObservation=new Promise(r=>{observed=r;});const gate={observed:()=>observed()};gates.set(h.pid,gate);
  scenarios.set(h.pid,{name:'historical_parent_edge_delayed_transport',rows:[{pid:unavailablePid,parentPid:h.pid,birth:String(BigInt(identity.creationFileTime)-10_000_000n)}]});
  const scan=h.inspectDescendants();await bounded(pendingObservation);
  const cleanup=h.terminate('BIRTH_SCAN_STOP_BARRIER'),late=h.inspectDescendants();
  const winner=await Promise.race([cleanup.then(()=>'overtook_scan'),pause(150).then(()=>'waiting')]);
  assert.equal(winner,'waiting');gate.release();await bounded(scan);await bounded(late);const c=await bounded(cleanup);cleanups.push(c);
  assert.equal(c.confirmed,true);assert.ok(c.scanDiagnostics.some(d=>d.code==='CIM_PRECEDES_VERIFIED_PARENT'));
  assert.equal(scans.filter(s=>s.rootPid===h.pid).length,2,'a post-stop inspection cannot schedule an extra scan');
});

test('proven historical edge permits real Scheduler cleanup, quota reclaim and next queued admission',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'einstein task7 birth scheduler ')),store=await RunStore.open(folder);
  let realHost,first;
  const scheduler=new Scheduler({store,snapshotPath,runnerMode:'offline_fixture',
    createHost:callbacks=>(realHost=new ProcessHost({workerPath:worker,workerArgs:['--mode','wait'],...callbacks}))});
  t.after(async()=>{
    if(first)scenarios.delete(first.pid);await scheduler.close();cleanups.push(...scheduler.cleanupEvidence);await store.close();
    const rel=relative(resolve(tmpdir()),resolve(folder));assert.ok(!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('einstein task7 birth scheduler '));
    await rm(resolve(folder),{recursive:true,force:true});
  });
  const a=await scheduler.submit({...input(),runId:randomUUID()});first=realHost.get(a.runId);await bounded(first.ready);const identity=await first.identity;
  const permit=await scheduler.permits.acquire(a.runId,randomUUID());
  const b=await scheduler.submit({...input(),runId:randomUUID()});assert.equal(store.getRun(b.runId).status,'queued');assert.equal(realHost.list().length,1);
  scenarios.set(first.pid,{name:'historical_root_edge_real_scheduler',rows:[{pid:unavailablePid,parentPid:first.pid,birth:String(BigInt(identity.creationFileTime)-10_000_000n)}]});
  await bounded(first.inspectDescendants());assert.equal(latest(first).result.known,true);
  await bounded(scheduler.cancel(a.runId));await scheduler.drain();
  const cleanup=scheduler.cleanupEvidence.find(c=>c.runId===a.runId);assert.ok(cleanup?.confirmed);
  assert.equal(store.getRun(a.runId).cleanupState,'confirmed');assert.equal(scheduler.safetyHold,false);
  assert.equal(scheduler.permits.snapshot().inFlight,0,'only a confirmed cleanup can reclaim the deliberately held permit');
  const next=realHost.get(b.runId);assert.ok(next);await bounded(next.ready);assert.equal(realHost.list().length,2);assert.equal(store.getRun(b.runId).status,'researching');
  assert.equal(cleanup.descendants.some(d=>d.identity.pid===unavailablePid),false,'excluded synthetic PID never becomes a termination target');
  controls.push({case:'proven_old_edge_real_scheduler_quota_and_queue',permitId:permit.id,firstRun:a.runId,nextRun:b.runId,
    cleanupConfirmed:cleanup.confirmed,permits:scheduler.permits.snapshot(),nextStatus:store.getRun(b.runId).status,safetyHold:scheduler.safetyHold});
});

test.after(async()=>{
  childProcess.execFile=originalExecFile;syncBuiltinESMExports();
  const file=resolve(`docs/implementation/task-7r-scan-evidence-${Date.now()}-${randomUUID()}.json`);
  await writeFile(file,JSON.stringify({runnerMode:'offline_fixture',platform:process.platform,
    scope:'synthetic CIM/native permission faults with real production scan, actual root/detached child identities and Windows cleanup; not historical hold recovery',scans,cleanups,controls},null,2)+'\n',{flag:'wx'});
  console.log('Immutable Task7 repair scan evidence: '+file);
});
