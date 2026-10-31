/** Trusted host composition only. Importing creates no worker, store, freeze,
 * attempt, HTTP request, recovery action or publication authority. */
import {DeveloperMessageItem,UserMessageItem,type InferenceInput,type InferenceRunner} from '@mozaik-ai/core';
import {canonicalizeArtifact} from '../contracts/canonical.js';
import {RunInputSchema,type RunInput} from '../contracts/domain.js';
import type {GatewayConfig,PermitClient,TaskIdentity} from '../model/gateway-runner.js';
import {ArtifactCoordinator,type ExecuteOptions,type ResearchContext} from '../runtime/orchestrator.js';
import {AnswerDiagnosticError,type AnswerDiagnosticsOptions} from '../runtime/answer-diagnostics.js';
import {createProtocolProbeV2Runner,createProtocolProbeV2Observer} from './protocol-probe-v2.js';
import {createProbeContractGuard,PROTOCOL_PROBE_V3_INSTRUCTION} from './probe-contract-guard.js';

export type ProtocolProbeV3ExecutionOptions={
  input:RunInput;research:ResearchContext;gateway:Pick<GatewayConfig,'baseURL'|'apiKey'|'model'>;
  permitClient:PermitClient;record(value:Record<string,unknown>):void;
  writeDiagnostic?:AnswerDiagnosticsOptions['write'];signal?:AbortSignal;
  runnerMode?:'live'|'offline_fixture';fetchImpl?:typeof fetch;
};
function need(value:unknown,code:string):asserts value{if(!value)throw Error(code);}

/** Bind the probe policy at the actual application execution boundary. This
 * never replaces the core tool-batch adapter or the parent's request permits. */
export function createProtocolProbeV3Execution(options:ProtocolProbeV3ExecutionOptions):ExecuteOptions{
  const mode=options.runnerMode??'live';
  need(mode==='live'||mode==='offline_fixture','PROBE_V3_RUNNER_MODE_INVALID');
  need(!options.fetchImpl||mode==='offline_fixture','PROBE_V3_FIXTURE_MODE_REQUIRED');
  need(typeof options.record==='function','PROBE_V3_RECORD_REQUIRED');
  const input=RunInputSchema.parse(options.input);
  // Reuse the established source/hash/pool binding validator and its owned
  // immutable copies. No source, ranking or candidate identity is inferred here.
  const coordinator=new ArtifactCoordinator({...options.research,input});
  need(coordinator.pool.candidates.length>0&&coordinator.evidence.length>0,'PROBE_V3_EMPTY_POOL');
  const research:ResearchContext={snapshot:options.research.snapshot,pool:coordinator.pool,evidence:coordinator.evidence};
  const expected=Object.freeze({runId:coordinator.input.runId,companyId:coordinator.input.companyId,
    challengeId:coordinator.input.challengeId,researcherId:coordinator.pool.candidates[0]!.researcherId});
  const gateway=Object.freeze({...options.gateway}),permitClient=options.permitClient,fetchImpl=options.fetchImpl;
  const sink=options.record;
  const record=(value:Record<string,unknown>)=>{try{
    const returned:unknown=sink(value);
    // `void` permits async callbacks in TypeScript. This record boundary is
    // intentionally synchronous; observe any rejection, then fail closed.
    // Asynchronous acknowledged writes belong only to writeDiagnostic.
    if(returned!==undefined){void Promise.resolve(returned).catch(()=>{});throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');}
  }catch{throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');}};
  const observer=createProtocolProbeV2Observer({apiKey:gateway.apiKey,record,...(options.writeDiagnostic?{writeDiagnostic:options.writeDiagnostic}:{})});
  const guard=createProbeContractGuard(expected,{credential:gateway.apiKey,maxCaptureBytes:8192,
    record:decision=>record(decision as unknown as Record<string,unknown>)});
  const roleActors=new Map<TaskIdentity['role'],string>();
  function checkTask(request:InferenceInput,actor:TaskIdentity){
    need(actor.runId===expected.runId&&['proposer','counter-evidence'].includes(actor.role)
      &&actor.attempt===1&&actor.contextId===request.context.id,'PROBE_V3_RUN_BINDING_INVALID');
    const items=request.context.getItems(),developers=items.filter((item):item is DeveloperMessageItem=>item instanceof DeveloperMessageItem),
      user=items.find((item):item is UserMessageItem=>item instanceof UserMessageItem);
    need(developers.length===1&&developers[0]!.content.text===PROTOCOL_PROBE_V3_INSTRUCTION&&user,'PROBE_V3_CONTEXT_BINDING_INVALID');
    let data:unknown;try{data=JSON.parse(user.content.text);}catch{throw Error('PROBE_V3_CONTEXT_BINDING_INVALID');}
    need(canonicalizeArtifact(data)===canonicalizeArtifact(expected),'PROBE_V3_CONTEXT_BINDING_INVALID');
    const key=canonicalizeArtifact(actor),previous=roleActors.get(actor.role);
    need(!previous||previous===key,'PROBE_V3_CONTEXT_BINDING_INVALID');
    roleActors.set(actor.role,key);
  }
  const execution:ExecuteOptions={runnerMode:mode,research,...(options.signal?{signal:options.signal}:{}),gateway,
    adapterProbe:true,adapterProbeInstruction:PROTOCOL_PROBE_V3_INSTRUCTION,inferenceGuard:guard,answerDiagnostics:observer.answerDiagnostics,
    onNative:observer.native,onTrace:observer.trace,onToolBatch:manifest=>record({kind:'tool.batch',manifest}),
    onArtifact:()=>{throw Error('PROBE_V3_PUBLICATION_FORBIDDEN');},
    runnerFactory:hooks=>{
      const runner=createProtocolProbeV2Runner({gateway,hooks,permitClient,requestTimeoutMs:40000,record,trace:hooks.trace,...(fetchImpl?{fetchImpl}:{})});
      const bound:InferenceRunner={run(request){checkTask(request,hooks.resolveTask(request.context.id));return runner.run(request);},
        async *stream(){throw Error('PROTOCOL_PROBE_STREAMING_UNSUPPORTED');}};
      return bound;
    }};
  return Object.freeze(execution);
}
