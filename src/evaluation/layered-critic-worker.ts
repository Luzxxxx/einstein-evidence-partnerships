/** Unique Task7t adversarial L05 bootstrap; never a matrix entry. */
import {readFileSync,writeFileSync,appendFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {appendFile,open} from 'node:fs/promises';import {resolve,join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {performance} from 'node:perf_hooks';
import {canonicalizeArtifact} from '../contracts/canonical.js';import {hashArtifact,sha256Bytes} from '../evidence/hashing.js';import {loadSnapshot} from '../data/snapshot.js';
import {startWorker} from '../runtime/worker-entry.js';import {buildCriticCase} from './critic-cases.js';import {projectCriticNative} from './critic-worker.js';
import {AnswerDiagnosticError,type AnswerDiagnostic} from '../runtime/answer-diagnostics.js';
import type {TaskIdentity} from '../model/gateway-runner.js';import type {SemanticEvent} from '@mozaik-ai/core';
const root=fileURLToPath(new URL('../../../',import.meta.url)),same=(a:unknown,b:unknown)=>canonicalizeArtifact(a)===canonicalizeArtifact(b);
function ensure(v:unknown,c:string):asserts v{if(!v)throw Error(c);}
export function validateLayeredCriticSample(freeze:any,start:{runId:string;runInput:unknown},sample:ReturnType<typeof buildCriticCase>){
 ensure(hashArtifact(freeze)===freeze.hash&&freeze.scope==='task7t_layered_protocol_then_single_L05'&&freeze.showcaseEligible===false&&freeze.automaticRetry===false,'LAYERED_CRITIC_FREEZE');
 ensure(freeze.l05?.variantId==='L05'&&freeze.l05.runId===start.runId&&sample.input.runId===start.runId&&sample.input.mode==='adversarial'
  &&same(freeze.l05.input,start.runInput)&&same(freeze.l05.input,sample.input)&&same(freeze.l05.manifest,sample.manifest),'LAYERED_CRITIC_SAMPLE');}
function arg(name:string){const n=process.argv.indexOf(name);ensure(n>=0&&process.argv[n+1],'LAYERED_CRITIC_ARGUMENT');return process.argv[n+1]!;}
export function startLayeredCriticWorker(){startWorker({configure:async({start,signal})=>{
 const freezeFile=resolve(arg('--validation-freeze'));ensure(freezeFile===resolve(root,'docs/implementation/task-7t-live/freeze.json'),'LAYERED_CRITIC_PATH');
 const bytes=readFileSync(freezeFile);ensure(sha256Bytes(bytes)===arg('--validation-freeze-hash'),'LAYERED_CRITIC_FREEZE_HASH');const freeze=JSON.parse(bytes.toString('utf8'));
 const snapshot=await loadSnapshot(start.snapshotPath,start.runInput.datasetCommit),sample=buildCriticCase(snapshot,'L05',start.runId);validateLayeredCriticSample(freeze,start,sample);
 ensure(start.limits.maxModelRequests===16&&start.limits.maxConcurrentModelRequests===2&&start.limits.requestTimeoutMs===40000&&start.limits.runTimeoutMs===180000,'LAYERED_CRITIC_LIMITS');
 const key=process.env.EINSTEIN_GATEWAY_API_KEY;ensure(key&&process.env.EINSTEIN_GATEWAY_MODEL===freeze.model&&process.env.EINSTEIN_GATEWAY_BASE_URL===freeze.gatewayBaseURL,'LAYERED_CRITIC_CONFIGURATION');
 const folder=join(dirname(freezeFile),'runs',start.runId),path=join(folder,'worker-evidence.jsonl'),diagnosticPath=join(folder,'answer-diagnostics.jsonl');
 writeFileSync(path,JSON.stringify({kind:'header',scope:freeze.scope,runnerMode:'live',controlledAdversarial:true,showcaseEligible:false,runId:start.runId,variantId:'L05',freezeHash:freeze.hash,
  sourceManifest:sample.manifest,attackDiff:sample.attackDiff,caseFixtureDraft:sample.draft,input:start.runInput})+'\n',{flag:'wx'});writeFileSync(diagnosticPath,'',{flag:'wx'});
 let total=0,diagnosticTotal=0,tail=Promise.resolve();
 function serialize(value:object){const text=JSON.stringify({at:new Date().toISOString(),monotonicMs:performance.now(),...value})+'\n';
  if(text.includes(key!))throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');
  return text;}
 function record(value:object){try{const text=serialize(value);ensure(Buffer.byteLength(text)<=1024*1024&&total+Buffer.byteLength(text)<=8*1024*1024,'LAYERED_CRITIC_EVIDENCE_LIMIT');
  appendFileSync(path,text);total+=Buffer.byteLength(text);const fd=openSync(path,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}}
  catch{throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');}}
 const writeDiagnostic=(value:AnswerDiagnostic)=>{const operation=tail.then(async()=>{try{const text=serialize(value);diagnosticTotal+=Buffer.byteLength(text);
   ensure(Buffer.byteLength(text)<=300000&&diagnosticTotal<=2*1024*1024,'LAYERED_CRITIC_DIAGNOSTIC_LIMIT');await appendFile(diagnosticPath,text);const h=await open(diagnosticPath,'r+');try{await h.sync();}finally{await h.close();}}
   catch{throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');}});tail=operation;return operation;};
 signal.addEventListener('abort',()=>{try{record({kind:'worker.abort',runId:start.runId});}catch{/* existing stop remains authoritative */}},{once:true});
 const native=(event:SemanticEvent,actor:TaskIdentity)=>{const projected=projectCriticNative(event,actor,freeze.promptHashes);record(projected);
  if(event.type==='inference.started')ensure(projected.instructionMatches===true,'LAYERED_CRITIC_EFFECTIVE_PROMPT_HASH');};
 return{runnerMode:'live',research:sample.research,controlledSeed:{proposerBody:sample.proposerBody},answerDiagnostics:{credential:key,maxCaptureBytes:262144,write:writeDiagnostic},
  gateway:{baseURL:freeze.gatewayBaseURL,model:freeze.model,apiKey:key},onNative:native,onTrace:trace=>record({kind:'request',trace}),onToolBatch:manifest=>record({kind:'tool.batch',manifest}),
  onArtifact:artifact=>record({kind:'artifact',artifact}),onReviewDispatch:v=>record({kind:'review.dispatch',actor:v.actor,expectation:v.expectation,snapshot:v.snapshot}),onReviewResult:v=>record({kind:'review.result',...v})};
 }});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startLayeredCriticWorker();
