import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {ModelMessageItem,SemanticEvent} from '@mozaik-ai/core';
import {z} from 'zod';
import {createTaskEngine} from '../../dist/server/runtime/task-context.js';
import {AnswerDiagnosticError} from '../../dist/server/runtime/answer-diagnostics.js';

// Actual installed Mozaik Runtime/Agent/Context and native model.answer events.
// All inference text and request IDs are explicitly controlled offline_fixture.
const key='offline-fixture-credential-do-not-record';
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const bounded=p=>Promise.race([p,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('OFFLINE_DIAGNOSTIC_TIMEOUT')),1500);timer.unref();})]);
function fixture(t,text,options={}){
 const runId=randomUUID(),controller=new AbortController(),diagnostics=[],events=[],requests=[],actors=[];
 const engine=createTaskEngine({runId,signal:controller.signal,model:'offline_fixture',tools:[],emit:e=>events.push(e),
  onNative:options.onNative,parseAnswer:options.parseAnswer,
  answerDiagnostics:{credential:key,maxCaptureBytes:options.maxCaptureBytes??4096,
   write:options.write??(async row=>{diagnostics.push(row);}),
   validate:options.validate??((_role,value)=>z.strictObject({ok:z.literal(true)}).parse(value))},
  runnerFactory:hooks=>({async run(request){const actor=hooks.resolveTask(request.context.id),requestId=randomUUID(),permitId=randomUUID();
   actors.push(actor);requests.push({requestId,permitId,actor});
   return{items:[ModelMessageItem.rehydrate({text:typeof text==='function'?text(actor):text})],tokenUsage:undefined,rowResponse:{requestId,permitId}};},async *stream(){throw Error('OFFLINE_NO_STREAM');}})});
 t.after(()=>{controller.abort();engine.dispose();});
 return{runId,controller,diagnostics,events,requests,actors,engine};
}
function bound(row,f){assert.equal(row.actor.runId,f.runId);const request=f.requests.find(r=>r.actor.contextId===row.actor.contextId);
 assert.ok(request);assert.deepEqual(row.request,{requestId:request.requestId,permitId:request.permitId});
 assert.deepEqual(row.actor,request.actor);}

test('native JSON parse failure captures safe original final text and precise JSON stage instead of observer fallback',async t=>{
 const f=fixture(t,'not json, offline_fixture');
 await assert.rejects(bounded(f.engine.startTask('proposer',{})),/ANSWER_JSON_PARSE_FAILED/);
 const captured=f.diagnostics.find(d=>d.stage==='answer_capture'),failed=f.diagnostics.find(d=>d.stage==='json_parse'&&d.status==='failed');
 assert.ok(captured&&failed);assert.equal(captured.capture.text,'not json, offline_fixture');assert.equal(captured.capture.sha256,hash(captured.capture.text));
 assert.equal(captured.capture.byteLength,Buffer.byteLength(captured.capture.text));assert.equal(captured.capture.truncated,false);bound(failed,f);
 assert.equal(f.events.some(e=>e.type==='task.failed'&&e.payload.code==='ANSWER_JSON_PARSE_FAILED'),true);
});

test('native schema failure preserves safe capture and controlled stage without exception text',async t=>{
 const f=fixture(t,'{"ok":false}',{validate:()=>{throw Error('PRIVATE_EXCEPTION_MUST_NOT_BE_RECORDED');}});
 await assert.rejects(bounded(f.engine.startTask('proposer',{})),/ANSWER_SCHEMA_INVALID/);
 const failed=f.diagnostics.find(d=>d.stage==='schema_validation'&&d.status==='failed');assert.ok(failed);bound(failed,f);
 assert.equal(f.diagnostics.find(d=>d.stage==='answer_capture').capture.text,'{"ok":false}');
 assert.equal(JSON.stringify(f.diagnostics).includes('PRIVATE_EXCEPTION'),false);
});

test('real asynchronous filesystem write rejection stops native task with evidence-write code and no success',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'einstein answer diagnostics '));
 t.after(async()=>{const r=relative(resolve(tmpdir()),resolve(folder));assert.ok(!isAbsolute(r)&&!r.startsWith('..')&&r.startsWith('einstein answer diagnostics '));await rm(folder,{recursive:true,force:true});});
 let writes=0;const f=fixture(t,'{"ok":true}',{write:async()=>{writes++;const h=await open(join(folder,'absent-parent','evidence.jsonl'),'a');await h.close();}});
 await assert.rejects(bounded(f.engine.startTask('proposer',{})),/ANSWER_EVIDENCE_WRITE_FAILED/);
 assert.equal(writes,1,'a failed diagnostic sink must not be recursively called to log its own failure');
 assert.equal(f.events.some(e=>e.type==='task.failed'&&e.payload.code==='ANSWER_EVIDENCE_WRITE_FAILED'),true);
});

test('positive native control settles only after capture/json/schema diagnostic acknowledgements and stays context-isolated',async t=>{
 const f=fixture(t,'{"ok":true}');const values=await bounded(Promise.all([f.engine.startTask('proposer',{}),f.engine.startTask('counter-evidence',{})]));
 assert.deepEqual(values,[{ok:true},{ok:true}]);assert.equal(f.requests.length,2);
 for(const actor of f.actors){const rows=f.diagnostics.filter(d=>d.actor?.contextId===actor.contextId);
  assert.ok(rows.some(d=>d.stage==='answer_capture'&&d.status==='captured'));
  assert.ok(rows.some(d=>d.stage==='json_parse'&&d.status==='passed'));
  assert.ok(rows.some(d=>d.stage==='schema_validation'&&d.status==='passed'));
  for(const row of rows)bound(row,f);
 }
 assert.equal(new Set(f.actors.map(a=>a.contextId)).size,2);
});

test('diagnosed native model.answer precedes application artifact parsing and completion side effects',async t=>{
 const order=[];const f=fixture(t,'{"ok":true}',{onNative:event=>{if(event.type==='model.answer')order.push('native-answer');},
  parseAnswer:(_role,value)=>{order.push('artifact-parse');return value;}});
 assert.deepEqual(await bounded(f.engine.startTask('proposer',{})),{ok:true});
 assert.deepEqual(order,['native-answer','artifact-parse'],'parent publication receipts require actual model.answer before artifact/task completion');
});

test('an unknown native answer hook failure is not mislabeled as model schema rejection',async t=>{
 const f=fixture(t,'{"ok":true}',{onNative:event=>{if(event.type==='model.answer')throw Error('PRIVATE_UNKNOWN_NATIVE_HOOK');}});
 await assert.rejects(bounded(f.engine.startTask('proposer',{})),/NATIVE_OBSERVER_FAILED/);
 const failure=f.diagnostics.find(d=>d.stage==='native_observer'&&d.status==='failed');assert.ok(failure);bound(failure,f);
 assert.equal(f.diagnostics.some(d=>d.stage==='schema_validation'&&d.status==='failed'),false);
 assert.equal(JSON.stringify(f.diagnostics).includes('PRIVATE_UNKNOWN_NATIVE_HOOK'),false);
});

test('credential checks inspect full original text before truncation and never retain reflected credentials',async t=>{
 const text='x'.repeat(80)+key;const f=fixture(t,text,{maxCaptureBytes:32});
 await assert.rejects(bounded(f.engine.startTask('proposer',{})),/ANSWER_CAPTURE_CREDENTIAL_REFLECTION/);
 const capture=f.diagnostics.find(d=>d.stage==='answer_capture').capture;
 assert.equal(capture.text,null);assert.equal(capture.omissionReason,'credential_reflection');assert.equal(capture.byteLength,Buffer.byteLength(text));
 assert.equal(JSON.stringify(f.diagnostics).includes(key),false);
});

test('JSON unicode-escaped credential values cannot bypass safe final-answer retention',async t=>{
 const escaped=[...key].map(ch=>'\\u'+ch.codePointAt(0).toString(16).padStart(4,'0')).join('');
 const text='{"ok":true,"unexpected":"'+escaped+'"}',f=fixture(t,text);
 await assert.rejects(bounded(f.engine.startTask('proposer',{})),/ANSWER_CAPTURE_CREDENTIAL_REFLECTION/);
 const capture=f.diagnostics.find(d=>d.stage==='answer_capture').capture;assert.equal(capture.text,null);assert.equal(capture.omissionReason,'credential_reflection');
 assert.equal(JSON.stringify(f.diagnostics).includes(escaped),false);
});

test('over-limit final text records UTF8-safe bounded prefix, hashes and truncation but cannot pass validation',async t=>{
 const text='😀'.repeat(20),f=fixture(t,text,{maxCaptureBytes:10});
 await assert.rejects(bounded(f.engine.startTask('proposer',{})),/ANSWER_CAPTURE_LIMIT/);
 const capture=f.diagnostics.find(d=>d.stage==='answer_capture').capture;
 assert.equal(capture.truncated,true);assert.equal(capture.byteLength,80);assert.equal(capture.savedByteLength,8);assert.equal(capture.text,'😀😀');
 assert.equal(capture.sha256,hash(text));assert.equal(capture.savedSha256,hash(capture.text));assert.equal(capture.omissionReason,'byte_limit');
});

test('explicit reasoning markers are omitted from final-answer diagnostics, not stored as a failed JSON body',async t=>{
 const f=fixture(t,'<think>PRIVATE_REASONING_SHOULD_NOT_BE_RECORDED</think>{"ok":true}');
 await assert.rejects(bounded(f.engine.startTask('proposer',{})),/ANSWER_CAPTURE_REASONING_OMITTED/);
 const capture=f.diagnostics.find(d=>d.stage==='answer_capture').capture;assert.equal(capture.text,null);assert.equal(capture.omissionReason,'reasoning_content');
 assert.equal(JSON.stringify(f.diagnostics).includes('PRIVATE_REASONING'),false);
});

test('cancel races a hung diagnostic sink, rejects promptly and fences late write acknowledgement',async t=>{
 let entered,release;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 const f=fixture(t,'{"ok":true}',{write:async()=>{entered();await gate;}});let settled=false;
 const pending=f.engine.startTask('proposer',{}).then(()=>{settled=true;return'accepted';},e=>{throw e;});
 await bounded(started);f.controller.abort();await assert.rejects(bounded(pending),/RUN_ABORTED/);release();await pause(25);
 assert.equal(settled,false);assert.equal(f.requests.length,1);
});

test('native identity failure records metadata without retaining forged answer payload or claiming fake actor',async t=>{
 let release;const gate=new Promise(r=>{release=r;}),diagnostics=[],controller=new AbortController(),events=[];
 const engine=createTaskEngine({runId:randomUUID(),signal:controller.signal,model:'offline_fixture',tools:[],emit:e=>events.push(e),
  answerDiagnostics:{credential:key,write:async row=>{diagnostics.push(row);}},
  runnerFactory:()=>({async run(){await gate;return{items:[ModelMessageItem.rehydrate({text:'{}'})],tokenUsage:undefined,rowResponse:null};},async *stream(){}})});
 t.after(()=>{release();controller.abort();engine.dispose();});
 const pending=engine.startTask('proposer',{});const rejected=assert.rejects(bounded(pending),/NATIVE_PRODUCER_MISMATCH/);
 engine.runtime.resolveRuntime().publish(new SemanticEvent('model.answer',randomUUID(),new Date(),{loopId:randomUUID(),answer:ModelMessageItem.rehydrate({text:key})}));
 await rejected;await pause(15);const failure=diagnostics.find(d=>d.stage==='native_identity');assert.ok(failure);assert.equal(failure.actor,null);assert.equal(failure.request,null);
 assert.equal(JSON.stringify(diagnostics).includes(key),false);
});

test('non-answer native hook preserves a trusted evidence-write error without changing the tool adapter',async t=>{
 const f=fixture(t,'{"ok":true}',{onNative:event=>{if(event.type==='inference.started')throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');}});
 await assert.rejects(bounded(f.engine.startTask('proposer',{})),/ANSWER_EVIDENCE_WRITE_FAILED/);
 assert.equal(f.events.some(e=>e.type==='task.failed'&&e.payload.code==='ANSWER_EVIDENCE_WRITE_FAILED'),true);
 assert.equal(f.events.some(e=>e.type==='model.answer'),false);
});

test('non-answer native hook never turns an unknown exception message into a trusted diagnostic code',async t=>{
 const f=fixture(t,'{"ok":true}',{onNative:event=>{if(event.type==='inference.started')throw Error('PRIVATE_NON_NATIVE_EXCEPTION');}});
 await assert.rejects(bounded(f.engine.startTask('proposer',{})),/NATIVE_OBSERVER_FAILED/);
 assert.equal(f.events.some(e=>e.type==='task.failed'&&e.payload.code==='NATIVE_OBSERVER_FAILED'),true);
 assert.equal(JSON.stringify(f.events).includes('PRIVATE_NON_NATIVE_EXCEPTION'),false);
});
