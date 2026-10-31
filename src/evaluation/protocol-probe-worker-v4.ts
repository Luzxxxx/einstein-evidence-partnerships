/** V4 protocol-only worker. Importing starts no process, model, Store or
 * recovery action. The CLI accepts only the new fixed freeze and exact bytes. */
import {readFile} from 'node:fs/promises';
import {resolve,join,relative as relativePath} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ParentToWorkerMessage} from '../contracts/ipc.js';
import {canonicalizeArtifact} from '../contracts/canonical.js';
import {HashSchema} from '../contracts/primitives.js';
import {sha256Bytes,hashEvidenceSnapshot} from '../evidence/hashing.js';
import {loadSnapshot} from '../data/snapshot.js';
import {buildIndex,retrieveWithTrace} from '../retrieval/index.js';
import {createResearchTools} from '../runtime/tools.js';
import {startWorker} from '../runtime/worker-entry.js';
import type {ExecuteOptions} from '../runtime/orchestrator.js';
import type {GatewayConfig,PermitClient} from '../model/gateway-runner.js';
import {createProtocolProbeV4Execution,protocolProbeV4ToolDefinitions} from './protocol-probe-v4.js';
import {createV4EvidenceWriter,type V4EvidenceWriter} from './v4-worker-evidence.js';
import {validateV4Plan,verifyV4CurrentFiles,V4_FOLDER,TASK7Y_ROOT,v4CandidateFolder,validatePreparedV4Location} from './protocol-probe-v4-plan.js';

export type V4WorkerContext={start:Extract<ParentToWorkerMessage,{kind:'start'}>;signal:AbortSignal;permitClient:PermitClient};
/** Trusted fixture-only injection. Never accepted from RunInput, source or IPC. */
export type V4OfflineWorkerOptions={runnerMode:'offline_fixture';gateway:Pick<GatewayConfig,'baseURL'|'apiKey'|'model'>;fetchImpl:typeof fetch;writer:V4EvidenceWriter};
const root=fileURLToPath(new URL('../../../',import.meta.url)),folder=resolve(root,V4_FOLDER);
const same=(a:unknown,b:unknown)=>canonicalizeArtifact(a)===canonicalizeArtifact(b);
function ensure(value:unknown,code:string):asserts value{if(!value)throw Error(code);}

export async function configureV4Probe(context:V4WorkerContext,value:unknown,offline:V4OfflineWorkerOptions|undefined,rawFreezeFileSha256:string):Promise<ExecuteOptions>{
 const freeze=validateV4Plan(value),{start,signal,permitClient}=context;
 ensure(HashSchema.safeParse(rawFreezeFileSha256).success,'V4_PROBE_RAW_FREEZE_HASH_REQUIRED');
 ensure(start.runId===freeze.probe.runId&&same(start.runInput,freeze.probe.input),'V4_PROBE_RUN_BINDING');
 ensure(start.limits.maxModelRequests===4&&start.limits.maxConcurrentModelRequests===2&&start.limits.requestTimeoutMs===40000&&start.limits.runTimeoutMs===180000
  &&start.limits.maxActiveRuns===1&&start.limits.maxQueuedRuns===3&&start.limits.queueTimeoutMs===120000,'V4_PROBE_LIMITS');
 ensure(!offline||offline.runnerMode==='offline_fixture'&&typeof offline.fetchImpl==='function'&&typeof offline.writer?.record==='function'&&typeof offline.writer.writeDiagnostic==='function','V4_PROBE_OFFLINE_OVERRIDE');
 const gateway=offline?.gateway??{apiKey:process.env.EINSTEIN_GATEWAY_API_KEY??'',model:process.env.EINSTEIN_GATEWAY_MODEL??'',baseURL:process.env.EINSTEIN_GATEWAY_BASE_URL??''};
 ensure(gateway.apiKey&&gateway.model===freeze.model&&gateway.baseURL===freeze.gatewayBaseURL,'V4_PROBE_CONFIGURATION');
 signal.throwIfAborted();await verifyV4CurrentFiles(freeze);signal.throwIfAborted();
 const snapshot=await loadSnapshot(start.snapshotPath,start.runInput.datasetCommit),research={snapshot,...retrieveWithTrace(start.runInput,buildIndex(snapshot))};signal.throwIfAborted();
 ensure(same(snapshot.files,freeze.sourceFiles)&&same(research.pool,freeze.probe.pool)&&research.pool.poolHash===freeze.probe.poolHash
  &&research.pool.candidates[0]?.researcherId===freeze.probe.researcherId&&hashEvidenceSnapshot(research.evidence)===freeze.probe.evidenceSnapshotHash,'V4_PROBE_SOURCE_POOL_BINDING');
 const definitions=protocolProbeV4ToolDefinitions(createResearchTools({...research,input:start.runInput,signal}));
 ensure(same(definitions,freeze.probe.toolDefinitions),'V4_PROBE_TOOL_DEFINITION_BINDING');
 const writer=offline?.writer??await createV4EvidenceWriter({folder:resolve(root,v4CandidateFolder(freeze),'runs',start.runId),credential:gateway.apiKey}),mode=offline?'offline_fixture':'live';
 writer.record({kind:'header',schemaVersion:4,runnerMode:mode,scope:freeze.scope,runId:start.runId,freezeHash:freeze.hash,rawFreezeFileSha256,
  contractVersion:freeze.probe.contractVersion,contractSha256:freeze.probe.contractSha256,input:start.runInput,
  expected:{companyId:start.runInput.companyId,challengeId:start.runInput.challengeId,researcherId:freeze.probe.researcherId},poolHash:research.pool.poolHash,
  evidenceSnapshotHash:freeze.probe.evidenceSnapshotHash,sourceFiles:snapshot.files,publication:'forbidden'});
 const common={input:start.runInput,research,gateway,permitClient,record:writer.record,writeDiagnostic:writer.writeDiagnostic,signal};
 return offline?createProtocolProbeV4Execution({...common,runnerMode:'offline_fixture',fetchImpl:offline.fetchImpl}):createProtocolProbeV4Execution({...common,runnerMode:'live'});
}
function arg(name:string){const index=process.argv.indexOf(name);ensure(index>=0&&process.argv[index+1],'V4_PROBE_ARGUMENT');return process.argv[index+1]!;}
export function startProtocolProbeV4Worker(){startWorker({configure:async context=>{
 const path=resolve(arg('--validation-freeze')),relative=relativePath(root,path).replaceAll('\\','/');
 ensure(path===join(folder,'freeze.json')
  ||new RegExp('^'+TASK7Y_ROOT+'/candidates/[a-f0-9-]{36}/freeze\\.json$').test(relative),'V4_PROBE_FREEZE_PATH');
 const expected=arg('--validation-freeze-hash');ensure(HashSchema.safeParse(expected).success,'V4_PROBE_FREEZE_FILE_HASH');
 const bytes=await readFile(path),actual=sha256Bytes(bytes);ensure(actual===expected,'V4_PROBE_FREEZE_FILE_HASH');
 let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('V4_PROBE_FREEZE_JSON');}
 const freeze=validateV4Plan(value);validatePreparedV4Location(freeze,path);
 return configureV4Probe(context,freeze,undefined,actual);
}});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startProtocolProbeV4Worker();
