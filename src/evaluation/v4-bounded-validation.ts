/** Task7x protocol-only host. Importing opens no Store/worker/attempt/model.
 * This file has no L05 callback, business execution or publication authority. */
import {readFile,open,mkdir,mkdtemp,readdir,lstat} from 'node:fs/promises';import {resolve,join,dirname,relative} from 'node:path';import {fileURLToPath} from 'node:url';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {DEFAULT_LIMITS} from '../contracts/config.js';import {DATASET_COMMIT,HashSchema} from '../contracts/primitives.js';
import {canonicalizeArtifact} from '../contracts/canonical.js';import {sha256Bytes} from '../evidence/hashing.js';
import {loadSnapshot} from '../data/snapshot.js';import {RunStore} from '../storage/run-store.js';import {Scheduler} from '../supervisor/scheduler.js';import {ProcessHost} from '../supervisor/process-host.js';
import {evaluateV4ProbeGate,type V4ProbeGateInput} from './protocol-probe-v4-gate.js';
import {validateV4Plan,verifyV4CurrentFiles,V4_SCOPE,V4_FOLDER,validatePreparedV4Location,type V4Plan} from './protocol-probe-v4-plan.js';
import {verifyTask7yAuthorizationFile,TASK7Y_ATTEMPT_FILE} from './prepared-v4-policy.js';
export {validateV4Plan} from './protocol-probe-v4-plan.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=(text:string)=>sha256Bytes(Buffer.from(text,'utf8'));
type Row=Record<string,any>&{runId:string};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a:unknown,b:unknown)=>canonicalizeArtifact(a)===canonicalizeArtifact(b);
const need=(v:unknown,c:string)=>{if(!v)throw Error(c);};
const known=new Set(['V4_CONFIGURATION_CHANGED','V4_ENGINEERING_GATE','V4_SOURCE_COMMIT_CHANGED','V4_STORE_HOLD_OR_RESOLUTION','V4_RUN_ALREADY_EXISTS','V4_FREEZE_FILE_CHANGED','V4_MANAGER_NOT_FRESH','V4_OFFICIAL_SOURCE_BYTES','V4_CURRENT_FINGERPRINT','V4_CURRENT_FINGERPRINT_SET','V4_BASELINE_FILE_HASH','V4_BASELINE_STORE','V4_RUNTIME_BEFORE_HASH','V4_CURRENT_INTERFACE','V4_PROTECTED_HISTORY_CHANGED','V4_UNAPPROVED_RUNTIME_CHANGED','V4_STORE_FILE_SET_CHANGED','V4_EXISTING_DECISION_CHANGED','V4_PREFLIGHT_FAILED','V4_RUN_FAILED','V4_SCHEDULER_CLOSE_FAILED','V4_NATIVE_EVIDENCE_INVALID','V4_ANSWER_EVIDENCE_INVALID','V4_TERMINAL_MISSING','V4_RESULT_WRITE_FAILED','V4_STORE_CLOSE_FAILED','V4_FINAL_INTEGRITY_FAILED','V4_SUMMARY_WRITE_FAILED']);
function safe(error:unknown,fallback:string){const code=object(error)?error.code:undefined,message=error instanceof Error?error.message:undefined;return typeof code==='string'&&known.has(code)?code:typeof message==='string'&&known.has(message)?message:fallback;}
for(const code of ['TASK7Y_PREFLIGHT_FAILED','TASK7Y_ATTEMPT_BINDING','TASK7Y_ATTEMPT_ALREADY_EXISTS','TASK7Y_POLICY_BINDING','TASK7Y_POLICY_SUPERSEDES','TASK7Y_POLICY_EVIDENCE','TASK7Y_POLICY_FILE_INVALID'])known.add(code);
export async function writeV4Json(file:string,value:unknown){const h=await open(file,'wx');try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}}
export async function acquireV4Attempt(folder:string,value:unknown){const p=validateV4Plan(value);await writeV4Json(join(folder,'attempt.json'),{scope:V4_SCOPE,freezeHash:p.hash,probeRunId:p.probe.runId,createdAt:new Date().toISOString(),maxGrantedRequests:4,perContextRequests:2,automaticRetry:false,sourceCommit:p.engineeringSourceCommit});}
/** Fixed Task7y capability. A created/partial marker is never removed on failure. */
export async function acquireTask7yAttempt(options:{plan:unknown;rawFreezeFileSha256:string;root?:string}){
 const p=validateV4Plan(options.plan),meta=p.preparation;need(meta,'TASK7Y_ATTEMPT_BINDING');
 const project=resolve(options.root??root);
 need(project===resolve(root)||p.model==='offline_fixture'&&p.gatewayBaseURL==='https://offline.invalid/v1','TASK7Y_ATTEMPT_BINDING');
 const authorizationRaw=await readFile(resolve(project,meta!.authorizationFile)),authorization=await verifyTask7yAuthorizationFile(project,meta!,{runnerMode:project===resolve(root)?'live':'offline_fixture'});
 const baselineRaw=await readFile(resolve(project,meta!.baselineFile)),baseline=JSON.parse(baselineRaw.toString('utf8'));
 need(sha256Bytes(authorizationRaw)===meta!.authorizationFileSha256&&authorization.authorizationId===meta!.authorizationId
  &&authorization.baselineFile===meta!.baselineFile&&authorization.baselineSha256===meta!.baselineSha256&&sha256Bytes(baselineRaw)===meta!.baselineSha256
  &&baseline.head===authorization.baselineHead&&baseline.historicalStore.root===authorization.storeRoot&&p.baseline.storeRoot===authorization.storeRoot
  &&meta!.globalAttemptFile===TASK7Y_ATTEMPT_FILE&&authorization.globalAttemptFile===TASK7Y_ATTEMPT_FILE,'TASK7Y_ATTEMPT_BINDING');
 const file=validatePreparedV4Location(p,meta!.candidateFolder+'/freeze.json',project),raw=await readFile(file);
 need(sha256Bytes(raw)===options.rawFreezeFileSha256&&same(JSON.parse(raw.toString('utf8')),p),'TASK7Y_ATTEMPT_BINDING');
 const marker={scope:V4_SCOPE,task:'Task7y',authorizationId:authorization.authorizationId,authorizationFile:meta!.authorizationFile,authorizationFileSha256:meta!.authorizationFileSha256,
  candidateId:meta!.candidateId,candidateFolder:meta!.candidateFolder,freezeHash:p.hash,rawFreezeFileSha256:options.rawFreezeFileSha256,
  probeRunId:p.probe.runId,createdAt:new Date().toISOString(),maxGrantedRequests:4,perContextRequests:2,automaticRetry:false,sourceCommit:p.engineeringSourceCommit};
 const target=resolve(project,TASK7Y_ATTEMPT_FILE);await mkdir(dirname(target),{recursive:true});
 let cursor=project;for(const segment of relative(project,dirname(target)).split(/[\\/]/)){cursor=join(cursor,segment);const stat=await lstat(cursor);need(stat.isDirectory()&&!stat.isSymbolicLink(),'TASK7Y_ATTEMPT_BINDING');}
 try{await writeV4Json(target,marker);}catch(error){if(object(error)&&error.code==='EEXIST')throw Error('TASK7Y_ATTEMPT_ALREADY_EXISTS');throw error;}return marker;
}
export async function verifyV4History(p?:V4Plan){
 const file=resolve(root,'docs/implementation/task-7x-baseline.json'),raw=await readFile(file),b=JSON.parse(raw.toString('utf8'));
 if(p)need(sha256Bytes(raw)===p.baseline.sha256&&b.historicalStore.root===p.baseline.storeRoot,'V4_PROTECTED_HISTORY_CHANGED');
 for(const f of [...b.protectedUntracked,...b.trackedChanges,...b.historicalImplementation,...b.historicalStore.files,b.existingAuthorization,b.existingResolution,...b.officialSources])need(sha256Bytes(await readFile(resolve(root,f.file)))===f.sha256,'V4_PROTECTED_HISTORY_CHANGED');
 const approved=new Set(['src/supervisor/permits.ts','dist/server/supervisor/permits.js']);
 for(const f of b.oldRuntime){const current=sha256Bytes(await readFile(resolve(root,f.file)));if(approved.has(f.file)){if(p)need(p.approvedRuntimeChanges.some(c=>c.file===f.file&&c.beforeSha256===f.sha256&&c.afterSha256===current),'V4_UNAPPROVED_RUNTIME_CHANGED');}
  else need(current===f.sha256,'V4_UNAPPROVED_RUNTIME_CHANGED');}
 return b;
}
export function v4GateExpectations(p:V4Plan,rawFreezeFileSha256:string,workerPath=resolve(root,p.workerPath)){
 return{expected:{companyId:p.probe.input.companyId,challengeId:p.probe.input.challengeId,researcherId:p.probe.researcherId},expectedInput:p.probe.input,
  expectedModel:p.model,expectedToolDefinitions:p.probe.toolDefinitions,expectedWorkerPath:workerPath,expectedFreezeHash:p.hash,expectedRawFreezeFileSha256:rawFreezeFileSha256,
  expectedPoolHash:p.probe.poolHash,expectedEvidenceSnapshotHash:p.probe.evidenceSnapshotHash,expectedSourceFiles:p.sourceFiles,expectedContractSha256:p.probe.contractSha256,
  effectiveInstructionText:p.probe.effectiveInstructionText,effectiveInstructionSha256:p.probe.effectiveInstructionSha256,genericDispatchSha256:p.promptContract.genericDispatchSha256};
}
/** Pure single-callback observation control; never grants execution authority. */
export async function runV4Sequence(value:unknown,execute:()=>Promise<Row>,options:{rawFreezeFileSha256?:string}={}){
 const p=validateV4Plan(value);let row:Row;try{row=await execute();}catch{return{scope:V4_SCOPE,passed:false,rows:[],totalGranted:null,stopReason:'V4_EXECUTION_THROWN_BUDGET_UNOBSERVED',L05Executed:false,automaticRetries:0};}
 const permitRows=Array.isArray(row.permitSnapshot?.runs)?row.permitSnapshot.runs.filter((r:Row)=>r.runId===p.probe.runId):[],grants=Array.isArray(row.events)?row.events.filter((r:Row)=>r.type==='permit.granted'&&r.runId===p.probe.runId):[];
 const declaredEmpty=object(row.permitSnapshot)&&Array.isArray(row.permitSnapshot.runs)&&row.permitSnapshot.runs.length===0&&row.permitSnapshot.inFlight===0;
 const count=permitRows.length===1&&Number.isSafeInteger(permitRows[0].attempts)?permitRows[0].attempts:declaredEmpty&&grants.length===0?0:null;
 let gate:ReturnType<typeof evaluateV4ProbeGate>|null=null;try{const input:V4ProbeGateInput={...v4GateExpectations(p,options.rawFreezeFileSha256??''),runId:row.runId,
  records:Array.isArray(row.records)?row.records:[],events:Array.isArray(row.events)?row.events:[],record:row.record,terminalOutcome:row.terminalOutcome,
  cleanups:Array.isArray(row.cleanups)?row.cleanups:[],permitSnapshot:row.permitSnapshot,safetyHold:row.safetyHold!==false,
  errorCode:row.errorCode===undefined?'V4_OBSERVATION_ERROR_UNDECLARED':row.errorCode,publication:row.publication,runnerMode:row.runnerMode==='live'?'live':'offline_fixture'};
  gate=evaluateV4ProbeGate(input);}catch{/* Incomplete evidence fails; it never authorizes another callback. */}
 const passed=row.runId===p.probe.runId&&row.runnerMode==='live'&&!row.errorCode&&row.safetyHold===false&&count===4&&gate?.passed===true&&gate.liveEligible===true;
 return{scope:V4_SCOPE,passed,rows:[{...row,probeGate:gate}],totalGranted:count,stopReason:passed?null:'V4_FULL_PROBE_NOT_PASSED',L05Executed:false,automaticRetries:0};
}
async function readEvidence(file:string,code:string){let text:string;try{text=await readFile(file,'utf8');}catch{return{rows:[] as Record<string,any>[],errorCode:code};}
 const rows:Record<string,any>[]=[];for(const line of text.split(/\r?\n/)){if(!line)continue;try{const row:unknown=JSON.parse(line);if(!object(row)||!Number.isFinite(row.monotonicMs))return{rows,errorCode:code};rows.push(row);}catch{return{rows,errorCode:code};}}return{rows,errorCode:null};}
async function storeFileSet(folder:string):Promise<string[]>{let result:string[]=[];for(const e of await readdir(folder,{withFileTypes:true})){const file=join(folder,e.name);if(e.isDirectory())result.push(...await storeFileSet(file));else if(e.isFile())result.push(resolve(file));else throw Error('V4_STORE_FILE_SET_CHANGED');}return result.sort();}
export function assertV4DecisionBinding(p:V4Plan,authorizationRaw:Buffer,resolutionRaw:Buffer,expectedAuthorizationSha:string,expectedResolutionSha:string){
 need(sha256Bytes(authorizationRaw)===p.authorizationFileSha256&&sha256Bytes(resolutionRaw)===p.resolutionFileSha256
  &&p.authorizationFileSha256===expectedAuthorizationSha&&p.resolutionFileSha256===expectedResolutionSha
  &&same(JSON.parse(authorizationRaw.toString('utf8')),p.existingAuthorization),'V4_EXISTING_DECISION_CHANGED');
}
/** Read-only preflight. No Store open, marker, worker or provider request. */
export async function preflightV4Live(p:V4Plan,options:{expectedRawFreezeFileSha256?:string}={}){
 if(p.preparation){const{checkPreparedV4}=await import('./prepared-v4-preflight.js');const report=await checkPreparedV4(p,{runnerMode:'live',phase:'execute',...options});
  if(!report.passed){const failure=Object.assign(Error('TASK7Y_PREFLIGHT_FAILED'),{code:'TASK7Y_PREFLIGHT_FAILED',preflightReport:report});throw failure;}
  return{...JSON.parse(await readFile(resolve(root,p.baseline.file),'utf8')),preparedPreflight:report};}
 await verifyV4CurrentFiles(p);const b=await verifyV4History(p);
 const gateRaw=await readFile(resolve(root,p.engineeringGate.file)),gate=JSON.parse(gateRaw.toString('utf8'));
 need(sha256Bytes(gateRaw)===p.engineeringGate.sha256&&gate.task==='Task7x'&&gate.engineeringVerified===true&&gate.independentReviewPassed===true&&gate.sourceCommit===p.engineeringSourceCommit
  &&gate.offline?.fail===0&&gate.offline?.tests===gate.offline?.pass&&gate.web?.exitCode===0&&same(gate.productFingerprints,p.productFingerprints),'V4_ENGINEERING_GATE');
 const commit=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();need(commit===p.engineeringSourceCommit,'V4_SOURCE_COMMIT_CHANGED');
 need(process.env.EINSTEIN_GATEWAY_API_KEY&&process.env.EINSTEIN_GATEWAY_MODEL===p.model&&process.env.EINSTEIN_GATEWAY_BASE_URL===p.gatewayBaseURL,'V4_CONFIGURATION_CHANGED');
 assertV4DecisionBinding(p,await readFile(resolve(root,b.existingAuthorization.file)),await readFile(b.existingResolution.file),b.existingAuthorization.sha256,b.existingResolution.sha256);
 need(same(await storeFileSet(p.baseline.storeRoot),b.historicalStore.files.map((f:Row)=>resolve(root,f.file)).sort()),'V4_STORE_FILE_SET_CHANGED');
 return b;
}
/** The actual host's pre-attempt boundary, with isolated offline options for tests. */
export async function runPreparedV4PreflightBoundary(value:unknown,options:NonNullable<Parameters<(typeof import('./prepared-v4-preflight.js'))['checkPreparedV4']>[1]>){
 const plan=validateV4Plan(value);need(plan.preparation,'TASK7Y_ATTEMPT_BINDING');
 need(resolve(options.root??root)===resolve(root)||options.runnerMode==='offline_fixture','TASK7Y_ATTEMPT_BINDING');
 const{checkPreparedV4}=await import('./prepared-v4-preflight.js'),report=await checkPreparedV4(plan,{...options,phase:'execute'});
 const project=resolve(options.root??root),output=resolve(project,plan.preparation!.candidateFolder,report.passed?'execution-preflight.json':'failed-execution-preflight.json');
 await writeV4Json(output,report);
 if(!report.passed)throw Object.assign(Error('TASK7Y_PREFLIGHT_FAILED'),{code:'TASK7Y_PREFLIGHT_FAILED',preflightReport:report,reportAlreadySaved:true});
 return report;
}
export async function runV4LiveValidation(options:{preparedFreezeFile?:string;preparedFreezeFileSha256?:string}={}){
 const file=options.preparedFreezeFile?resolve(root,options.preparedFreezeFile):resolve(root,V4_FOLDER,'freeze.json'),folder=dirname(file);
 need(!options.preparedFreezeFile||/^docs\/implementation\/task-7y-live\/candidates\/[a-f0-9-]{36}\/freeze\.json$/.test(relative(root,file).replaceAll('\\','/')),'TASK7Y_ATTEMPT_BINDING');
 let p:V4Plan|undefined,raw:Buffer|undefined,store:RunStore|undefined,result:Awaited<ReturnType<typeof runV4Sequence>>|undefined,errorCode:string|null=null;
 try{
  raw=await readFile(file);p=validateV4Plan(JSON.parse(raw.toString('utf8')));const plan=p;validatePreparedV4Location(plan,file);
  need(!options.preparedFreezeFile||plan.preparation,'TASK7Y_ATTEMPT_BINDING');
  const rawHash=sha256Bytes(raw);let baseline:Record<string,any>;
  if(plan.preparation){need(HashSchema.safeParse(options.preparedFreezeFileSha256).success&&rawHash===options.preparedFreezeFileSha256,'V4_FREEZE_FILE_CHANGED');
   await runPreparedV4PreflightBoundary(plan,{runnerMode:'live',phase:'execute',expectedRawFreezeFileSha256:options.preparedFreezeFileSha256});
   baseline=JSON.parse(await readFile(resolve(root,plan.baseline.file),'utf8'));await acquireTask7yAttempt({plan,rawFreezeFileSha256:rawHash});}
  else{baseline=await preflightV4Live(plan);await acquireV4Attempt(folder,plan);}
  store=await RunStore.open(plan.baseline.storeRoot,{historicalRecovery:plan.existingAuthorization,publicationSnapshot:()=>loadSnapshot(resolve(root,'reference/einstein-matchmaker-data'),DATASET_COMMIT)});
  need(!store.safetyHold&&store.unresolvedDiagnostics.length===0&&store.historicalResolutions.length===1,'V4_STORE_HOLD_OR_RESOLUTION');need(!store.getRun(plan.probe.runId),'V4_RUN_ALREADY_EXISTS');
  await writeV4Json(join(folder,'store-startup.json'),{scope:V4_SCOPE,safetyHold:store.safetyHold,diagnostics:store.diagnostics,unresolved:store.unresolvedDiagnostics,existingResolutions:store.historicalResolutions,historicalRun:store.getRun(plan.existingAuthorization.runId),recoveryApplyCalls:0,newRiskExceptions:0});
  const cwd=await mkdtemp(join(tmpdir(),'einstein task7x v4 empty cwd ')),out=join(folder,'runs',plan.probe.runId);await mkdir(join(folder,'runs'));await mkdir(out);
  await writeV4Json(join(out,'attempt.json'),{scope:V4_SCOPE,kind:'probe',runId:plan.probe.runId,freezeHash:plan.hash,rawFreezeFileSha256:rawHash,startedAt:new Date().toISOString(),maxGrantedRequests:4,automaticRetry:false});
  result=await runV4Sequence(plan,async()=>{
   await verifyV4History(plan);await verifyV4CurrentFiles(plan);need(sha256Bytes(await readFile(file))===rawHash,'V4_FREEZE_FILE_CHANGED');
   const scheduler=new Scheduler({store:store!,runnerMode:'live',snapshotPath:resolve(root,'reference/einstein-matchmaker-data'),limits:{...DEFAULT_LIMITS,maxModelRequests:4},
    publicationContext:async()=>{throw Error('V4_DIAGNOSTIC_PUBLICATION_FORBIDDEN');},createHost:callbacks=>new ProcessHost({...callbacks,workerPath:resolve(root,plan.workerPath),cwd,workerArgs:['--validation-freeze',file,'--validation-freeze-hash',rawHash]})});
   need(scheduler.permits.snapshot().inFlight===0&&scheduler.permits.snapshot().runs.length===0,'V4_MANAGER_NOT_FRESH');let failure:string|null=null;
   try{await scheduler.submit(plan.probe.input);await scheduler.waitForIdle(205000);}catch(e){failure=safe(e,'V4_RUN_FAILED');}
   finally{try{await scheduler.close();}catch(e){failure??=safe(e,'V4_SCHEDULER_CLOSE_FAILED');}}
   const record=store!.getRun(plan.probe.runId),events=record?store!.eventsAfter(plan.probe.runId,0):[],native=await readEvidence(join(out,'worker-evidence.jsonl'),'V4_NATIVE_EVIDENCE_INVALID'),diagnostics=await readEvidence(join(out,'answer-diagnostics.jsonl'),'V4_ANSWER_EVIDENCE_INVALID');
   failure??=native.errorCode??diagnostics.errorCode;let terminal:Record<string,any>|null=null;try{terminal=JSON.parse(await readFile(join(plan.baseline.storeRoot,plan.probe.runId,'terminal.json'),'utf8'));}catch{failure??='V4_TERMINAL_MISSING';}
   const cleanups=scheduler.cleanupEvidence.map(c=>{const{stdout,stderr,...exit}=c.exit;return{...c,exit,outputHashes:{stdout:sha(stdout),stderr:sha(stderr)}};});
   return{runId:plan.probe.runId,kind:'probe',status:record?.status??'technical_failure',record:record??null,runnerMode:'live',events,cleanups,terminalOutcome:terminal?.outcome??null,
    records:[...native.rows,...diagnostics.rows].sort((a,b)=>a.monotonicMs-b.monotonicMs),safetyHold:scheduler.safetyHold,errorCode:failure,permitSnapshot:scheduler.permits.snapshot(),publication:store!.getPublication(plan.probe.runId)??null,
    answerDiagnostics:diagnostics.rows,showcaseEligible:false,humanLabels:0,qualityMetrics:'NA',automaticRetries:0};
  },{rawFreezeFileSha256:rawHash});
  const row=result.rows[0];if(row){try{await writeV4Json(join(out,'result.json'),{...row,finishedAt:new Date().toISOString()});const copy=join(out,'parent-store-copy');await mkdir(copy);
    for(const name of ['record.json','events.jsonl','terminal.json']){const bytes=await readFile(join(plan.baseline.storeRoot,plan.probe.runId,name)),handle=await open(join(copy,name),'wx');try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
   }catch{errorCode='V4_RESULT_WRITE_FAILED';}}
  await verifyV4History(plan);await verifyV4CurrentFiles(plan);void baseline;
 }catch(e){errorCode=safe(e,'V4_PREFLIGHT_FAILED');
  if(object(e)&&object(e.preflightReport)&&!e.reportAlreadySaved){try{await writeV4Json(join(folder,'failed-execution-preflight.json'),e.preflightReport);}catch{errorCode='V4_RESULT_WRITE_FAILED';}}}
 finally{
  try{if(store)await store.close();}catch{errorCode??='V4_STORE_CLOSE_FAILED';}
  try{await verifyV4History(p);if(p)await verifyV4CurrentFiles(p);}catch{errorCode??='V4_FINAL_INTEGRITY_FAILED';}
  const passed=!errorCode&&result?.passed===true,summary={scope:V4_SCOPE,freezeHash:p?.hash??null,rawFreezeFileSha256:raw?sha256Bytes(raw):null,execution:result??null,errorCode,passed,
   totalGranted:result?.totalGranted??(store?null:0),finishedAt:new Date().toISOString(),L05Executed:false,batchStillLocked:true,Task8Started:false,humanLabels:0,qualityMetrics:'NA',holdout:'unopened',recoveryApplyCalls:0,newRiskExceptions:0,automaticRetries:0};
  try{await writeV4Json(join(folder,'summary.json'),summary);}catch{errorCode??='V4_SUMMARY_WRITE_FAILED';}
 }
 return{passed:!errorCode&&result?.passed===true,execution:result??null,errorCode};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runV4LiveValidation().then(result=>{if(!result.passed)process.exitCode=1;}).catch(()=>{console.error('V4_VALIDATION_STOPPED_NO_RETRY');process.exitCode=1;});
