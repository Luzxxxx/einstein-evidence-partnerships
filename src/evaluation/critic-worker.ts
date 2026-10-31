/** Trusted isolated evaluation bootstrap. No label or expected-finding file is
 * loaded, and all model results come from the actual gateway/native Runtime. */
import { readFileSync, writeFileSync, appendFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { canonicalizeArtifact } from '../contracts/canonical.js';
import { sha256Bytes, hashArtifact } from '../evidence/hashing.js';
import { loadSnapshot } from '../data/snapshot.js';
import { startWorker } from '../runtime/worker-entry.js';
import { buildCriticCase, CRITIC_VARIANTS } from './critic-cases.js';
import type { TaskIdentity } from '../model/gateway-runner.js';
import type { SemanticEvent } from '@mozaik-ai/core';

const projectRoot=fileURLToPath(new URL('../../../',import.meta.url));
function ensure(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
function argument(name:string){const index=process.argv.indexOf(name);ensure(index>=0&&process.argv[index+1],'CRITIC_WORKER_ARGUMENT');return process.argv[index+1];}
const textHash=(text:string)=>sha256Bytes(Buffer.from(text,'utf8'));

/** Safe projection only: final task answers and read-only tool data can be
 * inspected, while source prompts, provider envelopes and reasoning stay out.
 * Tests use a real SDK ModelContext; this helper never runs an inference. */
export function projectCriticNative(event:SemanticEvent,actor:TaskIdentity,promptHashes:Record<string,string>):Record<string,unknown>{
  const p=event.payload as Record<string,any>,base={kind:'native',type:event.type,actor};
  if(event.type==='function_call.started')return{...base,callId:p.call.callId,toolName:p.call.name,
    arguments:JSON.parse(p.call.args),argumentsHash:textHash(p.call.args)};
  if(event.type==='function_call.completed')return{...base,callId:p.callId,outputHash:textHash(p.output.text),output:JSON.parse(p.output.text)};
  if(event.type==='inference.started'){
    const items=p.context.getItems(),developers=items.filter((i:any)=>i.role==='developer');
    const actualInstructionHash=developers.length===1&&typeof developers[0].content?.text==='string'?textHash(developers[0].content.text):null;
    const instructionKey=actor.role==='critic'?'effectiveCritic':actor.role==='counter-evidence'?'effectiveCounter'
      :actor.attempt===1?'effectiveControlledProposer':'effectiveProposer';
    const expectedInstructionHash=promptHashes[instructionKey]??null;
    return{...base,contextId:p.context.id,actualInstructionHash,expectedInstructionHash,
      instructionMatches:actualInstructionHash!==null&&actualInstructionHash===expectedInstructionHash,
      toolResults:items.filter((i:any)=>i.type==='function_call_output').map((i:any)=>({callId:i.callId,outputHash:textHash(i.output.text)})),
      contextItems:items.map((i:any)=>({id:i.id??null,type:i.type??null,role:i.role??null}))};
  }
  if(event.type==='model.answer')return{...base,answerText:p.answer.content.text,answerHash:textHash(p.answer.content.text)};
  return base;
}

export function startCriticWorker():void{
  startWorker({configure:async({start,signal})=>{
    const freezePath=resolve(argument('--critic-freeze'));
    ensure(freezePath===resolve(projectRoot,'docs/implementation/task-7-live/freeze.json'),'CRITIC_FREEZE_PATH');
    const raw=readFileSync(freezePath);ensure(sha256Bytes(raw)===argument('--critic-freeze-hash'),'CRITIC_FREEZE_HASH');
    const freeze=JSON.parse(raw.toString('utf8'));
    ensure(hashArtifact(freeze)===freeze.hash&&freeze.controlledAdversarial===true&&freeze.showcaseEligible===false,'CRITIC_FREEZE_INVALID');
    const planned=freeze.runs.find((run:{runId:string})=>run.runId===start.runId);
    ensure(planned&&CRITIC_VARIANTS.some(v=>v.variantId===planned.variantId&&v.layer!=='D'),'CRITIC_RUN_NOT_PLANNED');
    const snapshot=await loadSnapshot(start.snapshotPath,start.runInput.datasetCommit),sample=buildCriticCase(snapshot,planned.variantId,start.runId);
    const frozen=freeze.caseFreezes.find((item:{runId:string})=>item.runId===start.runId);
    ensure(frozen&&canonicalizeArtifact(frozen.input)===canonicalizeArtifact(start.runInput)
      &&canonicalizeArtifact(frozen.manifest)===canonicalizeArtifact(sample.manifest),'CRITIC_CASE_FREEZE_MISMATCH');
    ensure(process.env.EINSTEIN_GATEWAY_BASE_URL===freeze.gatewayBaseURL&&process.env.EINSTEIN_GATEWAY_MODEL===freeze.model,'CRITIC_GATEWAY_CHANGED');
    ensure(process.env.EINSTEIN_GATEWAY_API_KEY,'CRITIC_MODEL_CONFIGURATION_MISSING');
    const folder=join(dirname(freezePath),'runs',start.runId),path=join(folder,'worker-evidence.jsonl');
    const header={schemaVersion:1,runnerMode:'live',controlledAdversarial:true,showcaseEligible:false,runId:start.runId,
      variantId:planned.variantId,repetition:planned.repetition,freezeHash:freeze.hash,sourceManifest:sample.manifest,
      attackDiff:sample.attackDiff,input:start.runInput,caseFixtureDraft:sample.draft};
    writeFileSync(path,JSON.stringify({kind:'header',...header})+'\n',{flag:'wx'});
    function record(value:unknown){appendFileSync(path,JSON.stringify({at:new Date().toISOString(),monotonicMs:performance.now(),...value as object})+'\n');
      const fd=openSync(path,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}}
    signal.addEventListener('abort',()=>record({kind:'worker.abort',runId:start.runId}),{once:true});
    function native(event:SemanticEvent,actor:TaskIdentity){
      const projection=projectCriticNative(event,actor,freeze.promptHashes);record(projection);
      if(event.type==='inference.started')ensure(projection.instructionMatches===true,'CRITIC_PROMPT_FREEZE_MISMATCH');
    }
    return{runnerMode:'live',research:sample.research,controlledSeed:{proposerBody:sample.proposerBody},
      gateway:{baseURL:process.env.EINSTEIN_GATEWAY_BASE_URL!,model:process.env.EINSTEIN_GATEWAY_MODEL!,apiKey:process.env.EINSTEIN_GATEWAY_API_KEY!},
      onTrace:trace=>record({kind:'request',trace}),onNative:native,onToolBatch:manifest=>record({kind:'tool.batch',manifest}),
      onArtifact:artifact=>record({kind:'artifact',artifact}),
      onReviewDispatch:value=>record({kind:'review.dispatch',actor:value.actor,expectation:value.expectation,snapshot:value.snapshot}),
      onReviewResult:value=>record({kind:'review.result',...value})};
  }});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startCriticWorker();
