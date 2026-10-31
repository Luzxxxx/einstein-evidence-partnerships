// Capture actual test/build process exits and raw logs; no model or Store.
import {captureEngineeringCommand} from '../dist/server/evaluation/engineering-material.js';
import {collectV4ProductFingerprints} from '../dist/server/evaluation/protocol-probe-v4-plan.js';
import {resolve} from 'node:path';import {mkdir,readFile,open,access} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const root=resolve('.'),batchId=randomUUID(),folder='docs/implementation/task-7y-checks/'+batchId;
const sha=b=>createHash('sha256').update(b).digest('hex'),commit=()=>execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
async function absent(){try{await access(resolve(root,'docs/implementation/task-7y-live/attempt.json'));throw Error('TASK7Y_ATTEMPT_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}}
await absent();await mkdir(resolve(root,folder),{recursive:true});
const sourceCommitBefore=commit(),fingerprintsBefore=await collectV4ProductFingerprints(),commands={};
console.log(JSON.stringify({batchId,folder,phase:'actual_command_capture_started',sourceCommitBefore,modelRequests:0}));
for(const kind of ['offline','web']){
 await absent();
 const receipt=await captureEngineeringCommand({root,kind,runnerMode:'live',logFile:folder+'/'+kind+'.txt',receiptFile:folder+'/'+kind+'-receipt.json'});
 commands[kind]={file:folder+'/'+kind+'-receipt.json',sha256:sha(await readFile(resolve(root,folder,kind+'-receipt.json')))};
 console.log(JSON.stringify({kind,receiptFile:folder+'/'+kind+'-receipt.json',exitCode:receipt.exitCode}));
 if(receipt.exitCode!==0){process.exitCode=1;break;}
}
const sourceCommitAfter=commit(),fingerprintsAfter=await collectV4ProductFingerprints();
const manifest={schemaVersion:1,kind:'engineering_capture_provenance',runnerMode:'live',sourceCommitBefore,sourceCommitAfter,fingerprintsBefore,fingerprintsAfter,commands};
const handle=await open(resolve(root,folder,'capture.json'),'wx');try{await handle.writeFile(JSON.stringify(manifest,null,2)+'\n');await handle.sync();}finally{await handle.close();}
if(sourceCommitBefore!==sourceCommitAfter||JSON.stringify(fingerprintsBefore)!==JSON.stringify(fingerprintsAfter)){console.error('TASK7Y_CAPTURE_SOURCE_DRIFT');process.exitCode=1;}
console.log(JSON.stringify({batchId,captureFile:folder+'/capture.json',exitCode:process.exitCode??0,modelRequests:0}));
