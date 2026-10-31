// Explicit post-execution read-only audit. No provider, worker spawn,
// RunStore.open, recovery, permit mutation, cleanup or lock operation.
// Only new parent-store copies and execution-audit.json are written with wx.
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalizeArtifact} from '../dist/server/contracts/canonical.js';
import {sha256Bytes,hashArtifact,hashRunInput} from '../dist/server/evidence/hashing.js';
import {validateV3Plan,collectV3ProductFingerprints} from '../dist/server/evaluation/v3-bounded-validation.js';
import {evaluateV3ProbeGate} from '../dist/server/evaluation/protocol-probe-v3-gate.js';
import {analyzeL05Chain} from '../dist/server/evaluation/bounded-validation.js';
import {summarizeCriticRequestIntervals,diffReviewedDrafts} from '../dist/server/evaluation/run-critic-eval.js';

const root=resolve(fileURLToPath(new URL('../',import.meta.url))),folder=join(root,'docs/implementation/task-7v-live');
const output=join(folder,'execution-audit.json');
const ensure=(v,code)=>{if(!v)throw Error(code);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a,b)=>canonicalizeArtifact(a??null)===canonicalizeArtifact(b??null);
const array=v=>Array.isArray(v)?v:[];
const actorKey=a=>canonicalizeArtifact(['runId','role','agentId','taskId','contextId','loopId','attempt'].map(k=>a?.[k]??null));
const own=(a,b)=>object(a)&&actorKey(a)===actorKey(b);
const shaText=text=>sha256Bytes(Buffer.from(text,'utf8'));
const sourceFiles=[];
async function exists(file){try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function source(file){const bytes=await readFile(file);sourceFiles.push({file:relative(root,file).replaceAll('\\','/'),bytes:bytes.length,sha256:sha256Bytes(bytes)});return bytes;}
const json=async file=>JSON.parse((await source(file)).toString('utf8'));
async function walk(dir){const result=[];
 for(const item of await readdir(dir,{withFileTypes:true})){const file=join(dir,item.name);
  if(item.isDirectory())result.push(...await walk(file));else if(item.isFile())result.push(resolve(file));else throw Error('AUDIT_UNEXPECTED_LINK');}
 return result.sort();
}
async function stream(file){
 if(!await exists(file))return{file:relative(root,file).replaceAll('\\','/'),exists:false,rows:[],complete:false,code:'AUDIT_EVIDENCE_STREAM_MISSING'};
 const bytes=await source(file);ensure(bytes.length<=32*1024*1024,'AUDIT_STREAM_SIZE_LIMIT');
 const rows=[];for(const line of bytes.toString('utf8').split(/\r?\n/).filter(Boolean)){
  let row;try{row=JSON.parse(line);}catch{return{file:relative(root,file).replaceAll('\\','/'),exists:true,rows,complete:false,code:'AUDIT_EVIDENCE_STREAM_INVALID_JSON'};}
  if(!object(row)||!Number.isFinite(row.monotonicMs))return{file:relative(root,file).replaceAll('\\','/'),exists:true,rows,complete:false,code:'AUDIT_EVIDENCE_STREAM_INVALID_RECORD'};
  rows.push(row);
 }
 return{file:relative(root,file).replaceAll('\\','/'),exists:true,rows,complete:true,code:null};
}

ensure(!await exists(output),'AUDIT_OUTPUT_ALREADY_EXISTS');
const freezeFile=join(folder,'freeze.json'),freezeRaw=await source(freezeFile),freeze=validateV3Plan(JSON.parse(freezeRaw.toString('utf8')));
ensure(freeze.scope==='task7v_v3_protocol_then_single_L05','AUDIT_SCOPE_MISMATCH');
const baselineRaw=await source(resolve(root,freeze.baseline.file));ensure(sha256Bytes(baselineRaw)===freeze.baseline.sha256,'AUDIT_BASELINE_HASH_CHANGED');
const baseline=JSON.parse(baselineRaw.toString('utf8'));
ensure(baseline.head==='c2fcaea67a57eff3a56b2f98b6b8cf80024a677f'&&baseline.protectedUntrackedJson.length===142
 &&baseline.historicalImplementation.length===939&&baseline.historicalStore.files.length===94&&baseline.historicalStore.root===freeze.baseline.storeRoot,'AUDIT_BASELINE_IDENTITY');
async function protectedIntegrity(){
 const groups={user:baseline.protectedUntrackedJson,implementation:baseline.historicalImplementation,store:baseline.historicalStore.files,
  decisions:[baseline.existingAuthorization,baseline.existingResolution]};
 const result={};for(const [name,files]of Object.entries(groups)){
  const rows=await Promise.all(files.map(async f=>({file:f.file,sha256:f.sha256,unchanged:sha256Bytes(await readFile(resolve(root,f.file)))===f.sha256})));
  ensure(rows.every(r=>r.unchanged),'AUDIT_PROTECTED_BYTES_CHANGED');result[name]={count:rows.length,allUnchanged:true};
 }
 return result;
}
const beforeIntegrity=await protectedIntegrity();
ensure(same(await collectV3ProductFingerprints(),freeze.productFingerprints),'AUDIT_FROZEN_PRODUCT_CHANGED');
const sourceIntegrity=await Promise.all(freeze.sourceIntegrity.map(async f=>{const bytes=await readFile(join(root,'reference/einstein-matchmaker-data',f.file));
 return{file:f.file,bytes:bytes.length,expectedSha256:f.expectedSha256,actualSha256:sha256Bytes(bytes),unchanged:bytes.length===f.bytes&&sha256Bytes(bytes)===f.actualSha256&&f.expectedSha256===f.actualSha256};}));
ensure(sourceIntegrity.length===8&&sourceIntegrity.every(f=>f.unchanged),'AUDIT_OFFICIAL_SOURCE_CHANGED');
const contract=await readFile(resolve(root,freeze.promptContract.interfaceContract.file));
ensure(sha256Bytes(contract)===freeze.promptContract.interfaceContract.sha256&&contract.toString('utf8')===freeze.promptContract.interfaceContract.text,'AUDIT_INTERFACE_CONTRACT_CHANGED');
const summary=await json(join(folder,'summary.json'));
ensure(summary.scope===freeze.scope&&summary.freezeHash===freeze.hash,'AUDIT_SUMMARY_FREEZE_MISMATCH');
if(await exists(join(folder,'attempt.json')))await source(join(folder,'attempt.json'));
const declared=array(summary.execution?.rows),runs=[],authorizedStoreFiles=[];

function permitAccounting(run){
 const events=array(run.events),grants=events.filter(e=>e.type==='permit.granted'),releases=events.filter(e=>e.type==='permit.released');
 const cleanups=array(run.cleanups),cleanupEvents=events.filter(e=>e.type==='cleanup.completed'&&e.payload?.confirmed===true&&e.runId===run.runId);
 const manager=run.permitSnapshot,managerRows=array(manager?.runs).filter(r=>r.runId===run.runId);
 const zero=manager?.inFlight===0&&managerRows.length===1&&managerRows[0].inFlight===0&&managerRows[0].pending===0
  &&array(manager?.runs).every(r=>r.inFlight===0&&r.pending===0);
 const cleanupConfirmed=cleanups.length===1&&cleanups[0].runId===run.runId&&cleanups[0].confirmed===true&&cleanups[0].rootVerification==='absent'
  &&run.record?.cleanupState==='confirmed'&&cleanups[0].exit?.exitObserved===true&&cleanups[0].exit?.closeObserved===true
  &&Array.isArray(cleanups[0].scanDiagnostics)&&cleanups[0].scanDiagnostics.length===0&&Array.isArray(cleanups[0].descendants)
  &&cleanups[0].descendants.every(d=>['absent','mismatch'].includes(d.verification))&&cleanupEvents.length===1
  &&events.filter(e=>['permit.granted','model.request.started','model.request.completed','model.request.failed'].includes(e.type)).every(e=>e.seq<cleanupEvents[0].seq);
 const problems=[],accounting=[];const ids=new Set(),requests=new Set();
 for(const grant of grants){const requestId=grant.payload?.requestId,permitId=grant.payload?.permitId;
  if(grant.runId!==run.runId||ids.has(permitId)||requests.has(requestId))problems.push('AUDIT_GRANT_OWNERSHIP_OR_DUPLICATION');
  ids.add(permitId);requests.add(requestId);const release=releases.filter(r=>r.payload?.permitId===permitId);
  const releaseValid=release.length===1&&release.every(r=>r.runId===run.runId&&r.seq>grant.seq);
  if(release.length>1||release.some(r=>r.runId!==run.runId||r.seq<=grant.seq))problems.push('AUDIT_EXPLICIT_RELEASE_INVALID');
  const disposition=releaseValid?'explicit_release':release.length===0&&cleanupConfirmed&&zero&&run.safetyHold===false&&cleanupEvents[0].seq>grant.seq?'confirmed_cleanup_reclaim':'unconfirmed';
  if(disposition==='unconfirmed')problems.push('AUDIT_RESERVATION_NOT_CONFIRMED_SETTLED');
  accounting.push({requestId:requestId??null,permitId:permitId??null,disposition,
   basis:disposition==='explicit_release'?'actual parent permit.released event':disposition==='confirmed_cleanup_reclaim'
    ?'existing confirmed-cleanup reclaim barrier, recorded exit/identity and current zero snapshot; no release event was observed or fabricated':'insufficient settlement evidence'});
 }
 if(releases.some(r=>!ids.has(r.payload?.permitId)))problems.push('AUDIT_FOREIGN_RELEASE');
 if(managerRows.length!==1||managerRows[0]?.attempts!==grants.length)problems.push('AUDIT_ATTEMPT_COUNT_MISMATCH');
 return{granted:grants.length,explicitReleaseEvents:releases.length,confirmedCleanupReclaims:accounting.filter(r=>r.disposition==='confirmed_cleanup_reclaim').length,
  attempts:managerRows[0]?.attempts??null,cleanupConfirmed,zeroCurrentSnapshot:zero,accounting,problems:[...new Set(problems)],
  interpretation:'Explicit releases are ledger events. Cleanup reclaim is a separately evidenced inference, never a manufactured permit.released event; attempts are not refunded.'};
}
function nativeObservations(records){
 const completed=records.filter(r=>r.kind==='native'&&r.type==='function_call.completed'),staged=records.filter(r=>r.kind==='tool.batch'&&r.manifest?.phase==='staged');
 const calls=completed.map((end,index)=>{
  const before=records.indexOf(end),start=records.slice(0,before).filter(r=>r.kind==='native'&&r.type==='function_call.started'&&r.callId===end.callId&&own(r.actor,end.actor)).at(-1);
  const outputHash=end.outputSha256??end.outputHash??null,receipt=end.receipt??end.output??null;
  const contexts=records.slice(before+1).filter(r=>r.kind==='native'&&r.type==='inference.started'&&own(r.actor,end.actor));
  const returned=contexts.find(r=>array(r.toolResults).some(t=>t.callId===end.callId&&(t.outputSha256??t.outputHash)===outputHash));
  return{index,actor:end.actor,originalCallId:end.callId??null,toolName:start?.toolName??null,argumentsHash:start?.argumentsSha256??start?.argumentsHash??null,
   outputHash,receiptId:receipt?.receiptId??null,ok:receipt?.ok===true,nativeStartObserved:Boolean(start),returnedToSameContext:Boolean(returned),
   returnedContextId:returned?.contextId??null,missingContextMeaning:returned?null:'not_observed; absence alone is not proof of output corruption'};
 });
 return{completedCallCount:completed.length,calls,batches:staged.map(s=>({actor:s.manifest.actor,batchId:s.manifest.batchId,
  callCount:array(s.manifest.calls).length,calls:s.manifest.calls,terminalPhases:records.filter(r=>r.kind==='tool.batch'&&r.manifest?.batchId===s.manifest.batchId
   &&own(r.manifest.actor,s.manifest.actor)&&['completed','failed','cancelled'].includes(r.manifest.phase)).map(r=>r.manifest.phase)}))};
}
function requestObservations(records){
 const traces=records.filter(r=>r.kind==='request').map(r=>r.trace),summary=summarizeCriticRequestIntervals(traces);
 const requests=summary.intervals.map(interval=>{const usage=traces.filter(t=>t.type==='usage'&&t.requestId===interval.requestId&&own(t.actor,interval.actor));
  const any=usage.length===1&&['promptTokens','completionTokens','totalTokens'].some(k=>Number.isFinite(usage[0].usage?.[k]));
  return{...interval,usageRowCount:usage.length,usageStatus:any?'gateway_reported':'unknown',reportedUsage:usage.length===1?usage[0].usage??null:null};});
 const {reportedTotals,usageStatus:originalUsageStatus,...rest}=summary;
 const fullyReported=requests.length>0&&requests.every(r=>r.usageRowCount===1&&['promptTokens','completionTokens','totalTokens'].every(k=>Number.isFinite(r.reportedUsage?.[k])));
 return{...rest,intervals:requests,usageStatus:fullyReported?'gateway_reported_complete':requests.some(r=>r.usageStatus==='gateway_reported')?'gateway_reported_partial':'unknown',
  originalAdapterUsageStatus:originalUsageStatus,sumOfAvailableReportedValues:reportedTotals,completeUsageTotalKnown:fullyReported,
  usageCoverage:{requests:requests.length,reported:requests.filter(r=>r.usageStatus==='gateway_reported').length,unknown:requests.filter(r=>r.usageStatus==='unknown').length},
  usageRows:traces.filter(t=>t.type==='usage').map(t=>({requestId:t.requestId??null,permitId:t.permitId??null,actor:t.actor??null,usage:t.usage??null})),
  interpretation:'Recorded request starts/ends and supplied usage only. Missing usage remains unknown; no token, price or provider scheduling estimate.'};
}
async function copyParentFiles(runId,runFolder){
 const copyFolder=join(runFolder,'parent-store-copy');await mkdir(copyFolder,{recursive:true});const files=[];
 for(const name of ['record.json','events.jsonl','terminal.json']){
  const file=join(baseline.historicalStore.root,runId,name),bytes=await source(file),copy=join(copyFolder,name);
  if(await exists(copy))ensure((await readFile(copy)).equals(bytes),'AUDIT_EXISTING_COPY_CHANGED');else await writeFile(copy,bytes,{flag:'wx'});
  files.push({file,copy:relative(root,copy).replaceAll('\\','/'),bytes:bytes.length,sha256:sha256Bytes(bytes)});authorizedStoreFiles.push(resolve(file));
 }
 return files;
}
for(const kind of ['probe','l05']){
 const planned=freeze[kind],runFolder=join(folder,'runs',planned.runId),storeFolder=join(baseline.historicalStore.root,planned.runId);
 const row=declared.find(r=>r.runId===planned.runId),runFolderExists=await exists(runFolder),storeFolderExists=await exists(storeFolder);
 const unexecuted=row?.status==='unexecuted'||!row&&!runFolderExists&&!storeFolderExists;
 if(unexecuted){ensure(!runFolderExists&&!storeFolderExists,'AUDIT_UNEXECUTED_RUN_HAS_DIRECTORY');runs.push({kind,runId:planned.runId,status:'unexecuted',requests:0,runDirectoryExists:false,storeDirectoryExists:false});continue;}
 ensure(runFolderExists&&storeFolderExists,'AUDIT_EXECUTED_RUN_DIRECTORY_MISSING');
 const resultFile=join(runFolder,'result.json'),result=await json(resultFile);ensure(result.runId===planned.runId,'AUDIT_RESULT_RUN_MISMATCH');
 const native=await stream(join(runFolder,'worker-evidence.jsonl')),diagnostics=await stream(join(runFolder,'answer-diagnostics.jsonl'));
 const records=[...native.rows,...diagnostics.rows].sort((a,b)=>a.monotonicMs-b.monotonicMs);
 const parentCopies=await copyParentFiles(planned.runId,runFolder),terminal=JSON.parse((await readFile(join(storeFolder,'terminal.json'))).toString('utf8'));
 const storedEvents=(await readFile(join(storeFolder,'events.jsonl'),'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
 const parentConsistency={terminalRecordMatches:same(terminal.record,result.record),terminalOutcomeMatches:same(terminal.outcome,result.terminalOutcome),
  eventsMatch:same(storedEvents,result.events),publicationMatches:same(terminal.publication??null,result.publication??null),
  fullFrozenInputMatches:same(result.record?.input,planned.input)&&result.record?.inputHash===hashRunInput(planned.input),
  originalRecordIsNotRewrittenToTerminal:'record.json is copied as found; terminal.json is the authoritative final envelope'};
 ensure(Object.values(parentConsistency).every(v=>v!==false),'AUDIT_PARENT_RESULT_CONTRADICTION');
 const nativeFacts=nativeObservations(records),requests=requestObservations(records),permits=permitAccounting(result),headers=native.rows.filter(r=>r.kind==='header');
 const item={kind,runId:planned.runId,status:'executed',originalStatus:result.record?.status??null,resultFile:relative(root,resultFile).replaceAll('\\','/'),
  parentCopies,parentConsistency,evidence:{native:{file:native.file,complete:native.complete,code:native.code,records:native.rows.length},
   diagnostics:{file:diagnostics.file,complete:diagnostics.complete,code:diagnostics.code,records:diagnostics.rows.length},sameWorkerClockMerged:true,resultRecordsMatchRawMerge:same(result.records,records)},
  ids:{actors:[...new Map(records.flatMap(r=>object(r.actor)?[[actorKey(r.actor),r.actor]]:[])).values()],requestIds:requests.intervals.map(r=>r.requestId),permitIds:requests.intervals.map(r=>r.permitId)},
  requests,native:nativeFacts,permits,cleanups:result.cleanups,terminalOutcome:result.terminalOutcome,errorCode:result.errorCode,safetyHold:result.safetyHold,permitSnapshot:result.permitSnapshot,
  headerBindings:{count:headers.length,runIds:headers.map(h=>h.runId),freezeHashes:headers.map(h=>h.freezeHash)},humanLabels:0,qualityMetrics:'NA'};
 if(kind==='probe'){
  const gate=evaluateV3ProbeGate({...result,records,expected:{companyId:planned.input.companyId,challengeId:planned.input.challengeId,researcherId:planned.researcherId},
   effectiveInstructionSha256:planned.effectiveInstructionSha256,genericDispatchSha256:freeze.promptContract.genericDispatchSha256});
  const wireBatches=array(gate.analysis?.batches).map(batch=>{
   const wire=records.find(r=>r.kind==='wire.request'&&r.requestId===batch.nextHttpRequestId&&own(r.actor,batch.actor));
   const messages=array(wire?.messages),calls=array(batch.calls),groups=messages.flatMap((m,i)=>m.role==='assistant'?[{message:m,index:i}]:[]);
   const matching=groups.filter(g=>same(array(g.message.calls).map(c=>c.callId),calls.map(c=>c.originalCallId))),group=matching[0];
   const outputs=group?messages.slice(group.index+1,group.index+1+calls.length):[];
   const exact=calls.length>0&&matching.length===1&&outputs.length===calls.length&&outputs.every(m=>m.role==='tool')&&calls.every((c,i)=>{
    const original=group.message.calls[i],output=outputs[i];return original.callId===c.originalCallId&&original.toolName===c.toolName
     &&original.argumentsSha256===c.argumentsSha256&&same(original.arguments,c.arguments)&&output.callId===c.originalCallId
     &&output.outputSha256===c.outputSha256&&same(output.receipt,c.receipt);
   });
   const interval=requests.intervals.find(r=>r.requestId===wire?.requestId),end=records.find(r=>r.kind==='request'&&r.trace.requestId===wire?.requestId&&['request.completed','request.failed'].includes(r.trace.type));
   return{actor:batch.actor,batchId:batch.batchId,requestId:wire?.requestId??null,outgoingProjectionObserved:Boolean(wire),originalCallsAndActualOutputsMatch:exact,
    requestCompletion:interval?.completion??'unobserved',responseStage:end?.trace?.diagnostic?.stage??null,responseCode:interval?.code??null,
    meaning:'Outgoing call/result correspondence is independent of later model-contract acceptance or successful request completion.'};
  });
  item.probe={originalGatePassed:result.probeGate?.passed??null,recomputedGate:gate,originalGateMatchesRecomputation:same(result.probeGate,gate),
   completeProtocolObserved:gate.passed&&gate.liveEligible&&native.complete&&diagnostics.complete,
   guardDecisions:native.rows.filter(r=>r.kind==='probe.contract'),effectivePrompts:native.rows.filter(r=>r.kind==='wire.effective_prompt'),
   finalModelAnswers:native.rows.filter(r=>r.kind==='native'&&r.type==='model.answer'),answerDiagnostics:diagnostics.rows,
   wireProjectionCount:native.rows.filter(r=>r.kind==='wire.request').length,wireBatches};
 }else{
  const artifacts=native.rows.filter(r=>r.kind==='artifact').map(r=>r.artifact),drafts=artifacts.filter(a=>a.kind==='proposal_draft').map(a=>a.artifact),
   reviews=artifacts.filter(a=>a.kind==='critic_review').map(a=>a.artifact),counters=artifacts.filter(a=>a.kind==='counter_report').map(a=>a.artifact),
   dispatches=native.rows.filter(r=>r.kind==='review.dispatch'),publication=terminal.publication??null;
  const base={...result,draftVersions:drafts,reviewVersions:reviews,loadedReviewSnapshots:dispatches,caseManifest:planned.manifest,publication};
  const chain=analyzeL05Chain(base),d2=drafts.find(d=>d.version===2),rendered=publication?.renderedDraft;
  let renderedDraft=null;try{renderedDraft=typeof rendered==='string'?JSON.parse(rendered):null;}catch{/* Retain the recorded malformed status below; never fix output. */}
  item.l05={controlledAdversarial:true,showcaseEligible:false,caseManifest:planned.manifest,attackDifferences:headers.map(h=>h.attackDiff??null),
   drafts,reviews,counters,draftHashVerification:{observed:drafts.length,status:drafts.length?drafts.every(d=>d.draftHash===hashArtifact(d))?'verified':'mismatch':'unobserved'},
   reviewHashVerification:{observed:reviews.length,status:reviews.length?reviews.every(r=>r.hash===hashArtifact(r))?'verified':'mismatch':'unobserved'},
   completeReviewLoads:dispatches.map(d=>({actor:d.actor,target:d.snapshot?.target??null,loadedFields:d.snapshot?.loadedFields??[],checks:d.snapshot?.checks??null,
    snapshotHash:object(d.snapshot)?hashArtifact(d.snapshot):null})),
   initialAndDynamicTaskFacts:native.rows.filter(r=>r.kind==='context.user_task'),reviewResults:native.rows.filter(r=>r.kind==='review.result'),
   versionDifferences:drafts.length===2?diffReviewedDrafts(drafts[0],drafts[1]):[],
   contentDifferences:drafts.length===2?diffReviewedDrafts({claims:drafts[0].claims,sections:drafts[0].sections},{claims:drafts[1].claims,sections:drafts[1].sections}):[],
   chain,originalChainMatchesRecomputation:same(result.l05Analysis,chain),diagnosticPublication:publication,
   publicationIsAdversarialDiagnosticOnly:publication?publication.mode==='adversarial'&&publication.runnerMode==='live'&&publication.formalProposal===null:null,
   finalRenderedDraftMatchesExactV2:publication?Boolean(d2)&&same(renderedDraft,d2):null,
   renderedTextByteSha256:typeof rendered==='string'?shaText(rendered):null,
   renderedArtifactHashValid:publication?publication.renderedHash===hashArtifact({renderedDraft:rendered}):null,
   semanticCorrection:'unadjudicated; inspect actual findings and content differences; not human gold or accuracy evidence'};
 }
 runs.push(item);
}
const probe=runs.find(r=>r.kind==='probe'),l05=runs.find(r=>r.kind==='l05');
ensure(l05?.status!=='executed'||probe?.probe?.completeProtocolObserved===true,'AUDIT_L05_WITHOUT_COMPLETE_PROBE');
const originalSet=new Set(baseline.historicalStore.files.map(f=>resolve(f.file))),allowedNew=new Set(authorizedStoreFiles);
const actualStoreFiles=await walk(baseline.historicalStore.root),unexpectedStoreFiles=actualStoreFiles.filter(f=>!originalSet.has(f)&&!allowedNew.has(f));
ensure(unexpectedStoreFiles.length===0,'AUDIT_UNEXPECTED_STORE_FILE');
const afterIntegrity=await protectedIntegrity();ensure(same(await collectV3ProductFingerprints(),freeze.productFingerprints),'AUDIT_FROZEN_PRODUCT_CHANGED_DURING_READ');
for(const f of sourceFiles)ensure(sha256Bytes(await readFile(resolve(root,f.file)))===f.sha256,'AUDIT_SOURCE_CHANGED_DURING_READ');
const totalGranted=runs.reduce((n,r)=>n+(r.permits?.granted??0),0),actualHttp=runs.reduce((n,r)=>n+(r.requests?.started??0),0);
ensure((probe?.permits?.granted??0)<=4&&(l05?.permits?.granted??0)<=16&&totalGranted<=20,'AUDIT_AUTHORIZED_REQUEST_LIMIT_EXCEEDED');
const allRequests=runs.flatMap(r=>r.requests?.intervals??[]),reportedUsageAggregate={};
for(const field of ['promptTokens','completionTokens','totalTokens']){
 const supplied=allRequests.filter(r=>r.usageRowCount===1&&Number.isFinite(r.reportedUsage?.[field])&&r.reportedUsage[field]>=0);
 const sumReported=supplied.reduce((n,r)=>n+r.reportedUsage[field],0);
 reportedUsageAggregate[field]={reportedRequests:supplied.length,requestDenominator:allRequests.length,sumOfReportedValues:sumReported,
  completeReportedTotal:allRequests.length>0&&supplied.length===allRequests.length?sumReported:null,status:allRequests.length>0&&supplied.length===allRequests.length?'gateway_reported':'unknown_or_partial'};
}
const report={scope:'task7v_readonly_post_execution_audit_not_reclassification',observedAt:new Date().toISOString(),sourceScope:freeze.scope,
 freeze:{file:relative(root,freezeFile).replaceAll('\\','/'),rawSha256:sha256Bytes(freezeRaw),artifactHash:freeze.hash},
 auditScriptSha256:sha256Bytes(await readFile(fileURLToPath(import.meta.url))),sources:sourceFiles,runs,totalGranted,actualHttp,reportedUsageAggregate,
 summaryTotalGranted:summary.execution?.totalGranted??null,summaryStopReason:summary.execution?.stopReason??null,summaryErrorCode:summary.errorCode??null,
 frozenProductFingerprintCount:freeze.productFingerprints.length,frozenProductFingerprintsUnchanged:true,officialSourceIntegrity:sourceIntegrity,
 protectedIntegrity:{before:beforeIntegrity,after:afterIntegrity,originalStoreFileCount:94,actualStoreFileCount:actualStoreFiles.length,unexpectedStoreFiles,
  userUntrackedStatus:'not inspected here; final Git verification remains separate'},
 probeCompleteProtocolObserved:probe?.probe?.completeProtocolObserved??false,L05Status:l05?.status??'unknown',
 L05StructuralChainObserved:l05?.l05?.chain?.structuralChainObserved??false,L05SemanticQuality:'unadjudicated',
 providerRequestsByAudit:0,storeOpenCalls:0,recoveryApplyCalls:0,newRiskExceptions:0,cleanupCalls:0,lockOperations:0,automaticRetries:0,
 historicalUnknown:'Task7s Proposer text and detailed cause remain unknown; no historical outcome or cleanup is rewritten',
 humanLabels:0,qualityMetrics:'NA',holdout:'unopened',showcaseEligible:false,Task7Overall:'NOT_PASS',Task8Started:false,
 interpretation:'Observed protocol/model/causality and recorded parent cleanup only. No new execution, semantic gold, accurate cost estimate or unknown-orphan guarantee. Originals remain unchanged.'};
await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output:relative(root,output).replaceAll('\\','/'),totalGranted,actualHttp,probePassed:report.probeCompleteProtocolObserved,
 L05:report.L05Status,L05StructuralChain:report.L05StructuralChainObserved,protectedUsers:142,historicalImplementation:939,historicalStore:94,
 allProtectedBytesUnchanged:true,frozenFingerprints:freeze.productFingerprints.length,auditProviderRequests:0,Task7Overall:'NOT_PASS'}));
