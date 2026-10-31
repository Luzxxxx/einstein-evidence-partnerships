import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { ProcessHost, queryWindowsIdentity } from '../../dist/server/supervisor/process-host.js';
import { DEFAULT_LIMITS } from '../../dist/server/contracts/config.js';
import { input } from '../fixtures/contracts.mjs';

const worker = fileURLToPath(new URL('../fixtures/offline-worker.mjs', import.meta.url));
const snapshotPath = resolve('reference/einstein-matchmaker-data');
const evidence = [];
const bounded = (promise, ms = 15000) => Promise.race([promise, new Promise((_, reject) => { const t = setTimeout(() => reject(Error('TEST_DEADLINE')), ms); t.unref(); })]);
const run = () => ({ ...input(), runId: randomUUID() });
const limits = { ...DEFAULT_LIMITS };
function fixture(mode, options = {}) { return new ProcessHost({ workerPath: worker, workerArgs: ['--mode', mode], ...options }); }
async function cleanup(handle) { const result = await bounded(handle.terminate('OFFLINE_FIXTURE_CLEANUP')); evidence.push(result); assert.equal(result.confirmed, true, JSON.stringify(result)); return result; }

test('offline fixture has no models and host registers OS identity before business ready', async t => {
  const host = fixture('wait'), h = host.start(run(), snapshotPath, limits); t.after(() => cleanup(h));
  assert.equal(h.runId.length, 36); assert.ok(h.pid > 0);
  const identity = await bounded(h.identity); assert.equal(identity.pid, h.pid); assert.match(identity.creationFileTime, /^\d+$/);
  assert.ok(identity.commandLine.includes('offline-worker.mjs')); assert.ok(identity.commandLine.includes('--supervisor-run-id '+h.runId));
  await bounded(h.ready); assert.equal((await queryWindowsIdentity(h.pid)).identity.creationFileTime, identity.creationFileTime);
});

test('ready-before-failure, never-ready and crash-before-ready are each actually cleaned', async () => {
  for (const mode of ['never-ready', 'crash', 'ready-crash']) {
    const h = fixture(mode).start(run(), snapshotPath, limits);
    if (mode === 'never-ready') {
      await bounded(h.identity); const result = await cleanup(h); assert.ok(result.exit.closeObserved); await assert.rejects(h.ready);
    } else {
      if (mode === 'crash') await assert.rejects(bounded(h.closed.then(() => h.ready)));
      else { await bounded(h.ready); await bounded(h.closed); }
      const result = await cleanup(h);
      assert.equal(result.exit.exitCode, 1); assert.equal(result.exit.closeObserved, true);
    }
  }
});

test('two actual workers overlap with separate offline_fixture state, contexts and IPC', async t => {
  const messages = [], host = fixture('permits', { onMessage: (runId, msg) => messages.push({runId, msg}) });
  const a = host.start(run(), snapshotPath, limits), b = host.start(run(), snapshotPath, limits);
  t.after(() => Promise.all([cleanup(a), cleanup(b)]));
  await bounded(Promise.all([a.ready, b.ready]));
  const [ia, ib] = await Promise.all([queryWindowsIdentity(a.pid), queryWindowsIdentity(b.pid)]);
  assert.equal(ia.status, 'present'); assert.equal(ib.status, 'present'); assert.notEqual(a.pid, b.pid);
  const until = Date.now() + 5000; while (messages.filter(m => m.msg.kind === 'permit.request').length < 2 && Date.now() < until) await new Promise(r => setTimeout(r, 10));
  const ar = messages.find(m => m.runId === a.runId && m.msg.kind === 'permit.request').msg.requestId;
  assert.equal(a.send({v:1,runId:a.runId,kind:'permit.granted',requestId:ar,permitId:randomUUID()}),true);
  assert.equal(a.send({v:1,runId:b.runId,kind:'cancel',reason:'CROSS_RUN'}),false);
  const ca = await cleanup(a), cb = await cleanup(b);
  const da = ca.exit.stdout.trim().split('\n').map(line => JSON.parse(line)).find(v=>v.fixture==='offline_fixture');
  const db = cb.exit.stdout.trim().split('\n').map(line => JSON.parse(line)).find(v=>v.fixture==='offline_fixture');
  assert.equal(da.counter,1); assert.equal(db.counter,0); assert.notEqual(da.contextId,db.contextId);
  assert.deepEqual(da.messages,[ar]); assert.deepEqual(db.messages,[]);
});

test('wrong-Run IPC is rejected and does not become a parent-authenticated message', async t => {
  const messages = [], faults = [], h = fixture('spoof',{onMessage:(id,msg)=>messages.push(msg),onFault:(id,code)=>faults.push(code)}).start(run(),snapshotPath,limits);
  t.after(()=>cleanup(h));
  await bounded(h.ready); await new Promise(r=>setTimeout(r,50));
  assert.ok(faults.includes('INVALID_WORKER_MESSAGE')); assert.equal(messages.some(m=>m.runId!==h.runId),false);
  await cleanup(h);
});

test('Chinese and space path, normal outcome and exception isolation use actual child handles', async t => {
  const root = await mkdtemp(join(tmpdir(),'einstein Task5 中文 ')), target = join(root,'离线 worker.mjs');
  await copyFile(worker,target); t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});});
  const seen=[], host = new ProcessHost({workerPath:target,workerArgs:['--mode','finish'],onMessage:(id,msg)=>seen.push(msg)});
  const h=host.start(run(),snapshotPath,limits); await bounded(h.ready);
  await bounded(h.closed); const c=await cleanup(h); assert.equal(c.exit.exitCode,0);
  assert.ok(seen.some(m=>m.kind==='outcome'&&m.typedOutcome.kind==='insufficient'));
  const good=fixture('wait').start(run(),snapshotPath,limits), bad=fixture('crash').start(run(),snapshotPath,limits);
  t.after(()=>cleanup(good)); await bounded(good.ready); await bounded(bad.closed); await cleanup(bad);
  assert.equal((await queryWindowsIdentity(good.pid)).status,'present');
});

test('tracked unexpected descendant is explicitly registered and cleaned through its own identity', async t => {
  const h=fixture('child').start(run(),snapshotPath,limits); t.after(()=>cleanup(h)); await bounded(h.ready);
  const children=await bounded(h.inspectDescendants()); assert.ok(children.length>=1); assert.ok(children.some(c=>c.commandLine.includes('detached-child')));
  const c=await cleanup(h); assert.equal(c.descendants.length,children.length); assert.ok(c.descendants.every(row=>row.verification==='absent'));
});

test('identity mismatch is refused without sending a termination command', async () => {
  const calls=[]; let owned=[];
  const {terminateWindowsIdentity}=await import('../../dist/server/supervisor/process-host.js');
  const host=fixture('ignore-cancel',{testIdentityTerminator: async identity=>{calls.push(identity);return {status:'identity_mismatch',terminated:false};}});
  const h=host.start(run(),snapshotPath,limits);
  try {
    await bounded(h.ready); const identity=await h.identity; owned.push(identity);
    const mismatch=await terminateWindowsIdentity({...identity,creationFileTime:String(BigInt(identity.creationFileTime)+1n)});
    assert.equal(mismatch.status,'identity_mismatch'); assert.equal(mismatch.terminated,false);
    assert.equal((await queryWindowsIdentity(h.pid)).status,'present');
    const c=await h.terminate('IDENTITY_TEST'); owned.push(...c.descendants.map(row=>row.identity)); evidence.push(c); assert.equal(c.confirmed,false);
    assert.ok(calls.some(row=>row.pid===h.pid)); assert.ok(calls.every(row=>owned.some(i=>i.pid===row.pid&&i.creationFileTime===row.creationFileTime)));
  } finally {
    for(const identity of [...owned].reverse()) await terminateWindowsIdentity(identity);
    await bounded(h.closed);
    const after=[];for(const identity of owned)after.push({identity,after:await queryWindowsIdentity(identity.pid)});
    evidence.push({fixture:'offline_fixture',testOnlyRefusalRecovery:after});
    assert.ok(after.every(row=>row.after.status==='absent'||(row.after.status==='present'&&row.after.identity.creationFileTime!==row.identity.creationFileTime)));
  }
});

test('verified descendant ancestry rejects stale immediate-parent PID edges before any termination', async () => {
  const {selectOwnedDescendants}=await import('../../dist/server/supervisor/process-host.js');
  const id=(pid,parentPid,birth)=>({pid,parentPid,creationFileTime:String(birth),commandLine:'synthetic identity graph; no OS actions',executablePath:'synthetic'});
  const root=id(100,1,1000), direct=id(101,100,3000), stale=id(102,101,2000), valid=id(103,101,4000);
  const result=selectOwnedDescendants(root,[stale,valid,direct]);
  assert.deepEqual(result.identities.map(i=>i.pid).sort(),[101,103]); assert.equal(result.ambiguous,true);
});

test('public send cannot replay or replace the internally bound initial start', async t => {
  const i=run(), h=fixture('wait').start(i,snapshotPath,limits); t.after(()=>cleanup(h));
  const start={v:1,kind:'start',runId:i.runId,runInput:{...i,promptVersion:'altered-valid-version'},snapshotPath,limits};
  assert.equal(h.send(start),false); await bounded(h.ready); assert.equal(h.send(start),false);
});

test('unsolicited ready cannot precede verified identity and the internal initial start', async t => {
  let release; const gate=new Promise(r=>{release=r;}), seen=[];
  const i=run(), host=new ProcessHost({workerPath:worker,workerArgs:['--mode','early-ready','--run-id',i.runId],
    testIdentityProbe:async pid=>{await gate;return queryWindowsIdentity(pid);},onMessage:(id,msg)=>seen.push(msg)});
  const h=host.start(i,snapshotPath,limits); t.after(()=>cleanup(h));
  try {await new Promise(r=>setTimeout(r,400));assert.equal(seen.some(m=>m.kind==='ready'),false);} finally {release();}
  await bounded(h.ready);
});

test('spawn failure with no PID is registered and cannot masquerade as a running worker', async () => {
  const host=fixture('wait',{cwd:join(tmpdir(),'missing-task5-'+randomUUID())});
  const h=host.start(run(),snapshotPath,limits); assert.equal(h.pid,undefined);
  await assert.rejects(h.ready); const c=await cleanup(h); assert.equal(c.identity,null);assert.equal(c.exit.spawnError,true);assert.equal(c.exit.closeObserved,true);
});

test('an identity returned after the original exit observation is not adopted or terminated', async () => {
  let release;const gate=new Promise(r=>{release=r;}),calls=[];
  const host=fixture('boot-exit',{testIdentityProbe:async pid=>{await gate;return {status:'present',identity:{pid,parentPid:process.pid,creationFileTime:'999999999999',executablePath:'synthetic reused identity',commandLine:'synthetic; no external process'}};},
    testIdentityTerminator:async identity=>{calls.push(identity);return {status:'identity_mismatch',terminated:false};}});
  const h=host.start(run(),snapshotPath,limits);await bounded(h.closed);release();
  assert.equal(await h.identity,null);const c=await h.terminate('LATE_IDENTITY');evidence.push(c);assert.equal(calls.length,0);
  assert.equal((await queryWindowsIdentity(h.pid)).status,'absent');
});

test('a different Run marker cannot authenticate even a matching PID path parent and birth', async t => {
  const i=run(),host=fixture('wait',{testIdentityProbe:async pid=>{const actual=await queryWindowsIdentity(pid);if(actual.status!=='present')return actual;
    return {status:'present',identity:{...actual.identity,commandLine:actual.identity.commandLine.replace(i.runId,randomUUID())}};}});
  const h=host.start(i,snapshotPath,limits);
  t.after(async()=>{const {terminateWindowsIdentity}=await import('../../dist/server/supervisor/process-host.js');const actual=await queryWindowsIdentity(h.pid);
    if(actual.status==='present'&&actual.identity.parentPid===process.pid&&actual.identity.commandLine.includes(worker)){
      const termination=await terminateWindowsIdentity(actual.identity);evidence.push({fixture:'offline_fixture',markerAuthenticationRecovery:{identity:actual.identity,termination,after:await queryWindowsIdentity(h.pid)}});
    }await bounded(h.closed);});
  assert.equal(await h.identity,null);
});

test('hard parent exit disconnects its offline worker, which exits rather than silently continuing', async t => {
  const fixtureId=randomUUID(),parent=fork(fileURLToPath(new URL('../fixtures/offline-parent.mjs',import.meta.url)),['--fixture-id',fixtureId],{silent:true,windowsHide:true,execArgv:[]});
  let identity,parentClosed=false;parent.once('close',()=>{parentClosed=true;});
  const parentIdentity=queryWindowsIdentity(parent.pid);
  t.after(async()=>{const {terminateWindowsIdentity}=await import('../../dist/server/supervisor/process-host.js');
    if(identity)await terminateWindowsIdentity(identity);
    const p=await parentIdentity;
    if(!parentClosed&&p.status==='present'&&p.identity.parentPid===process.pid&&p.identity.commandLine.includes(fixtureId))await terminateWindowsIdentity(p.identity);
  });
  const announced=await bounded(new Promise((r,j)=>{parent.on('message',msg=>{if(msg.identity)r(msg);});parent.once('error',j);parent.once('close',code=>{if(!identity&&code!==23)j(Error('OFFLINE_PARENT_EARLY_EXIT'));});}));
  identity=announced.identity;assert.equal(announced.fixture,'offline_fixture');
  const exited=new Promise(r=>parent.once('close',(code,signal)=>r({code,signal})));parent.send({kind:'exit-parent'});
  assert.equal((await bounded(exited)).code,23);
  let after; for(let i=0;i<30;i++){after=await queryWindowsIdentity(identity.pid);if(after.status==='absent')break;await new Promise(r=>setTimeout(r,30));}
  evidence.push({fixture:'offline_fixture',parentHardExit:23,identity,workerAfterDisconnect:after});assert.equal(after.status,'absent');
});

test.after(async()=>{const name='docs/implementation/task-5-process-evidence-'+Date.now()+'-'+randomUUID()+'.json';await writeFile(resolve(name),JSON.stringify({runnerMode:'offline_fixture',platform:process.platform,limits:'trusted fixture lifecycles only; no models or Mozaik',cleanups:evidence},null,2)+'\n',{flag:'wx'});console.log('Immutable process evidence: '+name);});
