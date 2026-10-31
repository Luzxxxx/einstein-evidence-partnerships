/** Pure, versioned observation analysis. It neither executes nor reclassifies a
 * historical probe and grants no publication, recovery, permit or live authority.
 * Calls are owned by the complete actor, batch, original ID and source request.
 * Missing observations are not evidence that a recorded output was corrupted. */
import {canonicalizeArtifact} from '../contracts/canonical.js';
import {UuidSchema} from '../contracts/primitives.js';
import {deepFreeze} from '../data/records.js';
import {ProtocolProbeV2AnswerSchema} from './protocol-probe-v2.js';
import type {ProtocolProbeInput} from './protocol-probe.js';

type Row=Record<string,any>;
type Indexed=Row&{index:number};
type Layer='binding'|'native'|'context'|'http'|'task'|'model';
type Status='verified'|'incomplete'|'corrupt';
type CallStatus='verified'|'not_observed'|'not_observed_after_stop'|'corrupt';
type Finding={code:string;layer:Layer;actor:Row|null;batchId:string|null;originalCallId:string|null;requestId:string|null};
type CallObservation={originalCallId:string|null;toolName:string|null;argumentsSha256:string|null;arguments:Row|null;
 outputSha256:string|null;receiptId:string|null;receipt:Row|null;nativeStatus:CallStatus;contextStatus:CallStatus;httpStatus:CallStatus};
type BatchObservation={actor:Row;batchId:string|null;callCount:number;sourceRequestId:string|null;sourcePermitId:string|null;
 nativeStatus:CallStatus;contextStatus:CallStatus;httpStatus:CallStatus;nextHttpRequestId:string|null;
 httpHistoryGroupIndex:number|null;calls:CallObservation[]};
type Work={stage:Indexed;actor:Row;batch:Row;calls:Row[];terminal?:Indexed;finished:Row[];
 observation:BatchObservation;nativeStarts:Map<string,Indexed>;nativeEnds:Map<string,Indexed>};
export type ProtocolProbeAnalysisV3Input=ProtocolProbeInput&{stopReasonCodes?:readonly string[]};
const object=(v:unknown):Row|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Row:undefined;
const list=(v:unknown):Row[]=>Array.isArray(v)?v:[];
const same=(a:unknown,b:unknown)=>canonicalizeArtifact(a??null)===canonicalizeArtifact(b??null);
const actorFields=['runId','role','agentId','taskId','contextId','loopId','attempt'] as const;
const actorKey=(a:Row)=>canonicalizeArtifact(actorFields.map(k=>a[k]??null));
const sameActor=(a:unknown,b:Row)=>Boolean(object(a)&&actorKey(object(a)!)===actorKey(b));
// Only a near-identical task identity is evidence of an identity contradiction.
// An unrelated concurrent actor with the same supplier call ID is not borrowed.
const relatedActor=(a:unknown,b:Row)=>{const r=object(a);return Boolean(r&&
 (r.agentId===b.agentId&&r.taskId===b.taskId||r.agentId===b.agentId&&r.contextId===b.contextId));};
const hash=/^[a-f0-9]{64}$/;
const tools=['read_company_challenge','read_candidate_bundle'];
const validActor=(a:Row,runId:string)=>a.runId===runId&&['proposer','counter-evidence'].includes(a.role)
 &&a.attempt===1&&['runId','agentId','taskId','contextId','loopId'].every(k=>UuidSchema.safeParse(a[k]).success);
const nonempty=(v:unknown):v is string=>typeof v==='string'&&v.length>0;
const status=(items:CallStatus[],corrupt:boolean):Status=>corrupt||items.includes('corrupt')?'corrupt':items.length>0&&items.every(s=>s==='verified')?'verified':'incomplete';

export function analyzeProtocolProbeV3(input:ProtocolProbeAnalysisV3Input){
 // Clone the evidence graph before freezing the report; callers' snapshots and
 // original parsed artifacts remain mutable/frozen exactly as they arrived.
 const rows:Indexed[]=input.records.map((r,index)=>({...structuredClone(r),index}));
 const task:Finding[]=[],corruption:Finding[]=[],unobserved:Finding[]=[];
 const finding=(target:Finding[],code:string,layer:Layer,work?:Work,callId?:string,requestId?:string)=>{
  const item:Finding={code,layer,actor:work?{...work.actor}:null,batchId:work?.observation.batchId??null,
   originalCallId:callId??null,requestId:requestId??null};
  if(!target.some(r=>same(r,item)))target.push(item);
 };
 const bad=(code:string,layer:Layer,w?:Work,c?:string,q?:string)=>finding(corruption,code,layer,w,c,q);
 const missing=(code:string,layer:Layer,w?:Work,c?:string,q?:string)=>finding(unobserved,code,layer,w,c,q);
 const violate=(code:string,w?:Work,c?:string,q?:string)=>finding(task,code,'task',w,c,q);
 const traces:Indexed[]=rows.filter(r=>r.kind==='request').map(r=>({...object(r.trace),index:r.index}));
 const starts=traces.filter(r=>r.type==='request.started'),ends=traces.filter(r=>['request.completed','request.failed'].includes(r.type));
 const stopReasonCodes=[...new Set((input.stopReasonCodes??[]).filter(nonempty))];
 const stopped=object(input.record)?.status==='failed'||object(input.record)?.status==='cancelled'||stopReasonCodes.length>0;
 const stages=rows.filter(r=>r.kind==='tool.batch'&&object(r.manifest)?.phase==='staged');
 const works:Work[]=stages.map(stage=>{const batch=object(stage.manifest)??{},actor=object(batch.actor)??{},calls=list(batch.calls);
  return{stage,actor,batch,calls,finished:[],nativeStarts:new Map(),nativeEnds:new Map(),observation:{actor:{...actor},batchId:nonempty(batch.batchId)?batch.batchId:null,
   callCount:calls.length,sourceRequestId:null,sourcePermitId:null,nativeStatus:'not_observed',contextStatus:'not_observed',httpStatus:'not_observed',nextHttpRequestId:null,httpHistoryGroupIndex:null,
   calls:calls.map(c=>({originalCallId:nonempty(c.callId)?c.callId:null,toolName:nonempty(c.toolName)?c.toolName:null,
    argumentsSha256:typeof c.argumentsSha256==='string'?c.argumentsSha256:null,arguments:null,outputSha256:null,receiptId:null,receipt:null,
    nativeStatus:'not_observed',contextStatus:'not_observed',httpStatus:'not_observed'}))}};});
 if(works.length===0)missing('BATCH_OBSERVATIONS_NOT_OBSERVED','binding');

 // First resolve every batch's own native interval. No actor-wide array is ever
 // zipped with a particular batch, even when that actor has several batches.
 for(const w of works){
  const {actor,batch,calls,stage,observation:o}=w;
  if(!validActor(actor,input.runId))bad('BATCH_ACTOR_BINDING_MISMATCH','binding',w);
  if(!UuidSchema.safeParse(batch.batchId).success)bad('BATCH_ID_INVALID','binding',w);
  if(works.filter(x=>x.batch.batchId===batch.batchId&&sameActor(x.actor,actor)).length!==1)bad('BATCH_ID_DUPLICATE','binding',w);
  if(calls.length!==2||tools.some(tool=>calls.filter(c=>c.toolName===tool).length!==1))violate('PROBE_REQUIRED_TOOL_BATCH_VIOLATION',w);
  const terminals=rows.filter(r=>r.kind==='tool.batch'&&object(r.manifest)?.batchId===batch.batchId
   &&['completed','failed','cancelled'].includes(object(r.manifest)?.phase));
  const ownTerminals=terminals.filter(r=>sameActor(object(r.manifest)?.actor,actor));
  if(terminals.some(r=>!sameActor(object(r.manifest)?.actor,actor)))bad('BATCH_TERMINAL_ACTOR_MISMATCH','binding',w);
  if(ownTerminals.length>1)bad('BATCH_TERMINAL_DUPLICATE','native',w);
  w.terminal=ownTerminals[0];w.finished=list(object(w.terminal?.manifest)?.calls);
  if(!w.terminal||object(w.terminal.manifest)?.phase!=='completed')missing('NATIVE_BATCH_COMPLETION_NOT_OBSERVED','native',w);
  else if(w.terminal.index<=stage.index)bad('BATCH_TERMINAL_ORDER_MISMATCH','native',w);
  const nextStage=works.find(x=>sameActor(x.actor,actor)&&x.stage.index>stage.index);
  const bound=w.terminal?.index??nextStage?.stage.index??Infinity;
  const native=rows.filter(r=>r.kind==='native'&&['function_call.started','function_call.completed'].includes(r.type)
   &&sameActor(r.actor,actor)&&r.index>stage.index&&r.index<bound);
  const foreignNative=rows.filter(r=>r.kind==='native'&&['function_call.started','function_call.completed'].includes(r.type)
   &&!sameActor(r.actor,actor)&&relatedActor(r.actor,actor)&&r.index>stage.index&&r.index<bound);
  const planned=calls.flatMap(c=>[`${c.callId}:function_call.started`,`${c.callId}:function_call.completed`]);
  let lastPosition=-1;
  for(const n of native){const position=planned.indexOf(`${n.callId}:${n.type}`);
   if(position<0)bad('UNREGISTERED_NATIVE_CALL','native',w,String(n.callId));
   else if(position<=lastPosition)bad('NATIVE_CALL_ORDER_OR_DUPLICATION','native',w,String(n.callId));
   lastPosition=position;
  }
  if(new Set(calls.map(c=>c.callId)).size!==calls.length)bad('BATCH_ORIGINAL_CALL_ID_DUPLICATE','binding',w);
  for(const prior of works.filter(x=>sameActor(x.actor,actor)&&x.stage.index<stage.index))
   for(const c of calls)if(prior.calls.some(p=>p.callId===c.callId))bad('ACTOR_ORIGINAL_CALL_ID_REUSED','binding',w,c.callId);
  calls.forEach((c,i)=>{
   const out=o.calls[i],id=String(c.callId),ss=native.filter(r=>r.type==='function_call.started'&&r.callId===c.callId),ee=native.filter(r=>r.type==='function_call.completed'&&r.callId===c.callId);
   if(!nonempty(c.callId)||!hash.test(String(c.argumentsSha256)))bad('BATCH_CALL_METADATA_INVALID','binding',w,id);
   if(foreignNative.some(r=>r.callId===c.callId))bad('NATIVE_CALL_ACTOR_BINDING_MISMATCH','binding',w,id);
   if(ss.length>1||ee.length>1)bad('NATIVE_CALL_DUPLICATE','native',w,id);
   if(ss.length===0)missing('NATIVE_CALL_START_NOT_OBSERVED','native',w,id);
   if(ee.length===0)missing('NATIVE_CALL_OUTPUT_NOT_OBSERVED','native',w,id);
   const s=ss[0],e=ee[0];if(s)w.nativeStarts.set(id,s);if(e)w.nativeEnds.set(id,e);
   if(s){out.arguments=object(s.arguments)??null;
    if(s.toolName!==c.toolName||s.argumentsSha256!==c.argumentsSha256)bad('NATIVE_ORIGINAL_CALL_BINDING_MISMATCH','native',w,id);
    const args=object(s.arguments);
    if(!args||args.runId!==input.runId)bad('NATIVE_ARGUMENT_RUN_BINDING_MISMATCH','binding',w,id);
    if(c.toolName==='read_company_challenge'&&(!args||args.companyId!==input.expected.companyId||args.challengeId!==input.expected.challengeId))violate('PROBE_CHALLENGE_ARGUMENT_VIOLATION',w,id);
    if(c.toolName==='read_candidate_bundle'&&args?.researcherId!==input.expected.researcherId)violate('PROBE_RESEARCHER_ARGUMENT_VIOLATION',w,id);
    if(!tools.includes(c.toolName))violate('PROBE_UNEXPECTED_TOOL',w,id);
   }
   if(s&&e&&s.index>=e.index)bad('NATIVE_CALL_OUTPUT_BEFORE_START','native',w,id);
   if(e){const receipt=object(e.receipt);out.receipt=receipt?{...receipt}:null;out.receiptId=typeof receipt?.receiptId==='string'?receipt.receiptId:null;out.outputSha256=typeof e.outputSha256==='string'?e.outputSha256:null;
    if(!hash.test(String(e.outputSha256)))bad('NATIVE_OUTPUT_HASH_INVALID','native',w,id);
    if(receipt?.ok===true){const args=object(s?.arguments);
     if(receipt.runId!==input.runId||!UuidSchema.safeParse(receipt.receiptId).success
      ||args&&(c.toolName==='read_company_challenge'&&receipt.challengeId!==args.challengeId
       ||c.toolName==='read_candidate_bundle'&&receipt.researcherId!==args.researcherId))bad('NATIVE_RECEIPT_BINDING_MISMATCH','native',w,id);
    }else violate('PROBE_TOOL_RESULT_NOT_SUCCESSFUL',w,id);
   }
   const finish=w.finished[i];
   if(w.terminal&&object(w.terminal.manifest)?.phase==='completed'){
    if(w.finished.length!==calls.length||finish?.callId!==c.callId||finish?.toolName!==c.toolName||finish?.argumentsSha256!==c.argumentsSha256
     ||finish?.started!==true||finish?.returned!==true)bad('BATCH_COMPLETION_CALL_BINDING_MISMATCH','native',w,id);
    if(e&&finish?.outputSha256!==e.outputSha256)bad('BATCH_NATIVE_OUTPUT_HASH_MISMATCH','native',w,id);
   }
   out.nativeStatus=corruption.some(f=>f.batchId===o.batchId&&f.originalCallId===id&&['binding','native'].includes(f.layer))?'corrupt':s&&e?'verified':'not_observed';
  });
  const relatedStarts=starts.filter(s=>relatedActor(s.actor,actor)&&s.index<stage.index),supplierStart=relatedStarts.at(-1);
  if(!supplierStart)missing('SUPPLIER_REQUEST_START_NOT_OBSERVED','binding',w);
  else if(!sameActor(supplierStart.actor,actor))bad('SUPPLIER_REQUEST_ACTOR_BINDING_MISMATCH','binding',w,undefined,supplierStart.requestId);
  else{
   o.sourceRequestId=typeof supplierStart.requestId==='string'?supplierStart.requestId:null;o.sourcePermitId=typeof supplierStart.permitId==='string'?supplierStart.permitId:null;
   const sourceWires=rows.filter(r=>r.kind==='wire.request'&&(r.requestId===supplierStart.requestId||r.permitId===supplierStart.permitId));
   const sourceWire=sourceWires.filter(r=>r.requestId===supplierStart.requestId&&r.permitId===supplierStart.permitId&&sameActor(r.actor,actor));
   if(sourceWires.some(r=>r.requestId!==supplierStart.requestId||r.permitId!==supplierStart.permitId||!sameActor(r.actor,actor)))bad('SUPPLIER_HTTP_REQUEST_BINDING_MISMATCH','http',w,undefined,supplierStart.requestId);
   if(sourceWire.length>1)bad('SUPPLIER_HTTP_REQUEST_DUPLICATE','http',w,undefined,supplierStart.requestId);
   if(sourceWire.length===0)missing('SUPPLIER_HTTP_PROJECTION_NOT_OBSERVED','binding',w,undefined,supplierStart.requestId);
   if(sourceWire[0]&&(sourceWire[0].index<=supplierStart.index||sourceWire[0].index>=stage.index))bad('SUPPLIER_HTTP_CAUSAL_ORDER_MISMATCH','http',w,undefined,supplierStart.requestId);
   const candidates=ends.filter(e=>e.requestId===supplierStart.requestId&&e.permitId===supplierStart.permitId);
   const ownEnds=candidates.filter(e=>sameActor(e.actor,actor));
   if(candidates.some(e=>!sameActor(e.actor,actor)))bad('SUPPLIER_RESPONSE_ACTOR_BINDING_MISMATCH','binding',w,undefined,supplierStart.requestId);
   if(ownEnds.length>1)bad('SUPPLIER_RESPONSE_DUPLICATE','binding',w,undefined,supplierStart.requestId);
   const end=ownEnds[0],firstNative=native[0];
   if(!end){const nearby=ends.filter(e=>relatedActor(e.actor,actor)&&e.index>stage.index&&e.index<(firstNative?.index??bound));
    if(nearby.length)bad('SUPPLIER_RESPONSE_REQUEST_BINDING_MISMATCH','binding',w,undefined,supplierStart.requestId);
    else missing('SUPPLIER_RESPONSE_NOT_OBSERVED','binding',w,undefined,supplierStart.requestId);
   }else{
    if(end.type!=='request.completed')violate('SUPPLIER_REQUEST_FAILED',w,undefined,supplierStart.requestId);
    if(end.index<=stage.index||firstNative&&end.index>=firstNative.index)bad('SUPPLIER_RESPONSE_CAUSAL_ORDER_MISMATCH','binding',w,undefined,supplierStart.requestId);
    if(end.diagnostic?.toolCallCount!==calls.length)bad('SUPPLIER_BATCH_COUNT_BINDING_MISMATCH','binding',w,undefined,supplierStart.requestId);
   }
  }
  o.nativeStatus=corruption.some(f=>f.batchId===o.batchId&&f.layer==='native')?'corrupt':o.calls.every(c=>c.nativeStatus==='verified')&&object(w.terminal?.manifest)?.phase==='completed'?'verified':'not_observed';
 }

 // A completed batch contributes one contiguous block to cumulative Context
 // and HTTP history. Validate the entire known prefix, then report this block.
 for(const w of works){
  const {actor,observation:o}=w;
  const lastNative=[...w.nativeEnds.values()].sort((a,b)=>a.index-b.index).at(-1);
  const after=w.terminal?.index??lastNative?.index??w.stage.index;
  const nextStart=starts.filter(s=>sameActor(s.actor,actor)&&s.index>after)[0];
  const nextRelatedStart=starts.filter(s=>relatedActor(s.actor,actor)&&s.index>after)[0];
  if(nextRelatedStart&&nextRelatedStart!==nextStart)bad('NEXT_REQUEST_ACTOR_BINDING_MISMATCH','binding',w,undefined,nextRelatedStart.requestId);
  const nextBatch=works.find(x=>sameActor(x.actor,actor)&&x.stage.index>w.stage.index);
  const contextBound=nextRelatedStart?.index??nextBatch?.stage.index??Infinity;
  const contexts=rows.filter(r=>r.kind==='native'&&r.type==='inference.started'&&r.index>after&&r.index<contextBound&&sameActor(r.actor,actor));
  const foreignContexts=rows.filter(r=>r.kind==='native'&&r.type==='inference.started'&&r.index>after&&r.index<contextBound&&!sameActor(r.actor,actor)&&relatedActor(r.actor,actor));
  if(foreignContexts.length)bad('CONTEXT_ACTOR_BINDING_MISMATCH','context',w);
  if(contexts.length===0)missing('POST_TOOL_CONTEXT_NOT_OBSERVED','context',w);
  if(contexts.length>1)bad('POST_TOOL_CONTEXT_DUPLICATE','context',w);
  const context=contexts[0];
  const history=works.filter(x=>sameActor(x.actor,actor)&&x.terminal&&object(x.terminal.manifest)?.phase==='completed'&&x.terminal.index<=after);
  const expectedResults=history.flatMap(x=>x.finished.map(c=>({callId:c.callId,outputSha256:c.outputSha256})));
  if(context){if(context.contextId!==actor.contextId)bad('CONTEXT_ID_BINDING_MISMATCH','context',w);
   if(!same(context.toolResults,expectedResults))bad('CONTEXT_CUMULATIVE_OUTPUT_BINDING_MISMATCH','context',w);
  }
  o.contextStatus=corruption.some(f=>f.batchId===o.batchId&&f.layer==='context')?'corrupt':context?'verified':'not_observed';
  for(const c of o.calls)c.contextStatus=o.contextStatus;
  if(!nextStart){
   o.httpStatus=stopped?'not_observed_after_stop':'not_observed';for(const c of o.calls)c.httpStatus=o.httpStatus;
   missing(stopped?'NEXT_HTTP_NOT_OBSERVED_AFTER_STOP':'NEXT_HTTP_NOT_OBSERVED','http',w);continue;
  }
  o.nextHttpRequestId=typeof nextStart.requestId==='string'?nextStart.requestId:null;
  const allWire=rows.filter(r=>r.kind==='wire.request'&&(r.requestId===nextStart.requestId||r.permitId===nextStart.permitId));
  const ownWire=allWire.filter(r=>r.requestId===nextStart.requestId&&r.permitId===nextStart.permitId&&sameActor(r.actor,actor));
  if(allWire.some(r=>r.requestId!==nextStart.requestId||r.permitId!==nextStart.permitId||!sameActor(r.actor,actor)))bad('HTTP_REQUEST_BINDING_MISMATCH','http',w,undefined,nextStart.requestId);
  if(ownWire.length>1)bad('HTTP_REQUEST_DUPLICATE','http',w,undefined,nextStart.requestId);
  const relatedEnds=ends.filter(e=>e.requestId===nextStart.requestId||e.permitId===nextStart.permitId);
  const exactEnds=relatedEnds.filter(e=>sameActor(e.actor,actor)&&e.requestId===nextStart.requestId&&e.permitId===nextStart.permitId);
  if(relatedEnds.some(e=>!sameActor(e.actor,actor)||e.requestId!==nextStart.requestId||e.permitId!==nextStart.permitId))bad('HTTP_RESPONSE_BINDING_MISMATCH','http',w,undefined,nextStart.requestId);
  if(exactEnds.length>1)bad('HTTP_RESPONSE_DUPLICATE','http',w,undefined,nextStart.requestId);
  const wire=ownWire[0],requestEnd=exactEnds[0];
  if(!requestEnd||requestEnd.type!=='request.completed')missing('NEXT_HTTP_COMPLETION_NOT_OBSERVED','http',w,undefined,nextStart.requestId);
  if(requestEnd?.type==='request.failed')violate('NEXT_HTTP_REQUEST_FAILED',w,undefined,nextStart.requestId);
  if(!wire)missing('NEXT_HTTP_PROJECTION_NOT_OBSERVED','http',w,undefined,nextStart.requestId);
  if(wire&&(wire.index<=nextStart.index||requestEnd&&wire.index>=requestEnd.index||context&&wire.index<=context.index))bad('HTTP_CAUSAL_ORDER_MISMATCH','http',w,undefined,nextStart.requestId);
  if(wire){
   const messages=list(wire.messages),groups:{calls:Row[];outputs:Row[]}[]=[];let group:typeof groups[number]|undefined;
   for(const m of messages){if(m.role==='assistant'){group={calls:list(m.calls),outputs:[]};groups.push(group);}
    else if(m.role==='tool'&&group)group.outputs.push(m);
    else bad('HTTP_HISTORY_GROUP_STRUCTURE_MISMATCH','http',w,undefined,nextStart.requestId);
   }
   const expectedHistory=works.filter(x=>sameActor(x.actor,actor)&&x.terminal&&object(x.terminal.manifest)?.phase==='completed'&&x.terminal.index<wire.index);
   const target=expectedHistory.findIndex(x=>x===w);o.httpHistoryGroupIndex=target>=0?target:null;
   if(groups.length!==expectedHistory.length||target<0)bad('HTTP_HISTORY_GROUP_COUNT_MISMATCH','http',w,undefined,nextStart.requestId);
   expectedHistory.forEach((old,groupIndex)=>{
    const actual=groups[groupIndex];
    if(!actual||actual.calls.length!==old.calls.length||actual.outputs.length!==old.calls.length){bad('HTTP_HISTORY_CALL_COUNT_MISMATCH','http',w,undefined,nextStart.requestId);return;}
    old.calls.forEach((c,i)=>{const wireCall=actual.calls[i],wireOutput=actual.outputs[i],nativeStart=old.nativeStarts.get(String(c.callId)),nativeEnd=old.nativeEnds.get(String(c.callId)),terminal=old.finished[i];
     if(wireCall.callId!==c.callId||wireCall.toolName!==c.toolName||wireCall.argumentsSha256!==c.argumentsSha256
      ||nativeStart&&!same(wireCall.arguments,nativeStart.arguments))bad('HTTP_ORIGINAL_CALL_BINDING_MISMATCH','http',w,c.callId,nextStart.requestId);
     if(wireOutput.callId!==c.callId||wireOutput.outputSha256!==terminal?.outputSha256
      ||nativeEnd&&(wireOutput.outputSha256!==nativeEnd.outputSha256||!same(wireOutput.receipt,nativeEnd.receipt)))bad('HTTP_REAL_OUTPUT_BINDING_MISMATCH','http',w,c.callId,nextStart.requestId);
    });
   });
  }
  o.httpStatus=corruption.some(f=>f.batchId===o.batchId&&f.layer==='http')?'corrupt':wire&&requestEnd?.type==='request.completed'?'verified':'not_observed';
  for(const c of o.calls)c.httpStatus=o.httpStatus;
 }

 const actors=new Map<string,Row>();for(const w of works)actors.set(actorKey(w.actor),w.actor);
 if(actors.size!==2||new Set([...actors.values()].map(a=>a.role)).size!==2)violate('PROBE_ANALYSIS_ACTOR_SET_VIOLATION');
 if(starts.length>4)violate('PROBE_TOTAL_REQUEST_LIMIT_VIOLATION');
 const modelReceiptUse=[...actors.values()].map(actor=>{
  const ownWorks=works.filter(w=>sameActor(w.actor,actor)),work=ownWorks[0];
  if(starts.filter(s=>sameActor(s.actor,actor)).length>2)violate('PROBE_CONTEXT_REQUEST_LIMIT_VIOLATION',work);
  if(ownWorks.length!==1)violate('PROBE_EXTRA_TOOL_BATCH',work);
  const answers=rows.filter(r=>r.kind==='native'&&r.type==='model.answer'&&sameActor(r.actor,actor));
  const expectedReceipts=ownWorks.flatMap(w=>w.observation.calls.filter(c=>c.nativeStatus==='verified').map(c=>({toolName:c.toolName,receiptId:c.receiptId})));
  if(answers.length===0){missing('FINAL_MODEL_ANSWER_NOT_OBSERVED','model',work);return{actor:{...actor},status:'not_observed' as const,requestId:null,receipts:[]};}
  const answer=answers[0],value=object(answer.answer),parsed=ProtocolProbeV2AnswerSchema.safeParse(value);
  const completed=ends.filter(e=>sameActor(e.actor,actor)&&e.type==='request.completed'&&e.requestId===answer.requestId&&e.permitId===answer.permitId);
  const lastCall=ownWorks.flatMap(w=>[...w.nativeEnds.values()]).sort((a,b)=>a.index-b.index).at(-1);
  const bound=answers.length===1&&completed.length===1&&completed[0].index<answer.index&&(!lastCall||lastCall.index<answer.index);
  if(!parsed.success)violate('PROBE_MODEL_SCHEMA_VIOLATION',work);
  const valid=bound&&value?.runId===input.runId&&value?.challengeId===input.expected.challengeId&&value?.researcherId===input.expected.researcherId&&same(value?.receipts,expectedReceipts);
  if(!valid)violate('MODEL_RECEIPT_USE_MISMATCH',work,undefined,answer.requestId);
  return{actor:{...actor},status:valid?'verified' as const:'invalid' as const,requestId:typeof answer.requestId==='string'?answer.requestId:null,receipts:list(value?.receipts)};
 });
 const nativeCalls=works.flatMap(w=>w.observation.calls),observations=works.map(w=>w.observation);
 const record=object(input.record),cleanupConfirmed=input.cleanups.length>0&&input.cleanups.every(c=>object(c)?.runId===input.runId&&object(c)?.confirmed===true
  &&object(c)?.exit?.exitObserved===true&&object(c)?.exit?.closeObserved===true);
 const executionStatus=record?.status==='failed'||record?.status==='cancelled'?'failed':record?.status==='insufficient'?'successful':'unknown';
 return deepFreeze({analysisVersion:'protocol-probe-analysis-v3',historicalReclassification:false,publicationAuthority:false,
  taskContract:{valid:task.length===0,violations:task},
  native:{status:status(nativeCalls.map(c=>c.nativeStatus),corruption.some(f=>f.layer==='native')),completedCalls:works.reduce((n,w)=>n+w.nativeEnds.size,0)},
  context:{status:status(observations.map(b=>b.contextStatus),corruption.some(f=>f.layer==='context'))},
  http:{status:status(observations.map(b=>b.httpStatus),corruption.some(f=>f.layer==='http'))},
  directBindingCorruption:corruption,unobserved,batches:observations,modelReceiptUse,stopReasonCodes,
  execution:{status:executionStatus,cleanupConfirmed},
  interpretation:'Read-only versioned causality analysis; observed task deviation, absent evidence and direct binding contradictions are separate. Historical outcomes and approvals are unchanged; no semantic or human quality claim.'});
}
