/** Task7v only. Importing never starts a worker, writes evidence or calls fetch. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFile} from 'node:fs/promises';import {resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
import type {InferenceRunner} from '@mozaik-ai/core';
import type {ParentToWorkerMessage} from '../contracts/ipc.js';
import {canonicalizeArtifact} from '../contracts/canonical.js';
import {sha256Bytes,hashEvidenceSnapshot} from '../evidence/hashing.js';
import {loadSnapshot} from '../data/snapshot.js';import {buildIndex,retrieveWithTrace} from '../retrieval/index.js';
import {startWorker} from '../runtime/worker-entry.js';import type {ExecuteOptions} from '../runtime/orchestrator.js';
import type {GatewayConfig,PermitClient,TaskIdentity} from '../model/gateway-runner.js';
import {createProtocolProbeV3Execution} from './protocol-probe-v3.js';
import {PROTOCOL_PROBE_V3_INSTRUCTION} from './probe-contract-guard.js';
import {createV3EvidenceWriter,type V3EvidenceWriter} from './v3-worker-evidence.js';
import {validateV3Plan} from './v3-bounded-validation.js';

export type V3WorkerContext={start:Extract<ParentToWorkerMessage,{kind:'start'}>;signal:AbortSignal;permitClient:PermitClient};
/** Trusted test-only injection. Never accepted from RunInput, IPC or source. */
export type V3OfflineWorkerOptions={runnerMode:'offline_fixture';gateway:Pick<GatewayConfig,'baseURL'|'apiKey'|'model'>;
  fetchImpl:typeof fetch;writer:V3EvidenceWriter};
const root=fileURLToPath(new URL('../../../',import.meta.url)),folder=resolve(root,'docs/implementation/task-7v-live');
const same=(a:unknown,b:unknown)=>canonicalizeArtifact(a)===canonicalizeArtifact(b),sha=(text:string)=>sha256Bytes(Buffer.from(text,'utf8'));
function ensure(v:unknown,c:string):asserts v{if(!v)throw Error(c);}
const actorKey=(actor:TaskIdentity)=>canonicalizeArtifact(actor);

export async function configureV3Probe(context:V3WorkerContext,value:unknown,offline?:V3OfflineWorkerOptions):Promise<ExecuteOptions>{
  const freeze=validateV3Plan(value),{start,signal,permitClient}=context;
  ensure(start.runId===freeze.probe.runId&&same(start.runInput,freeze.probe.input),'V3_PROBE_RUN_BINDING');
  ensure(start.limits.maxModelRequests===4&&start.limits.maxConcurrentModelRequests===2&&start.limits.requestTimeoutMs===40000&&start.limits.runTimeoutMs===180000,'V3_PROBE_LIMITS');
  const gateway=offline?.gateway??{apiKey:process.env.EINSTEIN_GATEWAY_API_KEY??'',model:process.env.EINSTEIN_GATEWAY_MODEL??'',baseURL:process.env.EINSTEIN_GATEWAY_BASE_URL??''};
  ensure(gateway.apiKey&&gateway.model===freeze.model&&gateway.baseURL===freeze.gatewayBaseURL,'V3_PROBE_CONFIGURATION');
  ensure(!offline||offline.runnerMode==='offline_fixture','V3_PROBE_OFFLINE_OVERRIDE');
  const snapshot=await loadSnapshot(start.snapshotPath,start.runInput.datasetCommit),research={snapshot,...retrieveWithTrace(start.runInput,buildIndex(snapshot))};
  ensure(same(snapshot.files,freeze.sourceFiles)&&research.pool.candidates[0]?.researcherId===freeze.probe.researcherId
    &&same(research.pool,freeze.probe.pool)&&research.pool.poolHash===freeze.probe.poolHash
    &&hashEvidenceSnapshot(research.evidence)===freeze.probe.evidenceSnapshotHash,'V3_PROBE_SOURCE_POOL_BINDING');
  const writer=offline?.writer??await createV3EvidenceWriter({folder:join(folder,'runs',start.runId),credential:gateway.apiKey,nativeTotalBytes:2*1024*1024});
  const mode=offline?'offline_fixture':'live';
  writer.record({kind:'header',schemaVersion:3,runnerMode:mode,scope:freeze.scope,runId:start.runId,freezeHash:freeze.hash,
    contractVersion:'protocol-probe-v3',contractSha256:freeze.probe.contractSha256,input:start.runInput,
    expected:{companyId:start.runInput.companyId,challengeId:start.runInput.challengeId,researcherId:freeze.probe.researcherId},
    poolHash:research.pool.poolHash,evidenceSnapshotHash:freeze.probe.evidenceSnapshotHash,sourceFiles:snapshot.files,publication:'forbidden'});
  const scope=new AsyncLocalStorage<TaskIdentity>(),requests=new Map<string,Record<string,any>>();
  const record=(row:Record<string,unknown>)=>{writer.record(row);if(row.kind==='wire.request'){
    const actor=row.actor as TaskIdentity;ensure(actor?.runId===start.runId,'V3_PROBE_WIRE_ACTOR');requests.set(actorKey(actor),row);
  }};
  const originalFetch=globalThis.fetch,actualFetch=offline?.fetchImpl??originalFetch;
  const observedFetch:typeof fetch=async(url,init)=>{
    const actor=scope.getStore(),request=actor?requests.get(actorKey(actor)):undefined;
    ensure(actor&&request&&typeof init?.body==='string'&&sha(init.body)===request.bodySha256,'V3_PROBE_WIRE_UNBOUND');
    let body:Record<string,any>;try{body=JSON.parse(init.body);}catch{throw Error('V3_PROBE_WIRE_INVALID');}
    ensure(Array.isArray(body.messages),'V3_PROBE_WIRE_INVALID');
    const systems=body.messages.filter((m:any)=>m?.role==='system'),users=body.messages.filter((m:any)=>m?.role==='user');
    const tasks=users.flatMap((m:any)=>{try{const task=JSON.parse(m.content);return same(task,freeze.probe.userTask)?[{raw:m.content,task}]:[];}catch{return[];}});
    ensure(systems.length===1&&systems[0].content===PROTOCOL_PROBE_V3_INSTRUCTION&&tasks.length===1,'V3_PROBE_EFFECTIVE_PROMPT_INVALID');
    const others=users.filter((m:any)=>m.content!==tasks[0]!.raw);
    ensure(users.length===2&&others.length===1&&others[0].content===freeze.promptContract.genericDispatchText,'V3_PROBE_USER_MESSAGE_INVALID');
    record({kind:'wire.effective_prompt',actor:{...actor},requestId:request.requestId,permitId:request.permitId,bodySha256:sha(init.body),
      systemMessageCount:systems.length,systemInstructionSha256:sha(systems[0].content),userMessageCount:users.length,userTaskCount:tasks.length,
      userTask:tasks[0]!.task,userTaskText:tasks[0]!.raw,userTaskSha256:sha(tasks[0]!.raw),otherUserMessageHashes:others.map((m:any)=>sha(m.content))});
    return actualFetch(url,init);
  };
  // The existing factory permits explicit fixture transport only. A transparent
  // live worker wrapper observes bytes without changing that accepted contract.
  if(!offline){globalThis.fetch=observedFetch;signal.addEventListener('abort',()=>{if(globalThis.fetch===observedFetch)globalThis.fetch=originalFetch;},{once:true});}
  const base=createProtocolProbeV3Execution({input:start.runInput,research,gateway,permitClient,record,writeDiagnostic:writer.writeDiagnostic,
    signal,runnerMode:mode,...(offline?{fetchImpl:observedFetch}:{})});
  return{...base,runnerFactory:hooks=>{
    const runner=base.runnerFactory!(hooks),bound:InferenceRunner={run(request){const actor=hooks.resolveTask(request.context.id);return scope.run(actor,()=>runner.run(request));},
      async *stream(){throw Error('PROTOCOL_PROBE_STREAMING_UNSUPPORTED');}};return bound;
  }};
}

function arg(name:string){const n=process.argv.indexOf(name);ensure(n>=0&&process.argv[n+1],'V3_PROBE_ARGUMENT');return process.argv[n+1]!;}
export function startProtocolProbeV3Worker(){startWorker({configure:async context=>{
  const path=resolve(arg('--validation-freeze'));ensure(path===join(folder,'freeze.json'),'V3_PROBE_FREEZE_PATH');
  const bytes=await readFile(path);ensure(sha256Bytes(bytes)===arg('--validation-freeze-hash'),'V3_PROBE_FREEZE_FILE_HASH');
  let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('V3_PROBE_FREEZE_JSON');}
  return configureV3Probe(context,value);
}});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startProtocolProbeV3Worker();
