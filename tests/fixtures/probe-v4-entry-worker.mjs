// Explicit offline_fixture for the real NEW V4 configure entry. Only supplied
// transport responses are controlled; SDK/tools/Context/parent permits are real.
import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {startWorker} from '../../dist/server/runtime/worker-entry.js';
import {configureV4Probe} from '../../dist/server/evaluation/protocol-probe-worker-v4.js';
import {createV4EvidenceWriter} from '../../dist/server/evaluation/v4-worker-evidence.js';
import {sha256Bytes} from '../../dist/server/evidence/hashing.js';
import {canonicalizeArtifact} from '../../dist/server/contracts/canonical.js';

const arg=name=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw Error('OFFLINE_FIXTURE_ARGUMENT_REQUIRED');return process.argv[i+1];};
const mode=arg('--mode'),planPath=arg('--validation-freeze'),expectedHash=arg('--validation-freeze-hash'),folder=arg('--fixture-evidence-folder');
if(!['forward','reverse','second_tools','parent_cancel'].includes(mode))throw Error('OFFLINE_FIXTURE_MODE_INVALID');
globalThis.fetch=async()=>{throw Error('OFFLINE_FIXTURE_NETWORK_FORBIDDEN');};
const respond=message=>new Response(JSON.stringify({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message:{role:'assistant',...message}}]}),{status:200,headers:{'content-type':'application/json'}});
function wait(promise,signal){return new Promise((resolve,reject)=>{
 const abort=()=>reject(Error('OFFLINE_FIXTURE_ABORTED'));if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});
 promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
});}
startWorker({async configure(context){
 const bytes=await readFile(planPath),rawHash=sha256Bytes(bytes);if(rawHash!==expectedHash)throw Error('OFFLINE_FIXTURE_PLAN_BYTES_CHANGED');
 const freeze=JSON.parse(bytes.toString('utf8')),key='offline_fixture_task7x_v4_entry_key',writer=await createV4EvidenceWriter({folder,credential:key});
 let initial=0,final=0,firstReady,finalReady;const firstBoth=new Promise(r=>{firstReady=r;}),finalBoth=new Promise(r=>{finalReady=r;});
 return configureV4Probe(context,freeze,{runnerMode:'offline_fixture',writer,gateway:{baseURL:freeze.gatewayBaseURL,model:freeze.model,apiKey:key},
  fetchImpl:async(url,init)=>{
   if(String(url)!=='https://offline.invalid/v1/chat/completions')throw Error('OFFLINE_FIXTURE_ENDPOINT_INVALID');
   const body=JSON.parse(init.body),task=JSON.parse(body.messages.find(m=>m.role==='user').content),outputs=body.messages.filter(m=>m.role==='tool');
   if(canonicalizeArtifact(task)!==canonicalizeArtifact(freeze.probe.userTask)||body.model!=='offline_fixture'||body.stream!==false||body.parallel_tool_calls!==false)throw Error('OFFLINE_FIXTURE_REQUEST_BINDING_INVALID');
   if(!outputs.length){
    if(body.tool_choice!=='auto'||canonicalizeArtifact(body.tools.map(t=>t.function.name))!==canonicalizeArtifact(['read_company_challenge','read_candidate_bundle']))throw Error('OFFLINE_FIXTURE_FIRST_EXPOSURE_INVALID');
    // Controlled barrier exists only in this explicitly offline fixture. It is
    // never used to manufacture concurrency in the authorized live route.
    if(++initial===2)firstReady();await wait(firstBoth,init.signal);
    if(mode==='parent_cancel')return await new Promise((_resolve,reject)=>{
     // Both real fetch invocations stay pending until the parent sends the
     // actual cancel IPC. No clock delay decides whether cancellation wins.
     const abort=()=>reject(Error('OFFLINE_FIXTURE_PARENT_ABORTED'));
     if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true});
    });
    const names=mode==='reverse'?['read_candidate_bundle','read_company_challenge']:['read_company_challenge','read_candidate_bundle'];
    return respond({content:null,tool_calls:names.map(name=>({id:'v4_entry_fixture_'+randomUUID(),type:'function',function:{name,arguments:JSON.stringify(name==='read_company_challenge'
     ?{runId:task.runId,companyId:task.companyId,challengeId:task.challengeId}:{runId:task.runId,researcherId:task.researcherId})}}))});
   }
   if(Object.hasOwn(body,'tools')||body.tool_choice!=='none')throw Error('OFFLINE_FIXTURE_FINAL_EXPOSURE_INVALID');
   const calls=body.messages.find(m=>m.role==='assistant'&&m.tool_calls).tool_calls;
   if(calls.length!==2||outputs.length!==2)throw Error('OFFLINE_FIXTURE_CONTEXT_OUTPUT_INVALID');
   const receipts=outputs.map((output,i)=>{const result=JSON.parse(output.content);if(output.tool_call_id!==calls[i].id||result.ok!==true||result.runId!==task.runId)throw Error('OFFLINE_FIXTURE_REAL_RECEIPT_BINDING_INVALID');return{toolName:calls[i].function.name,receiptId:result.receiptId};});
   if(++final===2)finalReady();await wait(finalBoth,init.signal);
   if(mode==='second_tools')return respond({content:null,tool_calls:[{id:'v4_entry_rejected_'+randomUUID(),type:'function',function:{name:'read_candidate_bundle',arguments:JSON.stringify({runId:task.runId,researcherId:task.researcherId})}}]});
   return respond({content:JSON.stringify({runId:task.runId,challengeId:task.challengeId,researcherId:task.researcherId,receipts})});
  }},rawHash);
}});
