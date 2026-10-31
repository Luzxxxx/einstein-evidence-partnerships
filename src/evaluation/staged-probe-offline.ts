/** Isolated OFFLINE experiment. No live default, endpoint fallback, provider
 * request, publication authority or mutation of the approved V3 implementation. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {FunctionCallItem,FunctionCallOutputItem,type ContextItem,type InferenceInput,type InferenceRunner,type ModelContext,type Tool} from '@mozaik-ai/core';
import {canonicalizeArtifact} from '../contracts/canonical.js';
import {UuidSchema} from '../contracts/primitives.js';
import {sha256Bytes} from '../evidence/hashing.js';
import type {TaskIdentity} from '../model/gateway-runner.js';
import type {ExecuteOptions} from '../runtime/orchestrator.js';
import {AnswerDiagnosticError} from '../runtime/answer-diagnostics.js';
import {projectProbeWireRequest} from './protocol-probe.js';
import {createProtocolProbeV3Execution,type ProtocolProbeV3ExecutionOptions} from './protocol-probe-v3.js';

export const STAGED_PROBE_OFFLINE_API_KEY='offline_fixture_staged_probe_key';
const NAMES=['read_company_challenge','read_candidate_bundle'] as const;
type Options=Omit<ProtocolProbeV3ExecutionOptions,'runnerMode'|'fetchImpl'>&{runnerMode:'offline_fixture';fetchImpl:typeof fetch};
type NativeRow=Record<string,any>;
type Owner={actor:TaskIdentity;context:ModelContext;prefix:ContextItem[];prefixValues:string[];turn:number};
type Scope={actor:TaskIdentity;input:InferenceInput;owner:Owner;stage:'first'|'final'};
const sha=(text:string)=>sha256Bytes(Buffer.from(text,'utf8'));
const key=(actor:TaskIdentity)=>canonicalizeArtifact(actor);
function need(value:unknown,code:string):asserts value{if(!value)throw Error('STAGED_PROBE_OFFLINE_'+code);}
function itemValue(item:ContextItem){
  if(item instanceof FunctionCallItem)return canonicalizeArtifact({type:item.type,callId:item.callId,name:item.name,args:item.args});
  if(item instanceof FunctionCallOutputItem)return canonicalizeArtifact({type:item.type,callId:item.callId,text:item.output.text});
  const row=item as unknown as {type:string;role?:string;content?:{text?:string}};
  return canonicalizeArtifact({type:row.type,role:row.role??null,text:row.content?.text??null});
}
function toolValue(tool:Tool){return canonicalizeArtifact({type:tool.type,name:tool.name,description:tool.description,parameters:tool.parameters,strict:tool.strict??null});}

/** Tools remain the SAME native objects across both inference stages. Only the
 * explicit fake HTTP transport's exposed schemas/choice change. The installed
 * SDK has no per-InferenceInput tool_choice API. Its native tool definitions
 * remain available to validate/serialize historical original calls. */
export function createStagedProbeOfflineExecution(options:Options):ExecuteOptions{
  need(options.runnerMode==='offline_fixture','MODE_REQUIRED');
  need(options.gateway?.baseURL==='https://offline.invalid/v1'&&options.gateway.model==='offline_fixture','ENDPOINT_MODEL_REQUIRED');
  need(options.gateway.apiKey===STAGED_PROBE_OFFLINE_API_KEY,'FIXTURE_CREDENTIAL_REQUIRED');
  need(typeof options.fetchImpl==='function','EXPLICIT_FAKE_FETCH_REQUIRED');
  need(typeof options.record==='function','RECORD_REQUIRED');
  const fakeFetch=options.fetchImpl,scope=new AsyncLocalStorage<Scope>(),owners=new Map<string,Owner>();
  const requests=new Map<string,{requestId:string;permitId:string;bodySha256:string}>(),native:NativeRow[]=[];
  let selected:Tool[]|undefined,snapshots:{tool:Tool;invoke:Tool['invoke'];value:string}[]|undefined,totalBytes=0;
  const write=(row:Record<string,unknown>)=>{
    try{
      const encoded=JSON.stringify(row),bytes=Buffer.byteLength(encoded);
      need(bytes<=262144&&totalBytes+bytes<=4*1024*1024,'METADATA_LIMIT');
      // Diagnostic records contain only safe projections/hashes and validated
      // receipt JSON. No headers, credential, reasoning or provider envelope.
      need(!encoded.includes(options.gateway.apiKey),'CREDENTIAL_REFLECTION');
      totalBytes+=bytes;const result:unknown=options.record(row);
      if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw Error('ASYNC_RECORD');}
    }catch{throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');}
  };
  const record=(row:Record<string,unknown>)=>{
    if(row.kind==='wire.request'){
      const current=scope.getStore();need(current&&row.actor&&key(row.actor as TaskIdentity)===key(current.actor),'UPSTREAM_CONTEXT_UNBOUND');
      need(typeof row.requestId==='string'&&typeof row.permitId==='string'&&typeof row.bodySha256==='string','UPSTREAM_REQUEST_UNBOUND');
      requests.set(key(current.actor),{requestId:row.requestId,permitId:row.permitId,bodySha256:row.bodySha256});
      write({...row,kind:'wire.before_stage_projection'});return;
    }
    if(row.kind==='native'&&['function_call.started','function_call.completed'].includes(String(row.type)))native.push(row);
    write(row);
  };
  function checkTools(input:InferenceInput){
    need(selected&&snapshots&&input.tools?.length===2,'NATIVE_TOOLS_REQUIRED');
    for(let i=0;i<2;i++)need(input.tools[i]===snapshots[i]!.tool&&input.tools[i]!.invoke===snapshots[i]!.invoke
      &&toolValue(input.tools[i]!)===snapshots[i]!.value,'NATIVE_TOOLS_CHANGED');
  }
  function checkFinal(input:InferenceInput,owner:Owner){
    const items=input.context.getItems();need(items.length===owner.prefix.length+4,'FINAL_CONTEXT_SHAPE');
    owner.prefix.forEach((item,i)=>need(items[i]===item&&itemValue(item)===owner.prefixValues[i],'CONTEXT_PREFIX_CHANGED'));
    const seenIds=new Set<string>(),seenNames=new Set<string>(),receipts=new Set<string>();
    for(let i=0;i<2;i++){
      const call=items[owner.prefix.length+i*2],output=items[owner.prefix.length+i*2+1];
      need(call instanceof FunctionCallItem&&output instanceof FunctionCallOutputItem&&output.callId===call.callId,'FINAL_CALL_OUTPUT_BINDING');
      need(NAMES.includes(call.name as typeof NAMES[number])&&!seenIds.has(call.callId)&&!seenNames.has(call.name),'FINAL_CALL_SET');
      seenIds.add(call.callId);seenNames.add(call.name);
      let args:Record<string,unknown>,value:Record<string,any>;try{args=JSON.parse(call.args);value=JSON.parse(output.output.text);}catch{throw Error('STAGED_PROBE_OFFLINE_FINAL_JSON');}
      const expected=call.name==='read_company_challenge'?{runId:options.input.runId,companyId:options.input.companyId,challengeId:options.input.challengeId}
        :{runId:options.input.runId,researcherId:options.research.pool.candidates[0]!.researcherId};
      need(canonicalizeArtifact(args)===canonicalizeArtifact(expected),'FINAL_ARGUMENT_BINDING');
      need(value.ok===true&&value.runId===options.input.runId&&UuidSchema.safeParse(value.receiptId).success&&!receipts.has(value.receiptId),'FINAL_RECEIPT_BINDING');
      receipts.add(value.receiptId);
      need(call.name==='read_company_challenge'?value.data?.challenge?.id===options.input.challengeId:
        value.data?.profile?.record?.id===options.research.pool.candidates[0]!.researcherId,'FINAL_SOURCE_ID_BINDING');
      const starts=native.filter(row=>key(row.actor)===key(owner.actor)&&row.type==='function_call.started'&&row.callId===call.callId),
        ends=native.filter(row=>key(row.actor)===key(owner.actor)&&row.type==='function_call.completed'&&row.callId===call.callId);
      need(starts.length===1&&ends.length===1&&starts[0]!.toolName===call.name&&starts[0]!.argumentsSha256===sha(call.args)
        &&ends[0]!.outputSha256===sha(output.output.text)&&ends[0]!.receipt?.receiptId===value.receiptId,'FINAL_NATIVE_RECEIPT_BINDING');
    }
  }
  const base=createProtocolProbeV3Execution({...options,record,fetchImpl:async(url,init)=>{
    const current=scope.getStore();need(current&&typeof init?.body==='string','FETCH_CONTEXT_UNBOUND');
    need(String(url)==='https://offline.invalid/v1/chat/completions','FETCH_ENDPOINT_CHANGED');
    const request=requests.get(key(current.actor));need(request&&sha(init.body)===request.bodySha256,'FETCH_REQUEST_UNBOUND');
    checkTools(current.input);if(current.stage==='final')checkFinal(current.input,current.owner);
    let before:Record<string,any>;try{before=JSON.parse(init.body);}catch{throw Error('STAGED_PROBE_OFFLINE_HTTP_JSON');}
    need(before.model==='offline_fixture'&&before.stream===false&&before.parallel_tool_calls===false
      &&before.tool_choice===undefined&&Array.isArray(before.tools),'HTTP_SHAPE');
    const expectedTools=selected!.map(tool=>({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters,strict:tool.strict}}));
    need(canonicalizeArtifact(before.tools)===canonicalizeArtifact(expectedTools),'HTTP_NATIVE_TOOL_MISMATCH');
    const actual:Record<string,any>={...before,tool_choice:current.stage==='first'?'auto':'none'};if(current.stage==='final')delete actual.tools;
    const withoutPolicy=(row:Record<string,unknown>)=>{const{tools,tool_choice,...rest}=row;return rest;};
    need(canonicalizeArtifact(withoutPolicy(before))===canonicalizeArtifact(withoutPolicy(actual)),'NON_TOOL_FIELDS_CHANGED');
    const body=JSON.stringify(actual),messages=JSON.stringify(actual.messages);
    need(messages===JSON.stringify(before.messages),'MESSAGES_CHANGED');
    write(projectProbeWireRequest(current.actor,request,body));
    write({kind:'staged.http.policy',actor:{...current.actor},requestId:request.requestId,permitId:request.permitId,stage:current.stage,
      beforeBodySha256:request.bodySha256,bodySha256:sha(body),beforeMessagesSha256:sha(JSON.stringify(before.messages)),messagesSha256:sha(messages),
      unchangedNonToolFields:true,actualToolNames:current.stage==='first'?[...NAMES]:[],toolChoice:actual.tool_choice,
      runnerMode:'offline_fixture',transport:'controlled_fake_fetch'});
    return fakeFetch(url,{...init,body});
  }});
  const execution:ExecuteOptions={...base,decorateTools:tools=>{
    need(!selected,'TOOL_DECORATOR_REENTRY');selected=NAMES.map(name=>{const matches=tools.filter(tool=>tool.name===name);need(matches.length===1,'REQUIRED_TOOL_SET');return matches[0]!;});
    snapshots=selected.map(tool=>({tool,invoke:tool.invoke,value:toolValue(tool)}));return selected;
  },runnerFactory:hooks=>{
    const runner=base.runnerFactory!(hooks);
    const wrapped:InferenceRunner={run(input){
      checkTools(input);const actor=hooks.resolveTask(input.context.id);need(actor.contextId===input.context.id,'NATIVE_ACTOR_CONTEXT');
      let owner=owners.get(input.context.id);
      if(!owner){const items=input.context.getItems();need(!items.some(item=>item instanceof FunctionCallItem||item instanceof FunctionCallOutputItem),'INITIAL_CONTEXT_HISTORY');
        owner={actor,context:input.context,prefix:[...items],prefixValues:items.map(itemValue),turn:0};owners.set(input.context.id,owner);
      }
      need(owner.context===input.context&&key(owner.actor)===key(actor),'NATIVE_CONTEXT_CHANGED');
      need(owner.turn<2,'THIRD_REQUEST_FORBIDDEN');const stage=owner.turn++===0?'first':'final';if(stage==='final')checkFinal(input,owner);
      write({kind:'staged.native.input',actor:{...actor},stage,sameToolReferences:true,sameContextObject:true,
        nativeTools:selected!.map(tool=>({name:tool.name,schemaSha256:sha(canonicalizeArtifact(tool.parameters)),definitionSha256:sha(toolValue(tool))})),
        contextItems:input.context.getItems().map(item=>({type:item.type,valueSha256:sha(itemValue(item)),
          ...(item instanceof FunctionCallItem?{callId:item.callId,toolName:item.name,argumentsSha256:sha(item.args)}:{}),
          ...(item instanceof FunctionCallOutputItem?{callId:item.callId,outputSha256:sha(item.output.text)}:{})}))});
      return scope.run({actor,input,owner,stage},()=>runner.run(input));
    },async *stream(){throw Error('STAGED_PROBE_OFFLINE_STREAMING_FORBIDDEN');}};
    return wrapped;
  }};
  return Object.freeze(execution);
}
