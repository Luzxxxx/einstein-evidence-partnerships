// Explicit offline_fixture. This worker uses the production bootstrap/factory,
// parent permit IPC and actual native source tools, with no provider transport.
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {startWorker} from '../../dist/server/runtime/worker-entry.js';
import {createProtocolProbeV3Execution} from '../../dist/server/evaluation/protocol-probe-v3.js';
import {loadSnapshot} from '../../dist/server/data/snapshot.js';
import {buildIndex,retrieveWithTrace} from '../../dist/server/retrieval/index.js';
import {PROTOCOL_PROBE_V3_INSTRUCTION} from '../../dist/server/evaluation/probe-contract-guard.js';

const arg=name=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw Error('OFFLINE_FIXTURE_ARGUMENT_REQUIRED');return process.argv[i+1];};
const mode=arg('--mode'),evidencePath=arg('--evidence-path');
if(!['reverse_roundtrip','reject_first_four'].includes(mode))throw Error('OFFLINE_FIXTURE_MODE_INVALID');
globalThis.fetch=async()=>{throw Error('OFFLINE_FIXTURE_NETWORK_FORBIDDEN');};
const records=[],diagnostics=[];let wireCount=0,initialCount=0,siblingAbortObserved=false,expected;
// Bounded transient test snapshot only. Parent archives the final bytes with wx.
// Do not rely on beforeSend for failed outcomes: production final-control IPC
// intentionally bypasses that fixture hook during cancellation/cleanup.
const persist=()=>writeFileSync(evidencePath,JSON.stringify({runnerMode:'offline_fixture',transientFixtureSnapshot:true,
  mode,expected,wireCount,initialCount,siblingAbortObserved,records,diagnostics},null,2)+'\n');
let releaseBoth;const bothFirstRequests=new Promise(resolve=>{releaseBoth=resolve;});
const respond=message=>new Response(JSON.stringify({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message:{role:'assistant',...message}}]}),
  {status:200,headers:{'content-type':'application/json'}});
startWorker({
  async configure({start,signal,permitClient}){
    const snapshot=await loadSnapshot(start.snapshotPath,start.runInput.datasetCommit),research={snapshot,...retrieveWithTrace(start.runInput,buildIndex(snapshot))};
    expected={runId:start.runId,companyId:start.runInput.companyId,challengeId:start.runInput.challengeId,researcherId:research.pool.candidates[0].researcherId};
    persist();
    const execution=createProtocolProbeV3Execution({input:start.runInput,research,permitClient,signal,runnerMode:'offline_fixture',
      gateway:{baseURL:'https://offline.invalid/v1',apiKey:'offline_fixture_windows_v3_key',model:'offline_fixture'},
      record:row=>{records.push(row);persist();},writeDiagnostic:async row=>{diagnostics.push(row);persist();},
      fetchImpl:async(_url,init)=>{
        wireCount++;const body=JSON.parse(init.body),task=JSON.parse(body.messages.find(m=>m.role==='user').content);
        if(JSON.stringify(Object.keys(task).sort())!==JSON.stringify(Object.keys(expected).sort())
          ||Object.keys(expected).some(k=>task[k]!==expected[k])
          ||body.messages.filter(m=>m.role==='system').length!==1
          ||body.messages.find(m=>m.role==='system').content!==PROTOCOL_PROBE_V3_INSTRUCTION)throw Error('OFFLINE_FIXTURE_CONTEXT_BINDING_INVALID');
        const outputs=body.messages.filter(m=>m.role==='tool');
        if(!outputs.length){
          const turn=++initialCount;if(initialCount===2)releaseBoth();
          await bothFirstRequests;
          if(mode==='reject_first_four'&&turn===2){
            await new Promise((_,reject)=>{
              const stop=()=>{siblingAbortObserved=true;persist();reject(Error('OFFLINE_FIXTURE_SIBLING_ABORTED'));};
              if(init.signal.aborted)stop();else init.signal.addEventListener('abort',stop,{once:true});
            });
            throw Error('OFFLINE_FIXTURE_ABORT_REQUIRED');
          }
          const tools=mode==='reject_first_four'?['read_candidate_bundle','read_company_challenge','read_candidate_bundle','read_candidate_bundle']
            :['read_candidate_bundle','read_company_challenge'];
          return respond({content:null,tool_calls:tools.map(name=>({id:'windows_fixture_'+randomUUID(),type:'function',function:{name,arguments:JSON.stringify(name==='read_company_challenge'
            ?{runId:expected.runId,companyId:expected.companyId,challengeId:expected.challengeId}:{runId:expected.runId,researcherId:expected.researcherId})}}))});
        }
        const calls=body.messages.find(m=>m.role==='assistant'&&m.tool_calls).tool_calls;
        const receipts=outputs.map((output,i)=>({toolName:calls[i].function.name,receiptId:JSON.parse(output.content).receiptId}));
        return respond({content:JSON.stringify({runId:expected.runId,challengeId:expected.challengeId,researcherId:expected.researcherId,receipts})});
      }});
    return execution;
  }
});
