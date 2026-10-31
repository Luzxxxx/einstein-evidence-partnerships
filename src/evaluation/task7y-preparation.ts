/** Real Task7y producer-to-full-preflight chain. Never opens Store or runs models. */
import {readFile,mkdir,open,access} from 'node:fs/promises';import {resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {produceEngineeringMaterial} from './engineering-material.js';
import {checkPreparedV4} from './prepared-v4-preflight.js';
import {Task7yAuthorizationSchema,verifyTask7yAuthorizationFile,TASK7Y_POLICY_V1_FILE,TASK7Y_POLICY_V2_FILE,TASK7Y_CANDIDATE_ROOT,TASK7Y_ATTEMPT_FILE} from './prepared-v4-policy.js';
import {validateV4Plan,collectV4ProductFingerprints,V4_SCOPE,V4_WORKER_PATH,V4_GENERIC_DISPATCH} from './protocol-probe-v4-plan.js';
import {PROTOCOL_PROBE_V3_INSTRUCTION} from './probe-contract-guard.js';import {PROTOCOL_PROBE_V4_CONTRACT,protocolProbeV4ToolDefinitions} from './protocol-probe-v4.js';
import {DATASET_COMMIT} from '../contracts/primitives.js';import {loadSnapshot} from '../data/snapshot.js';
import {buildIndex,retrieveWithTrace} from '../retrieval/index.js';import {createResearchTools} from '../runtime/tools.js';
import {hashArtifact,hashEvidenceSnapshot,hashRunInput,sha256Bytes} from '../evidence/hashing.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=(s:string)=>sha256Bytes(Buffer.from(s,'utf8'));
function need(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
async function wx(file:string,value:unknown){const h=await open(resolve(root,file),'wx');try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}}
async function absent(file:string){try{await access(resolve(root,file));throw Error('TASK7Y_GLOBAL_ATTEMPT_EXISTS');}catch(e){if(!(e&&typeof e==='object'&&'code'in e&&e.code==='ENOENT'))throw e;}}
export async function prepareTask7yCandidate(options:{checksBatchId?:string}){
 need(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(options.checksBatchId??''),'TASK7Y_CHECKS_BATCH_REQUIRED');
 await absent(TASK7Y_ATTEMPT_FILE);
 const candidateId=randomUUID(),candidateFolder=TASK7Y_CANDIDATE_ROOT+'/'+candidateId,runId=randomUUID();
 await mkdir(resolve(root,TASK7Y_CANDIDATE_ROOT),{recursive:true});await mkdir(resolve(root,candidateFolder));
 let stage='engineering_material';
 try{
  let authorizationFile=TASK7Y_POLICY_V1_FILE;try{await access(resolve(root,TASK7Y_POLICY_V2_FILE));authorizationFile=TASK7Y_POLICY_V2_FILE;}catch(e){if(!(e&&typeof e==='object'&&'code'in e&&e.code==='ENOENT'))throw e;}
  const authRaw=await readFile(resolve(root,authorizationFile)),declared=Task7yAuthorizationSchema.parse(JSON.parse(authRaw.toString('utf8'))),
   authorization=await verifyTask7yAuthorizationFile(root,{authorizationFile,authorizationFileSha256:sha256Bytes(authRaw),authorizationId:declared.authorizationId});
  const sourceCommit=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();need(sourceCommit!==authorization.baselineHead,'TASK7Y_ENGINEERING_COMMIT_REQUIRED');
  const productFingerprints=await collectV4ProductFingerprints(),folder='docs/implementation/task-7y-checks/'+options.checksBatchId;
  async function ref(file:string){return{file,sha256:sha256Bytes(await readFile(resolve(root,file)))};}
  const material=await produceEngineeringMaterial({task:'Task7y',runnerMode:'live',sourceCommit,fingerprints:productFingerprints,
   commands:{offline:await ref(folder+'/offline-receipt.json'),web:await ref(folder+'/web-receipt.json')},
   capture:await ref(folder+'/capture.json'),independentReview:await ref('docs/implementation/task-7y-live/reviews/'+sourceCommit+'.json')},{root});
  const engineeringFile=candidateFolder+'/engineering.json';await wx(engineeringFile,material);stage='candidate_plan';
  need(process.env.EINSTEIN_GATEWAY_API_KEY&&process.env.EINSTEIN_GATEWAY_MODEL&&process.env.EINSTEIN_GATEWAY_BASE_URL,'TASK7Y_CONFIGURATION_MISSING');
  const input={runId,companyId:'C001',challengeId:'C001-CH1',datasetCommit:DATASET_COMMIT,promptVersion:'task7x-protocol-v4',configVersion:'task7x-bounded-v4',mode:'adversarial' as const};
  const snapshot=await loadSnapshot(resolve(root,'reference/einstein-matchmaker-data'),DATASET_COMMIT),research={snapshot,...retrieveWithTrace(input,buildIndex(snapshot))};
  need(research.pool.candidates.length>0,'TASK7Y_EMPTY_POOL');const researcherId=research.pool.candidates[0]!.researcherId;
  const oldRaw=await readFile(resolve(root,'docs/implementation/task-7x-baseline.json')),old=JSON.parse(oldRaw.toString('utf8'));
  const baselineRaw=await readFile(resolve(root,authorization.baselineFile)),authorizationRaw=await readFile(resolve(root,old.existingAuthorization.file));
  const ifaceFile='docs/superpowers/specs/2026-10-30-interface-contracts.md',iface=await readFile(resolve(root,ifaceFile));
  const body={scope:V4_SCOPE,schemaVersion:4,createdAt:new Date().toISOString(),model:process.env.EINSTEIN_GATEWAY_MODEL,gatewayBaseURL:process.env.EINSTEIN_GATEWAY_BASE_URL,workerPath:V4_WORKER_PATH,
   probe:{runId,input,inputHash:hashRunInput(input),researcherId,contractVersion:'protocol-probe-v4-staged',contract:PROTOCOL_PROBE_V4_CONTRACT,contractSha256:hashArtifact(PROTOCOL_PROBE_V4_CONTRACT),
    effectiveInstructionText:PROTOCOL_PROBE_V3_INSTRUCTION,effectiveInstructionSha256:sha(PROTOCOL_PROBE_V3_INSTRUCTION),userTask:{runId,companyId:input.companyId,challengeId:input.challengeId,researcherId},
    pool:research.pool,poolHash:research.pool.poolHash,evidenceSnapshotHash:hashEvidenceSnapshot(research.evidence),toolDefinitions:protocolProbeV4ToolDefinitions(createResearchTools({...research,input,signal:new AbortController().signal}))},
   sourceFiles:snapshot.files,sourceIntegrity:old.officialSources.map((f:Record<string,any>)=>({file:f.datasetRelative,bytes:f.bytes,expectedSha256:f.sha256,actualSha256:f.sha256,unchanged:true})),
   limits:{probeRequests:4,perContextRequests:2,totalRequests:4,requestTimeoutMs:40000,runTimeoutMs:180000,maxConcurrentModelRequests:2,maxActiveRuns:1,maxQueuedRuns:3,queueTimeoutMs:120000},automaticRetry:false,showcaseEligible:false,
   baseline:{file:'docs/implementation/task-7x-baseline.json',sha256:sha256Bytes(oldRaw),storeRoot:authorization.storeRoot},
   promptContract:{version:'task7x-effective-v4',probeInstruction:PROTOCOL_PROBE_V3_INSTRUCTION,probeInstructionSha256:sha(PROTOCOL_PROBE_V3_INSTRUCTION),genericDispatchText:V4_GENERIC_DISPATCH,genericDispatchSha256:sha(V4_GENERIC_DISPATCH),interfaceContract:{file:ifaceFile,text:iface.toString('utf8'),sha256:sha256Bytes(iface)}},
   productFingerprints,approvedRuntimeChanges:await Promise.all(['src/supervisor/permits.ts','dist/server/supervisor/permits.js'].map(async file=>({file,beforeSha256:old.oldRuntime.find((r:Record<string,any>)=>r.file===file).sha256,afterSha256:sha256Bytes(await readFile(resolve(root,file)))}))),
   engineeringSourceCommit:sourceCommit,existingAuthorization:JSON.parse(authorizationRaw.toString('utf8')),authorizationFileSha256:sha256Bytes(authorizationRaw),resolutionFileSha256:old.existingResolution.sha256,
   engineeringGate:await ref(engineeringFile),preparation:{schemaVersion:1,task:'Task7y',candidateId,candidateFolder,authorizationId:authorization.authorizationId,authorizationFile,authorizationFileSha256:sha256Bytes(authRaw),
    globalAttemptFile:TASK7Y_ATTEMPT_FILE,baselineFile:authorization.baselineFile,baselineSha256:sha256Bytes(baselineRaw)}};
  const plan=validateV4Plan({...body,hash:hashArtifact(body)});await wx(candidateFolder+'/candidate-plan.json',plan);stage='candidate_preflight';
  const candidate=await checkPreparedV4(plan,{runnerMode:'live',phase:'candidate'});await wx(candidateFolder+'/candidate-preflight.json',candidate);
  need(candidate.passed,'TASK7Y_CANDIDATE_PREFLIGHT_FAILED');await absent(TASK7Y_ATTEMPT_FILE);stage='freeze';
  await wx(candidateFolder+'/freeze.json',plan);const freezeRaw=await readFile(resolve(root,candidateFolder,'freeze.json')),fromDisk=validateV4Plan(JSON.parse(freezeRaw.toString('utf8')));
  need(fromDisk.hash===plan.hash,'TASK7Y_FREEZE_READBACK_MISMATCH');stage='frozen_preflight';
  const frozen=await checkPreparedV4(fromDisk,{runnerMode:'live',phase:'frozen',expectedRawFreezeFileSha256:sha256Bytes(freezeRaw)});await wx(candidateFolder+'/frozen-preflight.json',frozen);need(frozen.passed,'TASK7Y_FROZEN_PREFLIGHT_FAILED');
  const result={task:'Task7y',passed:true,candidateId,candidateFolder,runId,sourceCommit,freezeHash:plan.hash,rawFreezeFileSha256:sha256Bytes(freezeRaw),stage:'ready',globalAttemptCreated:false,modelRequests:0};
  await wx(candidateFolder+'/preparation-result.json',result);return result;
 }catch(error){const raw=error instanceof Error?error.message:'',code=/^[A-Z][A-Z0-9_]{0,95}$/.test(raw)?raw:'TASK7Y_PREPARATION_FAILED';
  const result={task:'Task7y',passed:false,candidateId,candidateFolder,runId,stage,code,globalAttemptCreated:false,modelRequests:0};await wx(candidateFolder+'/preparation-result.json',result);return result;}
}
