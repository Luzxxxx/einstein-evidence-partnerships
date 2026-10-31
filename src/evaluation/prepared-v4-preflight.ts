/** One COMPLETE readiness check shared by preparation and execution. Reads only:
 * no marker, Store, recovery application, runtime/worker, permit or fetch call.
 * A successful report is readiness evidence, never execution/publication power. */
import {lstat,readdir} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,parse,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {canonicalizeArtifact} from '../contracts/canonical.js';
import {hashArtifact,sha256Bytes} from '../evidence/hashing.js';
import {deepFreeze} from '../data/records.js';
import {validateV4Plan,collectV4ProductFingerprints,type V4Plan} from './protocol-probe-v4-plan.js';
import {verifyTask7yAuthorizationFile,Task7yPolicyError,TASK7Y_CANDIDATE_ROOT,TASK7Y_ATTEMPT_FILE} from './prepared-v4-policy.js';
import {verifyEngineeringMaterial,EngineeringMaterialError} from './engineering-material.js';
import {readEngineeringFile,EngineeringFileError} from './engineering-files.js';
import {verifyHistoricalRecoveryAuthorization,verifyHistoricalRecoveryResolution,HistoricalRecoveryError} from '../storage/historical-recovery.js';

type Fingerprint={file:string;sha256:string};
type PreparedPlan=V4Plan&{preparation:NonNullable<V4Plan['preparation']>};
type Row=Record<string,any>;
type Mode='live'|'offline_fixture';
export type PreparedV4Options={root?:string;runnerMode?:Mode;phase?:'candidate'|'frozen'|'execute';expectedRawFreezeFileSha256?:string;
 /** Trusted isolated test inputs only. Never accepted by live readiness. */
 env?:Readonly<Record<string,string|undefined>>;currentCommit?:string;collectFingerprints?:()=>Promise<readonly Fingerprint[]>};
export type PreparedV4Check=Readonly<{name:string;status:'passed'|'failed'|'not_checked';code:string;details?:Readonly<Record<string,unknown>>}>;
export type PreparedV4Report=Readonly<{kind:'prepared_v4_readonly_preflight';passed:boolean;runnerMode:Mode;phase:'candidate'|'frozen'|'execute';readOnly:true;executionAuthority:false;liveEligible:boolean;
 candidateId:string|null;planHash:string|null;checks:readonly PreparedV4Check[];effects:Readonly<{attemptWrites:0;storeOpens:0;workerSpawns:0;permitAcquires:0;fetchCalls:0;recoveryApplies:0}>}>;
export class PreparedV4PreflightError extends Error{readonly code='PREPARED_V4_NOT_READY';constructor(readonly report:PreparedV4Report){super('PREPARED_V4_NOT_READY');}}
class Issue extends Error{constructor(readonly code:string){super(code);}}
const defaultRoot=fileURLToPath(new URL('../../../',import.meta.url)),digest=/^[a-f0-9]{64}$/;
const object=(v:unknown):v is Row=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a:unknown,b:unknown)=>canonicalizeArtifact(a)===canonicalizeArtifact(b);
function require(value:unknown,code:string):asserts value{if(!value)throw new Issue(code);}
const sha=(value:Uint8Array)=>sha256Bytes(value);
const names=['plan_structure','candidate_location','candidate_readback','engineering_material','source_commit','fingerprints','configuration','authorization','protected_history','official_sources','existing_decisions','store_file_set','admission_unused'] as const;
const inside=(root:string,file:string)=>{const r=relative(root,file);return r!==''&&!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r);};
function relativeFile(root:string,file:unknown){require(typeof file==='string'&&file.length>0&&!file.includes('\\')&&!file.includes(':')&&!file.includes('\0')&&!isAbsolute(file)
 &&file.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'),'PREPARED_UNSAFE_RELATIVE_PATH');const target=resolve(root,file);require(inside(root,target),'PREPARED_UNSAFE_RELATIVE_PATH');return target;}
async function ordinary(target:string,kind:'file'|'directory'){
 const volume=parse(target).root;let cursor=volume;for(const part of relative(volume,target).split(/[\\/]/).filter(Boolean)){cursor=join(cursor,part);const info=await lstat(cursor);
  require(!info.isSymbolicLink()&&(cursor===target&&kind==='file'?info.isFile():info.isDirectory()),'PREPARED_UNSAFE_FILE');}
}
function decode(value:Uint8Array):unknown{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(value));}catch{throw new Issue('PREPARED_JSON_INVALID');}}
async function exists(file:string){try{await lstat(file);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
function gitRead(root:string,args:readonly string[],failure='PREPARED_GIT_READ_FAILED'){
 try{return execFileSync('git',['--no-optional-locks','--no-replace-objects','-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});}
 catch{throw new Issue(failure);}
}
/** Actual dataset repository identity/status, independent of the eight raw
 * source hashes. Read-only Git flags prevent optional index refresh writes. */
export async function verifyPreparedDatasetGit(datasetRoot:string,expectedCommit:string):Promise<{datasetGit:'verified';datasetCommit:string}>{
 try{
  require(isAbsolute(datasetRoot)&&/^[a-f0-9]{40}$/.test(expectedCommit),'PREPARED_DATASET_GIT_INVALID');await ordinary(resolve(datasetRoot),'directory');
  const actual=gitRead(datasetRoot,['rev-parse','HEAD'],'PREPARED_DATASET_GIT_READ_FAILED').trim(),status=gitRead(datasetRoot,['status','--porcelain=v1','--untracked-files=all'],'PREPARED_DATASET_GIT_READ_FAILED');
  require(actual===expectedCommit,'PREPARED_DATASET_COMMIT_CHANGED');require(status.trim()==='','PREPARED_DATASET_DIRTY');return{datasetGit:'verified',datasetCommit:actual};
 }catch(error){if(error instanceof Issue)throw error;throw new Issue('PREPARED_DATASET_GIT_READ_FAILED');}
}
async function walk(folder:string):Promise<string[]>{await ordinary(folder,'directory');const out:string[]=[];for(const e of await readdir(folder,{withFileTypes:true})){const p=join(folder,e.name);if(e.isDirectory())out.push(...await walk(p));else if(e.isFile())out.push(resolve(p));else throw new Issue('PREPARED_UNSAFE_FILE');}return out.sort();}
function reference(row:unknown):asserts row is {file:string;sha256:string;bytes?:number}{require(object(row)&&typeof row.file==='string'&&digest.test(row.sha256)
 &&(row.bytes===undefined||Number.isSafeInteger(row.bytes)&&row.bytes>=0),'PREPARED_REFERENCE_INVALID');}

export async function checkPreparedV4(value:unknown,options:PreparedV4Options={}):Promise<PreparedV4Report>{
 const root=resolve(options.root??defaultRoot),mode=options.runnerMode??'live',phase=options.phase??'frozen',checks=new Map<string,PreparedV4Check>();
 const bytes=(file:string)=>readEngineeringFile(root,file,32*1024*1024);
 let p:PreparedPlan|undefined,locationReady=false,auth:Awaited<ReturnType<typeof verifyTask7yAuthorizationFile>>|undefined,baseline:Row|undefined,
  commit:string|undefined,fingerprints:Fingerprint[]|undefined;
 const add=(name:string,status:PreparedV4Check['status'],code:string,details?:Record<string,unknown>)=>checks.set(name,{name,status,code,...(details?{details}: {})});
 const skip=(name:string)=>add(name,'not_checked','PREPARED_DEPENDENCY_NOT_READY');
 async function check(name:string,action:()=>Promise<Record<string,unknown>|void>|Record<string,unknown>|void){try{const details=await action();add(name,'passed','PREPARED_CHECK_PASSED',details??undefined);}
  catch(error){const code=error instanceof Issue||error instanceof EngineeringMaterialError||error instanceof HistoricalRecoveryError||error instanceof EngineeringFileError?error.code:'PREPARED_'+name.toUpperCase()+'_FAILED';add(name,'failed',code);}}
 await check('plan_structure',()=>{
  require(mode==='live'||mode==='offline_fixture','PREPARED_MODE_INVALID');require(['candidate','frozen','execute'].includes(phase),'PREPARED_PHASE_INVALID');
  require(mode!=='live'||options.env===undefined&&options.currentCommit===undefined&&options.collectFingerprints===undefined,'PREPARED_LIVE_OVERRIDE_FORBIDDEN');
  require(options.expectedRawFreezeFileSha256===undefined||digest.test(options.expectedRawFreezeFileSha256),'PREPARED_RAW_FREEZE_HASH_INVALID');
  const parsed=validateV4Plan(value);require(parsed.preparation,'PREPARED_METADATA_REQUIRED');p=parsed as PreparedPlan;
  require(hashArtifact(value)===p.hash,'PREPARED_PLAN_HASH_INVALID');return{planHash:p.hash};
 });
 if(p)await check('candidate_location',async()=>{const m=p!.preparation;
  require(m.candidateFolder===TASK7Y_CANDIDATE_ROOT+'/'+m.candidateId&&m.globalAttemptFile===TASK7Y_ATTEMPT_FILE&&p!.engineeringGate.file===m.candidateFolder+'/engineering.json','PREPARED_CANDIDATE_LOCATION_INVALID');
  const candidate=relativeFile(root,m.candidateFolder);relativeFile(root,p!.engineeringGate.file);relativeFile(root,m.authorizationFile);relativeFile(root,m.baselineFile);relativeFile(root,m.globalAttemptFile);await ordinary(candidate,'directory');locationReady=true;
  return{candidateId:m.candidateId};
 });else skip('candidate_location');
 if(p&&locationReady)await check('candidate_readback',async()=>{const file=relativeFile(root,p!.preparation.candidateFolder+'/freeze.json'),present=await exists(file);
  if(!present){require(phase==='candidate','PREPARED_FREEZE_MISSING');return{freezeExists:false,required:false};}
  const raw=await bytes(file),disk=decode(raw),parsed=validateV4Plan(disk);require(same(parsed,p)&&hashArtifact(disk)===p!.hash,'PREPARED_FREEZE_READBACK_MISMATCH');
  const rawHash=sha(raw);require(options.expectedRawFreezeFileSha256===undefined||rawHash===options.expectedRawFreezeFileSha256,'PREPARED_RAW_FREEZE_HASH_MISMATCH');return{freezeExists:true,required:phase!=='candidate',rawFreezeFileSha256:rawHash,byteLength:raw.length};
 });else skip('candidate_readback');
 if(p)await check('source_commit',()=>{const actual=mode==='offline_fixture'&&options.currentCommit!==undefined?options.currentCommit:gitRead(root,['rev-parse','HEAD']).trim();
  require(/^[a-f0-9]{40}$/.test(actual),'PREPARED_COMMIT_INVALID');commit=actual;require(actual===p!.engineeringSourceCommit,'PREPARED_SOURCE_COMMIT_CHANGED');
  if(mode==='live'){
   const tracked=new Set(gitRead(root,['ls-files','-z']).split('\0').filter(Boolean)),sourcePaths=p!.productFingerprints.map(f=>f.file).filter(file=>/^(?:src\/|scripts\/)/.test(file)||/^(?:package\.json|pnpm-lock\.yaml|tsconfig(?:\.[^/]*)?\.json|(?:web\/)?vite\.config\.[^/]+)$/.test(file));
   require(sourcePaths.length>0&&sourcePaths.every(file=>tracked.has(file)),'PREPARED_SOURCE_NOT_COMMITTED');
   require(gitRead(root,['diff','--name-only','-z','HEAD','--',...sourcePaths])==='','PREPARED_COMMITTED_SOURCE_DRIFT');
   return{sourceCommit:actual,sourceGit:'verified',trackedCleanSourceFiles:sourcePaths.length};
  }
  return{sourceCommit:actual,sourceGit:'not_observed_offline_fixture'};
 });else skip('source_commit');
 if(p)await check('fingerprints',async()=>{
  const collected=mode==='offline_fixture'&&options.collectFingerprints?await options.collectFingerprints():await collectV4ProductFingerprints(root),actual:Fingerprint[]=[];
  require(Array.isArray(collected)&&collected.length>0&&new Set(collected.map(f=>f.file)).size===collected.length,'PREPARED_FINGERPRINT_SET_INVALID');
  for(const f of collected){reference(f);const raw=await bytes(relativeFile(root,f.file)),actualHash=sha(raw);actual.push({file:f.file,sha256:actualHash});require(actualHash===f.sha256,'PREPARED_CURRENT_FINGERPRINT_CHANGED');}
  fingerprints=actual;require(same(actual,p!.productFingerprints),'PREPARED_FROZEN_FINGERPRINT_SET_CHANGED');return{count:actual.length};
 });else skip('fingerprints');
 if(p&&locationReady&&commit&&fingerprints)await check('engineering_material',async()=>{const raw=await bytes(relativeFile(root,p!.engineeringGate.file));require(sha(raw)===p!.engineeringGate.sha256,'PREPARED_ENGINEERING_FILE_HASH');
  const material=await verifyEngineeringMaterial(decode(raw),{root,currentCommit:commit!,currentFingerprints:fingerprints!,runnerMode:mode});
  require(material.sourceCommit===p!.engineeringSourceCommit&&same(material.fingerprints,p!.productFingerprints),'PREPARED_ENGINEERING_PLAN_BINDING');return{materialHash:material.hash,offlineTests:material.commands.offline.summary.tests,webExitCode:material.commands.web.receipt.exitCode};
 });else skip('engineering_material');
 if(p)await check('configuration',()=>{const env=mode==='offline_fixture'&&options.env?options.env:process.env;
  require(typeof env.EINSTEIN_GATEWAY_API_KEY==='string'&&env.EINSTEIN_GATEWAY_API_KEY.length>0&&env.EINSTEIN_GATEWAY_MODEL===p!.model&&env.EINSTEIN_GATEWAY_BASE_URL===p!.gatewayBaseURL,'PREPARED_CONFIGURATION_CHANGED');return{credentialPresent:true,modelMatches:true,gatewayMatches:true};
 });else skip('configuration');
 if(p&&locationReady)await check('authorization',async()=>{const m=p!.preparation,raw=await bytes(relativeFile(root,m.authorizationFile));require(sha(raw)===m.authorizationFileSha256,'PREPARED_AUTHORIZATION_HASH');
  let a:Awaited<ReturnType<typeof verifyTask7yAuthorizationFile>>;try{a=await verifyTask7yAuthorizationFile(root,m,{runnerMode:mode});}
  catch(error){if(error instanceof Task7yPolicyError)throw new Issue(error.code);throw error;}
  require(a.authorizationId===m.authorizationId&&a.candidateRoot===TASK7Y_CANDIDATE_ROOT&&a.globalAttemptFile===m.globalAttemptFile&&a.baselineFile===m.baselineFile&&a.baselineSha256===m.baselineSha256,'PREPARED_AUTHORIZATION_METADATA_BINDING');
  require(isAbsolute(a.storeRoot)&&resolve(a.storeRoot)===resolve(p!.baseline.storeRoot)&&resolve(a.storeRoot)===resolve(p!.existingAuthorization.storeRoot),'PREPARED_STORE_ROOT_BINDING');
  require(a.protocolVersion===p!.probe.contractVersion&&a.protocolContractSha256===p!.probe.contractSha256&&a.limits.maxGrantedRequests===p!.limits.totalRequests&&a.limits.perContextRequests===p!.limits.perContextRequests,'PREPARED_AUTHORIZATION_PROTOCOL_BINDING');
  const baselineRaw=await bytes(relativeFile(root,m.baselineFile));require(sha(baselineRaw)===a.baselineSha256,'PREPARED_BASELINE_HASH');const b=decode(baselineRaw);
  require(object(b)&&b.task==='Task7y'&&b.head===a.baselineHead&&object(b.historicalStore)&&resolve(b.historicalStore.root)===resolve(a.storeRoot),'PREPARED_BASELINE_BINDING');auth=a;baseline=b;
  return{authorizationId:a.authorizationId,baselineSha256:a.baselineSha256};
 });else skip('authorization');
 function protectedTarget(file:string,storeAllowed=false){
  if(storeAllowed){
   // Persisted baseline references can be relative to the project even when
   // the immutable Store lives outside it. Resolve first, then bind exclusively
   // to that exact authorized Store. No other root-relative path gets '..'.
   require(typeof file==='string'&&file.length>0&&!file.includes('\0'),'PREPARED_UNSAFE_STORE_REFERENCE');
   const target=resolve(root,file);require(auth&&inside(resolve(auth.storeRoot),target),'PREPARED_UNSAFE_STORE_REFERENCE');return target;
  }
  require(!isAbsolute(file),'PREPARED_UNSAFE_ABSOLUTE_REFERENCE');return relativeFile(root,file);
 }
 async function verifyRows(rows:unknown,storeAllowed=false){require(Array.isArray(rows)&&rows.length>0,'PREPARED_BASELINE_GROUP_INVALID');const seen=new Set<string>();for(const row of rows){reference(row);const target=protectedTarget(row.file,storeAllowed);require(!seen.has(target),'PREPARED_DUPLICATE_PROTECTED_FILE');seen.add(target);
  const raw=await bytes(target);require(sha(raw)===row.sha256&&(row.bytes===undefined||row.bytes===raw.length),'PREPARED_PROTECTED_BYTES_CHANGED');}}
 if(p&&auth&&baseline)await check('protected_history',async()=>{const b=baseline!;
  require(Array.isArray(b.oldRuntime)&&Array.isArray(b.historicalStore.files)&&Array.isArray(b.officialSources)&&Array.isArray(b.trackedChanges)&&b.trackedChanges.length===5,'PREPARED_BASELINE_STRUCTURE');
  if(mode==='live')require(b.oldRuntime.length===145&&b.protectedUntracked?.length===473&&b.historicalImplementation?.length===1312&&b.historicalStore.files.length===97&&b.officialSources.length===8,'PREPARED_PRODUCTION_BASELINE_COUNTS');
  if(mode==='live'){
   require(Array.isArray(b.untrackedPaths)&&b.untrackedPaths.length===473&&b.untrackedPaths.every((file:unknown)=>typeof file==='string'),'PREPARED_BASELINE_UNTRACKED_SET');
   const tracked=new Set(gitRead(root,['ls-files','-z']).split('\0').filter(Boolean));require(b.untrackedPaths.every((file:string)=>!tracked.has(file)),'PREPARED_PROTECTED_FILE_BECAME_TRACKED');
   require(gitRead(root,['diff','--cached','--name-only','-z'])==='','PREPARED_INDEX_NOT_EMPTY');
  }
  for(const group of[b.protectedUntracked,b.trackedChanges,b.historicalImplementation,b.historicalStore.files])await verifyRows(group,group===b.historicalStore.files);
  require(new Set(b.oldRuntime.map((f:Row)=>f.file)).size===b.oldRuntime.length,'PREPARED_RUNTIME_BASELINE_DUPLICATE');let modified=0,unchanged=0;
  for(const row of b.oldRuntime){reference(row);const raw=await bytes(relativeFile(root,row.file)),actual=sha(raw),approved=auth!.approvedRuntimeChanges.find(a=>a.file===row.file);
   if(approved){require(approved.beforeSha256===row.sha256,'PREPARED_APPROVED_RUNTIME_BEFORE_HASH');if(actual!==row.sha256)modified++;}
   else{require(actual===row.sha256&&(row.bytes===undefined||row.bytes===raw.length),'PREPARED_UNAPPROVED_RUNTIME_CHANGED');unchanged++;}
   require(p!.productFingerprints.some(f=>f.file===row.file&&f.sha256===actual),'PREPARED_RUNTIME_FINGERPRINT_BINDING');}
  const approved=auth!.approvedRuntimeChanges;require(approved.length>0&&new Set(approved.map(a=>a.file)).size===approved.length&&approved.every(a=>b.oldRuntime.some((f:Row)=>f.file===a.file)),'PREPARED_APPROVED_RUNTIME_PATH_MISSING');
  require(unchanged===b.oldRuntime.length-approved.length,'PREPARED_APPROVED_RUNTIME_SCOPE');return{policyVersion:auth!.policyVersion,approvedPaths:approved.length,modifiedApproved:modified,unchangedUnapproved:unchanged,protectedFiles:b.protectedUntracked.length,historicalFiles:b.historicalImplementation.length,storeFiles:b.historicalStore.files.length,protectedGit:mode==='live'?'verified_untracked_and_empty_index':'not_observed_offline_fixture'};
 });else skip('protected_history');
 if(p&&auth&&baseline)await check('official_sources',async()=>{const b=baseline!;require(Array.isArray(b.officialSources)&&b.officialSources.length===8,'PREPARED_SOURCE_LIST_INVALID');await verifyRows(b.officialSources);
  const expected=b.officialSources.map((f:Row)=>({file:f.datasetRelative,bytes:f.bytes,expectedSha256:f.sha256,actualSha256:f.sha256,unchanged:true}));require(same(expected,p!.sourceIntegrity),'PREPARED_SOURCE_MANIFEST_BINDING');
  for(const f of p!.sourceIntegrity){const raw=await bytes(relativeFile(root,'reference/einstein-matchmaker-data/'+f.file));require(raw.length===f.bytes&&sha(raw)===f.actualSha256&&f.expectedSha256===f.actualSha256,'PREPARED_OFFICIAL_SOURCE_CHANGED');}
  const xRaw=await bytes(relativeFile(root,p!.baseline.file));require(sha(xRaw)===p!.baseline.sha256,'PREPARED_LEGACY_BASELINE_HASH');const x=decode(xRaw);require(object(x)&&resolve(x.historicalStore?.root)===resolve(p!.baseline.storeRoot),'PREPARED_LEGACY_BASELINE_BINDING');
  for(const c of p!.approvedRuntimeChanges){require(x.oldRuntime?.some((f:Row)=>f.file===c.file&&f.sha256===c.beforeSha256),'PREPARED_LEGACY_RUNTIME_BEFORE_HASH');require(sha(await bytes(relativeFile(root,c.file)))===c.afterSha256,'PREPARED_LEGACY_RUNTIME_AFTER_HASH');}
  const iface=p!.promptContract.interfaceContract,raw=await bytes(relativeFile(root,iface.file));require(sha(raw)===iface.sha256&&raw.toString('utf8')===iface.text,'PREPARED_INTERFACE_BYTES_CHANGED');
  require(b.datasetCommit===p!.probe.input.datasetCommit,'PREPARED_DATASET_BASELINE_COMMIT');
  const dataset=mode==='live'?await verifyPreparedDatasetGit(relativeFile(root,'reference/einstein-matchmaker-data'),p!.probe.input.datasetCommit):{datasetGit:'not_observed_offline_copy'};
  return{officialSources:8,...dataset};
 });else skip('official_sources');
 if(p&&auth&&baseline)await check('existing_decisions',async()=>{const b=baseline!;reference(b.existingAuthorization);reference(b.existingResolution);
  const raw=await bytes(protectedTarget(b.existingAuthorization.file)),resolutionRaw=await bytes(protectedTarget(b.existingResolution.file,true));
  require(sha(raw)===b.existingAuthorization.sha256&&sha(raw)===p!.authorizationFileSha256&&sha(resolutionRaw)===b.existingResolution.sha256&&sha(resolutionRaw)===p!.resolutionFileSha256,'PREPARED_EXISTING_DECISION_HASH');
  require(same(decode(raw),p!.existingAuthorization),'PREPARED_EXISTING_AUTHORIZATION_OBJECT');
  for(const bound of[p!.existingAuthorization.originalFiles.result,p!.existingAuthorization.originalFiles.freeze,p!.existingAuthorization.evidence])require(inside(root,resolve(bound.path))||inside(resolve(auth!.storeRoot),resolve(bound.path)),'PREPARED_EXISTING_DECISION_PATH');
  const verified=await verifyHistoricalRecoveryAuthorization(decode(raw),auth!.storeRoot,Date.now(),false),resolution=verifyHistoricalRecoveryResolution(decode(resolutionRaw),verified);
  return{historicalCleanupConfirmed:resolution.historicalCleanupConfirmed,preservedStatus:resolution.preservedHistoricalStatus,preservedCleanupState:resolution.preservedCleanupState,applyCalls:0,evidenceClass:mode==='offline_fixture'?'isolated_fixture_copy_not_actual_resolution_validation':'existing_durable_decision_readonly_verified'};
 });else skip('existing_decisions');
 if(p&&auth&&baseline)await check('store_file_set',async()=>{const files=baseline!.historicalStore.files;require(Array.isArray(files)&&files.length>0,'PREPARED_STORE_BASELINE_INVALID');const expected:string[]=[];
  for(const f of files){reference(f);const path=protectedTarget(f.file,true);require(inside(resolve(auth!.storeRoot),path),'PREPARED_STORE_REFERENCE_OUTSIDE_ROOT');expected.push(path);}
  require(new Set(expected).size===expected.length,'PREPARED_STORE_BASELINE_DUPLICATE');require(same((await walk(auth!.storeRoot)),expected.sort()),'PREPARED_STORE_FILE_SET_CHANGED');return{files:expected.length,storeOpenCalls:0};
 });else skip('store_file_set');
 if(p&&auth&&locationReady)await check('admission_unused',async()=>{require(!await exists(relativeFile(root,p!.preparation.globalAttemptFile)),'PREPARED_AUTHORIZATION_ALREADY_CONSUMED');
  for(const path of[relativeFile(root,p!.preparation.candidateFolder+'/attempt.json'),relativeFile(root,p!.preparation.candidateFolder+'/runs/'+p!.probe.runId),join(auth!.storeRoot,p!.probe.runId)])require(!await exists(path),'PREPARED_RUN_OR_ATTEMPT_ALREADY_EXISTS');return{globalAttemptAbsent:true,runAbsent:true};
 });else skip('admission_unused');
 const ordered=names.map(name=>checks.get(name)??{name,status:'not_checked' as const,code:'PREPARED_DEPENDENCY_NOT_READY'}),passed=ordered.every(c=>c.status==='passed');
 return deepFreeze({kind:'prepared_v4_readonly_preflight' as const,passed,runnerMode:mode,phase,readOnly:true as const,executionAuthority:false as const,liveEligible:passed&&mode==='live'&&phase==='execute',candidateId:p?.preparation.candidateId??null,planHash:p?.hash??null,checks:ordered,
  effects:{attemptWrites:0 as const,storeOpens:0 as const,workerSpawns:0 as const,permitAcquires:0 as const,fetchCalls:0 as const,recoveryApplies:0 as const}});
}
export async function assertPreparedV4(value:unknown,options:PreparedV4Options={}):Promise<PreparedV4Report>{const report=await checkPreparedV4(value,options);if(!report.passed)throw new PreparedV4PreflightError(report);return report;}
