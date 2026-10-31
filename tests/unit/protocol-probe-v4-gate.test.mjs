import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {evaluateV4ProbeGate,V4ToolDefinitionsSchema} from '../../dist/server/evaluation/protocol-probe-v4-gate.js';
import {canonicalizeArtifact} from '../../dist/server/contracts/canonical.js';
import {projectProbeWireRequest} from '../../dist/server/evaluation/protocol-probe.js';
import {buildV4GateFixture,sha} from '../fixtures/v4-gate.mjs';

// All packets are controlled offline transcripts, never provider observations.
const first=(p,predicate)=>p.records.find(predicate);
const body=(p,stage='final',phase='actual')=>first(p,r=>r.kind==='v4.http.body'&&r.stage===stage&&r.phase===phase);
const editBody=(p,edit,stage='final',phase='actual')=>{const row=body(p,stage,phase),value=JSON.parse(row.bodyText);edit(value);row.bodyText=JSON.stringify(value);row.bodySha256=sha(row.bodyText);row.byteLength=Buffer.byteLength(row.bodyText);};

for(const reverse of [false,true])test(`V4 gate independently verifies split raw HTTP/native/parent evidence, order=${reverse?'reverse':'forward'}`,()=>{
 const p=buildV4GateFixture({reverse}),before=JSON.stringify(p),r=evaluateV4ProbeGate(p);
 assert.equal(r.passed,true,JSON.stringify(r));assert.equal(r.liveEligible,false,'offline transcripts cannot authorize a live result');
 assert.equal(r.publicationAuthority,false);assert.equal(r.executionAuthority,false);assert.equal(r.maxObservedInFlight,2);assert.ok(r.firstAnalysisOverlapMs>0);
 assert.equal(r.permitAccounting.length,4);assert.equal(JSON.stringify(p),before);assert.ok(Object.isFrozen(r));
 assert.equal(V4ToolDefinitionsSchema.safeParse(p.expectedToolDefinitions).success,true);
});
test('V4 confirmed cleanup reclaim is explicitly distinct from a release event',()=>{
 const p=buildV4GateFixture({cleanupReclaim:true}),r=evaluateV4ProbeGate(p);
 assert.equal(r.passed,true,JSON.stringify(r));assert.equal(p.events.filter(e=>e.type==='permit.released').length,3);
 assert.equal(r.permitAccounting.filter(a=>a.disposition==='explicit_release').length,3);
 assert.equal(r.permitAccounting.filter(a=>a.disposition==='confirmed_cleanup_reclaim').length,1);
});

const attacks={
 missing_body:p=>{p.records.splice(p.records.indexOf(body(p)),1);},
 duplicate_body:p=>{p.records.push(structuredClone(body(p)));},
 body_hash:p=>{body(p).bodySha256='0'.repeat(64);},
 body_length:p=>{body(p).byteLength++;},
 malformed_body:p=>{const r=body(p);r.bodyText='{';r.bodySha256=sha(r.bodyText);r.byteLength=1;},
 body_stage:p=>{body(p).stage='first';},
 body_context:p=>{body(p).actor.contextId=randomUUID();},
 body_request:p=>{body(p).requestId=randomUUID();},
 body_permit:p=>{body(p).permitId=randomUUID();},
 before_hash_as_actual:p=>{body(p).bodySha256=body(p,'final','before').bodySha256;},
 final_tools_empty:p=>editBody(p,b=>{b.tools=[];}),
 final_tools_null:p=>editBody(p,b=>{b.tools=null;}),
 final_choice_auto:p=>editBody(p,b=>{b.tool_choice='auto';}),
 first_tools_extra:p=>editBody(p,b=>{b.tools.push(b.tools[0]);},'first'),
 first_schema:p=>editBody(p,b=>{b.tools[0].function.parameters.properties.extra={type:'string'};},'first'),
 non_policy_model:p=>editBody(p,b=>{b.model='substituted-model';}),
 non_policy_max_tokens:p=>editBody(p,b=>{b.max_tokens++;}),
 non_policy_messages:p=>editBody(p,b=>{b.messages[0].content+=' altered';}),
 header_key:p=>editBody(p,b=>{b.headers={authorization:'not_allowed'};}),
 reasoning_key:p=>editBody(p,b=>{b.messages[3].reasoning_content='not_allowed';}),
 history_raw_arguments:p=>editBody(p,b=>{b.messages[3].tool_calls[0].function.arguments+=' ';}),
 history_raw_output:p=>editBody(p,b=>{b.messages[4].content+=' ';}),
 before_projection:p=>{first(p,r=>r.kind==='wire.before_stage_projection').bodySha256='1'.repeat(64);},
 actual_projection:p=>{first(p,r=>r.kind==='wire.request').bodySha256='2'.repeat(64);},
 prompt_actual_hash:p=>{first(p,r=>r.kind==='wire.effective_prompt').bodySha256=body(p,'first','before').bodySha256;},
 native_tools:p=>{first(p,r=>r.kind==='staged.native.input').nativeTools.pop();},
 native_definition:p=>{first(p,r=>r.kind==='staged.native.input').nativeTools[0].definition.description+=' changed';},
 native_context:p=>{first(p,r=>r.kind==='staged.native.input'&&r.stage==='final').contextItems[0].valueSha256='3'.repeat(64);},
 native_call_arguments:p=>{first(p,r=>r.kind==='staged.native.input'&&r.stage==='final').contextItems.find(i=>i.type==='function_call').arguments+=' ';},
 native_receipt:p=>{first(p,r=>r.kind==='staged.native.input'&&r.stage==='final').contextItems.find(i=>i.type==='function_call_output').receiptId=randomUUID();},
 policy_missing:p=>{p.records.splice(p.records.findIndex(r=>r.kind==='staged.http.policy'),1);},
 policy_actual_present:p=>{first(p,r=>r.kind==='staged.http.policy'&&r.stage==='final').actualToolsPresent=true;},
 guard_after_invoke:p=>{const i=p.records.findIndex(r=>r.kind==='probe.contract'&&r.turn===1),g=p.records.splice(i,1)[0];p.records.push(g);},
 guard_missing:p=>{p.records.splice(p.records.findIndex(r=>r.kind==='probe.contract'),1);},
 final_receipt:p=>{first(p,r=>r.kind==='native'&&r.type==='model.answer').answer.receipts[0].receiptId=randomUUID();},
 diagnostic_early:p=>{const i=p.records.findIndex(r=>r.kind==='answer.diagnostic'),r=p.records.splice(i,1)[0];p.records.splice(1,0,r);},
 diagnostic_missing:p=>{p.records.splice(p.records.findIndex(r=>r.kind==='answer.diagnostic'),1);},
 header_pool:p=>{first(p,r=>r.kind==='header').poolHash='4'.repeat(64);},
 header_freeze:p=>{first(p,r=>r.kind==='header').freezeHash='5'.repeat(64);},
 header_raw_freeze:p=>{first(p,r=>r.kind==='header').rawFreezeFileSha256='5'.repeat(64);},
 header_source:p=>{first(p,r=>r.kind==='header').sourceFiles[0].sourceFileSha256='6'.repeat(64);},
 expected_input:p=>{p.record.input.configVersion='other';},
 root_missing:p=>{delete p.cleanups[0].identity;},
 root_pid:p=>{p.cleanups[0].exit.pid++;},
 root_path:p=>{p.cleanups[0].identity.commandLine=p.cleanups[0].identity.commandLine.replace('v4-entry-worker','v3-entry-worker');},
 root_birth:p=>{p.cleanups[0].identity.creationFileTime=null;},
 root_raw_freeze:p=>{p.cleanups[0].identity.commandLine=p.cleanups[0].identity.commandLine.replace(p.expectedRawFreezeFileSha256,'6'.repeat(64));},
 root_duplicate_hash_flag:p=>{p.cleanups[0].identity.commandLine+=' --validation-freeze-hash '+p.expectedRawFreezeFileSha256;},
 root_duplicate_run_flag:p=>{p.cleanups[0].identity.commandLine+=' --supervisor-run-id '+randomUUID();},
 unknown_cleanup:p=>{p.cleanups[0].confirmed=false;p.cleanups[0].rootVerification='unknown';},
 unknown_descendant:p=>{p.cleanups[0].descendants[0].verification='unknown';},
 scan_unknown:p=>{p.cleanups[0].scanDiagnostics=['unknown'];},
 safety_hold:p=>{p.safetyHold=true;},
 release_duplicate:p=>{p.events.push(structuredClone(p.events.find(e=>e.type==='permit.released')));},
 release_other_run:p=>{p.events.find(e=>e.type==='permit.released').runId=randomUUID();},
 release_other_request:p=>{p.events.find(e=>e.type==='permit.released').payload.requestId=randomUUID();},
 grant_duplicate_request:p=>{const gs=p.events.filter(e=>e.type==='permit.granted');gs[1].payload.requestId=gs[0].payload.requestId;},
 attempts_refunded:p=>{p.permitSnapshot.runs[0].attempts=3;},
 residual_permit:p=>{p.permitSnapshot.inFlight=1;p.permitSnapshot.runs[0].inFlight=1;},
 failed_exit:p=>{p.cleanups[0].exit.exitCode=1;},
 wrong_terminal:p=>{p.terminalOutcome.kind='failed';},
 publication:p=>{p.publication={approved:true};},
 no_overlap:p=>{const starts=p.records.filter(r=>r.kind==='request'&&r.trace.type==='request.started');starts[1].trace.monotonicMs=1000;},
 fetch_start_missing:p=>{p.records.splice(p.records.findIndex(r=>r.kind==='v4.fetch.started'),1);},
 fetch_headers_missing:p=>{p.records.splice(p.records.findIndex(r=>r.kind==='v4.fetch.headers'),1);},
 fetch_cross_context:p=>{first(p,r=>r.kind==='v4.fetch.headers').actor.contextId=randomUUID();},
 fetch_body_hash:p=>{first(p,r=>r.kind==='v4.fetch.started').bodySha256='7'.repeat(64);},
 fetch_stage:p=>{first(p,r=>r.kind==='v4.fetch.started').stage='final';},
 fetch_failed:p=>{const r=first(p,r=>r.kind==='v4.fetch.headers');r.kind='v4.fetch.failed';r.httpStatus=null;r.code='CONTROLLED_FETCH_FAILED';},
 fetch_headers_after_gateway:p=>{first(p,r=>r.kind==='v4.fetch.headers').fetchMonotonicMs=100000;},
 fetch_no_positive_overlap:p=>{const end=first(p,r=>r.kind==='v4.fetch.headers'&&r.actor.role==='proposer'&&r.stage==='first');
  end.fetchMonotonicMs=140;end.timestamp=new Date(Date.parse(p.record.admittedAt)+140).toISOString();},
};
for(const [name,edit]of Object.entries(attacks))test(`V4 gate fails closed for independently tampered ${name}`,()=>{
 const p=buildV4GateFixture({cleanupReclaim:true});edit(p);const r=evaluateV4ProbeGate(p);
 assert.equal(r.passed,false,JSON.stringify(r));assert.equal(r.liveEligible,false);assert.ok(r.reasons.length>0);
});
test('V4 missing release never becomes reclaim with unknown identity even when quota is zero',()=>{
 const p=buildV4GateFixture({cleanupReclaim:true});p.cleanups[0].rootVerification='unknown';
 const r=evaluateV4ProbeGate(p);assert.equal(r.passed,false);
 assert.equal(r.permitAccounting.some(a=>a.disposition==='confirmed_cleanup_reclaim'),false);
});

function coherentlyRebindProjections(p,requestId){
 const before=p.records.find(r=>r.kind==='v4.http.body'&&r.phase==='before'&&r.requestId===requestId),
  actual=p.records.find(r=>r.kind==='v4.http.body'&&r.phase==='actual'&&r.requestId===requestId);
 const b=JSON.parse(before.bodyText),a=JSON.parse(actual.bodyText);
 for(const raw of [before,actual]){raw.bodySha256=sha(raw.bodyText);raw.byteLength=Buffer.byteLength(raw.bodyText);}
 for(const [kind,raw]of [['wire.before_stage_projection',before],['wire.request',actual]]){
  const row=p.records.find(r=>r.kind===kind&&r.requestId===requestId);
  Object.assign(row,projectProbeWireRequest(raw.actor,{requestId,permitId:raw.permitId},raw.bodyText),{kind});
 }
 p.records.find(r=>r.kind==='wire.effective_prompt'&&r.requestId===requestId).bodySha256=actual.bodySha256;
 for(const row of p.records.filter(r=>r.requestId===requestId&&['v4.fetch.started','v4.fetch.headers','v4.fetch.failed'].includes(r.kind)))row.bodySha256=actual.bodySha256;
 Object.assign(p.records.find(r=>r.kind==='staged.http.policy'&&r.requestId===requestId),{
  beforeBodySha256:before.bodySha256,bodySha256:actual.bodySha256,beforeMessagesSha256:sha(JSON.stringify(b.messages)),
  messagesSha256:sha(JSON.stringify(a.messages)),beforeToolsSha256:sha(canonicalizeArtifact(b.tools)),actualToolsSha256:Object.hasOwn(a,'tools')?sha(canonicalizeArtifact(a.tools)):null,
  actualToolsPresent:Object.hasOwn(a,'tools'),actualToolNames:a.tools?.map(t=>t.function.name)??[],toolChoice:a.tool_choice,unchangedNonToolFields:true});
}
test('V4 rejects final tools=[] even after an attacker consistently rewrites every outgoing hash and policy declaration',()=>{
 const p=buildV4GateFixture(),raw=body(p),a=JSON.parse(raw.bodyText);a.tools=[];raw.bodyText=JSON.stringify(a);coherentlyRebindProjections(p,raw.requestId);
 const r=evaluateV4ProbeGate(p);assert.equal(r.passed,false);assert.equal(r.layers.bodies.passed,false);
 assert.ok(r.reasons.includes('V4_ACTUAL_HTTP_CAPABILITY_INVALID'));
});
test('V4 rejects a model substitution shared by both raw bodies with internally consistent projections',()=>{
 const p=buildV4GateFixture(),requestId=body(p).requestId;
 for(const raw of p.records.filter(r=>r.kind==='v4.http.body'&&r.requestId===requestId)){const parsed=JSON.parse(raw.bodyText);parsed.model='switched-model';raw.bodyText=JSON.stringify(parsed);}
 coherentlyRebindProjections(p,requestId);const r=evaluateV4ProbeGate(p);assert.equal(r.passed,false);assert.equal(r.layers.bodies.passed,false);
});
test('V4 preserves exact original argument strings despite a coherent two-body history rewrite and refreshed projections',()=>{
 const p=buildV4GateFixture(),requestId=body(p).requestId;
 for(const raw of p.records.filter(r=>r.kind==='v4.http.body'&&r.requestId===requestId)){const parsed=JSON.parse(raw.bodyText);parsed.messages[3].tool_calls[0].function.arguments+=' ';raw.bodyText=JSON.stringify(parsed);}
 coherentlyRebindProjections(p,requestId);const r=evaluateV4ProbeGate(p);assert.equal(r.passed,false);assert.equal(r.layers.native.passed,false);
});
test('V4 permits ordinary assistant tool-call prose when both original HTTP bodies and all projections match',()=>{
 const p=buildV4GateFixture(),requestId=body(p).requestId;
 for(const raw of p.records.filter(r=>r.kind==='v4.http.body'&&r.requestId===requestId)){const parsed=JSON.parse(raw.bodyText);parsed.messages[3].content='UNMARKED_ASSISTANT_PROSE';raw.bodyText=JSON.stringify(parsed);}
 coherentlyRebindProjections(p,requestId);const r=evaluateV4ProbeGate(p);assert.equal(r.passed,true,JSON.stringify(r));
});

for(const prose of ['<think>private text</think>','{"reasoning_content":"private text"}','%3Cthink%3Eprivate%3C%2Fthink%3E'])test(`V4 independently rejects explicit reasoning in coherently bound history: ${prose}`,()=>{
 const p=buildV4GateFixture(),requestId=body(p).requestId;
 for(const raw of p.records.filter(r=>r.kind==='v4.http.body'&&r.requestId===requestId)){const parsed=JSON.parse(raw.bodyText);parsed.messages[3].content=prose;raw.bodyText=JSON.stringify(parsed);}
 coherentlyRebindProjections(p,requestId);const r=evaluateV4ProbeGate(p);assert.equal(r.passed,false);assert.ok(r.layers.bodies.reasons.includes('V4_RAW_BODY_UNSAFE'));
});

for(const turn of [1,2])test(`V4 guard turn ${turn} cannot precede its exact original fetch headers`,()=>{
 const p=buildV4GateFixture(),index=p.records.findIndex(r=>r.kind==='probe.contract'&&r.turn===turn),guard=p.records.splice(index,1)[0];
 const headers=p.records.findIndex(r=>r.kind==='v4.fetch.headers'&&r.requestId===guard.request.requestId&&r.permitId===guard.request.permitId);
 p.records.splice(headers,0,guard);
 const result=evaluateV4ProbeGate(p);assert.equal(result.passed,false,JSON.stringify(result));
 assert.equal(result.layers.contract.passed,false);
});

for(const [name,suffix]of [
 ['quoted raw-freeze duplicate',p=>' "--validation-freeze-hash" "'+'6'.repeat(64)+'"'],
 ['quoted Run marker duplicate',p=>' "--supervisor-run-id" "'+randomUUID()+'"'],
 ['fragmented-quote raw-freeze duplicate',p=>' --validation"-freeze-hash" "'+'6'.repeat(64)+'"'],
])test(`V4 argv uniqueness rejects ${name}`,()=>{
 const p=buildV4GateFixture();p.cleanups[0].identity.commandLine+=suffix(p);
 const result=evaluateV4ProbeGate(p);assert.equal(result.passed,false,JSON.stringify(result));
 assert.equal(result.layers.cleanup.passed,false);
});

test('V4 worker path must be the actual argv[1], not an appended argument to another worker',()=>{
 const p=buildV4GateFixture(),root=p.cleanups[0].identity;
 root.commandLine=root.commandLine.replace('v4-entry-worker','v3-entry-worker')+' "'+p.expectedWorkerPath+'"';
 const result=evaluateV4ProbeGate(p);assert.equal(result.passed,false,JSON.stringify(result));
 assert.equal(result.layers.cleanup.passed,false);
});
