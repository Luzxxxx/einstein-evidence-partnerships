/** User-authorized Task7 completion runs. Real SDK, original tools and parent permits. */
import {readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startWorker} from '../runtime/worker-entry.js';
import {loadSnapshot} from '../data/snapshot.js';
import {buildIndex,retrieveWithTrace} from '../retrieval/index.js';
import {canonicalizeArtifact} from '../contracts/canonical.js';
import {hashArtifact,hashEvidenceSnapshot,sha256Bytes} from '../evidence/hashing.js';
import {RunInputSchema} from '../contracts/domain.js';
import {createResearchTools} from '../runtime/tools.js';
import {createProtocolProbeV4Execution,protocolProbeV4ToolDefinitions,PROTOCOL_PROBE_V4_CONTRACT} from './protocol-probe-v4.js';
import {createV4EvidenceWriter} from './v4-worker-evidence.js';
import {createV3EvidenceWriter} from './v3-worker-evidence.js';
import {buildCriticCase,CRITIC_VARIANTS} from './critic-cases.js';
import {projectCriticNative} from './critic-worker.js';
import type {SemanticEvent} from '@mozaik-ai/core';
import type {TaskIdentity} from '../model/gateway-runner.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const same=(a:unknown,b:unknown)=>canonicalizeArtifact(a)===canonicalizeArtifact(b);
function need(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
function arg(name:string){const i=process.argv.indexOf(name);need(i>0&&process.argv[i+1],'COMPLETION_ARGUMENT');return process.argv[i+1]!;}
export function completionNativeRecorder(promptHashes:Record<string,string>,record:(value:Record<string,unknown>)=>void){
 return(event:SemanticEvent,actor:TaskIdentity)=>{
  const projection=projectCriticNative(event,actor,promptHashes);record(projection);
  if(event.type==='inference.started')need(projection.instructionMatches===true,'CRITIC_PROMPT_FREEZE_MISMATCH');
 };
}
export function startCompletionWorker(){startWorker({configure:async({start,signal,permitClient})=>{
 const file=resolve(arg('--validation-freeze')),raw=await readFile(file),rawHash=sha256Bytes(raw);
 need(rawHash===arg('--validation-freeze-hash'),'COMPLETION_FREEZE_HASH');
 const freeze=JSON.parse(raw.toString('utf8')),input=RunInputSchema.parse(freeze.input);
 need(freeze.scope==='task7-completion-v1'&&freeze.hash===hashArtifact(freeze)&&freeze.runnerMode==='live','COMPLETION_FREEZE');
 need(input.runId===start.runId&&same(input,start.runInput)&&file===join(root,'docs/implementation/task-7-completion-live/runs',input.runId,'freeze.json'),'COMPLETION_RUN_BINDING');
 need(same(start.limits,freeze.limits)&&start.limits.maxModelRequests===(freeze.kind==='probe'?4:16)
  &&start.limits.maxConcurrentModelRequests===2&&start.limits.runTimeoutMs===180000&&start.limits.requestTimeoutMs===40000,'COMPLETION_LIMITS');
 for(const f of freeze.productFingerprints){need(typeof f.file==='string'&&!f.file.includes('..')&&!f.file.includes(':')&&!f.file.startsWith('/'),'COMPLETION_FINGERPRINT_PATH');
  need(sha256Bytes(await readFile(resolve(root,f.file)))===f.sha256,'COMPLETION_PRODUCT_CHANGED');}
 const gateway={apiKey:process.env.EINSTEIN_GATEWAY_API_KEY??'',baseURL:process.env.EINSTEIN_GATEWAY_BASE_URL??'',model:process.env.EINSTEIN_GATEWAY_MODEL??''};
 need(gateway.apiKey&&gateway.model===freeze.model&&gateway.baseURL===freeze.gatewayBaseURL,'COMPLETION_CONFIGURATION');
 const snapshot=await loadSnapshot(start.snapshotPath,input.datasetCommit);need(same(snapshot.files,freeze.sourceFiles),'COMPLETION_SOURCES_CHANGED');
 const folder=dirname(file);
 if(freeze.kind==='probe'){
  const research={snapshot,...retrieveWithTrace(input,buildIndex(snapshot))};
  need(same(research.pool,freeze.pool)&&hashEvidenceSnapshot(research.evidence)===freeze.evidenceSnapshotHash,'COMPLETION_POOL_CHANGED');
  const defs=protocolProbeV4ToolDefinitions(createResearchTools({...research,input,signal}));
  need(same(defs,freeze.toolDefinitions)&&hashArtifact(PROTOCOL_PROBE_V4_CONTRACT)===freeze.contractSha256,'COMPLETION_PROTOCOL_CHANGED');
  const writer=await createV4EvidenceWriter({folder,credential:gateway.apiKey});
  writer.record({kind:'header',schemaVersion:4,runnerMode:'live',scope:'task7x_v4_protocol_only',completionAuthorization:freeze.authorization,
   runId:input.runId,freezeHash:freeze.hash,rawFreezeFileSha256:rawHash,contractVersion:PROTOCOL_PROBE_V4_CONTRACT.version,
   contractSha256:freeze.contractSha256,input,expected:{companyId:input.companyId,challengeId:input.challengeId,researcherId:freeze.researcherId},
   poolHash:research.pool.poolHash,evidenceSnapshotHash:freeze.evidenceSnapshotHash,sourceFiles:snapshot.files,publication:'forbidden',toolDefinitions:defs});
  return createProtocolProbeV4Execution({input,research,gateway,runnerMode:'live',signal,permitClient,record:writer.record,writeDiagnostic:writer.writeDiagnostic});
 }
 need(freeze.kind==='critic'&&CRITIC_VARIANTS.some(v=>v.layer!=='D'&&v.variantId===freeze.variantId),'COMPLETION_CASE');
 const sample=buildCriticCase(snapshot,freeze.variantId,input.runId);
 need(same(sample.input,input)&&same(sample.manifest,freeze.caseManifest)&&same(sample.proposerBody,freeze.proposerBody)
  &&same(sample.research.pool,freeze.pool)&&hashEvidenceSnapshot(sample.research.evidence)===freeze.evidenceSnapshotHash,'COMPLETION_CASE_CHANGED');
 const writer=await createV3EvidenceWriter({folder,credential:gateway.apiKey,nativeLineBytes:1024*1024});
 writer.record({kind:'header',schemaVersion:1,scope:freeze.scope,runnerMode:'live',runId:input.runId,variantId:freeze.variantId,
  controlledAdversarial:true,showcaseEligible:false,freezeHash:freeze.hash,rawFreezeFileSha256:rawHash,input,sourceFiles:snapshot.files,sourceManifest:sample.manifest,attackDiff:sample.attackDiff});
 return{runnerMode:'live',signal,gateway,research:sample.research,controlledSeed:{proposerBody:sample.proposerBody},
  answerDiagnostics:{credential:gateway.apiKey,maxCaptureBytes:262144,write:writer.writeDiagnostic},
  onNative:completionNativeRecorder(freeze.promptHashes,writer.record),
  onTrace:trace=>writer.record({kind:'request',trace}),onToolBatch:manifest=>writer.record({kind:'tool.batch',manifest}),
  onArtifact:artifact=>writer.record({kind:'artifact',artifact}),
  onReviewDispatch:review=>writer.record({kind:'review.dispatch',...review}),
  onReviewResult:review=>writer.record({kind:'review.result',...review})};
}});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startCompletionWorker();
