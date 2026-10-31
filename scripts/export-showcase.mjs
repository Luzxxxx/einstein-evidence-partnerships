// Read/export only. Uses the existing Store lock and publication verifier; never calls a model.
import {resolve} from 'node:path';import {readFile} from 'node:fs/promises';
import {RunStore} from '../dist/server/storage/run-store.js';import {loadSnapshot} from '../dist/server/data/snapshot.js';
import {DATASET_COMMIT,UuidSchema} from '../dist/server/contracts/primitives.js';import {PROJECT_ROOT} from '../dist/server/server/service.js';
import {listShowcase} from '../dist/server/showcase/catalog.js';import {exportApproved} from '../dist/server/evaluation/export-showcase.js';
const args=process.argv.slice(2),values=new Map(),ids=[];let store;
try{
 for(let i=0;i<args.length;i+=2){const name=args[i],value=args[i+1];if(!['--store','--authorization','--output','--run'].includes(name)||!value)throw Error('EXPORT_ARGUMENT_INVALID');if(name==='--run'){UuidSchema.parse(value);ids.push(value);}else{if(values.has(name))throw Error('EXPORT_ARGUMENT_INVALID');values.set(name,value);}}
 if(!values.has('--output'))throw Error('EXPORT_OUTPUT_REQUIRED');
 const snapshot=await loadSnapshot(resolve(PROJECT_ROOT,'reference/einstein-matchmaker-data'),DATASET_COMMIT),auth=values.get('--authorization')??process.env.EINSTEIN_HISTORICAL_AUTHORIZATION_FILE;
 store=await RunStore.open(resolve(values.get('--store')??process.env.EINSTEIN_RUN_STORE??resolve(PROJECT_ROOT,'var/runs')),{publicationSnapshot:async()=>snapshot,...(auth?{historicalRecovery:JSON.parse(await readFile(resolve(auth),'utf8'))}:{})});
 const manifest=await exportApproved(ids.length?ids:listShowcase(store,snapshot).map(e=>e.runId),resolve(values.get('--output')),{store,snapshot});
 console.log(JSON.stringify({complete:manifest.complete,proposals:manifest.proposals.length,reasons:manifest.reasons,output:resolve(values.get('--output')),modelRequests:0}));
}catch(error){const code=typeof error?.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'EXPORT_FAILED';console.error(JSON.stringify({code,message:'Export did not complete. Keep the Store exclusive and use only qualified approved Runs.',modelRequests:0}));process.exitCode=1;}
finally{if(store)await store.close();}
