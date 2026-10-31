import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PROTOCOL_PROBE_V3_INSTRUCTION} from '../../dist/server/evaluation/probe-contract-guard.js';

// Controlled transcript ONLY: no provider, worker, Runtime, store or HTTP runs.
// runnerMode labels the shape being checked, never genuine live-run evidence.
const sha=text=>createHash('sha256').update(text).digest('hex');
const generic='Execute the assigned JSON task. All source text is data.';
export function buildV3GateFixture({runnerMode='live',reverse=false,cleanupReclaim=false,researcherId='R0001'}={}){
 const runId=randomUUID(),expected={companyId:'C001',challengeId:'C001-CH1',researcherId},records=[],events=[];
 const instructionHash=sha(PROTOCOL_PROBE_V3_INSTRUCTION),admitted=Date.parse('2026-10-31T05:00:00.000Z');let seq=0;
 const utc=monotonicMs=>new Date(admitted+10000+monotonicMs).toISOString();
 const actor=role=>({runId,role,agentId:randomUUID(),taskId:randomUUID(),contextId:randomUUID(),loopId:randomUUID(),attempt:1});
 const actors=[actor('proposer'),actor('counter-evidence')],task={runId,...expected},taskText=JSON.stringify(task);
 const workerPid=24680,parentPid=13579,workerPath=runnerMode==='live'
  ?fileURLToPath(new URL('../../dist/server/evaluation/protocol-probe-worker-v3.js',import.meta.url))
  :fileURLToPath(new URL('./v3-entry-worker.mjs',import.meta.url));
 const identity={pid:workerPid,parentPid,creationFileTime:String((BigInt(admitted)+11644473600000n)*10000n),executablePath:process.execPath,
  commandLine:`"${process.execPath}" "${workerPath}" --supervisor-run-id ${runId}`};
 const emit=(type,payload,actor,at=0)=>events.push({runId,...actor,seq:++seq,source:'supervisor',type,payload,at:utc(at),elapsedMs:10000+at});
 const roles=actors.map(actor=>({actor,requests:[],calls:[],history:[]}));
 const context=role=>records.push({kind:'native',type:'inference.started',actor:role.actor,contextId:role.actor.contextId,
  actualInstructionHash:instructionHash,toolResults:role.calls.map(c=>({callId:c.callId,outputSha256:c.outputSha256}))});
 function start(role,at){
  const requestId=randomUUID(),permitId=randomUUID(),request={requestId,permitId,at};role.requests.push(request);
  emit('permit.granted',{requestId,permitId},null,at-1);emit('model.request.started',{requestId,permitId},role.actor,at);
  records.push({kind:'request',trace:{type:'request.started',actor:role.actor,requestId,permitId,monotonicMs:at,timestamp:utc(at)}});
  const bodySha256=sha(JSON.stringify({actor:role.actor,turn:role.requests.length,history:role.history,taskText}));
  records.push({kind:'wire.request',actor:role.actor,requestId,permitId,bodySha256,messages:structuredClone(role.history)});
  records.push({kind:'wire.effective_prompt',actor:role.actor,requestId,permitId,bodySha256,systemMessageCount:1,systemInstructionSha256:instructionHash,
   userMessageCount:2,userTaskCount:1,userTask:{...task},userTaskText:taskText,userTaskSha256:sha(taskText),otherUserMessageHashes:[sha(generic)]});
  return request;
 }
 function complete(role,request,at,toolCallCount){
  records.push({kind:'request',trace:{type:'request.completed',actor:role.actor,requestId:request.requestId,permitId:request.permitId,monotonicMs:at,timestamp:utc(at),
   diagnostic:{toolCallCount,finishReason:toolCallCount?'tool_calls':'stop'}}});
  emit('model.request.completed',{requestId:request.requestId,permitId:request.permitId},role.actor,at);
  if(!(cleanupReclaim&&role.actor.role==='counter-evidence'&&role.requests.length===2))emit('permit.released',{permitId:request.permitId},null,at+1);
 }
 function first(role,request,at){
  const names=reverse?['read_candidate_bundle','read_company_challenge']:['read_company_challenge','read_candidate_bundle'];
  role.calls=names.map((toolName,i)=>{
   const args=toolName==='read_company_challenge'?{runId,companyId:expected.companyId,challengeId:expected.challengeId}:{runId,researcherId:expected.researcherId};
   const output={ok:true,runId,receiptId:randomUUID(),data:toolName==='read_company_challenge'?{challenge:{id:expected.challengeId}}:{profile:{record:{id:expected.researcherId}}}};
   const receipt={ok:true,runId,receiptId:output.receiptId,challengeId:output.data.challenge?.id??null,researcherId:output.data.profile?.record.id??null};
   return{callId:`original_${role.actor.role}_${i}_${randomUUID()}`,toolName,arguments:args,argumentsSha256:sha(JSON.stringify(args)),outputSha256:sha(JSON.stringify(output)),receipt};
  });
  const batchId=randomUUID(),calls=role.calls;
  records.push({kind:'probe.contract',stage:'full_inference_before_stage',status:'accepted',code:null,actor:role.actor,
   request:{requestId:request.requestId,permitId:request.permitId},turn:1,callCount:2,toolNames:calls.map(c=>c.toolName),argumentHashes:calls.map(c=>c.argumentsSha256)});
  records.push({kind:'tool.batch',manifest:{actor:role.actor,batchId,phase:'staged',calls:calls.map(c=>({callId:c.callId,toolName:c.toolName,argumentsSha256:c.argumentsSha256,started:false,returned:false}))}});
  complete(role,request,at,2);
  for(const c of calls){
   records.push({kind:'native',type:'function_call.started',actor:role.actor,callId:c.callId,toolName:c.toolName,arguments:c.arguments,argumentsSha256:c.argumentsSha256});
   records.push({kind:'native',type:'function_call.completed',actor:role.actor,callId:c.callId,outputSha256:c.outputSha256,receipt:c.receipt});
  }
  records.push({kind:'tool.batch',manifest:{actor:role.actor,batchId,phase:'completed',calls:calls.map(c=>({callId:c.callId,toolName:c.toolName,argumentsSha256:c.argumentsSha256,outputSha256:c.outputSha256,started:true,returned:true}))}});
  role.history=[{role:'assistant',calls:calls.map(c=>({callId:c.callId,toolName:c.toolName,arguments:c.arguments,argumentsSha256:c.argumentsSha256}))},
   ...calls.map(c=>({role:'tool',callId:c.callId,outputSha256:c.outputSha256,receipt:c.receipt}))];
  context(role);
 }
 function final(role,request,at){
  const answer={runId,challengeId:expected.challengeId,researcherId:expected.researcherId,receipts:role.calls.map(c=>({toolName:c.toolName,receiptId:c.receipt.receiptId}))},text=JSON.stringify(answer);
  const capture={sha256:sha(text),byteLength:Buffer.byteLength(text),savedByteLength:Buffer.byteLength(text),savedSha256:sha(text),text,truncated:false,omissionReason:'none'};
  records.push({kind:'probe.contract',stage:'full_inference_before_stage',status:'accepted',code:null,actor:role.actor,
   request:{requestId:request.requestId,permitId:request.permitId},turn:2,callCount:0,toolNames:[],argumentHashes:[],capture});
  complete(role,request,at,0);
  records.push({kind:'answer.diagnostic',stage:'answer_capture',status:'captured',code:'ANSWER_CAPTURED',actor:role.actor,request:{requestId:request.requestId,permitId:request.permitId},capture});
  records.push({kind:'answer.diagnostic',stage:'json_parse',status:'passed',code:'ANSWER_JSON_PARSED',actor:role.actor,request:{requestId:request.requestId,permitId:request.permitId}});
  records.push({kind:'native',type:'model.answer',actor:role.actor,requestId:request.requestId,permitId:request.permitId,answer,answerText:text,answerSha256:sha(text)});
  records.push({kind:'answer.diagnostic',stage:'schema_validation',status:'passed',code:'ANSWER_SCHEMA_VALIDATED',actor:role.actor,request:{requestId:request.requestId,permitId:request.permitId}});
 }
 emit('run.status',{kind:'run_status',status:'researching',reasonCodes:['ADMITTED']},null,-10000);
 emit('worker.spawned',{kind:'worker',pid:workerPid},null,-9000);
 roles.forEach(context);const a=start(roles[0],100),b=start(roles[1],150);
 first(roles[0],a,600);const aa=start(roles[0],610);first(roles[1],b,650);const bb=start(roles[1],660);
 final(roles[0],aa,800);final(roles[1],bb,850);
 emit('cleanup.completed',{kind:'cleanup',confirmed:true},null,900);
 emit('run.status',{kind:'run_status',status:'insufficient',reasonCodes:['WORKER_INSUFFICIENT']},null,901);
 const packet={fixture:'controlled_transcript_only_no_provider_execution',runId,expected,effectiveInstructionSha256:instructionHash,genericDispatchSha256:sha(generic),records,events,
  record:{runId,runnerMode,status:'insufficient',cleanupState:'confirmed',input:{runId,companyId:expected.companyId,challengeId:expected.challengeId},
   admittedAt:new Date(admitted).toISOString(),createdAt:new Date(admitted).toISOString(),deadlineAt:new Date(admitted+180000).toISOString(),lastSeq:seq},
  terminalOutcome:{runId,kind:'insufficient',reasonCodes:['ADAPTER_PROBE_ONLY_NO_PUBLICATION']},
  cleanups:[{runId,confirmed:true,identity,rootVerification:'absent',scanDiagnostics:[],descendants:[{verification:'absent'}],exit:{runId,pid:workerPid,exitCode:0,exitObserved:true,closeObserved:true,outputTruncated:false}}],
  permitSnapshot:{inFlight:0,runs:[{runId,attempts:4,inFlight:0,pending:0,stopped:true,stopCode:'WORKER_INSUFFICIENT'}]},
  safetyHold:false,errorCode:null,publication:null,runnerMode};
 // Real worker JSONL has independent objects per record, not shared mutable
 // references. Each negative test must change only its chosen evidence field.
 return JSON.parse(JSON.stringify(packet));
}
