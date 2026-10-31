// OFFLINE_FIXTURE parent-death harness. No model/Mozaik and no automatic recovery.
import { ProcessHost } from '../../dist/server/supervisor/process-host.js';
import { DEFAULT_LIMITS } from '../../dist/server/contracts/config.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const host=new ProcessHost({workerPath:fileURLToPath(new URL('./offline-worker.mjs',import.meta.url)),workerArgs:['--mode','wait']});
const input={runId:randomUUID(),companyId:'C001',challengeId:'C001-CH1',datasetCommit:'4fb99b3749adf0d10b5977089ff4c73f4f522240',promptVersion:'offline_fixture',configVersion:'offline_fixture',mode:'research'};
const child=host.start(input,fileURLToPath(new URL('../../reference/einstein-matchmaker-data',import.meta.url)),DEFAULT_LIMITS);
process.on('message',msg=>{if(msg?.kind==='exit-parent')process.exit(23);});
await child.ready;const identity=await child.identity;
process.send?.({fixture:'offline_fixture',identity});
