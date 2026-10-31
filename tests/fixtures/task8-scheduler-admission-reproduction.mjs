// offline_fixture diagnostic: actual Scheduler/Store, controlled slow admission I/O.
// Demonstrates why a 160ms wall-clock test must not assume a worker was spawned.
import {mkdtemp,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {resolve,join} from 'node:path';import {randomUUID} from 'node:crypto';
import {RunStore} from '../../dist/server/storage/run-store.js';import {Scheduler} from '../../dist/server/supervisor/scheduler.js';
import {DEFAULT_LIMITS} from '../../dist/server/contracts/config.js';import {DATASET_COMMIT} from '../../dist/server/contracts/primitives.js';
let eventWrites=0,spawns=0;const root=await mkdtemp(join(tmpdir(),'einstein task8 admission reproduction '));
const store=await RunStore.open(root,{fault:async point=>{if(point==='events:beforeRename'&&++eventWrites===2)await new Promise(r=>setTimeout(r,220));}});
const scheduler=new Scheduler({store,runnerMode:'offline_fixture',snapshotPath:resolve('reference/einstein-matchmaker-data'),limits:{...DEFAULT_LIMITS,runTimeoutMs:160,requestTimeoutMs:80},createHost:()=>({start(){spawns++;throw Error('UNEXPECTED_OFFLINE_FIXTURE_SPAWN');}})});
const runId=randomUUID();try{await scheduler.submit({runId,companyId:'C001',challengeId:'C001-CH1',datasetCommit:DATASET_COMMIT,promptVersion:'offline_fixture',configVersion:'task8-reproduction',mode:'research'});await scheduler.drain();
 const result={runnerMode:'offline_fixture',kind:'controlled_slow_admission',runTimeoutMs:160,admissionEventDelayMs:220,spawns,run:store.getRun(runId),events:store.eventsAfter(runId,0),modelRequests:0};
 await writeFile('docs/implementation/task-8-scheduler-admission-reproduction.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({spawns,status:result.run.status,modelRequests:0}));if(spawns!==0||result.run.status!=='failed')process.exitCode=1;
}finally{await scheduler.close();await store.close();}
