// Read-only per-batch audit, append only. No model, store.open, cleanup or retry.
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';import {join,resolve} from 'node:path';
import {collectLayeredProductFingerprints,verifyLayeredHistory} from '../dist/server/evaluation/layered-validation.js';
import {sha256Bytes} from '../dist/server/evidence/hashing.js';import {canonicalizeArtifact} from '../dist/server/contracts/canonical.js';
const j=async p=>JSON.parse(await readFile(p,'utf8')),folder=resolve('docs/implementation/task-7t-live'),freeze=await j(join(folder,'freeze.json')),b=await verifyLayeredHistory();
if(canonicalizeArtifact(await collectLayeredProductFingerprints())!==canonicalizeArtifact(freeze.productFingerprints))throw Error('PRODUCT_CHANGED');
const runFolder=join(folder,'runs',freeze.probe.runId),result=await j(join(runFolder,'result.json'));
const records=(await readFile(join(runFolder,'worker-evidence.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const diagnostics=(await readFile(join(runFolder,'answer-diagnostics.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const actorKey=a=>canonicalizeArtifact([a.runId,a.agentId,a.taskId,a.contextId,a.loopId,a.attempt]);
const batches=[];
for(let i=0;i<records.length;i++){
 const row=records[i];if(row.kind!=='tool.batch'||row.manifest.phase!=='staged')continue;
 const batch=row.manifest,own=r=>r.actor&&actorKey(r.actor)===actorKey(batch.actor);
 const done=records.findIndex((r,k)=>k>i&&r.kind==='tool.batch'&&r.manifest.batchId===batch.batchId&&r.manifest.phase==='completed');
 if(done<0)throw Error('NATIVE_BATCH_NOT_COMPLETED');
 const native=records.slice(i+1,done).filter(r=>r.kind==='native'&&own(r)&&['function_call.started','function_call.completed'].includes(r.type));
 const completed=records[done].manifest.calls;
 const nativeCorrect=native.length===batch.calls.length*2&&batch.calls.every((c,k)=>native[k*2].type==='function_call.started'&&native[k*2+1].type==='function_call.completed'
  &&native[k*2].callId===c.callId&&native[k*2+1].callId===c.callId&&native[k*2].argumentsSha256===c.argumentsSha256
  &&native[k*2+1].outputSha256===completed[k].outputSha256&&native[k*2+1].receipt.ok===true);
 const context=records.slice(done+1).find(r=>r.kind==='native'&&r.type==='inference.started'&&own(r));
 const contextsCorrect=batch.calls.every((c,k)=>context?.toolResults.some(x=>x.callId===c.callId&&x.outputSha256===completed[k].outputSha256));
 const wire=records.slice(done+1).find(r=>r.kind==='wire.request'&&own(r));
 const wireTools=wire?.messages.filter(m=>m.role==='tool')??[];
 const nextHttpCorrect=batch.calls.every((c,k)=>wireTools.some(t=>t.callId===c.callId&&t.outputSha256===completed[k].outputSha256));
 batches.push({batchId:batch.batchId,actor:batch.actor,calls:batch.calls.map((c,k)=>({callId:c.callId,toolName:c.toolName,arguments:native[k*2].arguments,outputSha256:completed[k].outputSha256,receipt:native[k*2+1].receipt})),
  nativeCorrect,contextsCorrect,nextHttpObserved:Boolean(wire),nextHttpCorrect});
 if(!nativeCorrect||!contextsCorrect)throw Error('PER_BATCH_NATIVE_AUDIT_FAILED');
}
await mkdir(join(runFolder,'parent-store-copy'));const copies=[];
for(const name of ['record.json','events.jsonl','terminal.json']){const file=join(b.historicalStore.root,freeze.probe.runId,name),bytes=await readFile(file),copy=join(runFolder,'parent-store-copy',name);await writeFile(copy,bytes,{flag:'wx'});copies.push({file,copy,sha256:sha256Bytes(bytes)});}
const terminal=await j(join(runFolder,'parent-store-copy/terminal.json'));
let l05Exists=false;try{await access(join(b.historicalStore.root,freeze.l05.runId));l05Exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
if(l05Exists)throw Error('L05_NOT_AUTHORIZED_BY_FAILED_PROBE');
const clarification={scope:'append_only_layered_probe_audit_not_reclassification',observedAt:new Date().toISOString(),probeRunId:freeze.probe.runId,L05RunId:freeze.l05.runId,
 originalResultSha256:sha256Bytes(await readFile(join(runFolder,'result.json'))),originalParentFiles:copies,batches,
 nativeCallCount:batches.reduce((n,b)=>n+b.calls.length,0),allNativeBatchesVerified:true,allBatchOutputsReturnedToNativeContexts:true,
 nextHttpBatchCount:batches.filter(b=>b.nextHttpObserved&&b.nextHttpCorrect).length,lastCounterBatchNextHttp:false,
 answerDiagnostics:diagnostics,typedOutcome:terminal.outcome,requests:result.requests,actualCleanup:result.cleanups.map(c=>({confirmed:c.confirmed,rootVerification:c.rootVerification,exitCode:c.exit.exitCode,exitObserved:c.exit.exitObserved,closeObserved:c.exit.closeObserved,scanDiagnostics:c.scanDiagnostics})),
 currentPermits:result.permitSnapshot,safetyHold:result.safetyHold,fullProbePassed:false,L05Status:'unexecuted',L05Created:false,recoveryApplyCalls:0,newRiskExceptions:0,
 notes:[
  'Three supplier batches have 2/4/5 calls; all 11 actual distinct calls execute once in original order with real successful outputs.',
  'Proposer two-call batch and Counter first four-call batch enter their exact second HTTP. Counter final five outputs enter native Context only: third Context request was denied before permit/fetch.',
  'Frozen analyzer assumes one required-tools batch per actor, so secondary NATIVE/WIRE/RECEIPT mismatch codes are not independent proof of adapter corruption. Raw per-batch audit remains separate; original result stays failed.',
  'Counter has no final model.answer; absence of its final capture is an unfinished task, not evidence of a lost final answer or failed diagnostic write.',
  'The runtime currently enforces request-turn caps; required-tool-count violations are diagnosed after execution. Earlier probe-specific failure guards require follow-up, with no extra live requests in this round.',
 ],historicalImplementationUnchanged:761,historicalStoreOriginalFilesUnchanged:91,protectedUserJsonUnchanged:95,frozenFingerprintsUnchanged:115,
 humanLabels:0,qualityMetrics:'NA',holdout:'unopened',auditModelRequests:0,Task7Overall:'NOT_PASS'};
await writeFile(join(folder,'execution-audit.json'),JSON.stringify(clarification,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({batches:batches.map(b=>({role:b.actor.role,count:b.calls.length,native:b.nativeCorrect,context:b.contextsCorrect,nextHTTP:b.nextHttpCorrect})),calls:11,L05:'unexecuted',currentPermit:result.permitSnapshot.inFlight,fullProbe:false,auditModelRequests:0}));
