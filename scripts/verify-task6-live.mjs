// One authorized product-adapter diagnostic flow. Importing this file never calls a model.
import { writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Scheduler } from '../dist/server/supervisor/scheduler.js';
import { ProcessHost } from '../dist/server/supervisor/process-host.js';
import { RunStore } from '../dist/server/storage/run-store.js';
import { DATASET_COMMIT } from '../dist/server/contracts/primitives.js';
import { DEFAULT_LIMITS } from '../dist/server/contracts/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uuid = /^[a-f0-9-]{36}$/;
const actorKey = a => JSON.stringify([a?.runId,a?.role,a?.agentId,a?.taskId,a?.contextId,a?.loopId,a?.attempt]);
export function analyzeProbe(input) {
  const reasons=[],requests=[],toolRoundTrips=[];
  const need=(ok,code)=>{if(!ok&&!reasons.includes(code))reasons.push(code);};
  need(input.runnerMode==='live','NOT_LIVE');need(input.record?.status==='insufficient','DIAGNOSTIC_TERMINAL_MISMATCH');
  need(input.record?.runId===input.runId&&input.record?.runnerMode==='live'&&input.cleanup?.runId===input.runId,'PARENT_RUN_BINDING_MISMATCH');
  need(input.cleanup?.exit?.exitObserved&&input.cleanup?.exit?.exitCode===0,'WORKER_EXIT_NOT_SUCCESSFUL');
  need(input.cleanup?.confirmed&&input.cleanup?.exit?.closeObserved&&input.record?.cleanupState==='confirmed','CLEANUP_UNCONFIRMED');
  const native=input.diagnostic?.native??[],traces=input.diagnostic?.requests??[];
  const starts=traces.filter(t=>t.type==='request.started'),ends=traces.filter(t=>t.type==='request.completed');
  need(starts.length===4&&ends.length===4&&!traces.some(t=>t.type==='request.failed'),'REQUEST_FLOW_INCOMPLETE');
  for(const s of starts){
    const matches=ends.filter(e=>e.requestId===s.requestId&&e.permitId===s.permitId&&actorKey(e.actor)===actorKey(s.actor));
    const e=matches[0];need(matches.length===1,'REQUEST_COMPLETION_MISMATCH');
    need(s.actor?.runId===input.runId&&['proposer','counter-evidence'].includes(s.actor?.role)&&['agentId','taskId','contextId','loopId'].every(k=>uuid.test(s.actor?.[k]??'')),'REQUEST_ACTOR_MISMATCH');
    need(uuid.test(s.requestId??'')&&uuid.test(s.permitId??''),'REQUEST_ID_MISMATCH');
    need(Number.isFinite(s.monotonicMs)&&Number.isFinite(e?.monotonicMs)&&e.monotonicMs>=s.monotonicMs,'INVALID_REQUEST_INTERVAL');
    const grant=input.events?.find(v=>v.type==='permit.granted'&&v.payload.requestId===s.requestId&&v.payload.permitId===s.permitId);
    const begun=input.events?.find(v=>v.type==='model.request.started'&&v.payload.requestId===s.requestId&&v.payload.permitId===s.permitId);
    need(grant&&begun&&grant.seq<begun.seq,'PARENT_GRANT_NOT_PROVEN');
    requests.push({requestId:s.requestId,permitId:s.permitId,actor:s.actor,startedAt:s.timestamp??null,completedAt:e?.timestamp??null,
      startMs:s.monotonicMs,endMs:e?.monotonicMs??null,durationMs:e?e.monotonicMs-s.monotonicMs:null});
  }
  need(new Set(starts.map(s=>s.requestId)).size===4,'DUPLICATE_REQUEST');
  const actors=[];
  for(const role of ['proposer','counter-evidence']){
    const own=starts.filter(t=>t.actor.role===role);need(own.length===2,'ROLE_REQUEST_COUNT');
    need(new Set(own.map(t=>actorKey(t.actor))).size===1,'TASK_CONTEXT_CHANGED');
    if(own[0])actors.push(own[0].actor);
    const began=native.filter(e=>e.type==='function_call.started'&&e.actor?.role===role),completed=native.filter(e=>e.type==='function_call.completed'&&e.actor?.role===role);
    const back=native.filter(e=>e.type==='context.tool_result'&&e.actor?.role===role),answers=native.filter(e=>e.type==='model.answer'&&e.actor?.role===role);
    const c=completed[0],b=back[0],a=answers[0],s=began[0];
    need(began.length===1&&completed.length===1&&back.length===1&&answers.length===1,'NATIVE_TOOL_FLOW_INCOMPLETE');
    need(s?.toolName==='read_company_challenge'&&s?.callId===c?.callId&&c?.callId===b?.callId,'NATIVE_TOOL_CALL_MISMATCH');
    need(Boolean(c?.outputHash)&&c.outputHash===b?.outputHash,'TOOL_OUTPUT_NOT_REINSERTED');
    need(c?.receipt?.ok===true&&c.receipt.runId===input.runId&&c.receipt.challengeId===input.challengeId&&uuid.test(c.receipt.receiptId??''),'INVALID_TOOL_RECEIPT');
    need(c?.receipt?.receiptId===b?.receiptId&&b?.receiptId===a?.answer?.receiptId&&a?.answer?.runId===input.runId&&a?.answer?.challengeId===input.challengeId,'TOOL_RECEIPT_NOT_RETURNED');
    need([s,c,b,a].every(e=>e&&actorKey(e.actor)===actorKey(own[0]?.actor)),'NATIVE_TASK_ID_MISMATCH');
    toolRoundTrips.push({role,callId:c?.callId??null,receiptId:c?.receipt?.receiptId??null,outputHash:c?.outputHash??null,
      returnedByModel:a?.answer?.receiptId??null});
  }
  need(['agentId','taskId','contextId','loopId'].every(k=>actors.length===2&&actors[0][k]!==actors[1][k]),'ANALYSIS_AGENTS_NOT_ISOLATED');
  const first=role=>requests.filter(r=>r.actor.role===role).sort((a,b)=>a.startMs-b.startMs)[0];
  const a=first('proposer'),b=first('counter-evidence');
  const firstRequestOverlapMs=a&&b&&a.endMs!==null&&b.endMs!==null?Math.max(0,Math.min(a.endMs,b.endMs)-Math.max(a.startMs,b.startMs)):0;
  need(firstRequestOverlapMs>0,'NO_REAL_REQUEST_OVERLAP');
  let active=0,maxInFlight=0;
  const edges=requests.filter(r=>r.endMs!==null).flatMap(r=>[{t:r.startMs,n:1},{t:r.endMs,n:-1}]).sort((a,b)=>a.t-b.t||a.n-b.n);
  for(const edge of edges){active+=edge.n;maxInFlight=Math.max(active,maxInFlight);}need(maxInFlight<=2,'GLOBAL_CONCURRENCY_EXCEEDED');
  const usage=traces.filter(t=>t.type==='usage').map(t=>t.usage);
  return {valid:reasons.length===0,reasons,requests,toolRoundTrips,firstRequestOverlapMs,maxInFlight,
    usage,usageStatus:usage.some(u=>u?.totalTokens!==undefined||u?.promptTokens!==undefined||u?.completionTokens!==undefined)?'gateway_reported':'unknown',
    interpretation:'Client fetch/body intervals only; no claim about provider internal scheduling, semantic quality, cost or publishing'};
}

async function main(){
  const runId=randomUUID(),createdAt=new Date().toISOString(),folder=resolve(root,'docs/implementation');
  // Exclusive marker prevents an accidental second flow. A failed attempt is never retried here.
  await writeFile(join(folder,'task-6-live-attempt.json'),JSON.stringify({runnerMode:'live',scope:'one_authorized_product_adapter_probe',runId,createdAt},null,2)+'\n',{flag:'wx'});
  const workRoot=await mkdtemp(join(tmpdir(),'einstein task6 live ')),store=await RunStore.open(workRoot);
  const workerPath=resolve(root,'dist/server/runtime/worker-entry.js');
  const limits={...DEFAULT_LIMITS,maxModelRequests:4}; // narrower probe budget; production default remains16
  const scheduler=new Scheduler({store,runnerMode:'live',limits,snapshotPath:resolve(root,'reference/einstein-matchmaker-data'),
    createHost:callbacks=>new ProcessHost({workerPath,workerArgs:['--adapter-probe'],cwd:workRoot,...callbacks})});
  let errorCode;
  try{
    await scheduler.submit({runId,companyId:'C001',challengeId:'C001-CH1',datasetCommit:DATASET_COMMIT,promptVersion:'task6_adapter_probe_v1',configVersion:'task6',mode:'research'});
    await scheduler.waitForIdle(205000);
  }catch(error){errorCode=typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'LIVE_FLOW_FAILED';}
  finally{try{await scheduler.close();}catch{errorCode??='SCHEDULER_CLOSE_FAILED';}}
  const record=store.getRun(runId),events=record?store.eventsAfter(runId,0):[],cleanups=scheduler.cleanupEvidence;
  const cleanup=cleanups.find(c=>c.runId===runId);let diagnostic;
  for(const line of cleanup?.exit.stdout.trim().split(/\r?\n/)??[]){try{const value=JSON.parse(line);if(value.task6Worker&&value.runId===runId)diagnostic=value.diagnostic;}catch{/* SDK banner is not proof */}}
  const analysis=analyzeProbe({runId,challengeId:'C001-CH1',runnerMode:'live',record,events,cleanup,diagnostic});
  const projections=cleanups.map(c=>{const {stdout,stderr,...exit}=c.exit;return {...c,exit,outputBytes:{stdout:Buffer.byteLength(stdout),stderr:Buffer.byteLength(stderr)}};});
  const result={runnerMode:'live',scope:'one_authorized_product_adapter_probe',runId,createdAt,finishedAt:new Date().toISOString(),
    workerPath,workerCwdPolicy:'new empty temporary working directory; no source .env read',model:process.env.EINSTEIN_GATEWAY_MODEL??null,
    record:record??null,events,diagnostic:diagnostic??null,analysis,cleanups:projections,permitSnapshot:scheduler.permits.snapshot(),
    limits,safetyHold:scheduler.safetyHold,errorCode:errorCode??null,publication:'forbidden_Task7_not_implemented',retryCount:0};
  await writeFile(join(folder,'task-6-live-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  await store.close();
  console.log(JSON.stringify({runId,liveValid:analysis.valid,errorCode:errorCode??null,requests:analysis.requests.length,
    overlapMs:analysis.firstRequestOverlapMs,usageStatus:analysis.usageStatus,cleanupConfirmed:cleanup?.confirmed??false,output:'docs/implementation/task-6-live-result.json'}));
  if(errorCode||!analysis.valid)process.exitCode=1;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(()=>{console.error('LIVE_FLOW_FAILED_NO_RETRY');process.exitCode=1;});
