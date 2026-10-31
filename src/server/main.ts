import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {startLocalService} from './service.js';
export {startLocalService};
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 startLocalService({port:process.env.PORT===undefined?3000:Number(process.env.PORT)}).then(app=>{
  console.info(`EINSTEIN local service: ${app.url}`);
  for(const name of ['SIGINT','SIGTERM'] as const)process.once(name,()=>{void app.close().catch(()=>{console.error('LOCAL_SERVICE_SHUTDOWN_FAILED');process.exitCode=1;});});
 }).catch(()=>{console.error('LOCAL_SERVICE_START_FAILED');process.exitCode=1;});
}
