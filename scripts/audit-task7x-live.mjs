// Read-only post-execution audit. The ONLY write is a new execution-audit.json
// with wx. No fetch/provider, worker, Store.open, recovery, cleanup, lock or Git
// operation. Original result/summary/freeze/copies are never repaired/replaced.
import {readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';import {fileURLToPath} from 'node:url';
process.env.MOZAIK_API_KEY=''; // Disable optional SDK cloud telemetry in this audit process.
const {canonicalizeArtifact}=await import('../dist/server/contracts/canonical.js');
const {sha256Bytes,hashRunInput}=await import('../dist/server/evidence/hashing.js');
const {RawUsageSchema}=await import('../dist/server/contracts/domain.js');
const {validateV4Plan,collectV4ProductFingerprints}=await import('../dist/server/evaluation/protocol-probe-v4-plan.js');
const {evaluateV4ProbeGate}=await import('../dist/server/evaluation/protocol-probe-v4-gate.js');
const {ProtocolProbeV2AnswerSchema}=await import('../dist/server/evaluation/protocol-probe-v2.js');
const {projectProbeWireRequest}=await import('../dist/server/evaluation/protocol-probe.js');
const {verifyPermitSettlement}=await import('../tests/helpers/permit-settlement.mjs');

const root=resolve(fileURLToPath(new URL('../',import.meta.url))),folder=join(root,'docs/implementation/task-7x-live'),output=join(folder,'execution-audit.json');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),array=v=>Array.isArray(v)?v:[];
const same=(a,b)=>canonicalizeArtifact(a??null)===canonicalizeArtifact(b??null),sha=text=>sha256Bytes(Buffer.from(text,'utf8'));
const need=(value,code)=>{if(!value)throw Error(code);};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,digest=/^[a-f0-9]{64}$/;
const id=v=>typeof v==='string'&&uuid.test(v)?v:null,hash=v=>typeof v==='string'&&digest.test(v)?v:null;
const code=v=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{1,95}$/.test(v)?v:null;
const callId=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)&&!/sk-[A-Za-z0-9]{20,}/.test(v)?v:null;
const actorKey=a=>canonicalizeArtifact(['runId','role','agentId','taskId','contextId','loopId','attempt'].map(k=>a?.[k]??null));
const own=(a,b)=>object(a)&&object(b)&&actorKey(a)===actorKey(b);
const actor=a=>object(a)?{runId:id(a.runId),role:['proposer','counter-evidence','critic'].includes(a.role)?a.role:null,agentId:id(a.agentId),taskId:id(a.taskId),contextId:id(a.contextId),loopId:id(a.loopId),attempt:[1,2].includes(a.attempt)?a.attempt:null}:null;
const location=file=>{const r=relative(root,file).replaceAll('\\','/');return r.startsWith('../')?resolve(file).replaceAll('\\','/'):r;};
const sources=new Map(),problems=[];
async function exists(file){try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function source(file){file=resolve(file);const info=await lstat(file);need(info.isFile()&&!info.isSymbolicLink(),'AUDIT_INPUT_NOT_ORDINARY_FILE');const bytes=await readFile(file);
 const row={file:location(file),byteLength:bytes.length,sha256:sha256Bytes(bytes)},prior=sources.get(file);need(!prior||same(prior,row),'AUDIT_INPUT_CHANGED_DURING_READ');sources.set(file,row);return bytes;}
async function json(file){return JSON.parse((await source(file)).toString('utf8'));}
async function optionalJson(file){if(!await exists(file))return null;try{return await json(file);}catch{problems.push('AUDIT_OPTIONAL_JSON_INVALID');return null;}}
async function walk(dir){const files=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())files.push(...await walk(p));else if(e.isFile())files.push(resolve(p));else throw Error('AUDIT_UNEXPECTED_STORE_LINK');}return files.sort();}
async function stream(file){
 if(!await exists(file))return{file:location(file),exists:false,complete:false,rows:[],reason:'AUDIT_STREAM_MISSING'};
 const bytes=await source(file);need(bytes.length<=8*1024*1024,'AUDIT_STREAM_READ_LIMIT');
 const rows=[];for(const line of bytes.toString('utf8').split(/\r?\n/)){if(!line)continue;let value;try{value=JSON.parse(line);}catch{return{file:location(file),exists:true,complete:false,rows,reason:'AUDIT_STREAM_INVALID_JSON'};}
  if(!object(value)||!Number.isFinite(value.monotonicMs))return{file:location(file),exists:true,complete:false,rows,reason:'AUDIT_STREAM_INVALID_RECORD'};rows.push(value);}
 return{file:location(file),exists:true,complete:true,rows,reason:null};
}
function intervals(rows,startKind,endKinds,clock){
 const starts=rows.filter(r=>r.kind===startKind),out=[];
 for(const start of starts){const ends=rows.filter(r=>endKinds.includes(r.kind)&&r.requestId===start.requestId&&r.permitId===start.permitId&&own(r.actor,start.actor));const end=ends[0],valid=ends.length===1&&Number.isFinite(start[clock])&&Number.isFinite(end?.[clock])&&end[clock]>=start[clock];
  out.push({actor:actor(start.actor),requestId:id(start.requestId),permitId:id(start.permitId),stage:['first','final'].includes(start.stage)?start.stage:null,
   startMs:Number.isFinite(start[clock])?start[clock]:null,endMs:valid?end[clock]:null,durationMs:valid?end[clock]-start[clock]:null,
   completion:end?.kind??'unobserved',completionCount:ends.length,httpStatus:Number.isInteger(end?.httpStatus)?end.httpStatus:null,bodySha256:hash(start.bodySha256),code:code(end?.code),intervalComplete:valid});}
 return out;
}
function concurrency(items){const complete=items.filter(r=>r.intervalComplete),edges=complete.flatMap(r=>[{at:r.startMs,delta:1},{at:r.endMs,delta:-1}]).sort((a,b)=>a.at-b.at||a.delta-b.delta);let active=0,max=0;for(const e of edges){active+=e.delta;max=Math.max(max,active);}
 const firsts=[...new Map(complete.filter(r=>r.actor&&['proposer','counter-evidence'].includes(r.actor.role)).sort((a,b)=>a.startMs-b.startMs).map(r=>[actorKey(r.actor),null])).keys()].map(k=>complete.filter(r=>actorKey(r.actor)===k).sort((a,b)=>a.startMs-b.startMs)[0]);
 return{completeIntervals:complete.length,unknownIntervals:items.length-complete.length,maxObservedInFlight:max,firstAnalysisOverlapMs:firsts.length===2?Math.max(0,Math.min(firsts[0].endMs,firsts[1].endMs)-Math.max(firsts[0].startMs,firsts[1].startMs)):null};
}
function cleanupFacts(raw){return array(raw).map(c=>({runId:id(c.runId),confirmed:c.confirmed===true,rootVerification:['absent','mismatch','unknown'].includes(c.rootVerification)?c.rootVerification:'unobserved',
 identity:c.identity?{pid:c.identity.pid,parentPid:c.identity.parentPid,creationFileTime:c.identity.creationFileTime,commandLineSha256:typeof c.identity.commandLine==='string'?sha(c.identity.commandLine):null}:null,
 exit:{pid:c.exit?.pid,exitObserved:c.exit?.exitObserved===true,closeObserved:c.exit?.closeObserved===true,exitCode:c.exit?.exitCode??null,spawnError:c.exit?.spawnError??null},
 scanDiagnosticCount:array(c.scanDiagnostics).length,descendants:array(c.descendants).map(d=>({pid:d.identity?.pid,parentPid:d.identity?.parentPid,creationFileTime:d.identity?.creationFileTime,verification:['absent','mismatch','unknown'].includes(d.verification)?d.verification:'unobserved'})),
 scope:c.scope,unobservedDescendantsNotGuaranteed:c.unobservedDescendantsNotGuaranteed===true}));}
function nativeFacts(records){const completed=records.filter(r=>r.kind==='native'&&r.type==='function_call.completed');return{
 nativeStarted:records.filter(r=>r.kind==='native'&&r.type==='function_call.started').length,nativeCompleted:completed.length,
 batches:records.filter(r=>r.kind==='tool.batch'&&r.manifest?.phase==='staged').map(r=>({actor:actor(r.manifest.actor),batchId:id(r.manifest.batchId),callCount:array(r.manifest.calls).length,
  originalCalls:array(r.manifest.calls).map(c=>({callId:callId(c.callId),toolName:['read_company_challenge','read_candidate_bundle'].includes(c.toolName)?c.toolName:null,argumentsSha256:hash(c.argumentsSha256)}))})),
 calls:completed.map(end=>{const i=records.indexOf(end),starts=records.slice(0,i).filter(r=>r.kind==='native'&&r.type==='function_call.started'&&r.callId===end.callId&&own(r.actor,end.actor));
  const contexts=records.slice(i+1).filter(r=>r.kind==='native'&&r.type==='inference.started'&&own(r.actor,end.actor)),context=contexts.find(r=>array(r.toolResults).some(t=>t.callId===end.callId&&t.outputSha256===end.outputSha256));
  const wires=records.slice(i+1).filter(r=>r.kind==='wire.request'&&own(r.actor,end.actor)&&array(r.messages).some(m=>m.role==='tool'&&m.callId===end.callId&&m.outputSha256===end.outputSha256&&m.receipt?.receiptId===end.receipt?.receiptId));
  return{actor:actor(end.actor),callId:callId(end.callId),toolName:starts.length===1?starts[0].toolName:null,argumentsSha256:starts.length===1?hash(starts[0].argumentsSha256):null,outputSha256:hash(end.outputSha256),receiptId:id(end.receipt?.receiptId),ok:end.receipt?.ok===true,
   uniqueNativeStart:starts.length===1,sameContextRefillObserved:Boolean(context),actualHTTPRefillObserved:wires.length===1,nextHTTPRequestId:wires.length===1?id(wires[0].requestId):null,
   incompleteMeaning:context&&wires.length===1?null:'unobserved evidence is not automatically binding corruption'};})};}

need(!await exists(output),'AUDIT_OUTPUT_ALREADY_EXISTS');
const self=fileURLToPath(import.meta.url);await source(self);await source(resolve(root,'tests/helpers/permit-settlement.mjs'));
const freezeFile=join(folder,'freeze.json'),freezeRaw=await source(freezeFile),rawFreezeSha=sha256Bytes(freezeRaw),freeze=validateV4Plan(JSON.parse(freezeRaw.toString('utf8')));
need(freeze.scope==='task7x_v4_protocol_only','AUDIT_SCOPE_MISMATCH');
const baselineRaw=await source(resolve(root,freeze.baseline.file));need(sha256Bytes(baselineRaw)===freeze.baseline.sha256,'AUDIT_BASELINE_HASH_CHANGED');const baseline=JSON.parse(baselineRaw.toString('utf8'));
need(baseline.head==='c7480c7a75493c5641c9a5a9fcca153533e06df1'&&baseline.protectedUntracked.length===424&&baseline.historicalImplementation.length===1149
 &&baseline.historicalStore.files.length===97&&baseline.oldRuntime.length===131&&baseline.historicalStore.root===freeze.baseline.storeRoot,'AUDIT_BASELINE_IDENTITY');
async function integrity(){const groups={priorUntracked:baseline.protectedUntracked,preexistingFiveDocuments:baseline.trackedChanges,historicalImplementation:baseline.historicalImplementation,historicalStore:baseline.historicalStore.files,existingDecisions:[baseline.existingAuthorization,baseline.existingResolution],officialSources:baseline.officialSources},out={};
 for(const[name,files]of Object.entries(groups)){for(const f of files){const bytes=await readFile(resolve(root,f.file));need(bytes.length===f.bytes&&sha256Bytes(bytes)===f.sha256,'AUDIT_PROTECTED_BYTES_CHANGED');}out[name]={count:files.length,allBytesUnchanged:true};}
 need(baseline.trackedChanges.length===5,'AUDIT_BASELINE_FIVE_DOCUMENTS');let sameCount=0,approvedCount=0;for(const f of baseline.oldRuntime){const current=sha256Bytes(await readFile(resolve(root,f.file))),approved=freeze.approvedRuntimeChanges.find(c=>c.file===f.file);
  if(approved){need(approved.beforeSha256===f.sha256&&approved.afterSha256===current&&current!==f.sha256,'AUDIT_RUNTIME_DELTA_MISMATCH');approvedCount++;}else{need(current===f.sha256,'AUDIT_UNAPPROVED_RUNTIME_CHANGED');sameCount++;}}
 need(sameCount===129&&approvedCount===2,'AUDIT_RUNTIME_DELTA_COUNTS');out.oldRuntime={unchanged:sameCount,explicitlyApprovedChanged:approvedCount};return out;
}
const beforeIntegrity=await integrity();need(same(await collectV4ProductFingerprints(),freeze.productFingerprints),'AUDIT_FROZEN_PRODUCT_CHANGED');
const sourceIntegrity=[];for(const f of freeze.sourceIntegrity){const bytes=await readFile(join(root,'reference/einstein-matchmaker-data',f.file)),actual=sha256Bytes(bytes);need(bytes.length===f.bytes&&actual===f.actualSha256&&actual===f.expectedSha256,'AUDIT_OFFICIAL_SOURCE_CHANGED');sourceIntegrity.push({file:f.file,bytes:bytes.length,sha256:actual,unchanged:true});}
need(sourceIntegrity.length===8,'AUDIT_OFFICIAL_SOURCE_COUNT');
const engineeringRaw=await source(resolve(root,freeze.engineeringGate.file));need(sha256Bytes(engineeringRaw)===freeze.engineeringGate.sha256,'AUDIT_ENGINEERING_GATE_BYTES_CHANGED');const engineering=JSON.parse(engineeringRaw.toString('utf8'));
const preflightRecord=await optionalJson(resolve(root,'docs/implementation/task-7x-preflight-blocked.json'));
const preflightOutputPath=resolve(root,'docs/implementation/task-7x-preflight-output.txt'),preflightOutput=await exists(preflightOutputPath)?await source(preflightOutputPath):null;
if(preflightRecord)need(preflightRecord.task==='Task7x'&&preflightRecord.kind==='readonly_preflight_reverification'&&preflightRecord.runId===freeze.probe.runId
 &&preflightRecord.freezeHash===freeze.hash&&preflightRecord.rawFreezeFileSha256===rawFreezeSha&&preflightRecord.engineeringGateSha256===freeze.engineeringGate.sha256,'AUDIT_PREFLIGHT_RECORD_BINDING');
const summaryExists=await exists(join(folder,'summary.json')),summary=await optionalJson(join(folder,'summary.json'));if(summary){need(summary.scope===freeze.scope&&summary.freezeHash===freeze.hash&&summary.rawFreezeFileSha256===rawFreezeSha,'AUDIT_SUMMARY_FREEZE_BINDING');
 need(summary.L05Executed===false&&summary.batchStillLocked===true&&summary.Task8Started===false&&summary.automaticRetries===0,'AUDIT_AUTHORIZATION_SCOPE');}
const globalAttemptExists=await exists(join(folder,'attempt.json')),globalAttempt=await optionalJson(join(folder,'attempt.json')),startup=await optionalJson(join(folder,'store-startup.json'));
if(globalAttempt)need(globalAttempt.scope===freeze.scope&&globalAttempt.freezeHash===freeze.hash&&globalAttempt.probeRunId===freeze.probe.runId&&globalAttempt.maxGrantedRequests===4&&globalAttempt.automaticRetry===false,'AUDIT_GLOBAL_ATTEMPT_BINDING');
const rows=array(summary?.execution?.rows);need(rows.length<=1&&rows.every(r=>r.runId===freeze.probe.runId),'AUDIT_UNAUTHORIZED_EXECUTION_ROW');
const runId=freeze.probe.runId,runFolder=join(folder,'runs',runId),storeFolder=join(freeze.baseline.storeRoot,runId),runExists=await exists(runFolder),storeExists=await exists(storeFolder);
if(await exists(join(folder,'runs'))){const dirs=await readdir(join(folder,'runs'),{withFileTypes:true});need(dirs.every(d=>d.isDirectory()&&d.name===runId),'AUDIT_UNAUTHORIZED_RUN_DIRECTORY');}
const result=runExists?await optionalJson(join(runFolder,'result.json')):null,runAttempt=runExists?await optionalJson(join(runFolder,'attempt.json')):null;
if(runAttempt)need(runAttempt.scope===freeze.scope&&runAttempt.runId===runId&&runAttempt.freezeHash===freeze.hash&&runAttempt.rawFreezeFileSha256===rawFreezeSha&&runAttempt.maxGrantedRequests===4&&runAttempt.automaticRetry===false,'AUDIT_RUN_ATTEMPT_BINDING');
const native=await stream(join(runFolder,'worker-evidence.jsonl')),diagnostics=await stream(join(runFolder,'answer-diagnostics.jsonl')),records=[...native.rows,...diagnostics.rows].sort((a,b)=>a.monotonicMs-b.monotonicMs);
const terminal=storeExists?await optionalJson(join(storeFolder,'terminal.json')):null,admissionEnvelope=storeExists?await optionalJson(join(storeFolder,'record.json')):null;
let storedEvents=[];if(storeExists&&await exists(join(storeFolder,'events.jsonl'))){const bytes=await source(join(storeFolder,'events.jsonl'));try{storedEvents=bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));}catch{problems.push('AUDIT_PARENT_EVENTS_INVALID');}}
const parentCopies=[];for(const name of['record.json','events.jsonl','terminal.json']){const original=join(storeFolder,name),copy=join(runFolder,'parent-store-copy',name),present=await exists(original),copyExists=await exists(copy);
 if(present){const originalBytes=await source(original);let sameBytes=false;if(copyExists)sameBytes=originalBytes.equals(await source(copy));if(!sameBytes)problems.push('AUDIT_PARENT_COPY_MISSING_OR_CHANGED');parentCopies.push({name,original:location(original),copy:location(copy),exists:true,copyExists,bytes:originalBytes.length,sha256:sha256Bytes(originalBytes),sameBytes});}
 else{if(copyExists)problems.push('AUDIT_COPY_WITHOUT_ORIGINAL');parentCopies.push({name,exists:false,copyExists});}}
const observation=result??rows[0]??null,terminalReplayView=terminal?.record?{...terminal.record,lastSeq:storedEvents.length}:null,record=observation?.record??terminalReplayView;
const terminalTail=terminal?storedEvents.slice(terminal.eventCount):[],terminalBound=terminal&&Number.isSafeInteger(terminal.eventCount)&&terminal.eventCount<=storedEvents.length
 &&terminal.record?.lastSeq===terminal.eventCount&&terminalTail.every(e=>e.type==='event.ignored');
const parentConsistency={terminalPresent:Boolean(terminal),resultPresent:Boolean(result),admissionInputMatches:admissionEnvelope?admissionEnvelope.record?.runId===runId&&same(admissionEnvelope.record?.input,freeze.probe.input):null,
 finalRecordMatches:result&&terminal?Boolean(terminalBound)&&same(result.record,terminalReplayView):null,eventsMatch:result?same(result.events,storedEvents):null,outcomeMatches:result&&terminal?same(result.terminalOutcome,terminal.outcome):null,
 publicationMatches:result&&terminal?same(result.publication??null,terminal.publication??null):null,resultRecordsMatchSidecarMerge:result?same(result.records,records):null,
 resultDiagnosticsMatchSidecar:result?same(result.answerDiagnostics,diagnostics.rows):null,frozenInputMatches:record?same(record.input,freeze.probe.input)&&record.inputHash===hashRunInput(freeze.probe.input):null,
 recordJsonMeaning:'Original admission and terminal bytes are unchanged. A derived replay view advances only lastSeq over explicitly ignored tail events; every terminal field remains exact.',
 currentRecordSource:observation?.record?'actual_parent_execution_observation':terminalReplayView?'derived_terminal_replay_view':'unobserved'};
const consistencyChecks=['admissionInputMatches','finalRecordMatches','eventsMatch','outcomeMatches','publicationMatches','resultRecordsMatchSidecarMerge','resultDiagnosticsMatchSidecar','frozenInputMatches'];
if(consistencyChecks.some(key=>parentConsistency[key]===false))problems.push('AUDIT_PARENT_RESULT_CONTRADICTION');
if(result&&rows.length===1){const{finishedAt,...saved}=result;need(same(saved,rows[0]),'AUDIT_RESULT_SUMMARY_ROW_CONTRADICTION');}

const snapshot=observation?.permitSnapshot??null,cleanups=array(observation?.cleanups),safetyHold=observation?.safetyHold;
let settlement=null;if(storeExists||result){try{settlement=verifyPermitSettlement({runId,record,events:storedEvents,cleanup:cleanups.length===1?cleanups[0]:null,snapshot,terminal:terminal??undefined,safetyHold});}catch{problems.push('AUDIT_SETTLEMENT_EVIDENCE_INVALID');}}
const grants=storedEvents.filter(e=>e.type==='permit.granted'),permitRows=array(snapshot?.runs).filter(r=>r.runId===runId),declaredEmpty=object(snapshot)&&Array.isArray(snapshot.runs)&&snapshot.runs.length===0&&snapshot.inFlight===0;
const authoritativeAttempts=permitRows.length===1&&Number.isSafeInteger(permitRows[0].attempts)?permitRows[0].attempts:declaredEmpty&&grants.length===0?0:null;
need(grants.length<=4&&(authoritativeAttempts===null||authoritativeAttempts<=4),'AUDIT_REQUEST_BUDGET_EXCEEDED');
const traces=records.filter(r=>r.kind==='request').map(r=>r.trace),gatewayRows=traces.map(t=>({...t,kind:t.type})),gatewayIntervals=intervals(gatewayRows,'request.started',['request.completed','request.failed'],'monotonicMs');
const actualFetchIntervals=intervals(records,'v4.fetch.started',['v4.fetch.headers','v4.fetch.failed'],'fetchMonotonicMs');
const requestFacts=grants.map(g=>{const requestId=g.payload?.requestId,permitId=g.payload?.permitId,start=traces.find(t=>t.type==='request.started'&&t.requestId===requestId&&t.permitId===permitId),parentStart=storedEvents.find(e=>e.type==='model.request.started'&&e.payload?.requestId===requestId&&e.payload?.permitId===permitId),owner=start?.actor??parentStart;
 const usageRows=traces.filter(t=>t.type==='usage'&&t.requestId===requestId&&t.permitId===permitId&&own(t.actor,owner)),parsed=usageRows.length===1?RawUsageSchema.safeParse(usageRows[0].usage):null,reported=parsed?.success&&parsed.data.requestId===requestId?parsed.data:null;
 const fetched=actualFetchIntervals.filter(r=>r.requestId===requestId&&r.permitId===permitId),rejected=records.find(r=>r.kind==='v4.evidence.rejected'&&r.requestId===requestId&&r.permitId===permitId&&own(r.actor,owner));
 return{requestId:id(requestId),permitId:id(permitId),actor:actor(owner),grantSeq:g.seq,gatewayStarted:Boolean(start),actualFetchObserved:fetched.length===1,
  dispatchState:fetched.length===1?'actual_fetch_invocation_observed':rejected?'preflight_rejected_before_fetch':'unobserved_not_assumed_zero',preflightReason:code(rejected?.reason),
  usageRows:usageRows.length,usageStatus:reported&&['promptTokens','completionTokens','totalTokens','cachedInputTokens'].some(k=>Number.isSafeInteger(reported[k]))?'gateway_reported':'unknown',reportedUsage:reported,
  gatewayCompletion:traces.find(t=>['request.completed','request.failed'].includes(t.type)&&t.requestId===requestId&&t.permitId===permitId&&own(t.actor,owner))?.type??'unobserved'};});
const usageAggregate={};for(const field of['promptTokens','completionTokens','totalTokens','cachedInputTokens']){const supplied=requestFacts.filter(r=>Number.isSafeInteger(r.reportedUsage?.[field])&&r.reportedUsage[field]>=0),sum=supplied.reduce((n,r)=>n+r.reportedUsage[field],0),whole=requestFacts.length>0&&supplied.length===requestFacts.length;
 usageAggregate[field]={reportedRequests:supplied.length,grantedAttemptDenominator:requestFacts.length,knownSubtotal:supplied.length?sum:null,completeReportedTotal:whole?sum:null,status:whole?'gateway_reported_complete':supplied.length?'gateway_reported_partial':'unknown'};}

const bodyFacts=records.filter(r=>r.kind==='v4.http.body').map(row=>{let parsed=null;try{parsed=JSON.parse(row.bodyText);}catch{/* No raw text is copied into this report. */}return{
 actor:actor(row.actor),requestId:id(row.requestId),permitId:id(row.permitId),stage:['first','final'].includes(row.stage)?row.stage:null,phase:['before','actual'].includes(row.phase)?row.phase:null,
 bodySha256:hash(row.bodySha256),byteLength:row.byteLength,hashValid:typeof row.bodyText==='string'&&sha(row.bodyText)===row.bodySha256,lengthValid:typeof row.bodyText==='string'&&Buffer.byteLength(row.bodyText)===row.byteLength,
 parsed:Boolean(parsed),toolsPropertyPresent:parsed?Object.hasOwn(parsed,'tools'):null,toolNames:array(parsed?.tools).map(t=>['read_company_challenge','read_candidate_bundle'].includes(t.function?.name)?t.function.name:'unrecognized'),
 toolChoice:['auto','none'].includes(parsed?.tool_choice)?parsed.tool_choice:null};});
const answers=records.filter(r=>r.kind==='native'&&r.type==='model.answer').map(row=>{const parsed=ProtocolProbeV2AnswerSchema.safeParse(row.answer);let fromText=null;try{fromText=JSON.parse(row.answerText);}catch{}
 const outputs=records.filter(r=>r.kind==='native'&&r.type==='function_call.completed'&&own(r.actor,row.actor)),receipts=outputs.map(e=>{const start=records.find(r=>r.kind==='native'&&r.type==='function_call.started'&&own(r.actor,e.actor)&&r.callId===e.callId);return{toolName:start?.toolName,receiptId:e.receipt?.receiptId};});
 return{actor:actor(row.actor),requestId:id(row.requestId),permitId:id(row.permitId),schemaValid:parsed.success,answerHashValid:typeof row.answerText==='string'&&sha(row.answerText)===row.answerSha256,
  answerTextMatchesObject:same(fromText,row.answer),orderedRealReceiptsMatch:parsed.success&&same(parsed.data.receipts,receipts),answer:parsed.success?parsed.data:null};});
const failures=records.flatMap((row,index)=>{const trace=row.kind==='request'?row.trace:null,reason=row.kind==='v4.evidence.rejected'?row.reason:row.kind==='probe.contract'&&row.status==='rejected'?row.code:row.kind==='answer.diagnostic'&&row.status==='failed'?row.code:trace?.type==='request.failed'?trace.code:row.kind==='v4.fetch.failed'?row.code:null;
 return reason?[{recordIndex:index,kind:row.kind,code:code(reason)??'UNRECOGNIZED_CONTROLLED_CODE',actor:actor(row.actor??trace?.actor),requestId:id(row.requestId??row.request?.requestId??trace?.requestId),permitId:id(row.permitId??row.request?.permitId??trace?.permitId),stage:typeof row.stage==='string'&&/^[a-z_]{1,48}$/.test(row.stage)?row.stage:null,writerMonotonicMs:row.monotonicMs}]:[];});
let recomputed=null;if(observation){try{recomputed=evaluateV4ProbeGate({runId,expected:{companyId:freeze.probe.input.companyId,challengeId:freeze.probe.input.challengeId,researcherId:freeze.probe.researcherId},expectedInput:freeze.probe.input,
 expectedModel:freeze.model,expectedToolDefinitions:freeze.probe.toolDefinitions,expectedWorkerPath:resolve(root,freeze.workerPath),expectedFreezeHash:freeze.hash,expectedRawFreezeFileSha256:rawFreezeSha,
 expectedPoolHash:freeze.probe.poolHash,expectedEvidenceSnapshotHash:freeze.probe.evidenceSnapshotHash,expectedSourceFiles:freeze.sourceFiles,expectedContractSha256:freeze.probe.contractSha256,
 effectiveInstructionText:freeze.probe.effectiveInstructionText,effectiveInstructionSha256:freeze.probe.effectiveInstructionSha256,genericDispatchSha256:freeze.promptContract.genericDispatchSha256,
 records,events:storedEvents,record,terminalOutcome:terminal?.outcome??null,cleanups,permitSnapshot:snapshot,safetyHold:safetyHold!==false,errorCode:observation.errorCode??null,publication:terminal?.publication??null,runnerMode:'live'});}catch{problems.push('AUDIT_GATE_RECOMPUTATION_FAILED');}}
const gateSummary=recomputed?{version:recomputed.version,passed:recomputed.passed,liveEligible:recomputed.liveEligible,reasons:recomputed.reasons,layers:recomputed.layers,
 actualFirstAnalysisOverlapMs:recomputed.firstAnalysisOverlapMs,actualMaxObservedInFlight:recomputed.maxObservedInFlight,gatewayFirstAnalysisOverlapMs:recomputed.gatewayFirstAnalysisOverlapMs,gatewayMaxObservedInFlight:recomputed.gatewayMaxObservedInFlight,
 analysis:{taskContractValid:recomputed.analysis?.taskContract?.valid,native:recomputed.analysis?.native,context:recomputed.analysis?.context,http:recomputed.analysis?.http,
  directBindingCorruptionCount:array(recomputed.analysis?.directBindingCorruption).length,unobservedCount:array(recomputed.analysis?.unobserved).length},publicationAuthority:false,executionAuthority:false}:null;

const oldStoreSet=new Set(baseline.historicalStore.files.map(f=>resolve(root,f.file))),allowedStoreSet=new Set(['record.json','events.jsonl','terminal.json'].map(name=>resolve(storeFolder,name))),actualStoreSet=await walk(freeze.baseline.storeRoot),extras=actualStoreSet.filter(file=>!oldStoreSet.has(file));
need(extras.every(file=>allowedStoreSet.has(file)),'AUDIT_UNEXPECTED_ORIGINAL_STORE_FILE');if(extras.length!==0&&extras.length!==3)problems.push('AUDIT_PLANNED_RUN_STORE_INCOMPLETE');
if(!storeExists&&extras.length!==0)problems.push('AUDIT_STORE_FILE_WITHOUT_RUN_DIRECTORY');
const notExecuted=!summaryExists&&!globalAttemptExists&&!runAttempt&&!runExists&&!storeExists&&!result&&rows.length===0&&extras.length===0&&records.length===0&&!native.exists&&!diagnostics.exists;
if(preflightRecord)need(notExecuted&&preflightRecord.attemptExists===false&&preflightRecord.summaryExists===false&&preflightRecord.runFolderExists===false&&preflightRecord.storeRunExists===false
 &&preflightRecord.originalStoreOpened===false&&preflightRecord.workerSpawned===false&&preflightRecord.liveEntrypointExecuted===false&&preflightRecord.actualModelRequests===0&&preflightRecord.permitsGranted===0,'AUDIT_PREFLIGHT_RECORD_CONTRADICTION');
if(!summary&&!notExecuted)problems.push('AUDIT_SUMMARY_MISSING_FOR_EXECUTION');
const afterIntegrity=await integrity();need(same(await collectV4ProductFingerprints(),freeze.productFingerprints),'AUDIT_FROZEN_PRODUCT_CHANGED_DURING_READ');
for(const[file,expected]of sources){const bytes=await readFile(file);need(bytes.length===expected.byteLength&&sha256Bytes(bytes)===expected.sha256,'AUDIT_INPUT_CHANGED_DURING_READ');}
const report={scope:'task7x_readonly_post_execution_audit',sourceScope:freeze.scope,observedAt:new Date().toISOString(),auditScriptSha256:sources.get(resolve(self)).sha256,
 freeze:{file:location(freezeFile),artifactHash:freeze.hash,rawSha256:rawFreezeSha},plannedRunId:runId,executionState:notExecuted?'preflight_blocked_not_executed':result?'result_recorded':storeExists?'partial_store_observation':runExists?'attempt_without_parent_run':'execution_unobserved',
 preflight:{recordPresent:Boolean(preflightRecord),recordedErrorCode:code(preflightRecord?.errorCode),frozenEngineeringGateSha256:freeze.engineeringGate.sha256,webExitCodePropertyPresent:Object.hasOwn(engineering.web??{},'exitCode'),
  preservedOutputSha256:preflightOutput?sha256Bytes(preflightOutput):null,recordedControlledCodeInPreservedOutput:preflightOutput&&code(preflightRecord?.errorCode)?preflightOutput.toString('utf8').includes(preflightRecord.errorCode):null,
  frozenWebExitCode:typeof engineering.web?.exitCode==='number'?engineering.web.exitCode:null,requiredWebExitCode:0,frozenWebGateFieldEligible:engineering.web?.exitCode===0,
  explanation:notExecuted?'No attempt, summary, Run, worker evidence or new original-store file exists. Frozen gate metadata and its bytes are preserved; protocol was not executed and is not classified as a model/protocol failure.':null},
 summary:summary?{passed:summary.passed===true,errorCode:code(summary.errorCode),stopReason:code(summary.execution?.stopReason),totalGranted:summary.totalGranted??null,rows:rows.length,automaticRetries:summary.automaticRetries}:null,
 globalAttemptObserved:Boolean(globalAttempt),runAttemptObserved:Boolean(runAttempt),startupObserved:Boolean(startup),recordedRecoveryApplyCalls:startup?.recoveryApplyCalls??summary?.recoveryApplyCalls??preflightRecord?.recoveryApplyCalls??null,recordedNewRiskExceptions:startup?.newRiskExceptions??summary?.newRiskExceptions??null,
 parent:{recordStatus:record?.status??null,terminalOutcomeKind:terminal?.outcome?.kind??null,terminalReasons:array(terminal?.outcome?.reasonCodes).map(code),parentConsistency,parentCopies,
  originalStoreFiles:97,currentOriginalStoreFiles:actualStoreSet.length,onlyNewPlannedRunFiles:extras.map(location),admissionRecordRetained:Boolean(admissionEnvelope)},
 evidence:{requiredForExecutedRun:!notExecuted,native:{file:native.file,exists:native.exists,complete:native.complete,rows:native.rows.length,reason:notExecuted?'NOT_CREATED_EXECUTION_NOT_STARTED':native.reason},answerDiagnostics:{file:diagnostics.file,exists:diagnostics.exists,complete:diagnostics.complete,rows:diagnostics.rows.length,reason:notExecuted?'NOT_CREATED_EXECUTION_NOT_STARTED':diagnostics.reason},sameWorkerClockMerged:true},
 ids:{actors:[...new Map(records.flatMap(r=>object(r.actor)?[[actorKey(r.actor),actor(r.actor)]]:[])).values()],requests:requestFacts.map(r=>r.requestId),permits:requestFacts.map(r=>r.permitId)},
 grantedAttempts:{parentGrantEvents:grants.length,authoritativeManagerAttempts:authoritativeAttempts,summaryTotalGranted:summary?.totalGranted??null,scopeRequestsNotExecuted:notExecuted?0:null,managerWasConstructed:!notExecuted&&snapshot!==null,attemptsAreNotRefunded:true},
 actualFetch:{observedInvocations:actualFetchIntervals.length,headersObserved:records.filter(r=>r.kind==='v4.fetch.headers').length,failedObserved:records.filter(r=>r.kind==='v4.fetch.failed').length,intervals:actualFetchIntervals,...concurrency(actualFetchIntervals),
  interpretation:'Invocation to headers-resolution samples exclude preflight/fsync. Unknown dispatch is not zero; only complete sampled intervals establish observed client overlap.'},
 gateway:{observedStarts:gatewayIntervals.length,intervals:gatewayIntervals,...concurrency(gatewayIntervals),interpretation:'Gateway intervals include V4 preflight and are not substituted for actual fetch concurrency.'},
 requestFacts,usageAggregate,usageStatus:notExecuted?'not_applicable_not_executed':'reported_values_only_unknown_fields_retained',usageInterpretation:'Only exact actor/request/permit-bound valid gateway reports are counted, including reports on failed requests. No execution produces no usage report; missing values stay unknown, subtotals are not whole-flow totals and no cost is inferred.',
 native:nativeFacts(records),bodies:bodyFacts,modelAnswers:answers,modelAnswerCount:answers.length,answerDiagnosticCounts:diagnostics.rows.map(r=>({stage:r.stage,status:r.status,code:code(r.code),actor:actor(r.actor),requestId:id(r.request?.requestId),permitId:id(r.request?.permitId)})),
 controlledFailureTimeline:failures,earliestWorkerControlledFailure:failures[0]??null,independentGate:gateSummary,originalGateMatchesRecomputation:result&&recomputed?same(result.probeGate,recomputed):null,
 permits:settlement,cleanup:cleanupFacts(cleanups),currentPermitSnapshot:snapshot,safetyHold:safetyHold??null,
 protocolState:notExecuted?'not_executed_unverified':recomputed?.passed?'local_gate_passed_pending_complete_host_result':'not_passed_or_incomplete',
 completeProtocolObserved:summary?.passed===true&&summary?.execution?.passed===true&&summary?.errorCode===null&&recomputed?.passed===true&&recomputed.liveEligible===true&&native.complete&&diagnostics.complete&&consistencyChecks.every(key=>parentConsistency[key]!==false),
 protectedIntegrity:{before:beforeIntegrity,after:afterIntegrity},officialSourceIntegrity:sourceIntegrity,frozenProductFingerprintCount:freeze.productFingerprints.length,frozenProductFingerprintsUnchanged:true,
 auditInputs:[...sources.values()],problems:[...new Set(problems)],originalArtifactsRewritten:false,parentStoreCopiesCreatedByAudit:0,providerRequestsByAudit:0,storeOpenCalls:0,recoveryApplyCalls:0,cleanupCalls:0,lockOperations:0,gitOperations:0,
 L05Executed:false,batchStillLocked:true,Task8Started:false,humanLabels:0,qualityMetrics:'NA',holdout:'unopened',showcaseEligible:false,Task7Overall:'NOT_PASS',
 historicalUnknown:'Task7s final Proposer text and detailed cause remain unknown; synthetic fixtures do not fill historical gaps.',
 interpretation:'New-scope read-only observations only. Successful cleanup is distinct from execution/protocol success. No semantic quality, human gold, exact cost, global unknown-orphan or publishing claim is created.'};
await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output:location(output),runId,executionState:report.executionState,grantedAttempts:authoritativeAttempts,scopeRequestsNotExecuted:notExecuted?0:null,actualFetchObserved:actualFetchIntervals.length,protocolState:report.protocolState,completeProtocolObserved:report.completeProtocolObserved,
 parentSettlementValid:settlement?.valid??null,problems:report.problems,protectedFiles:424,historicalImplementation:1149,historicalStore:97,allProtectedBytesUnchanged:true,providerRequestsByAudit:0,Task7Overall:'NOT_PASS'}));
