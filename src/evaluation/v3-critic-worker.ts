/** Unique Task7v adversarial L05. This is ordinary business orchestration,
 * never diagnostic instructions, expected labels or a new matrix entry. */
import {readFile} from 'node:fs/promises';import {resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {DeveloperMessageItem,UserMessageItem,type ModelContext,type InferenceRunner} from '@mozaik-ai/core';
import {canonicalizeArtifact} from '../contracts/canonical.js';import {sha256Bytes,hashArtifact,hashEvidenceSnapshot} from '../evidence/hashing.js';
import {loadSnapshot} from '../data/snapshot.js';import {startWorker} from '../runtime/worker-entry.js';
import type {ExecuteOptions} from '../runtime/orchestrator.js';import {createGatewayRunner,type TaskIdentity} from '../model/gateway-runner.js';
import {ToolBatchError} from '../model/tool-batch.js';
import {buildCriticCase} from './critic-cases.js';import {projectCriticNative} from './critic-worker.js';
import {createV3EvidenceWriter} from './v3-worker-evidence.js';import {validateV3Plan} from './v3-bounded-validation.js';
import type {V3WorkerContext,V3OfflineWorkerOptions} from './protocol-probe-worker-v3.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),folder=resolve(root,'docs/implementation/task-7v-live');
const same=(a:unknown,b:unknown)=>canonicalizeArtifact(a)===canonicalizeArtifact(b);
const sha=(text:string)=>sha256Bytes(Buffer.from(text,'utf8'));
function ensure(v:unknown,c:string):asserts v{if(!v)throw Error(c);}
export function validateV3CriticSample(value:unknown,start:{runId:string;runInput:unknown},sample:ReturnType<typeof buildCriticCase>){
  const freeze=validateV3Plan(value);
  ensure(freeze.l05.variantId==='L05'&&freeze.l05.runId===start.runId&&sample.input.runId===start.runId&&sample.input.mode==='adversarial'
    &&same(freeze.l05.input,start.runInput)&&same(freeze.l05.input,sample.input)&&same(freeze.l05.manifest,sample.manifest)
    &&same(freeze.l05.controlledSeed,sample.proposerBody)&&freeze.l05.controlledSeedHash===hashArtifact(sample.proposerBody)
    &&same(freeze.l05.pool,sample.research.pool)&&freeze.l05.poolHash===sample.research.pool.poolHash
    &&freeze.l05.evidenceSnapshotHash===hashEvidenceSnapshot(sample.research.evidence),'V3_CRITIC_SAMPLE_BINDING');
  return freeze;
}
export async function configureV3Critic(context:V3WorkerContext,value:unknown,offline?:V3OfflineWorkerOptions):Promise<ExecuteOptions>{
  const {start,signal}=context,snapshot=await loadSnapshot(start.snapshotPath,start.runInput.datasetCommit),sample=buildCriticCase(snapshot,'L05',start.runId);
  const freeze=validateV3CriticSample(value,start,sample);
  ensure(same(snapshot.files,freeze.sourceFiles),'V3_CRITIC_SOURCE_BINDING');
  ensure(start.limits.maxModelRequests===16&&start.limits.maxConcurrentModelRequests===2&&start.limits.requestTimeoutMs===40000&&start.limits.runTimeoutMs===180000,'V3_CRITIC_LIMITS');
  const gateway=offline?.gateway??{apiKey:process.env.EINSTEIN_GATEWAY_API_KEY??'',model:process.env.EINSTEIN_GATEWAY_MODEL??'',baseURL:process.env.EINSTEIN_GATEWAY_BASE_URL??''};
  ensure(gateway.apiKey&&gateway.model===freeze.model&&gateway.baseURL===freeze.gatewayBaseURL,'V3_CRITIC_CONFIGURATION');
  ensure(!offline||offline.runnerMode==='offline_fixture','V3_CRITIC_OFFLINE_OVERRIDE');
  const writer=offline?.writer??await createV3EvidenceWriter({folder:join(folder,'runs',start.runId),credential:gateway.apiKey,nativeLineBytes:1024*1024});
  writer.record({kind:'header',schemaVersion:3,scope:freeze.scope,runnerMode:offline?'offline_fixture':'live',controlledAdversarial:true,
    showcaseEligible:false,runId:start.runId,variantId:'L05',freezeHash:freeze.hash,sourceManifest:sample.manifest,attackDiff:sample.attackDiff,
    caseFixtureDraft:sample.draft,input:start.runInput,sourceFiles:snapshot.files});
  function taskFact(modelContext:ModelContext,actor:TaskIdentity){
    const items=modelContext.getItems(),user=items.find((item):item is UserMessageItem=>item instanceof UserMessageItem),
      developers=items.filter((item):item is DeveloperMessageItem=>item instanceof DeveloperMessageItem);
    const initialKey=actor.attempt===1&&actor.role!=='critic'?(actor.role==='proposer'?'proposer':'counter'):null;
    const expectedTask=initialKey?freeze.promptContract.initialBusinessTasks[initialKey]:null,
      expectedTaskHash=initialKey?freeze.promptContract.initialBusinessTaskHashes[initialKey]:null;
    let canonicalTask:string|null=null;
    if(user)try{canonicalTask=canonicalizeArtifact(JSON.parse(user.content.text));}catch{/* No untrusted text or exception is recorded. */}
    const actualTaskHash=canonicalTask===null?null:sha(canonicalTask);
    const actualInstructionHash=developers.length===1?sha(developers[0]!.content.text):null;
    const instructionKey=actor.role==='critic'?'effectiveCritic':actor.role==='counter-evidence'?'effectiveCounter'
      :actor.attempt===1?'effectiveControlledProposer':'effectiveProposer';
    const expectedInstructionHash=freeze.promptHashes[instructionKey]??null;
    return{kind:'context.user_task',actor:{...actor},contextId:modelContext.id,
      taskKind:initialKey?'frozen_initial_business_task':actor.role==='critic'?'dynamic_review_task':'dynamic_targeted_revision',
      rawUserTaskSha256:user?sha(user.content.text):null,canonicalTaskSha256:actualTaskHash,expectedTaskHash,
      matchesFrozen:initialKey?canonicalTask!==null&&actualTaskHash===expectedTaskHash&&canonicalTask===canonicalizeArtifact(expectedTask):null,
      actualInstructionHash,expectedInstructionHash,instructionMatches:actualInstructionHash!==null&&actualInstructionHash===expectedInstructionHash};
  }
  return{runnerMode:offline?'offline_fixture':'live',signal,research:sample.research,controlledSeed:{proposerBody:sample.proposerBody},
    answerDiagnostics:{credential:gateway.apiKey,maxCaptureBytes:262144,write:writer.writeDiagnostic},gateway,
    runnerFactory:hooks=>{
      const actual=createGatewayRunner({...gateway,...hooks,requestTimeoutMs:start.limits.requestTimeoutMs,...(offline?{fetchImpl:offline.fetchImpl}:{})},context.permitClient,hooks.trace);
      const controlled:InferenceRunner={run(request){
        const actor=hooks.resolveTask(request.context.id),fact=taskFact(request.context,actor);
        // Actual execution control is before the parent permit and fetch. The
        // native callback records facts but never grants or denies this call.
        if(!fact.instructionMatches)throw new ToolBatchError('V3_CRITIC_EFFECTIVE_PROMPT_HASH');
        if(fact.matchesFrozen===false)throw new ToolBatchError('V3_CRITIC_INITIAL_TASK_BINDING');
        if(fact.canonicalTaskSha256===null)throw new ToolBatchError('V3_CRITIC_DYNAMIC_TASK_INVALID');
        return actual.run(request);
      },async *stream(){throw Error('STREAMING_UNSUPPORTED');}};
      return controlled;
    },
    onNative:(event,actor)=>{const row=projectCriticNative(event,actor,freeze.promptHashes);writer.record(row);
      if(event.type==='inference.started')writer.record(taskFact((event.payload as {context:ModelContext}).context,actor));},
    onTrace:trace=>writer.record({kind:'request',trace}),onToolBatch:manifest=>writer.record({kind:'tool.batch',manifest}),
    onArtifact:artifact=>writer.record({kind:'artifact',artifact}),
    onReviewDispatch:review=>writer.record({kind:'review.dispatch',actor:review.actor,expectation:review.expectation,snapshot:review.snapshot}),
    onReviewResult:review=>writer.record({kind:'review.result',...review})};
}
function arg(name:string){const n=process.argv.indexOf(name);ensure(n>=0&&process.argv[n+1],'V3_CRITIC_ARGUMENT');return process.argv[n+1]!;}
export function startV3CriticWorker(){startWorker({configure:async context=>{
  const path=resolve(arg('--validation-freeze'));ensure(path===join(folder,'freeze.json'),'V3_CRITIC_FREEZE_PATH');
  const bytes=await readFile(path);ensure(sha256Bytes(bytes)===arg('--validation-freeze-hash'),'V3_CRITIC_FREEZE_FILE_HASH');
  let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('V3_CRITIC_FREEZE_JSON');}
  return configureV3Critic(context,value);
}});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startV3CriticWorker();
