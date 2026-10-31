// Creates a fresh freeze only after the exact engineering gate/source commit.
// No Store open, recovery, worker, attempt, model request, retry or L05.
import {readFile,mkdir,open} from 'node:fs/promises';import {resolve,join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {validateV4Plan,collectV4ProductFingerprints,V4_SCOPE,V4_FOLDER,V4_WORKER_PATH,V4_GENERIC_DISPATCH} from '../dist/server/evaluation/protocol-probe-v4-plan.js';
import {verifyV4History} from '../dist/server/evaluation/v4-bounded-validation.js';
import {PROTOCOL_PROBE_V4_CONTRACT,protocolProbeV4ToolDefinitions} from '../dist/server/evaluation/protocol-probe-v4.js';
import {PROTOCOL_PROBE_V3_INSTRUCTION} from '../dist/server/evaluation/probe-contract-guard.js';
import {DATASET_COMMIT} from '../dist/server/contracts/primitives.js';import {loadSnapshot} from '../dist/server/data/snapshot.js';
import {buildIndex,retrieveWithTrace} from '../dist/server/retrieval/index.js';import {createResearchTools} from '../dist/server/runtime/tools.js';
import {hashArtifact,hashEvidenceSnapshot,hashRunInput,sha256Bytes} from '../dist/server/evidence/hashing.js';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=s=>sha256Bytes(Buffer.from(s,'utf8'));
const need=(v,c)=>{if(!v)throw Error(c);};
export async function prepareTask7xValidation(){
 const baseline=await verifyV4History(),baselineFile='docs/implementation/task-7x-baseline.json',baselineRaw=await readFile(resolve(root,baselineFile));
 const sourceCommit=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
 need(sourceCommit!==baseline.head,'V4_ENGINEERING_COMMIT_REQUIRED');
 const gateFile='docs/implementation/task-7x-pre-live-gate.json',gateRaw=await readFile(resolve(root,gateFile)),gate=JSON.parse(gateRaw.toString('utf8')),fingerprints=await collectV4ProductFingerprints();
 need(gate.task==='Task7x'&&gate.engineeringVerified===true&&gate.independentReviewPassed===true&&gate.sourceCommit===sourceCommit&&JSON.stringify(gate.productFingerprints)===JSON.stringify(fingerprints),'V4_ENGINEERING_GATE_REQUIRED');
 const model=process.env.EINSTEIN_GATEWAY_MODEL,baseURL=process.env.EINSTEIN_GATEWAY_BASE_URL;
 need(process.env.EINSTEIN_GATEWAY_API_KEY&&model&&baseURL,'V4_CONFIGURATION_MISSING');
 const runId=randomUUID(),input={runId,companyId:'C001',challengeId:'C001-CH1',datasetCommit:DATASET_COMMIT,promptVersion:'task7x-protocol-v4',configVersion:'task7x-bounded-v4',mode:'adversarial'};
 const snapshot=await loadSnapshot(resolve(root,'reference/einstein-matchmaker-data'),DATASET_COMMIT),research={snapshot,...retrieveWithTrace(input,buildIndex(snapshot))};
 need(research.pool.candidates.length>0,'V4_EMPTY_POOL');const researcherId=research.pool.candidates[0].researcherId;
 const toolDefinitions=protocolProbeV4ToolDefinitions(createResearchTools({...research,input,signal:new AbortController().signal}));
 const ifaceFile='docs/superpowers/specs/2026-10-30-interface-contracts.md',iface=await readFile(resolve(root,ifaceFile)),authorizationRaw=await readFile(resolve(root,baseline.existingAuthorization.file));
 const approvedRuntimeChanges=await Promise.all(['src/supervisor/permits.ts','dist/server/supervisor/permits.js'].map(async file=>({file,beforeSha256:baseline.oldRuntime.find(f=>f.file===file).sha256,afterSha256:sha256Bytes(await readFile(resolve(root,file)))})));
 const content={scope:V4_SCOPE,schemaVersion:4,createdAt:new Date().toISOString(),model,gatewayBaseURL:baseURL,workerPath:V4_WORKER_PATH,
  probe:{runId,input,inputHash:hashRunInput(input),researcherId,contractVersion:'protocol-probe-v4-staged',contract:PROTOCOL_PROBE_V4_CONTRACT,contractSha256:hashArtifact(PROTOCOL_PROBE_V4_CONTRACT),effectiveInstructionText:PROTOCOL_PROBE_V3_INSTRUCTION,effectiveInstructionSha256:sha(PROTOCOL_PROBE_V3_INSTRUCTION),userTask:{runId,companyId:input.companyId,challengeId:input.challengeId,researcherId},pool:research.pool,poolHash:research.pool.poolHash,evidenceSnapshotHash:hashEvidenceSnapshot(research.evidence),toolDefinitions},
  sourceFiles:snapshot.files,sourceIntegrity:baseline.officialSources.map(f=>({file:f.datasetRelative,bytes:f.bytes,expectedSha256:f.sha256,actualSha256:f.sha256,unchanged:true})),
  limits:{probeRequests:4,perContextRequests:2,totalRequests:4,requestTimeoutMs:40000,runTimeoutMs:180000,maxConcurrentModelRequests:2,maxActiveRuns:1,maxQueuedRuns:3,queueTimeoutMs:120000},automaticRetry:false,showcaseEligible:false,
  baseline:{file:baselineFile,sha256:sha256Bytes(baselineRaw),storeRoot:baseline.historicalStore.root},promptContract:{version:'task7x-effective-v4',probeInstruction:PROTOCOL_PROBE_V3_INSTRUCTION,probeInstructionSha256:sha(PROTOCOL_PROBE_V3_INSTRUCTION),genericDispatchText:V4_GENERIC_DISPATCH,genericDispatchSha256:sha(V4_GENERIC_DISPATCH),interfaceContract:{file:ifaceFile,text:iface.toString('utf8'),sha256:sha256Bytes(iface)}},
  productFingerprints:fingerprints,approvedRuntimeChanges,engineeringSourceCommit:sourceCommit,existingAuthorization:JSON.parse(authorizationRaw.toString('utf8')),authorizationFileSha256:sha256Bytes(authorizationRaw),resolutionFileSha256:baseline.existingResolution.sha256,engineeringGate:{file:gateFile,sha256:sha256Bytes(gateRaw)}};
 const plan=validateV4Plan({...content,hash:hashArtifact(content)}),folder=resolve(root,V4_FOLDER);await mkdir(folder);const bytes=Buffer.from(JSON.stringify(plan,null,2)+'\n'),h=await open(join(folder,'freeze.json'),'wx');try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
 console.log(JSON.stringify({scope:plan.scope,runId,freezeHash:plan.hash,rawFreezeFileSha256:sha256Bytes(bytes),fingerprints:fingerprints.length,sourceCommit,maxGrantedRequests:4,L05Authorized:false,providerRequests:0,attemptCreated:false}));return plan;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)prepareTask7xValidation().catch(()=>{console.error('V4_PREPARATION_STOPPED_NO_EXECUTION');process.exitCode=1;});
