// Task7y READ-ONLY execution audit. The only write is the new audit JSON (wx).
// No fetch, worker, Store.open, recovery, cleanup, lock or Git operation.
import {writeFile,lstat,readdir} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';import {fileURLToPath} from 'node:url';
process.env.MOZAIK_API_KEY='';
const {canonicalizeArtifact}=await import('../dist/server/contracts/canonical.js');
const {sha256Bytes,hashRunInput}=await import('../dist/server/evidence/hashing.js');
const {RawUsageSchema}=await import('../dist/server/contracts/domain.js');
const {validateV4Plan,collectV4ProductFingerprints}=await import('../dist/server/evaluation/protocol-probe-v4-plan.js');
const {v4GateExpectations}=await import('../dist/server/evaluation/v4-bounded-validation.js');
const {evaluateV4ProbeGate}=await import('../dist/server/evaluation/protocol-probe-v4-gate.js');
const {ProtocolProbeV2AnswerSchema}=await import('../dist/server/evaluation/protocol-probe-v2.js');
const {Task7yAuthorizationSchema,verifyTask7yAuthorizationFile}=await import('../dist/server/evaluation/prepared-v4-policy.js');
const {readEngineeringFile}=await import('../dist/server/evaluation/engineering-files.js');
const {verifyPermitSettlement}=await import('../tests/helpers/permit-settlement.mjs');

const root=resolve(fileURLToPath(new URL('../',import.meta.url))),output=join(root,'docs/implementation/task-7y-execution-audit-v2.json'),inputs=new Map(),problems=[];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),list=v=>Array.isArray(v)?v:[],same=(a,b)=>canonicalizeArtifact(a??null)===canonicalizeArtifact(b??null);
const sha=text=>sha256Bytes(Buffer.from(text,'utf8')),need=(v,c)=>{if(!v)throw Error(c);};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,digest=/^[a-f0-9]{64}$/;
const id=v=>typeof v==='string'&&uuid.test(v)?v:null,hash=v=>typeof v==='string'&&digest.test(v)?v:null,code=v=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{1,95}$/.test(v)?v:null;
const callId=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)&&!/sk-[A-Za-z0-9]{20,}/.test(v)?v:null;
const actorKey=a=>canonicalizeArtifact(['runId','role','agentId','taskId','contextId','loopId','attempt'].map(k=>a?.[k]??null));
const own=(a,b)=>object(a)&&object(b)&&actorKey(a)===actorKey(b);
const actor=a=>object(a)?{runId:id(a.runId),role:['proposer','counter-evidence','critic'].includes(a.role)?a.role:null,agentId:id(a.agentId),taskId:id(a.taskId),contextId:id(a.contextId),loopId:id(a.loopId),attempt:[1,2].includes(a.attempt)?a.attempt:null}:null;
const pathLabel=file=>{const p=relative(root,file).replaceAll('\\','/');return p.startsWith('../')?resolve(file).replaceAll('\\','/'):p;};
async function exists(file){try{await lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function bytes(file){file=resolve(file);const raw=await readEngineeringFile(root,file,32*1024*1024),row={file:pathLabel(file),bytes:raw.length,sha256:sha256Bytes(raw)};
 const old=inputs.get(file);need(!old||same(old,row),'Y_AUDIT_INPUT_CHANGED');inputs.set(file,row);return raw;}
async function json(file){return JSON.parse((await bytes(file)).toString('utf8'));}
async function optional(file){if(!await exists(file))return null;try{return await json(file);}catch{problems.push('Y_AUDIT_OPTIONAL_JSON_INVALID');return null;}}
async function walk(folder){const out=[];for(const e of await readdir(folder,{withFileTypes:true})){const file=join(folder,e.name);if(e.isDirectory())out.push(...await walk(file));else if(e.isFile())out.push(resolve(file));else throw Error('Y_AUDIT_UNEXPECTED_LINK');}return out.sort();}
async function stream(file){if(!await exists(file))return{file:pathLabel(file),exists:false,complete:false,rows:[],code:'NOT_OBSERVED'};
 const raw=await bytes(file);need(raw.length<=8*1024*1024,'Y_AUDIT_STREAM_LIMIT');const rows=[];for(const line of raw.toString('utf8').split(/\r?\n/)){if(!line)continue;let row;try{row=JSON.parse(line);}catch{return{file:pathLabel(file),exists:true,complete:false,rows,code:'Y_AUDIT_BAD_JSONL'};}
  if(!object(row)||!Number.isFinite(row.monotonicMs))return{file:pathLabel(file),exists:true,complete:false,rows,code:'Y_AUDIT_BAD_RECORD'};rows.push(row);}return{file:pathLabel(file),exists:true,complete:true,rows,code:null};}
function intervals(rows,startKind,endKinds,clock){return rows.filter(r=>r.kind===startKind).map(start=>{const ends=rows.filter(e=>endKinds.includes(e.kind)&&e.requestId===start.requestId&&e.permitId===start.permitId&&own(e.actor,start.actor)),end=ends[0],complete=ends.length===1&&Number.isFinite(start[clock])&&Number.isFinite(end?.[clock])&&end[clock]>=start[clock];
 return{actor:actor(start.actor),requestId:id(start.requestId),permitId:id(start.permitId),stage:['first','final'].includes(start.stage)?start.stage:null,startMs:Number.isFinite(start[clock])?start[clock]:null,endMs:complete?end[clock]:null,
  complete,completion:end?.kind??'unobserved',httpStatus:Number.isInteger(end?.httpStatus)?end.httpStatus:null,code:code(end?.code),actualBodySha256:hash(start.bodySha256)};});}
function concurrency(rows){const done=rows.filter(r=>r.complete),edges=done.flatMap(r=>[{at:r.startMs,n:1},{at:r.endMs,n:-1}]).sort((a,b)=>a.at-b.at||a.n-b.n);let active=0,max=0;for(const e of edges){active+=e.n;max=Math.max(max,active);}
 const keys=[...new Set(done.filter(r=>['proposer','counter-evidence'].includes(r.actor?.role)).map(r=>actorKey(r.actor)))],first=keys.map(k=>done.filter(r=>actorKey(r.actor)===k).sort((a,b)=>a.startMs-b.startMs)[0]);
 return{completeIntervals:done.length,unknownIntervals:rows.length-done.length,maxObservedInFlight:max,firstAnalysisOverlapMs:first.length===2?Math.max(0,Math.min(first[0].endMs,first[1].endMs)-Math.max(first[0].startMs,first[1].startMs)):null};}
function gateSummary(g){return g?{version:g.version,passed:g.passed,liveEligible:g.liveEligible,reasons:g.reasons,layers:g.layers,actualFirstAnalysisOverlapMs:g.firstAnalysisOverlapMs,actualMaxObservedInFlight:g.maxObservedInFlight,
 gatewayFirstAnalysisOverlapMs:g.gatewayFirstAnalysisOverlapMs,gatewayMaxObservedInFlight:g.gatewayMaxObservedInFlight,analysis:{taskContractValid:g.analysis?.taskContract?.valid,native:g.analysis?.native,context:g.analysis?.context,http:g.analysis?.http,
 directBindingCorruptionCount:list(g.analysis?.directBindingCorruption).length,unobservedCount:list(g.analysis?.unobserved).length},executionAuthority:false,publicationAuthority:false}:null;}
// Display the recorded parent vocabulary literally. This does not normalize a
// legacy "mismatch" into "identity_replaced", or grant settlement authority.
const cleanupVerification=value=>['absent','identity_replaced','unknown','still_present','not_spawned','present','mismatch'].includes(value)?value:'unobserved';
function safeCleanup(rows){return list(rows).map(c=>({runId:id(c.runId),confirmed:c.confirmed===true,rootVerification:cleanupVerification(c.rootVerification),scope:typeof c.scope==='string'?c.scope:null,unobservedDescendantsNotGuaranteed:c.unobservedDescendantsNotGuaranteed===true,
 rootIdentity:c.identity?{pid:c.identity.pid,parentPid:c.identity.parentPid,creationFileTime:c.identity.creationFileTime,commandLineSha256:typeof c.identity.commandLine==='string'?sha(c.identity.commandLine):null}:null,
 exit:{pid:c.exit?.pid,exitObserved:c.exit?.exitObserved===true,closeObserved:c.exit?.closeObserved===true,exitCode:c.exit?.exitCode??null,spawnErrorObserved:Boolean(c.exit?.spawnError)},scanDiagnosticCount:list(c.scanDiagnostics).length,
 descendants:list(c.descendants).map(d=>({pid:d.identity?.pid,parentPid:d.identity?.parentPid,creationFileTime:d.identity?.creationFileTime,verification:cleanupVerification(d.verification)}))}));}

need(!await exists(output),'Y_AUDIT_OUTPUT_EXISTS');const self=fileURLToPath(import.meta.url);await bytes(self);await bytes(join(root,'tests/helpers/permit-settlement.mjs'));
const authorizationFiles=['docs/implementation/task-7y-authorization.json','docs/implementation/task-7y-authorization-v2.json'],markerFile=join(root,'docs/implementation/task-7y-live/attempt.json'),markerExists=await exists(markerFile),marker=await optional(markerFile);
let authorizationRelative=await exists(join(root,authorizationFiles[1]))?authorizationFiles[1]:authorizationFiles[0],markerPreparation=null;
if(marker&&id(marker.candidateId)&&marker.candidateFolder==='docs/implementation/task-7y-live/candidates/'+marker.candidateId){
 const frozen=await optional(join(root,marker.candidateFolder,'freeze.json'));
 if(frozen){try{const p=validateV4Plan(frozen);need(p.preparation&&p.preparation.candidateId===marker.candidateId&&p.preparation.candidateFolder===marker.candidateFolder&&authorizationFiles.includes(p.preparation.authorizationFile),'Y_AUDIT_MARKER_AUTHORIZATION_SELECTION');
  authorizationRelative=p.preparation.authorizationFile;markerPreparation=p.preparation;}catch{problems.push('Y_AUDIT_MARKER_FREEZE_INVALID');}}
}
const authorizationFile=join(root,authorizationRelative),authRaw=await bytes(authorizationFile),parsedAuthorization=Task7yAuthorizationSchema.parse(JSON.parse(authRaw.toString('utf8')));
const authorization=await verifyTask7yAuthorizationFile(root,markerPreparation??{authorizationFile:authorizationRelative,authorizationFileSha256:sha256Bytes(authRaw),authorizationId:parsedAuthorization.authorizationId,
 baselineFile:parsedAuthorization.baselineFile,baselineSha256:parsedAuthorization.baselineSha256,globalAttemptFile:parsedAuthorization.globalAttemptFile});
need(same(authorization,parsedAuthorization),'Y_AUDIT_AUTHORIZATION_READBACK');
if('supersedes'in authorization){const old=await bytes(resolve(root,authorization.supersedes.file)),evidence=await bytes(resolve(root,authorization.scopeExtension.evidence.file));
 need(sha256Bytes(old)===authorization.supersedes.sha256&&sha256Bytes(evidence)===authorization.scopeExtension.evidence.sha256,'Y_AUDIT_SCOPE_EXTENSION_EVIDENCE');}
const baselineRaw=await bytes(resolve(root,authorization.baselineFile));need(sha256Bytes(baselineRaw)===authorization.baselineSha256,'Y_AUDIT_BASELINE_HASH');const baseline=JSON.parse(baselineRaw.toString('utf8'));
need(baseline.task==='Task7y'&&baseline.head===authorization.baselineHead&&baseline.protectedUntracked.length===473&&baseline.protectedUntracked.filter(f=>f.file.endsWith('.json')).length===262
 &&baseline.trackedChanges.length===5&&baseline.historicalImplementation.length===1312&&baseline.historicalStore.files.length===97&&baseline.oldRuntime.length===145&&baseline.historicalStore.root===authorization.storeRoot,'Y_AUDIT_BASELINE_IDENTITY');
async function integrity(){const groups={initialUntracked:baseline.protectedUntracked,initialJson:baseline.protectedUntracked.filter(f=>f.file.endsWith('.json')),preexistingDocuments:baseline.trackedChanges,historicalImplementation:baseline.historicalImplementation,
 historicalStore:baseline.historicalStore.files,existingDecisions:[baseline.existingAuthorization,baseline.existingResolution],officialSources:baseline.officialSources},out={};
 for(const[name,rows]of Object.entries(groups)){for(const row of rows){const raw=await bytes(resolve(root,row.file));need(raw.length===row.bytes&&sha256Bytes(raw)===row.sha256,'Y_AUDIT_PROTECTED_BYTES_CHANGED');}out[name]={files:rows.length,allBytesUnchanged:true};}
 const changed=[],unchanged=[];for(const row of baseline.oldRuntime){const raw=await bytes(resolve(root,row.file)),actual=sha256Bytes(raw),allowed=authorization.approvedRuntimeChanges.find(a=>a.file===row.file);
  if(allowed){need(allowed.beforeSha256===row.sha256,'Y_AUDIT_APPROVED_BEFORE_HASH');changed.push({file:row.file,beforeSha256:row.sha256,afterSha256:actual,changed:actual!==row.sha256});}
  else{need(actual===row.sha256,'Y_AUDIT_UNAPPROVED_RUNTIME_CHANGED');unchanged.push(row.file);}}
 const approvedCount=authorization.approvedRuntimeChanges.length;need(changed.length===approvedCount&&unchanged.length===baseline.oldRuntime.length-approvedCount&&authorization.approvedRuntimeChanges.every(a=>changed.some(r=>r.file===a.file)),'Y_AUDIT_RUNTIME_SCOPE');
 out.oldRuntime={total:baseline.oldRuntime.length,policyVersion:authorization.policyVersion,approvedPaths:approvedCount,actuallyChanged:changed.filter(r=>r.changed).length,unchangedUnapproved:unchanged.length,all145Unchanged:false,approvedDeltas:changed};return out;
}
const beforeIntegrity=await integrity(),runtimeBefore=await collectV4ProductFingerprints();
if(runtimeBefore.length!==165)problems.push('Y_AUDIT_CURRENT_FINGERPRINT_COUNT_UNEXPECTED');
const legacy=await json(join(root,'docs/implementation/task-7x-baseline.json')),legacyOverlap=legacy.oldRuntime.filter(f=>authorization.approvedRuntimeChanges.some(a=>a.file===f.file)).map(f=>f.file);
need(resolve(root,authorization.globalAttemptFile)===markerFile,'Y_AUDIT_FIXED_GLOBAL_ATTEMPT');const candidateRoot=resolve(root,authorization.candidateRoot);
const candidateNames=await exists(candidateRoot)?await readdir(candidateRoot,{withFileTypes:true}):[];need(candidateNames.every(d=>d.isDirectory()&&id(d.name)),'Y_AUDIT_CANDIDATE_DIRECTORY_UNSAFE');
const candidates=[],allRuns=[];let selected=null;
for(const entry of candidateNames.sort((a,b)=>a.name.localeCompare(b.name,'en'))){const candidateId=entry.name,folder=join(candidateRoot,candidateId),rel=relative(root,folder).replaceAll('\\','/');
 const preparation=await optional(join(folder,'preparation-result.json')),candidateCheck=await optional(join(folder,'candidate-preflight.json')),frozenCheck=await optional(join(folder,'frozen-preflight.json')),
 executionCheck=await optional(join(folder,'execution-preflight.json')),executionFailure=await optional(join(folder,'failed-execution-preflight.json')),summary=await optional(join(folder,'summary.json'));
 const freezeFile=join(folder,'freeze.json'),hasFreeze=await exists(freezeFile),candidatePlan=await optional(join(folder,'candidate-plan.json')),planFile=hasFreeze?freezeFile:join(folder,'candidate-plan.json');let p=null,raw=null,rawHash=null,parseCode=null;
 if(await exists(planFile)){try{raw=await bytes(planFile);p=validateV4Plan(JSON.parse(raw.toString('utf8')));rawHash=sha256Bytes(raw);need(p.preparation?.candidateId===candidateId&&p.preparation.candidateFolder===rel,'Y_AUDIT_CANDIDATE_PLAN_BINDING');}catch{parseCode='Y_AUDIT_CANDIDATE_PLAN_INVALID';p=null;}}
 if(await exists(join(folder,'engineering.json')))await bytes(join(folder,'engineering.json'));
 const runEntries=await exists(join(folder,'runs'))?await readdir(join(folder,'runs'),{withFileTypes:true}):[];need(runEntries.every(d=>d.isDirectory()&&id(d.name)),'Y_AUDIT_RUN_DIRECTORY_UNSAFE');
 for(const d of runEntries)allRuns.push({candidateId,runId:d.name,folder:join(folder,'runs',d.name),p,rawHash,summary});
 const info={candidateId,folder:rel,preparation:preparation?{passed:preparation.passed===true,stage:preparation.stage,code:code(preparation.code),runId:id(preparation.runId),modelRequests:preparation.modelRequests??null}:null,
  candidatePreflightPassed:candidateCheck?.passed??null,frozenPreflightPassed:frozenCheck?.passed??null,executionPreflightPassed:executionCheck?.passed??null,executionPreflightFailed:executionFailure?.passed===false,
  executionFailureCodes:list(executionFailure?.checks).filter(c=>c.status==='failed').map(c=>code(c.code)),freezeExists:hasFreeze,planParseCode:parseCode,planHash:p?.hash??null,rawFreezeFileSha256:hasFreeze?rawHash:null,runId:p?.probe.runId??null,
  candidatePlanMatchesFreeze:hasFreeze&&p&&candidatePlan?same(candidatePlan,p):null,sourceCommit:p?.engineeringSourceCommit??null,configuredModel:p?.model??null,configuredBaseURL:p?.gatewayBaseURL??null,currentFingerprintMatch:p?same(runtimeBefore,p.productFingerprints):null,runDirectories:runEntries.map(d=>d.name),summary:summary?{passed:summary.passed===true,errorCode:code(summary.errorCode),stopReason:code(summary.execution?.stopReason),totalGranted:summary.totalGranted??null}:null};
 candidates.push(info);
 if(marker&&marker.candidateId===candidateId){need(p&&hasFreeze&&marker.task==='Task7y'&&marker.authorizationId===authorization.authorizationId&&marker.authorizationFileSha256===sha256Bytes(authRaw)
  &&marker.candidateFolder===rel&&marker.probeRunId===p.probe.runId&&marker.freezeHash===p.hash&&marker.rawFreezeFileSha256===rawHash&&marker.sourceCommit===p.engineeringSourceCommit
  &&marker.maxGrantedRequests===4&&marker.perContextRequests===2&&marker.automaticRetry===false,'Y_AUDIT_GLOBAL_MARKER_BINDING');
  need(p.preparation.authorizationFileSha256===sha256Bytes(authRaw)&&p.preparation.baselineSha256===authorization.baselineSha256&&p.preparation.authorizationId===authorization.authorizationId,'Y_AUDIT_PLAN_AUTHORITY_BINDING');
  need(same(runtimeBefore,p.productFingerprints)&&candidatePlan&&same(candidatePlan,p),'Y_AUDIT_SELECTED_RUNTIME_CHANGED');selected={candidateId,folder,p,rawHash,summary,info};}
}
need(allRuns.length<=1,'Y_AUDIT_MORE_THAN_ONE_RUN');if(markerExists&&!selected)problems.push('Y_AUDIT_GLOBAL_MARKER_INVALID_OR_PARTIAL');
if(allRuns.length)need(selected&&allRuns[0].candidateId===selected.candidateId&&allRuns[0].runId===selected.p.probe.runId,'Y_AUDIT_UNAUTHORIZED_RUN');
const run=allRuns[0]??null,allowedNewStore=new Set(selected?['record.json','events.jsonl','terminal.json'].map(n=>resolve(authorization.storeRoot,selected.p.probe.runId,n)):[]),oldStore=new Set(baseline.historicalStore.files.map(f=>resolve(root,f.file))),currentStore=await walk(authorization.storeRoot),extraStore=currentStore.filter(f=>!oldStore.has(f));
need(extraStore.every(f=>allowedNewStore.has(f)),'Y_AUDIT_UNEXPECTED_STORE_FILE');if(extraStore.length!==0&&extraStore.length!==3)problems.push('Y_AUDIT_INCOMPLETE_NEW_RUN_STORE');if(extraStore.length&&!run)problems.push('Y_AUDIT_STORE_FILES_WITHOUT_RUN_DIRECTORY');
let execution=null;
if(selected){const{p,rawHash,summary}=selected,runId=p.probe.runId,runFolder=join(selected.folder,'runs',runId),storeFolder=join(authorization.storeRoot,runId),result=await optional(join(runFolder,'result.json')),
 terminal=await optional(join(storeFolder,'terminal.json')),admission=await optional(join(storeFolder,'record.json')),runAttempt=await optional(join(runFolder,'attempt.json')),startup=await optional(join(selected.folder,'store-startup.json'));
 if(runAttempt)need(runAttempt.scope===p.scope&&runAttempt.kind==='probe'&&runAttempt.runId===runId&&runAttempt.freezeHash===p.hash&&runAttempt.rawFreezeFileSha256===rawHash&&runAttempt.maxGrantedRequests===4&&runAttempt.automaticRetry===false,'Y_AUDIT_RUN_ATTEMPT_BINDING');
 const native=await stream(join(runFolder,'worker-evidence.jsonl')),answers=await stream(join(runFolder,'answer-diagnostics.jsonl')),records=[...native.rows,...answers.rows].sort((a,b)=>a.monotonicMs-b.monotonicMs);
 let events=[];if(await exists(join(storeFolder,'events.jsonl'))){try{events=(await bytes(join(storeFolder,'events.jsonl'))).toString('utf8').split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));}catch{problems.push('Y_AUDIT_PARENT_LOG_INVALID');}}
 const copies=[];for(const name of['record.json','events.jsonl','terminal.json']){const original=join(storeFolder,name),copy=join(runFolder,'parent-store-copy',name),present=await exists(original),copyExists=await exists(copy);
  if(present){const originalBytes=await bytes(original),matches=copyExists&&originalBytes.equals(await bytes(copy));if(!matches)problems.push('Y_AUDIT_PARENT_COPY_MISSING_OR_CHANGED');copies.push({name,original:pathLabel(original),copy:pathLabel(copy),sha256:sha256Bytes(originalBytes),byteLength:originalBytes.length,copyExists,matches});}
  else{if(copyExists)problems.push('Y_AUDIT_COPY_WITHOUT_PARENT');copies.push({name,present:false,copyExists});}}
 const declared=list(summary?.execution?.rows);need(declared.length<=1&&declared.every(r=>r.runId===runId),'Y_AUDIT_SUMMARY_EXTRA_RUN');const observation=result??declared[0]??null;
 const terminalBound=terminal&&Number.isSafeInteger(terminal.eventCount)&&terminal.eventCount<=events.length&&terminal.record?.lastSeq===terminal.eventCount&&events.slice(terminal.eventCount).every(e=>e.type==='event.ignored');
 const replay=terminalBound?{...terminal.record,lastSeq:events.length}:null,record=observation?.record??replay,snapshot=observation?.permitSnapshot??null,cleanups=list(observation?.cleanups),safetyHold=observation?.safetyHold;
 const consistency={terminalRecordBinding:result&&terminal?Boolean(terminalBound)&&same(result.record,replay):null,eventsMatch:result?same(result.events,events):null,outcomeMatches:result&&terminal?same(result.terminalOutcome,terminal.outcome):null,
  publicationMatches:result&&terminal?same(result.publication??null,terminal.publication??null):null,sidecarMergeMatches:result?same(result.records,records):null,diagnosticSidecarMatches:result?same(result.answerDiagnostics,answers.rows):null,
  frozenInputMatches:record?same(record.input,p.probe.input)&&record.inputHash===hashRunInput(p.probe.input):null,admissionInputMatches:admission?same(admission.record?.input,p.probe.input):null};
 if(Object.values(consistency).some(v=>v===false))problems.push('Y_AUDIT_PARENT_RESULT_CONTRADICTION');
 if(result&&declared.length){const{finishedAt,...row}=result;need(same(row,declared[0]),'Y_AUDIT_RESULT_SUMMARY_MISMATCH');}
 if(summary)need(summary.freezeHash===p.hash&&summary.rawFreezeFileSha256===rawHash&&summary.L05Executed===false&&summary.automaticRetries===0&&summary.Task8Started===false,'Y_AUDIT_SUMMARY_BINDING');
 let settlement=null;if(observation||terminal){try{settlement=verifyPermitSettlement({runId,record,events,cleanup:cleanups.length===1?cleanups[0]:null,snapshot,terminal:terminal??undefined,safetyHold});}catch{problems.push('Y_AUDIT_SETTLEMENT_INCOMPLETE');}}
 const grants=events.filter(e=>e.type==='permit.granted'),managerRows=list(snapshot?.runs).filter(r=>r.runId===runId),attempts=managerRows.length===1&&Number.isSafeInteger(managerRows[0].attempts)?managerRows[0].attempts:null;
 need(grants.length<=4&&(attempts===null||attempts<=4),'Y_AUDIT_REQUEST_LIMIT');
 const traces=records.filter(r=>r.kind==='request').map(r=>r.trace),actualIntervals=intervals(records,'v4.fetch.started',['v4.fetch.headers','v4.fetch.failed'],'fetchMonotonicMs'),gatewayIntervals=intervals(traces.map(t=>({...t,kind:t.type})),'request.started',['request.completed','request.failed'],'monotonicMs');
 const requestFacts=grants.map(grant=>{const requestId=grant.payload?.requestId,permitId=grant.payload?.permitId,start=traces.find(t=>t.type==='request.started'&&t.requestId===requestId&&t.permitId===permitId),parent=events.find(e=>e.type==='model.request.started'&&e.payload?.requestId===requestId&&e.payload?.permitId===permitId),owner=start?.actor??parent,
  supplied=traces.filter(t=>t.type==='usage'&&t.requestId===requestId&&t.permitId===permitId&&own(t.actor,owner)),parsed=supplied.length===1?RawUsageSchema.safeParse(supplied[0].usage):null,usage=parsed?.success&&parsed.data.requestId===requestId?parsed.data:null,
  fetched=actualIntervals.filter(r=>r.requestId===requestId&&r.permitId===permitId),rejected=records.find(r=>r.kind==='v4.evidence.rejected'&&r.requestId===requestId&&r.permitId===permitId&&own(r.actor,owner));
  return{actor:actor(owner),requestId:id(requestId),permitId:id(permitId),actualFetchObserved:fetched.length===1,dispatch:fetched.length===1?'observed':rejected?'preflight_rejected_before_fetch':'unknown_not_assumed_zero',preflightReason:code(rejected?.reason),
   usageRows:supplied.length,reportedUsage:usage,usageStatus:usage&&['promptTokens','completionTokens','totalTokens','cachedInputTokens'].some(k=>Number.isSafeInteger(usage[k]))?'gateway_reported':'unknown',completion:traces.find(t=>['request.completed','request.failed'].includes(t.type)&&t.requestId===requestId&&t.permitId===permitId&&own(t.actor,owner))?.type??'unobserved'};});
 const usage={};for(const field of['promptTokens','completionTokens','totalTokens','cachedInputTokens']){const supplied=requestFacts.filter(r=>Number.isSafeInteger(r.reportedUsage?.[field])&&r.reportedUsage[field]>=0),subtotal=supplied.reduce((n,r)=>n+r.reportedUsage[field],0),complete=requestFacts.length>0&&supplied.length===requestFacts.length;
  usage[field]={reportedRequests:supplied.length,grantedAttemptDenominator:requestFacts.length,knownSubtotal:supplied.length?subtotal:null,completeReportedTotal:complete?subtotal:null,status:complete?'reported_complete':supplied.length?'reported_partial':'unknown'};}
 const completed=records.filter(r=>r.kind==='native'&&r.type==='function_call.completed'),calls=completed.map(end=>{const index=records.indexOf(end),starts=records.slice(0,index).filter(r=>r.kind==='native'&&r.type==='function_call.started'&&r.callId===end.callId&&own(r.actor,end.actor)),contexts=records.slice(index+1).filter(r=>r.kind==='native'&&r.type==='inference.started'&&own(r.actor,end.actor)),context=contexts.find(r=>list(r.toolResults).some(t=>t.callId===end.callId&&t.outputSha256===end.outputSha256)),
  wires=records.slice(index+1).filter(r=>r.kind==='wire.request'&&own(r.actor,end.actor)&&list(r.messages).some(m=>m.role==='tool'&&m.callId===end.callId&&m.outputSha256===end.outputSha256&&m.receipt?.receiptId===end.receipt?.receiptId));
  return{actor:actor(end.actor),callId:callId(end.callId),toolName:starts.length===1?starts[0].toolName:null,argumentsSha256:starts.length===1?hash(starts[0].argumentsSha256):null,outputSha256:hash(end.outputSha256),receiptId:id(end.receipt?.receiptId),uniqueNativeStart:starts.length===1,
   sameContextRefillObserved:Boolean(context),actualNextHTTPRefillObserved:wires.length===1,nextHTTPRequestId:wires.length===1?id(wires[0].requestId):null,absenceMeaning:context&&wires.length===1?null:'not_observed is not binding corruption'};});
 const finalAnswers=records.filter(r=>r.kind==='native'&&r.type==='model.answer').map(row=>{const parsed=ProtocolProbeV2AnswerSchema.safeParse(row.answer),outputs=completed.filter(r=>own(r.actor,row.actor)),expected=outputs.map(e=>({toolName:records.find(r=>r.kind==='native'&&r.type==='function_call.started'&&r.callId===e.callId&&own(r.actor,e.actor))?.toolName,receiptId:e.receipt?.receiptId}));
  return{actor:actor(row.actor),requestId:id(row.requestId),permitId:id(row.permitId),schemaValid:parsed.success,answerSha256:hash(row.answerSha256),answerHashValid:typeof row.answerText==='string'&&sha(row.answerText)===row.answerSha256,
   exactOrderedRealReceipts:parsed.success&&same(parsed.data.receipts,expected),answer:parsed.success?parsed.data:null};});
 const bodyFacts=records.filter(r=>r.kind==='v4.http.body').map(row=>{let parsed=null;try{parsed=JSON.parse(row.bodyText);}catch{}return{actor:actor(row.actor),requestId:id(row.requestId),permitId:id(row.permitId),phase:row.phase,stage:row.stage,bodySha256:hash(row.bodySha256),byteLength:row.byteLength,
  hashValid:typeof row.bodyText==='string'&&sha(row.bodyText)===row.bodySha256,lengthValid:typeof row.bodyText==='string'&&Buffer.byteLength(row.bodyText)===row.byteLength,parsed:Boolean(parsed),toolsPresent:parsed?Object.hasOwn(parsed,'tools'):null,
  toolNames:list(parsed?.tools).map(t=>['read_company_challenge','read_candidate_bundle'].includes(t.function?.name)?t.function.name:'unrecognized'),toolChoice:['auto','none'].includes(parsed?.tool_choice)?parsed.tool_choice:null};});
 const timeline=records.flatMap((row,index)=>{const t=row.kind==='request'?row.trace:null,reason=row.kind==='v4.evidence.rejected'?row.reason:row.kind==='probe.contract'&&row.status==='rejected'?row.code:row.kind==='answer.diagnostic'&&row.status==='failed'?row.code:t?.type==='request.failed'?t.code:row.kind==='v4.fetch.failed'?row.code:null;
  return reason?[{index,kind:row.kind,code:code(reason)??'UNKNOWN_CONTROLLED_CODE',actor:actor(row.actor??t?.actor),requestId:id(row.requestId??row.request?.requestId??t?.requestId),permitId:id(row.permitId??row.request?.permitId??t?.permitId),monotonicMs:row.monotonicMs}]:[];});
 let gate=null;if(observation){const errorCode=observation.errorCode===undefined?'Y_AUDIT_OBSERVATION_ERROR_UNDECLARED':observation.errorCode;
  gate=evaluateV4ProbeGate({...observation,runId,runnerMode:'live',record,events,records,terminalOutcome:terminal?.outcome??null,publication:terminal?.publication??null,permitSnapshot:snapshot,cleanups,safetyHold:safetyHold!==false,errorCode,
   ...v4GateExpectations(p,rawHash,resolve(root,p.workerPath))});}
 const complete=summary?.passed===true&&summary.execution?.passed===true&&summary.errorCode===null&&gate?.passed===true&&gate.liveEligible===true&&native.complete&&answers.complete&&Object.values(consistency).every(v=>v!==false)&&problems.length===0;
 execution={candidateId:selected.candidateId,runId,sourceCommit:p.engineeringSourceCommit,configuredProvider:{baseURL:p.gatewayBaseURL,model:p.model,matchesLatestUserConfiguration:p.gatewayBaseURL.replace(/\/$/,'')==='https://api.deepseek.com'&&p.model==='deepseek-flash'},
  state:record?record.status:run?'attempt_without_parent_run':'global_marker_without_run',summary:summary?{passed:summary.passed,errorCode:code(summary.errorCode),stopReason:code(summary.execution?.stopReason),totalGranted:summary.totalGranted??null}:null,
  runAttemptObserved:Boolean(runAttempt),storeStartupObserved:Boolean(startup),recordedRecoveryApplyCalls:startup?.recoveryApplyCalls??summary?.recoveryApplyCalls??null,recordedNewRiskExceptions:startup?.newRiskExceptions??summary?.newRiskExceptions??null,
  managerSnapshot:snapshot,authoritativeManagerAttempts:attempts,parentGrantEvents:grants.length,attemptsNotRefunded:true,safetyHold:safetyHold??null,consistency,parentCopies:copies,
  terminalReplay:{derivedOnlyLastSeq:Boolean(replay),eventCount:terminal?.eventCount??null,tailIgnoredOnly:Boolean(terminalBound),originalBytesNeverChanged:true},
  evidence:{native:{file:native.file,exists:native.exists,complete:native.complete,rows:native.rows.length,code:native.code},answers:{file:answers.file,exists:answers.exists,complete:answers.complete,rows:answers.rows.length,code:answers.code},mergedBySameWorkerClock:true},
  actualFetch:{observedInvocations:actualIntervals.length,headers:records.filter(r=>r.kind==='v4.fetch.headers').length,failed:records.filter(r=>r.kind==='v4.fetch.failed').length,intervals:actualIntervals,...concurrency(actualIntervals),meaning:'original invocation to observed response headers; excludes preceding evidence fsync'},
  gateway:{intervals:gatewayIntervals,...concurrency(gatewayIntervals),meaning:'includes preflight; never substituted for actual fetch intervals'},requestFacts,usage,
  usageMeaning:'Only exact actor/request/permit-bound valid reports, even on failed protocol requests. Partial subtotals are not whole totals. Missing reports remain unknown; no cost estimate.',
  native:{started:records.filter(r=>r.kind==='native'&&r.type==='function_call.started').length,completed:completed.length,calls},bodies:bodyFacts,prompts:records.filter(r=>r.kind==='wire.effective_prompt').map(r=>({actor:actor(r.actor),requestId:id(r.requestId),permitId:id(r.permitId),bodySha256:hash(r.bodySha256),systemInstructionSha256:hash(r.systemInstructionSha256),userTaskSha256:hash(r.userTaskSha256)})),
  guardDecisions:records.filter(r=>r.kind==='probe.contract').map(r=>({actor:actor(r.actor),requestId:id(r.request?.requestId),permitId:id(r.request?.permitId),turn:r.turn,status:r.status,code:code(r.code),callCount:r.callCount,toolNames:list(r.toolNames).filter(n=>['read_company_challenge','read_candidate_bundle','unrecognized'].includes(n))})),
  finalAnswers,finalAnswerCount:finalAnswers.length,answerDiagnosticStages:answers.rows.map(r=>({actor:actor(r.actor),requestId:id(r.request?.requestId),permitId:id(r.request?.permitId),stage:r.stage,status:r.status,code:code(r.code)})),
  controlledFailureTimeline:timeline,earliestWorkerFailure:timeline[0]??null,permitSettlement:settlement,settlementHelperVocabulary:'Strict existing helper is used unchanged. It still accepts legacy mismatch, not identity_replaced, for cleanup-reclaim proof; no recorded value or explicit release is remapped.',cleanup:safeCleanup(cleanups),independentGate:gateSummary(gate),originalGateMatchesRecomputation:result&&gate?same(result.probeGate,JSON.parse(JSON.stringify(gate))):null,
  completeProtocolObserved:complete,protocolState:!records.length?'not_executed_or_no_worker_evidence':complete?'complete_observed':'incomplete_or_not_passed',formalPublicationObserved:Boolean(terminal?.publication)};
 if(!execution.configuredProvider.matchesLatestUserConfiguration)problems.push('Y_AUDIT_SELECTED_PROVIDER_MISMATCH');
}
const afterIntegrity=await integrity(),runtimeAfter=await collectV4ProductFingerprints();need(same(runtimeBefore,runtimeAfter),'Y_AUDIT_RUNTIME_CHANGED_DURING_READ');
for(const[file,row]of inputs){const current=await readEngineeringFile(root,file,32*1024*1024);need(current.length===row.bytes&&sha256Bytes(current)===row.sha256,'Y_AUDIT_INPUT_CHANGED_DURING_READ');}
const report={task:'Task7y',kind:'readonly_execution_audit',auditVersion:'task7y-execution-audit-v2',gateComparisonProjection:'The recomputed Gate is explicitly JSON.stringify/JSON.parse projected for comparison with the previously persisted JSON Gate. Undefined optional object properties are omitted by persistence; no production canonicalization or Hash rule is changed, and no original Gate/result is rewritten.',observedAt:new Date().toISOString(),auditScriptSha256:inputs.get(resolve(self)).sha256,authorizationId:authorization.authorizationId,authorizationFile:authorizationRelative,authorizationPolicyVersion:authorization.policyVersion,authorizationFileSha256:sha256Bytes(authRaw),
 globalAuthorization:{fixedFile:pathLabel(markerFile),markerExists,consumed:markerExists,markerParsed:Boolean(marker),selectedCandidateId:selected?.candidateId??null,retryAuthority:false},candidates,actualRunDirectories:allRuns.length,execution,
 managerSnapshotObserved:execution?.managerSnapshot!=null,managerCreationNotInferredFromMissingSnapshot:true,authoritativeManagerAttempts:execution?.authoritativeManagerAttempts??null,scopeFetchInvocationsObserved:execution?.actualFetch.observedInvocations??0,
 integrity:{before:beforeIntegrity,after:afterIntegrity,originalStoreFiles:97,currentStoreFiles:currentStore.length,uniqueNewRunFiles:extraStore.map(pathLabel),allInitialBytesUnchanged:true,
  initialUntrackedTrackingStatus:'byte preservation verified; actual Git tracking is independently checked by preflight/final whitelist verifier'},
 runtime:{currentFingerprintCount:runtimeBefore.length,expectedNewRuntimeCount:165,newFingerprintSetUnchangedDuringAudit:true,selectedFrozenFingerprintMatch:selected?same(selected.p.productFingerprints,runtimeAfter):null,all145Unchanged:false},
 correction:{initialConcern:'Y six runtime changes might conflict with the legacy X runtime predicate',actualLegacyXOverlap:legacyOverlap,conclusion:legacyOverlap.length===0?'The initial static suspicion was unsupported: X predates these files. No corresponding block is asserted.':'Review actual overlap; no execution is performed by this audit.'},
 inputs:[...inputs.values()],problems:[...new Set(problems)],completeProtocolObserved:execution?.completeProtocolObserved===true&&problems.length===0,
 providerRequestsByAudit:0,workerSpawnsByAudit:0,storeOpenCalls:0,recoveryApplyCalls:0,newRiskExceptions:0,cleanupCalls:0,lockOperations:0,gitOperations:0,parentStoreCopiesCreatedByAudit:0,originalArtifactsRewritten:false,
 L05Executed:false,batchStillLocked:true,Task8Started:false,humanLabels:0,qualityMetrics:'NA',holdout:'unopened',Task7Overall:'NOT_PASS',
 historicalUnknown:'Task7s Proposer final text and detailed failure remain unknown. Copied fixtures do not fill historical gaps.',
 interpretation:'Observation only. Missing evidence is not automatically corruption; registered cleanup is not global orphan assurance. No human semantic quality, publishing or execution authority is created.'};
await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output:pathLabel(output),candidates:candidates.length,globalAttemptExists:markerExists,actualRunDirectories:allRuns.length,managerAttempts:report.authoritativeManagerAttempts,
 actualFetchObserved:report.scopeFetchInvocationsObserved,completeProtocolObserved:report.completeProtocolObserved,protectedUntracked:473,protectedJson:262,initialStoreFiles:97,currentStoreFiles:currentStore.length,
 allInitialBytesUnchanged:true,problems:report.problems,providerRequestsByAudit:0,Task7Overall:'NOT_PASS'}));
