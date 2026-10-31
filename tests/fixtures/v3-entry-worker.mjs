// Explicit offline_fixture for the NEW configureV3Probe entry. This process
// never imports or invokes the real main, original store, freeze or attempt.
import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {startWorker} from '../../dist/server/runtime/worker-entry.js';
import {configureV3Probe} from '../../dist/server/evaluation/protocol-probe-worker-v3.js';
import {createV3EvidenceWriter} from '../../dist/server/evaluation/v3-worker-evidence.js';
import {sha256Bytes} from '../../dist/server/evidence/hashing.js';
import {canonicalizeArtifact} from '../../dist/server/contracts/canonical.js';

const arg=name=>{const n=process.argv.indexOf(name);if(n<0||!process.argv[n+1])throw Error('OFFLINE_FIXTURE_ARGUMENT_REQUIRED');return process.argv[n+1];};
const mode=arg('--mode'),planPath=arg('--fixture-plan'),planHash=arg('--fixture-plan-hash'),evidenceFolder=arg('--fixture-evidence-folder');
if(!['forward','reverse','first_four'].includes(mode))throw Error('OFFLINE_FIXTURE_MODE_INVALID');
globalThis.fetch=async()=>{throw Error('OFFLINE_FIXTURE_NETWORK_FORBIDDEN');};
const respond=message=>new Response(JSON.stringify({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message:{role:'assistant',...message}}]}),
  {status:200,headers:{'content-type':'application/json'}});
startWorker({async configure(context){
  const bytes=await readFile(planPath);if(sha256Bytes(bytes)!==planHash)throw Error('OFFLINE_FIXTURE_PLAN_BYTES_CHANGED');
  const freeze=JSON.parse(bytes.toString('utf8')),key='offline_fixture_task7v_entry_key';
  const writer=await createV3EvidenceWriter({folder:evidenceFolder,credential:key,nativeTotalBytes:2*1024*1024});
  let initial=0,releaseBoth;const bothFirstRequests=new Promise(resolve=>{releaseBoth=resolve;});
  return configureV3Probe(context,freeze,{runnerMode:'offline_fixture',writer,
    gateway:{baseURL:freeze.gatewayBaseURL,model:freeze.model,apiKey:key},
    fetchImpl:async(_url,init)=>{
      const body=JSON.parse(init.body),task=JSON.parse(body.messages.find(m=>m.role==='user').content);
      if(canonicalizeArtifact(task)!==canonicalizeArtifact(freeze.probe.userTask))throw Error('OFFLINE_FIXTURE_TASK_BINDING_INVALID');
      const outputs=body.messages.filter(m=>m.role==='tool');
      if(!outputs.length){
        // A controlled offline barrier proves parent grants and both native
        // Contexts are actually in fetch. It is never real-model concurrency.
        if(++initial===2)releaseBoth();await bothFirstRequests;
        const names=mode==='reverse'?['read_candidate_bundle','read_company_challenge']:['read_company_challenge','read_candidate_bundle'];
        if(mode==='first_four')names.push('read_candidate_bundle','read_candidate_bundle');
        return respond({content:null,tool_calls:names.map(name=>({id:'entry_fixture_'+randomUUID(),type:'function',function:{name,arguments:JSON.stringify(name==='read_company_challenge'
          ?{runId:task.runId,companyId:task.companyId,challengeId:task.challengeId}:{runId:task.runId,researcherId:task.researcherId})}}))});
      }
      const calls=body.messages.find(m=>m.role==='assistant'&&m.tool_calls).tool_calls;
      const receipts=outputs.map((output,i)=>{
        const result=JSON.parse(output.content);
        if(output.tool_call_id!==calls[i].id||result.ok!==true||result.runId!==task.runId)throw Error('OFFLINE_FIXTURE_TOOL_OUTPUT_BINDING_INVALID');
        return{toolName:calls[i].function.name,receiptId:result.receiptId};
      });
      return respond({content:JSON.stringify({runId:task.runId,challengeId:task.challengeId,researcherId:task.researcherId,receipts})});
    }});
}});
