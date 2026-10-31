// Explicit offline_fixture harness. Real source tools/SDK; controlled fetch only.
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {loadSnapshot} from '../../dist/server/data/snapshot.js';
import {buildIndex,retrieveWithTrace} from '../../dist/server/retrieval/index.js';
import {createStagedProbeOfflineExecution,STAGED_PROBE_OFFLINE_API_KEY} from '../../dist/server/evaluation/staged-probe-offline.js';
import {createProtocolProbeV3Execution} from '../../dist/server/evaluation/protocol-probe-v3.js';
import {executeRun} from '../../dist/server/runtime/orchestrator.js';
import {PermitManager} from '../../dist/server/supervisor/permits.js';
import {DEFAULT_LIMITS} from '../../dist/server/contracts/config.js';
import {input as inputFixture} from './contracts.mjs';

export const sha=text=>createHash('sha256').update(text).digest('hex');
let snapshotPromise;
export async function sourceResearch(input,snapshotPath=resolve('reference/einstein-matchmaker-data')){
 snapshotPromise??=loadSnapshot(snapshotPath,input.datasetCommit);
 const snapshot=await snapshotPromise;return{snapshot,...retrieveWithTrace(input,buildIndex(snapshot))};
}
const response=message=>new Response(JSON.stringify({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message:{role:'assistant',...message}}]}),{status:200});
function abortable(promise,signal){return new Promise((resolve,reject)=>{
 const abort=()=>reject(Error('OFFLINE_FIXTURE_ABORTED'));
 if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});
 promise.then(v=>{signal.removeEventListener('abort',abort);resolve(v);},e=>{signal.removeEventListener('abort',abort);reject(e);});
});}
export async function createStagedHarness({input={...inputFixture(),runId:randomUUID()},permitClient,reverse=false,fault,baseline=false,recordSink,diagnosticSink,
 snapshotPath=resolve('reference/einstein-matchmaker-data'),signal}={}){
 const research=await sourceResearch(input,snapshotPath),signalController=new AbortController(),records=[],diagnostics=[],events=[],http=[],grants=[],releases=[];
 if(signal){if(signal.aborted)signalController.abort();else signal.addEventListener('abort',()=>signalController.abort(),{once:true});}
 const manager=permitClient?null:new PermitManager({limits:{...DEFAULT_LIMITS,maxModelRequests:4}});
 // Exercise the unchanged, now precisely validated 180-second Run boundary.
 manager?.registerRun(input.runId,Date.now()+180000);
 const client=permitClient??{async acquire(requestId){const p=await manager.acquire(input.runId,requestId);grants.push({requestId,permitId:p.id});return p;},release(permitId){releases.push(permitId);manager.release(input.runId,permitId);}};
 const expected={runId:input.runId,companyId:input.companyId,challengeId:input.challengeId,researcherId:research.pool.candidates[0].researcherId};
 let firstCount=0,firstReady,finalCount=0,finalReady,siblingAbortObserved=false;
 const firstBoth=new Promise(r=>{firstReady=r;}),finalBoth=new Promise(r=>{finalReady=r;}),finalReceipts=new Map();
 const record=row=>{records.push(row);recordSink?.(row);};
 const writeDiagnostic=async row=>{diagnostics.push(row);await diagnosticSink?.(row);};
 const fetchImpl=async(url,init)=>{
  const rawBody=init.body,body=JSON.parse(rawBody),last=records.filter(r=>r.kind==='staged.http.policy'||baseline&&r.kind==='wire.request').at(-1);
  const task=JSON.parse(body.messages.find(m=>m.role==='user').content),outputs=body.messages.filter(m=>m.role==='tool');
  const entry={url,rawBody,body,actor:last?.actor??null,requestId:last?.requestId??null,permitId:last?.permitId??null,stage:outputs.length?'final':'first'};http.push(entry);
  if(!outputs.length){
   const slot=++firstCount;if(firstCount===2)firstReady();await abortable(firstBoth,init.signal);
   if(fault==='bad_response')return new Response('not JSON',{status:200});
   const names=reverse?['read_candidate_bundle','read_company_challenge']:['read_company_challenge','read_candidate_bundle'];
   if(fault==='first_four')names.push(...names);
   return response({content:null,tool_calls:names.map((name,i)=>({id:`staged_fixture_${slot}_${i}_${randomUUID()}`,type:'function',function:{name,
    arguments:JSON.stringify(name==='read_company_challenge'?{runId:task.runId,companyId:task.companyId,challengeId:task.challengeId}:{runId:task.runId,researcherId:task.researcherId})}}))});
  }
  const calls=body.messages.find(m=>m.role==='assistant'&&m.tool_calls).tool_calls,key=calls[0].id;
  const receipts=outputs.map((o,i)=>{const actual=JSON.parse(o.content);return{toolName:calls[i].function.name,receiptId:actual.receiptId};});
  finalReceipts.set(key,receipts);if(++finalCount===2)finalReady();await abortable(finalBoth,init.signal);
  if(fault==='second_tools')return response({content:null,tool_calls:[{id:'staged_rejected_'+randomUUID(),type:'function',function:{name:'read_candidate_bundle',arguments:JSON.stringify({runId:task.runId,researcherId:task.researcherId})}}]});
  if(fault==='sibling_cancel'){
   if(key===finalReceipts.keys().next().value)return response({content:null,tool_calls:[{id:'staged_rejected_'+randomUUID(),type:'function',function:{name:'read_candidate_bundle',arguments:JSON.stringify({runId:task.runId,researcherId:task.researcherId})}}]});
   return await new Promise((resolve,reject)=>{const abort=()=>{siblingAbortObserved=true;reject(Error('OFFLINE_FIXTURE_SIBLING_ABORTED'));};
    if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true});});
  }
  const answer={runId:task.runId,challengeId:task.challengeId,researcherId:task.researcherId,receipts:structuredClone(receipts)};
  if(fault==='missing_receipt')answer.receipts.pop();
  if(fault==='wrong_receipt')answer.receipts[0].receiptId=randomUUID();
  if(fault==='cross_context_receipt')answer.receipts=structuredClone([...finalReceipts.entries()].find(([k])=>k!==key)[1]);
  return response({content:JSON.stringify(answer)});
 };
 const common={input,research,gateway:{baseURL:'https://offline.invalid/v1',apiKey:STAGED_PROBE_OFFLINE_API_KEY,model:'offline_fixture'},
  runnerMode:'offline_fixture',signal:signalController.signal,permitClient:client,record,writeDiagnostic,fetchImpl};
 const execution=baseline?createProtocolProbeV3Execution(common):createStagedProbeOfflineExecution(common);
 const limits={...DEFAULT_LIMITS,maxModelRequests:4};
 return{input,research,expected,execution,common,records,diagnostics,events,http,grants,releases,manager,signalController,
  get siblingAbortObserved(){return siblingAbortObserved;},
  run:()=>executeRun({v:1,kind:'start',runId:input.runId,runInput:input,snapshotPath,limits},event=>events.push(event),client,execution),
  close(){signalController.abort();manager?.dispose();}};
}
