// Explicit offline_fixture. Actual installed SDK/Context/original source tools;
// responses below are controlled transport fixtures, never provider evidence.
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {loadSnapshot} from '../../dist/server/data/snapshot.js';
import {buildIndex,retrieveWithTrace} from '../../dist/server/retrieval/index.js';
import {createProtocolProbeV4Execution} from '../../dist/server/evaluation/protocol-probe-v4.js';
import {executeRun} from '../../dist/server/runtime/orchestrator.js';
import {PermitManager} from '../../dist/server/supervisor/permits.js';
import {DEFAULT_LIMITS} from '../../dist/server/contracts/config.js';
import {input as inputFixture} from './contracts.mjs';

export const sha=text=>createHash('sha256').update(text).digest('hex');
let researchBase;
export async function v4Research(input,snapshotPath=resolve('reference/einstein-matchmaker-data')){
 researchBase??=loadSnapshot(snapshotPath,input.datasetCommit).then(snapshot=>({snapshot,index:buildIndex(snapshot)}));
 const{snapshot,index}=await researchBase;return{snapshot,...retrieveWithTrace(input,index)};
}
const respond=message=>new Response(JSON.stringify({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message:{role:'assistant',...message}}]}),{status:200});
const stopWait=(wait,signal)=>new Promise((resolve,reject)=>{
 const abort=()=>reject(Error('OFFLINE_FIXTURE_ABORTED'));if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});
 wait.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
});
export async function createV4Harness({input={...inputFixture(),runId:randomUUID()},permitClient,reverse=false,fault,recordSink,diagnosticSink,
 snapshotPath=resolve('reference/einstein-matchmaker-data'),signal,executionFactory=createProtocolProbeV4Execution}={}){
 const research=await v4Research(input,snapshotPath),controller=new AbortController(),records=[],diagnostics=[],events=[],http=[],grants=[],releases=[],transportLifecycle=[];
 if(signal){if(signal.aborted)controller.abort();else signal.addEventListener('abort',()=>controller.abort(),{once:true});}
 const manager=permitClient?null:new PermitManager({limits:{...DEFAULT_LIMITS,maxModelRequests:4}});
 manager?.registerRun(input.runId,Date.now()+180000);
 const client=permitClient??{async acquire(requestId){const p=await manager.acquire(input.runId,requestId);grants.push({requestId,permitId:p.id});return p;},release(permitId){releases.push(permitId);transportLifecycle.push({kind:'permit.release',permitId});manager.release(input.runId,permitId);}};
 const expected={runId:input.runId,companyId:input.companyId,challengeId:input.challengeId,researcherId:research.pool.candidates[0].researcherId};
 let firstCount=0,firstReady,finalCount=0,finalReady,siblingAbortObserved=false;
 const firstBoth=new Promise(r=>{firstReady=r;}),finalBoth=new Promise(r=>{finalReady=r;}),finalReceipts=new Map();
 const record=row=>{records.push(row);return recordSink?.(row);},writeDiagnostic=async row=>{diagnostics.push(row);await diagnosticSink?.(row);};
 const fetchImpl=async(url,init)=>{
  const body=JSON.parse(init.body),last=records.filter(r=>r.kind==='staged.http.policy').at(-1),outputs=body.messages.filter(m=>m.role==='tool');
  const task=JSON.parse(body.messages.find(m=>m.role==='user').content),entry={url,rawBody:init.body,body,actor:last?.actor,requestId:last?.requestId,permitId:last?.permitId,stage:outputs.length?'final':'first'};
  http.push(entry);
  transportLifecycle.push({kind:'fetch.entered',requestId:entry.requestId,permitId:entry.permitId});
  init.signal.addEventListener('abort',()=>transportLifecycle.push({kind:'fetch.aborted',requestId:entry.requestId,permitId:entry.permitId}),{once:true});
  if(!outputs.length){
   const slot=++firstCount;if(firstCount===2)firstReady();await stopWait(firstBoth,init.signal);
   if(fault==='bad_response')return new Response('not JSON',{status:200});
   const names=reverse?['read_candidate_bundle','read_company_challenge']:['read_company_challenge','read_candidate_bundle'];
   if(fault==='first_three')names.push('read_candidate_bundle');
   return respond({content:fault==='first_reasoning'?'<think>fixture hidden</think>':fault==='first_preface'?'Ordinary fixture preface.':null,tool_calls:names.map((name,i)=>({id:`v4_fixture_${slot}_${i}_${randomUUID()}`,type:'function',function:{name,
    arguments:JSON.stringify(name==='read_company_challenge'?{runId:task.runId,companyId:task.companyId,challengeId:task.challengeId}:{runId:task.runId,researcherId:task.researcherId})}}))});
  }
  const calls=body.messages.find(m=>m.role==='assistant'&&m.tool_calls).tool_calls,key=calls[0].id;
  const receipts=outputs.map((output,i)=>({toolName:calls[i].function.name,receiptId:JSON.parse(output.content).receiptId}));
  finalReceipts.set(key,receipts);if(++finalCount===2)finalReady();await stopWait(finalBoth,init.signal);
  const extra=()=>respond({content:null,tool_calls:[{id:'v4_rejected_'+randomUUID(),type:'function',function:{name:'read_candidate_bundle',arguments:JSON.stringify({runId:task.runId,researcherId:task.researcherId})}}]});
  if(fault==='second_tools')return extra();
  if(fault==='sibling_cancel'){
   if(key===finalReceipts.keys().next().value)return extra();
   return await new Promise((resolve,reject)=>{const stop=()=>{siblingAbortObserved=true;reject(Error('OFFLINE_FIXTURE_SIBLING_ABORTED'));};
    if(init.signal.aborted)stop();else init.signal.addEventListener('abort',stop,{once:true});});
  }
  const answer={runId:task.runId,challengeId:task.challengeId,researcherId:task.researcherId,receipts:structuredClone(receipts)};
  if(fault==='missing_receipt')answer.receipts.pop();if(fault==='wrong_receipt')answer.receipts[0].receiptId=randomUUID();
  if(fault==='cross_context_receipt')answer.receipts=structuredClone([...finalReceipts.entries()].find(([k])=>k!==key)[1]);
  if(fault==='wrong_order')answer.receipts.reverse();
  return respond({content:JSON.stringify(answer)});
 };
 const common={input,research,gateway:{baseURL:'https://offline.invalid/v1',apiKey:'offline_fixture_v4_key',model:'offline_fixture'},
  runnerMode:'offline_fixture',signal:controller.signal,permitClient:client,record,writeDiagnostic,fetchImpl};
 const execution=executionFactory(common),limits={...DEFAULT_LIMITS,maxModelRequests:4};
 return{input,research,expected,execution,common,records,diagnostics,events,http,grants,releases,manager,client,controller,transportLifecycle,
  get siblingAbortObserved(){return siblingAbortObserved;},
  run:()=>executeRun({v:1,kind:'start',runId:input.runId,runInput:input,snapshotPath,limits},e=>events.push(e),client,execution),
  close(){controller.abort();manager?.dispose();}};
}
