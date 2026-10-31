import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {readFile} from 'node:fs/promises';
import {loadSnapshot,assertSnapshot,type DatasetSnapshot} from '../data/snapshot.js';import {DATASET_COMMIT} from '../contracts/primitives.js';
import {RunStore} from '../storage/run-store.js';import {Scheduler} from '../supervisor/scheduler.js';import {createLocalServer} from './routes.js';
export const PROJECT_ROOT=fileURLToPath(new URL('../../../',import.meta.url));
export function modelConfigurationReady(){const key=process.env.EINSTEIN_GATEWAY_API_KEY,model=process.env.EINSTEIN_GATEWAY_MODEL,url=process.env.EINSTEIN_GATEWAY_BASE_URL;
 if(!key?.trim()||!model?.trim()||!url)return false;try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}}
/** Trusted host options only. None of these controls are accepted by HTTP. */
export async function startLocalService(options:{storeRoot?:string;snapshotPath?:string;webRoot?:string;port?:number;historicalRecovery?:unknown;snapshot?:DatasetSnapshot;store?:RunStore;scheduler?:Scheduler;modelConfigured?:()=>boolean;credential?:string}={}){
 const port=options.port??3000;if(!Number.isInteger(port)||port<0||port>65535)throw Error('INVALID_SERVICE_PORT');
 if(Boolean(options.store)!==Boolean(options.scheduler))throw Error('SERVICE_STORE_SCHEDULER_PAIR_REQUIRED');
 const snapshotPath=resolve(options.snapshotPath??resolve(PROJECT_ROOT,'reference/einstein-matchmaker-data')),snapshot=options.snapshot??await loadSnapshot(snapshotPath,DATASET_COMMIT);assertSnapshot(snapshot);
 const owns=!options.store;let recovery=options.historicalRecovery;
 if(recovery===undefined&&process.env.EINSTEIN_HISTORICAL_AUTHORIZATION_FILE)recovery=JSON.parse(await readFile(resolve(process.env.EINSTEIN_HISTORICAL_AUTHORIZATION_FILE),'utf8'));
 const store=options.store??await RunStore.open(resolve(options.storeRoot??process.env.EINSTEIN_RUN_STORE??resolve(PROJECT_ROOT,'var/runs')),{publicationSnapshot:async()=>loadSnapshot(snapshotPath,DATASET_COMMIT),...(recovery===undefined?{}:{historicalRecovery:recovery})});
 let scheduler=options.scheduler;
 try{
  scheduler??=new Scheduler({store,snapshotPath,runnerMode:'live',workerPath:resolve(PROJECT_ROOT,'dist/server/runtime/worker-entry.js')});const current=scheduler;
  const http=createLocalServer({store,scheduler:current,snapshot,webRoot:resolve(options.webRoot??resolve(PROJECT_ROOT,'dist/web')),modelConfigured:options.modelConfigured??modelConfigurationReady,credential:options.credential??process.env.EINSTEIN_GATEWAY_API_KEY});
  await new Promise<void>((yes,no)=>{http.server.once('error',no);http.server.listen(port,'127.0.0.1',()=>{http.server.off('error',no);yes();});});
  const address=http.server.address();if(!address||typeof address==='string')throw Error('SERVICE_BIND_FAILED');let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{http.closeStreams();await new Promise<void>((yes,no)=>http.server.close(e=>e?no(e):yes()));try{await current.close();if(current.safetyHold)throw Error('SERVICE_SAFETY_HOLD');}finally{if(owns)await store.close();}})();
  return{server:http.server,store,scheduler:current,snapshot,url:`http://127.0.0.1:${address.port}`,close};
 }catch(e){try{await scheduler?.close();}finally{if(owns)await store.close();}throw e;}
}
