/** Only the one frozen L05. The old matrix worker/entry is never unlocked. */
import {readFileSync,writeFileSync,appendFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {canonicalizeArtifact} from '../contracts/canonical.js';
import {hashArtifact,sha256Bytes} from '../evidence/hashing.js';
import {loadSnapshot} from '../data/snapshot.js';
import {startWorker} from '../runtime/worker-entry.js';
import {buildCriticCase} from './critic-cases.js';
import {projectCriticNative} from './critic-worker.js';
import type {TaskIdentity} from '../model/gateway-runner.js';
import type {SemanticEvent} from '@mozaik-ai/core';
const root=fileURLToPath(new URL('../../../',import.meta.url));
function ensure(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const equal=(a:unknown,b:unknown)=>canonicalizeArtifact(a)===canonicalizeArtifact(b);
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
/** Checks actual source-built sample, never draft expected-finding labels. */
export function validateBoundedCriticSample(value:unknown,start:{runId:string;runInput:unknown},sample:ReturnType<typeof buildCriticCase>){
 ensure(object(value)&&hashArtifact(value)===value.hash&&value.scope==='task7s_bounded_protocol_then_single_L05'
  &&value.showcaseEligible===false&&value.automaticRetry===false,'BOUNDED_CRITIC_FREEZE');
 ensure(object(value.l05)&&value.l05.variantId==='L05'&&value.l05.runId===start.runId
  &&sample.input.runId===start.runId&&sample.input.mode==='adversarial'
  &&equal(value.l05.input,start.runInput)&&equal(value.l05.input,sample.input)
  &&equal(value.l05.manifest,sample.manifest),'BOUNDED_CRITIC_SAMPLE');
}
function arg(name:string){const i=process.argv.indexOf(name);ensure(i>=0&&process.argv[i+1],'BOUNDED_CRITIC_ARGUMENT');return process.argv[i+1]!;}
export function startBoundedCriticWorker(){startWorker({configure:async({start,signal})=>{
 const freezePath=resolve(arg('--validation-freeze'));ensure(freezePath===resolve(root,'docs/implementation/task-7s-live/freeze.json'),'BOUNDED_CRITIC_PATH');
 const bytes=readFileSync(freezePath);ensure(sha256Bytes(bytes)===arg('--validation-freeze-hash'),'BOUNDED_CRITIC_FILE_HASH');
 const freeze=JSON.parse(bytes.toString('utf8'));
 const snapshot=await loadSnapshot(start.snapshotPath,start.runInput.datasetCommit),sample=buildCriticCase(snapshot,'L05',start.runId);
 validateBoundedCriticSample(freeze,start,sample);
 ensure(start.limits.maxModelRequests===16&&start.limits.maxConcurrentModelRequests===2&&start.limits.runTimeoutMs===180000
  &&start.limits.requestTimeoutMs===40000,'BOUNDED_CRITIC_LIMITS');
 ensure(process.env.EINSTEIN_GATEWAY_BASE_URL===freeze.gatewayBaseURL&&process.env.EINSTEIN_GATEWAY_MODEL===freeze.model
  &&process.env.EINSTEIN_GATEWAY_API_KEY,'BOUNDED_CRITIC_CONFIGURATION');
 const path=join(dirname(freezePath),'runs',start.runId,'worker-evidence.jsonl');
 writeFileSync(path,JSON.stringify({kind:'header',schemaVersion:1,runnerMode:'live',scope:freeze.scope,runId:start.runId,
  variantId:'L05',controlledAdversarial:true,showcaseEligible:false,freezeHash:freeze.hash,sourceManifest:sample.manifest,
  attackDiff:sample.attackDiff,input:start.runInput,caseFixtureDraft:sample.draft})+'\n',{flag:'wx'});
 function record(value:object){const text=JSON.stringify({at:new Date().toISOString(),monotonicMs:performance.now(),...value});
  ensure(!text.includes(process.env.EINSTEIN_GATEWAY_API_KEY!),'BOUNDED_CRITIC_CREDENTIAL_REFLECTION');
  ensure(Buffer.byteLength(text)<=1024*1024,'BOUNDED_CRITIC_EVIDENCE_LIMIT');
  appendFileSync(path,text+'\n');const fd=openSync(path,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}}
 signal.addEventListener('abort',()=>record({kind:'worker.abort',runId:start.runId}),{once:true});
 function native(event:SemanticEvent,actor:TaskIdentity){const projected=projectCriticNative(event,actor,freeze.promptHashes);record(projected);
  if(event.type==='inference.started')ensure(projected.instructionMatches===true,'BOUNDED_CRITIC_PROMPT_HASH');}
 return{runnerMode:'live',research:sample.research,controlledSeed:{proposerBody:sample.proposerBody},
  gateway:{baseURL:freeze.gatewayBaseURL,model:freeze.model,apiKey:process.env.EINSTEIN_GATEWAY_API_KEY!},
  onTrace:trace=>record({kind:'request',trace}),onNative:native,onToolBatch:manifest=>record({kind:'tool.batch',manifest}),
  onArtifact:artifact=>record({kind:'artifact',artifact}),
  onReviewDispatch:value=>record({kind:'review.dispatch',actor:value.actor,expectation:value.expectation,snapshot:value.snapshot}),
  onReviewResult:value=>record({kind:'review.result',...value})};
 }});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startBoundedCriticWorker();
