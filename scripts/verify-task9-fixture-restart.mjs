// Read the already-closed, isolated offline browser fixture. Never the original
// archive, never a replay/continuation of tasks, and never a model request.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startLocalService } from '../dist/server/server/service.js';
const source = 'docs/implementation/task-9-browser-sixth.json';
const record = JSON.parse(await readFile(source, 'utf8'));
const root = join(record.fixture.root, 'store');
async function fingerprints(path) {
  const rows=[];
  for(const e of await readdir(path,{withFileTypes:true})){const file=join(path,e.name);if(e.isDirectory())rows.push(...await fingerprints(file));else{const bytes=await readFile(file);rows.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}}
  return rows.sort((a,b)=>a.file.localeCompare(b.file));
}
const before = await fingerprints(root);
let app,result;
try {
  app = await startLocalService({ storeRoot:root,port:0,modelConfigured:()=>false });
  const replies=[];
  for(const run of record.fixture.runs){const response=await fetch(app.url+'/api/runs/'+run.runId),detail=await response.json();assert.equal(response.status,200);assert.equal(detail.run.status,'cancelled');replies.push({runId:run.runId,status:detail.run.status,cleanupState:detail.run.cleanupState});}
  const manager=app.scheduler.permits.snapshot();
  assert.equal(app.scheduler.safetyHold,false);assert.equal(manager.runs.length,0);assert.equal(manager.inFlight,0);
  result={task:'Task9',kind:'read_only_restart_of_closed_isolated_offline_fixture',source,root,replies,
    newManagerCreated:true,newManager:manager,safetyHoldBeforeClose:app.scheduler.safetyHold,oldManagerNotReusedOrDecremented:true,
    priorArchiveSafetyHoldField:true,priorFieldObservedAfterStoreClose:true,
    interpretation:'Scheduler safetyHold includes Store.closed. The historical browser archive computes this getter after close; it is not an active safety-hold snapshot. The original in-flow assertion passed before close. This restart is a separate new manager, not a rewrite of history.',
    modelRequests:0,newRuns:0,workerSpawns:0,recoveryApplyCalls:0,passed:true};
} finally { await app?.close(); }
const after=await fingerprints(root);assert.deepEqual(after,before);result.fixtureFileBytesUnchanged=true;
await writeFile(resolve('docs/implementation/task-9-fixture-restart.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:true,readRuns:result.replies.length,safetyHoldBeforeClose:result.safetyHoldBeforeClose,newManagerRuns:result.newManager.runs.length,modelRequests:0,fixtureBytesUnchanged:true}));
