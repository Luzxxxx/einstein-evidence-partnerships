/** New version only. No historical probe is rerun or reinterpreted here. */
import {readFileSync,writeFileSync,appendFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {appendFile,open} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {canonicalizeArtifact} from '../contracts/canonical.js';
import {sha256Bytes,hashArtifact} from '../evidence/hashing.js';
import {loadSnapshot} from '../data/snapshot.js';
import {buildIndex,retrieveWithTrace} from '../retrieval/index.js';
import {startWorker} from '../runtime/worker-entry.js';
import {AnswerDiagnosticError,type AnswerDiagnostic} from '../runtime/answer-diagnostics.js';
import {PROTOCOL_PROBE_V2_POLICY,PROTOCOL_PROBE_V2_CONTRACT,protocolProbeV2PromptHashes,protocolProbeV2PromptTexts,
 createProtocolProbeV2Runner,createProtocolProbeV2Observer} from './protocol-probe-v2.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
function ensure(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
function arg(name:string){const i=process.argv.indexOf(name);ensure(i>=0&&process.argv[i+1],'PROTOCOL_PROBE_V2_ARGUMENT');return process.argv[i+1]!;}
export function startProtocolProbeV2Worker(){startWorker({configure:async({start,signal,permitClient})=>{
 const path=resolve(arg('--validation-freeze'));ensure(path===resolve(root,'docs/implementation/task-7t-live/freeze.json'),'PROTOCOL_PROBE_V2_FREEZE_PATH');
 const raw=readFileSync(path);ensure(sha256Bytes(raw)===arg('--validation-freeze-hash'),'PROTOCOL_PROBE_V2_FREEZE_FILE_HASH');
 const freeze=JSON.parse(raw.toString('utf8')),hashes=protocolProbeV2PromptHashes(),texts=protocolProbeV2PromptTexts();
 ensure(hashArtifact(freeze)===freeze.hash&&freeze.scope==='task7t_layered_protocol_then_single_L05','PROTOCOL_PROBE_V2_FREEZE');
 ensure(freeze.probe?.runId===start.runId&&canonicalizeArtifact(freeze.probe.input)===canonicalizeArtifact(start.runInput),'PROTOCOL_PROBE_V2_RUN_BINDING');
 ensure(freeze.probe.contractVersion==='protocol-probe-v2'&&freeze.probe.contractSha256===hashes.contract
  &&canonicalizeArtifact(freeze.probe.contract)===canonicalizeArtifact(PROTOCOL_PROBE_V2_CONTRACT),'PROTOCOL_PROBE_V2_CONTRACT_HASH');
 ensure(canonicalizeArtifact(freeze.probe.promptHashes)===canonicalizeArtifact(hashes)
  &&canonicalizeArtifact(freeze.probe.effectivePrompts)===canonicalizeArtifact(texts),'PROTOCOL_PROBE_V2_PROMPT_HASH');
 ensure(process.env.EINSTEIN_GATEWAY_BASE_URL===freeze.gatewayBaseURL&&process.env.EINSTEIN_GATEWAY_MODEL===freeze.model,'PROTOCOL_PROBE_V2_CONFIGURATION');
 const key=process.env.EINSTEIN_GATEWAY_API_KEY;ensure(key,'PROTOCOL_PROBE_V2_CREDENTIAL_REQUIRED');
 ensure(start.limits.maxModelRequests===4&&start.limits.maxConcurrentModelRequests===2&&start.limits.requestTimeoutMs===40000
  &&start.limits.runTimeoutMs===180000,'PROTOCOL_PROBE_V2_LIMITS');
 const snapshot=await loadSnapshot(start.snapshotPath,start.runInput.datasetCommit),research={snapshot,...retrieveWithTrace(start.runInput,buildIndex(snapshot))};
 ensure(research.pool.candidates.length>0&&research.pool.candidates[0].researcherId===freeze.probe.researcherId
  &&research.pool.poolHash===freeze.probe.poolHash,'PROTOCOL_PROBE_V2_POOL_BINDING');
 const folder=join(dirname(path),'runs',start.runId),evidence=join(folder,'worker-evidence.jsonl'),answers=join(folder,'answer-diagnostics.jsonl');
 let nativeBytes=0,diagnosticBytes=0,diagnosticFailed=false,tail=Promise.resolve();
 function line(value:object){const text=JSON.stringify({at:new Date().toISOString(),monotonicMs:performance.now(),...value})+'\n';
  if(text.includes(key!)||Buffer.byteLength(text)>262144)throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');return text;}
 function record(value:Record<string,unknown>,first=false){
  const text=line(value),size=Buffer.byteLength(text);if(nativeBytes+size>2*1024*1024)throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');
  try{if(first)writeFileSync(evidence,text,{flag:'wx'});else appendFileSync(evidence,text);
   const fd=openSync(evidence,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}nativeBytes+=size;
  }catch{throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');}
 }
 // Diagnostic IO is asynchronous and serialized separately from the short
 // native metadata stream. Engine cancellation races the ACK, not a blocked IO.
 writeFileSync(answers,'',{flag:'wx'});
 function writeDiagnostic(value:AnswerDiagnostic):Promise<void>{
  const operation=tail.then(async()=>{
   if(diagnosticFailed)throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');
   const text=line(value),size=Buffer.byteLength(text);if(diagnosticBytes+size>2*1024*1024)throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');
   try{await appendFile(answers,text);const h=await open(answers,'r+');try{await h.sync();}finally{await h.close();}diagnosticBytes+=size;}
   catch{throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');}
  });
  tail=operation.catch(()=>{diagnosticFailed=true;});return operation;
 }
 record({kind:'header',schemaVersion:2,runnerMode:'live',scope:freeze.scope,runId:start.runId,freezeHash:freeze.hash,
  contractVersion:'protocol-probe-v2',contractSha256:hashes.contract,input:start.runInput,
  expected:{companyId:start.runInput.companyId,challengeId:start.runInput.challengeId,researcherId:freeze.probe.researcherId},
  poolHash:research.pool.poolHash,sourceFiles:snapshot.files,publication:'forbidden'},true);
 const observer=createProtocolProbeV2Observer({apiKey:key,record,writeDiagnostic});
 return{runnerMode:'live',adapterProbe:true,adapterProbeInstruction:PROTOCOL_PROBE_V2_POLICY,answerDiagnostics:observer.answerDiagnostics,research,
  gateway:{baseURL:freeze.gatewayBaseURL,model:freeze.model,apiKey:key},
  runnerFactory:hooks=>createProtocolProbeV2Runner({gateway:{baseURL:freeze.gatewayBaseURL,model:freeze.model,apiKey:key},hooks,permitClient,
   requestTimeoutMs:start.limits.requestTimeoutMs,record,trace:trace=>{observer.trace(trace);hooks.trace?.(trace);}}),
  onToolBatch:manifest=>record({kind:'tool.batch',manifest}),
  onNative:(event,actor)=>{observer.native(event,actor);if(event.type==='inference.started'){
   const items=(event.payload as Record<string,any>).context.getItems(),developer=items.filter((i:any)=>i.role==='developer');
   const text=developer.length===1?developer[0].content?.text:null;
   ensure(typeof text==='string'&&sha256Bytes(Buffer.from(text,'utf8'))===(actor.role==='proposer'?hashes.effectiveProposer:hashes.effectiveCounter),'PROTOCOL_PROBE_V2_EFFECTIVE_PROMPT_HASH');
  }},
  onArtifact:()=>{throw Error('PROTOCOL_PROBE_V2_PUBLICATION_FORBIDDEN');},
 };
 }});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startProtocolProbeV2Worker();
