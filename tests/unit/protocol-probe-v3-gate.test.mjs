import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {evaluateV3ProbeGate} from '../../dist/server/evaluation/protocol-probe-v3-gate.js';
import {buildV3GateFixture} from '../fixtures/v3-gate.mjs';

// Pure, controlled transcripts ONLY. These tests execute no provider, worker,
// Runtime, store or L05. A counter callback checks conditional sequencing only.
const first=(p,predicate)=>p.records.find(predicate),starts=p=>p.records.filter(r=>r.kind==='request'&&r.trace.type==='request.started');
const nativeStart=p=>first(p,r=>r.type==='function_call.started'),nativeAnswer=p=>first(p,r=>r.type==='model.answer');
const prompt=p=>first(p,r=>r.kind==='wire.effective_prompt'),guard=p=>first(p,r=>r.kind==='probe.contract');
const diagnostic=p=>first(p,r=>r.kind==='answer.diagnostic'&&r.stage==='answer_capture');
const changeActor=(row,key='contextId')=>{row.actor={...row.actor,[key]:randomUUID()};};
const conditionalL05=(input,callback)=>{const result=evaluateV3ProbeGate(input);if(result.passed&&result.liveEligible)callback();return result;};

for(const reverse of [false,true])test(`controlled v3 gate requires all layers, and original supplier order may be reversed: ${reverse}`,()=>{
 const p=buildV3GateFixture({reverse}),before=JSON.stringify(p),r=evaluateV3ProbeGate(p);
 assert.equal(r.passed,true,JSON.stringify(r));assert.equal(r.liveEligible,true);assert.deepEqual(r.reasons,[]);
 assert.equal(r.publicationAuthority,false);assert.equal(r.executionAuthority,false);assert.equal(r.analysis.analysisVersion,'protocol-probe-analysis-v3');
 assert.equal(r.analysis.native.completedCalls,4);assert.equal(r.analysis.http.status,'verified');assert.equal(r.firstAnalysisOverlapMs,450);
 assert.ok(Object.values(r.layers).every(layer=>layer.passed===true));assert.equal(r.permitAccounting.filter(p=>p.disposition==='explicit_release').length,4);
 assert.equal(JSON.stringify(p),before);assert.ok(Object.isFrozen(r));
});

test('offline_fixture evidence can pass its engineering gate but cannot authorize a live L05 callback',()=>{
 const p=buildV3GateFixture({runnerMode:'offline_fixture'});let callbacks=0;const r=conditionalL05(p,()=>callbacks++);
 assert.equal(r.passed,true,JSON.stringify(r));assert.equal(r.liveEligible,false);assert.equal(callbacks,0);assert.equal(r.runnerMode,'offline_fixture');
});

test('confirmed cleanup reclaim remains a distinct disposition, never a fabricated release event',()=>{
 const p=buildV3GateFixture({cleanupReclaim:true}),before=p.events.filter(e=>e.type==='permit.released').length,r=evaluateV3ProbeGate(p);
 assert.equal(r.passed,true,JSON.stringify(r));assert.equal(before,3);assert.equal(p.events.filter(e=>e.type==='permit.released').length,3);
 assert.equal(r.permitAccounting.filter(a=>a.disposition==='explicit_release').length,3);assert.equal(r.permitAccounting.filter(a=>a.disposition==='confirmed_cleanup_reclaim').length,1);
});

const mutations={
 run_id:p=>{p.runId=randomUUID();},
 expected_challenge:p=>{p.expected.challengeId='C009-CH1';},
 mode_mismatch:p=>{p.record.runnerMode='offline_fixture';},
 missing_counter:p=>{p.records=p.records.filter(r=>r.actor?.role!=='counter-evidence'&&r.trace?.actor?.role!=='counter-evidence'&&r.manifest?.actor?.role!=='counter-evidence');},
 extra_request:p=>{p.records.push(structuredClone(starts(p)[0]));},
 missing_http:p=>{p.records.splice(p.records.findIndex(r=>r.kind==='wire.request'),1);},
 request_actor:p=>{const s=starts(p)[0];s.trace.actor={...s.trace.actor,taskId:randomUUID()};},
 duplicate_request_id:p=>{const s=starts(p);s[1].trace.requestId=s[0].trace.requestId;},
 duplicate_actor_context:p=>{const s=starts(p);const a=s[0].trace.actor,b=s.find(r=>r.trace.actor.role!==a.role).trace.actor;b.contextId=a.contextId;},
 serial_first_requests:p=>{const s=starts(p).find(r=>r.trace.actor.role==='counter-evidence');s.trace.monotonicMs=605;s.trace.timestamp=new Date(Date.parse(p.record.admittedAt)+10605).toISOString();},
 global_concurrency:p=>{const s=starts(p).filter(r=>r.trace.actor.role==='proposer')[1];s.trace.monotonicMs=200;s.trace.timestamp=new Date(Date.parse(p.record.admittedAt)+10200).toISOString();},
 request_timeout:p=>{const a=starts(p)[0].trace,e=first(p,r=>r.kind==='request'&&r.trace.type==='request.completed'&&r.trace.requestId===a.requestId).trace;e.monotonicMs=a.monotonicMs+40001;e.timestamp=new Date(Date.parse(a.timestamp)+40001).toISOString();},
 run_deadline:p=>{p.record.deadlineAt=new Date(Date.parse(p.record.admittedAt)+179999).toISOString();},
 request_before_admission:p=>{starts(p)[0].trace.timestamp=new Date(Date.parse(p.record.admittedAt)-1).toISOString();},
 request_after_deadline:p=>{const e=first(p,r=>r.kind==='request'&&r.trace.type==='request.completed');e.trace.timestamp=new Date(Date.parse(p.record.deadlineAt)+1).toISOString();},
 native_output_hash:p=>{first(p,r=>r.type==='function_call.completed').outputSha256='0'.repeat(64);},
 native_instruction:p=>{first(p,r=>r.type==='inference.started').actualInstructionHash='0'.repeat(64);},
 missing_initial_context:p=>{p.records.splice(p.records.findIndex(r=>r.type==='inference.started'),1);},
 extra_batch:p=>{p.records.push(structuredClone(first(p,r=>r.kind==='tool.batch'&&r.manifest.phase==='staged')));},
 wrong_first_tools:p=>{first(p,r=>r.kind==='tool.batch'&&r.manifest.phase==='staged').manifest.calls[1].toolName='read_company_challenge';},
 missing_guard:p=>{p.records.splice(p.records.findIndex(r=>r.kind==='probe.contract'),1);},
 duplicate_guard:p=>{p.records.push(structuredClone(guard(p)));},
 rejected_guard:p=>{guard(p).status='rejected';guard(p).code='PROBE_CONTRACT_FIRST_BATCH_COUNT';},
 guard_stage:p=>{guard(p).stage='after_execution';},
 guard_request:p=>{guard(p).request.requestId=randomUUID();},
 guard_context:p=>changeActor(guard(p)),
 guard_tool_order:p=>{guard(p).toolNames.reverse();},
 guard_argument_hash:p=>{guard(p).argumentHashes[0]='0'.repeat(64);},
 late_first_guard:p=>{const r=guard(p);p.records.splice(p.records.indexOf(r),1);p.records.splice(p.records.indexOf(nativeStart(p))+1,0,r);},
 late_final_guard:p=>{const r=first(p,r=>r.kind==='probe.contract'&&r.turn===2);p.records.splice(p.records.indexOf(r),1);p.records.splice(p.records.indexOf(nativeAnswer(p))+1,0,r);},
 final_guard_tools:p=>{first(p,r=>r.kind==='probe.contract'&&r.turn===2).callCount=1;},
 missing_guard_capture:p=>{delete first(p,r=>r.kind==='probe.contract'&&r.turn===2).capture;},
 missing_prompt:p=>{p.records.splice(p.records.findIndex(r=>r.kind==='wire.effective_prompt'),1);},
 duplicate_prompt:p=>{p.records.push(structuredClone(prompt(p)));},
 prompt_body_hash:p=>{prompt(p).bodySha256='0'.repeat(64);},
 prompt_actor:p=>changeActor(prompt(p)),
 prompt_request:p=>{prompt(p).requestId=randomUUID();},
 prompt_system_count:p=>{prompt(p).systemMessageCount=2;},
 prompt_system_hash:p=>{prompt(p).systemInstructionSha256='0'.repeat(64);},
 prompt_user_count:p=>{prompt(p).userMessageCount=3;},
 prompt_user_task_count:p=>{prompt(p).userTaskCount=2;},
 prompt_task_id:p=>{prompt(p).userTask.researcherId='R9999';},
 prompt_task_extra_key:p=>{prompt(p).userTask.pool=[];},
 prompt_raw_hash:p=>{prompt(p).userTaskSha256='0'.repeat(64);},
 prompt_raw_text:p=>{prompt(p).userTaskText='{"runId":"other"}';},
 prompt_other_user:p=>{prompt(p).otherUserMessageHashes=['0'.repeat(64)];},
 frozen_generic_hash:p=>{p.genericDispatchSha256='0'.repeat(64);},
 frozen_instruction_hash:p=>{p.effectiveInstructionSha256='0'.repeat(64);},
 missing_answer:p=>{p.records.splice(p.records.indexOf(nativeAnswer(p)),1);},
 extra_answer:p=>{p.records.push(structuredClone(nativeAnswer(p)));},
 answer_receipt:p=>{nativeAnswer(p).answer.receipts[0].receiptId=randomUUID();},
 answer_extra_field:p=>{nativeAnswer(p).answer.approved=true;},
 answer_raw_text:p=>{nativeAnswer(p).answerText+=' ';},
 answer_request:p=>{nativeAnswer(p).requestId=randomUUID();},
 missing_json_diagnostic:p=>{p.records.splice(p.records.findIndex(r=>r.kind==='answer.diagnostic'&&r.stage==='json_parse'),1);},
 duplicate_json_diagnostic:p=>{p.records.push(structuredClone(first(p,r=>r.kind==='answer.diagnostic'&&r.stage==='json_parse')));},
 diagnostic_failed:p=>{first(p,r=>r.kind==='answer.diagnostic'&&r.stage==='schema_validation').status='failed';},
 diagnostic_request:p=>{diagnostic(p).request.requestId=randomUUID();},
 diagnostic_permit:p=>{diagnostic(p).request.permitId=randomUUID();},
 diagnostic_actor:p=>changeActor(diagnostic(p)),
 capture_length:p=>{diagnostic(p).capture.byteLength++;},
 capture_saved_hash:p=>{diagnostic(p).capture.savedSha256='0'.repeat(64);},
 capture_truncated:p=>{diagnostic(p).capture.truncated=true;},
 capture_credential_omission:p=>{diagnostic(p).capture.omissionReason='credential_reflection';},
 evidence_write_failure:p=>{p.records.push({kind:'answer.diagnostic',stage:'evidence_write',status:'failed',code:'ANSWER_EVIDENCE_WRITE_FAILED'});},
 terminal_run:p=>{p.terminalOutcome.runId=randomUUID();},
 terminal_approved:p=>{p.terminalOutcome.kind='reviewed';},
 terminal_reason:p=>{p.terminalOutcome.reasonCodes=['APPROVED'];},
 record_status:p=>{p.record.status='approved';},
 record_cleanup:p=>{p.record.cleanupState='unconfirmed';},
 error_code:p=>{p.errorCode='EVIDENCE_WRITE_FAILED';},
 publication:p=>{p.publication={approved:true};},
 artifact:p=>{p.records.push({kind:'artifact',artifact:{kind:'proposal'}});},
 review_event:p=>{p.events.push({runId:p.runId,seq:p.events.length+1,type:'review.completed',payload:{}});},
 permit_residual:p=>{p.permitSnapshot.inFlight=1;},
 pending_permit:p=>{p.permitSnapshot.runs[0].pending=1;},
 attempts:p=>{p.permitSnapshot.runs[0].attempts=5;},
 safety_hold:p=>{p.safetyHold=true;},
 missing_grant:p=>{p.events.splice(p.events.findIndex(e=>e.type==='permit.granted'),1);},
 duplicate_grant:p=>{p.events.push({...structuredClone(p.events.find(e=>e.type==='permit.granted')),seq:p.events.length+1});},
 parent_request_actor:p=>{const e=p.events.find(e=>e.type==='model.request.started');e.contextId=randomUUID();},
 duplicate_release:p=>{p.events.push({...structuredClone(p.events.find(e=>e.type==='permit.released')),seq:p.events.length+1});},
 foreign_release:p=>{p.events.find(e=>e.type==='permit.released').payload.permitId=randomUUID();},
 foreign_release_run:p=>{p.events.find(e=>e.type==='permit.released').runId=randomUUID();},
 early_release:p=>{const g=p.events.find(e=>e.type==='permit.granted'),r=p.events.find(e=>e.type==='permit.released');r.seq=g.seq-1;},
 missing_cleanup_event:p=>{p.events.splice(p.events.findIndex(e=>e.type==='cleanup.completed'),1);},
 cleanup_unknown:p=>{p.cleanups[0].confirmed=false;},
 cleanup_root_present:p=>{p.cleanups[0].rootVerification='same_identity';},
 cleanup_scan_unknown:p=>{p.cleanups[0].scanDiagnostics=['SCAN_UNCONFIRMED'];},
 cleanup_descendant_unknown:p=>{p.cleanups[0].descendants[0].verification='unknown';},
 cleanup_close_missing:p=>{p.cleanups[0].exit.closeObserved=false;},
 cleanup_exit_nonzero:p=>{p.cleanups[0].exit.exitCode=1;},
 cleanup_truncated:p=>{p.cleanups[0].exit.outputTruncated=true;},
 cleanup_other_run:p=>{p.cleanups[0].runId=randomUUID();},
 duplicate_cleanup:p=>{p.cleanups.push(structuredClone(p.cleanups[0]));},
};
for(const [name,mutate] of Object.entries(mutations))test(`controlled transcript ${name} blocks L05 callback`,()=>{
 const p=buildV3GateFixture();mutate(p);const before=JSON.stringify(p);let callbackCount=0;
 const r=conditionalL05(p,()=>callbackCount++);assert.equal(r.passed,false,`${name}: ${JSON.stringify(r)}`);assert.equal(r.liveEligible,false);
 assert.equal(callbackCount,0,name);assert.ok(r.reasons.length>0,name);assert.equal(r.publicationAuthority,false);assert.equal(JSON.stringify(p),before);
});

test('exit failure blocks execution while observed identity cleanup remains confirmed',()=>{
 const p=buildV3GateFixture();p.cleanups[0].exit.exitCode=1;const r=evaluateV3ProbeGate(p);
 assert.equal(r.passed,false);assert.equal(r.layers.cleanup.passed,true);assert.equal(r.layers.execution.passed,false);
});

test('cleanup reclaim cannot cover an unresolved cleanup identity or safety hold',()=>{
 for(const mutate of [p=>{p.cleanups[0].rootVerification='unknown';},p=>{p.safetyHold=true;},p=>{p.permitSnapshot.runs[0].inFlight=1;}]){
  const p=buildV3GateFixture({cleanupReclaim:true});mutate(p);let callbacks=0;assert.equal(conditionalL05(p,()=>callbacks++).passed,false);assert.equal(callbacks,0);
 }
});

test('cleanup preceding grants cannot justify reclaim of reservations acquired afterward',()=>{
 const p=buildV3GateFixture({cleanupReclaim:true}),i=p.events.findIndex(e=>e.type==='cleanup.completed'),cleanup=p.events.splice(i,1)[0];
 p.events.splice(1,0,cleanup);p.events.forEach((e,i)=>{e.seq=i+1;});p.record.lastSeq=p.events.length;
 let callbacks=0;const r=conditionalL05(p,()=>callbacks++);assert.equal(r.passed,false,JSON.stringify(r));assert.equal(callbacks,0);
});

test('an earlier failed terminal event cannot be reopened by the later insufficient record',()=>{
 const p=buildV3GateFixture(),i=p.events.findLastIndex(e=>e.type==='run.status'),failed=structuredClone(p.events[i]);
 failed.payload.status='failed';failed.payload.reasonCodes=['WORKER_FAILED'];p.events.splice(i,0,failed);
 p.events.forEach((e,i)=>{e.seq=i+1;});p.record.lastSeq=p.events.length;
 let callbacks=0;const r=conditionalL05(p,()=>callbacks++);assert.equal(r.passed,false,JSON.stringify(r));assert.equal(callbacks,0);
});

test('future-request diagnostic IDs cannot authenticate capture recorded before that request begins',()=>{
 const p=buildV3GateFixture(),actor=nativeAnswer(p).actor,selected=p.records.filter(r=>r.kind==='answer.diagnostic'&&r.actor.contextId===actor.contextId);
 p.records=p.records.filter(r=>!selected.includes(r));
 const second=p.records.filter(r=>r.kind==='request'&&r.trace.type==='request.started'&&r.trace.actor.contextId===actor.contextId)[1];
 p.records.splice(p.records.indexOf(second),0,...selected);
 let callbacks=0;const r=conditionalL05(p,()=>callbacks++);assert.equal(r.passed,false,JSON.stringify(r));assert.equal(callbacks,0);
});

for(const fault of ['missing_identity','identity_pid','exit_pid','wrong_run_marker','missing_native_birth','missing_spawn','spawn_pid'])
 test(`recorded worker identity chain ${fault} cannot qualify its cleanup`,()=>{
  const p=buildV3GateFixture(),c=p.cleanups[0],spawn=p.events.find(e=>e.type==='worker.spawned');
  if(fault==='missing_identity')delete c.identity;
  if(fault==='identity_pid')c.identity.pid++;
  if(fault==='exit_pid')c.exit.pid++;
  if(fault==='wrong_run_marker')c.identity.commandLine=c.identity.commandLine.replace(p.runId,randomUUID());
  if(fault==='missing_native_birth')delete c.identity.creationFileTime;
  if(fault==='missing_spawn')p.events.splice(p.events.indexOf(spawn),1);
  if(fault==='spawn_pid')spawn.payload.pid++;
  let callbacks=0;const r=conditionalL05(p,()=>callbacks++);assert.equal(r.passed,false,JSON.stringify(r));assert.equal(callbacks,0);
 });
