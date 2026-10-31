import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEvent, runPresentation, isTerminal, publicationVisible, requestSpans, sourceHighlight, acceptRun, emptyResult, answerDiagnostics } from '../../web/src/state.ts';

const id='11111111-1111-4111-8111-111111111111';
const hash='a'.repeat(64),reviewHash='b'.repeat(64);
const run=(status='researching')=>({runId:id,status,lastSeq:0,input:{runId:id,companyId:'C001',challengeId:'C001-CH1',mode:'research'},runnerMode:'live',cleanupState:'pending'});
const event=(seq,type='review.completed',extra={})=>({schemaVersion:1,runId:id,seq,type,source:'application',at:'2026-10-31T10:00:00.000Z',elapsedMs:seq*10,payload:{kind:'review_ref',verdict:'approve'},...extra});

test('a held service marks an unfinished run interrupted without changing its stored status or completed results',()=>{
 const original=run('researching');assert.equal(runPresentation(original,true).title,'Analysis interrupted');assert.equal(original.status,'researching');
 assert.equal(runPresentation(run('approved'),true).title,'Analysis approved');
 assert.equal(runPresentation(run('failed'),true).title,'Analysis failed');
});

test('failed answers remain failed, with a concise primary message and no insufficient substitution',()=>{
 const p=runPresentation(run('failed'));assert.equal(p.title,'Analysis failed');assert.equal(p.tone,'error');assert.ok(!p.description.includes('Insufficient'));
 assert.equal(runPresentation(run('insufficient')).title,'Insufficient evidence');
 assert.equal(runPresentation(run('cancelled')).title,'Analysis cancelled');
 assert.equal(isTerminal('approved'),true);assert.equal(isTerminal('reviewing'),false);
});
test('a model approval or cleanup event cannot publish; only the bound parent record and publication can',()=>{
 const r={...run('approved'),cleanupState:'confirmed',publishedDraftHash:hash,acceptedReview:{hash:reviewHash}};
 const a={publication:{draftHash:hash,reviewHash,formalProposal:{id:'formal'}}};
 assert.equal(publicationVisible(r,a),true);
 for(const altered of [{...r,status:'reviewing'},{...r,cleanupState:'unconfirmed'},{...r,input:{...r.input,mode:'adversarial'}},{...r,runnerMode:'offline_fixture'},{...r,publishedDraftHash:reviewHash}])assert.equal(publicationVisible(altered,a),false);
 assert.equal(publicationVisible(r,{publication:{...a.publication,formalProposal:null}}),false);
 assert.equal(publicationVisible(r,{publication:{...a.publication,reviewHash:hash}}),false);
 assert.equal(publicationVisible(r,null),false);
});
test('diagnostic and fixture labels stay separate from formal publication',()=>{
 assert.equal(runPresentation({...run('approved'),input:{...run().input,mode:'adversarial'}}).title,'Review approved');
 assert.equal(runPresentation({...run(),runnerMode:'offline_fixture'}).label,'Offline fixture');
 assert.equal(runPresentation({...run(),input:{...run().input,mode:'adversarial'}}).label,'Diagnostic / Replay');
});
test('events deduplicate and reject gaps, cross-Run packets and mutated duplicate identities',()=>{
 const first=mergeEvent([],event(1),id);assert.equal(first.length,1);assert.equal(mergeEvent(first,event(1),id),first);
 assert.throws(()=>mergeEvent(first,event(3),id),/EVENT_SEQUENCE_GAP/);
 assert.throws(()=>mergeEvent(first,event(2,'task.started',{runId:'another'}),id),/EVENT_RUN_MISMATCH/);
 assert.throws(()=>mergeEvent(first,{...event(1),type:'task.failed'},id),/EVENT_DUPLICATE_CONFLICT/);
 assert.equal(mergeEvent(first,event(2),id).length,2);
});
test('stale snapshots and ended Run status cannot reopen or replace the current Run',()=>{
 const a={...run('failed'),lastSeq:10};assert.equal(acceptRun(a,{...run(),lastSeq:11}),a);
 assert.equal(acceptRun(a,{...run('approved'),lastSeq:12}),a);
 assert.equal(acceptRun(a,{...run('failed'),lastSeq:9}),a);
 assert.throws(()=>acceptRun(a,{...run(),runId:'other'}),/RUN_IDENTITY_MISMATCH/);
});
test('request intervals bind the complete actor and request, and never invent a missing end',()=>{
 const actor={role:'proposer',agentId:'a',taskId:'t',contextId:'c',attempt:1};
 const begin=event(1,'model.request.started',{...actor,source:'model',elapsedMs:20,payload:{kind:'request',requestId:'q',permitId:'p'}});
 const wrong=event(2,'model.request.completed',{...actor,contextId:'other',source:'model',elapsedMs:50,payload:{kind:'request',requestId:'q',permitId:'p'}});
 assert.equal(requestSpans([begin,wrong])[0].endMs,null);
 const done={...wrong,contextId:'c',seq:3,elapsedMs:80};const spans=requestSpans([begin,wrong,done]);assert.equal(spans.length,1);assert.equal(spans[0].endMs,80);assert.equal(spans[0].durationMs,60);
});
test('evidence highlighting uses code points and never changes the source to make an excerpt fit',()=>{
 const evidence={excerpt:'🧪é',source:{codePointRange:[1,3]}};
 assert.deepEqual(sourceHighlight('A🧪éZ',evidence),{before:'A',selected:'🧪é',after:'Z',verified:true});
 assert.equal(sourceHighlight('A🧪eZ',evidence).verified,false);
 assert.equal(sourceHighlight('null',{excerpt:'null',source:{}}).selected,'null');
});
test('missing or failed artifact reads are not treated as proof that no proposal was published',()=>{
 assert.equal(emptyResult(run('approved'),false,false).title,'Loading the saved result');
 assert.equal(emptyResult(run('approved'),false,true).title,'Saved result unavailable');
 assert.equal(emptyResult(run('approved'),true,false).title,'No draft is available in this archive');
 assert.equal(emptyResult(run('failed'),true,false).title,'No proposal was published');
 assert.equal(emptyResult(run('researching'),true,false).title,'Waiting for a saved draft');
});
test('old answer failures remain unknown while new persisted validation details keep their actual actor and stage',()=>{
 const old=event(1,'task.failed',{role:'proposer',contextId:'old',payload:{kind:'task',code:'INVALID_TASK_ANSWER',retryable:false}});
 assert.deepEqual(answerDiagnostics([old]),[]);
 const validation={stage:'schema_validation',issues:[{path:['claims',0,'evidenceIds'],code:'invalid_type',expected:'array'}]};
 const current=event(2,'task.failed',{role:'counter-evidence',contextId:'current',taskId:'task-current',payload:{kind:'task',code:'INVALID_TASK_ANSWER',retryable:false,validation}});
 const result=answerDiagnostics([old,current]);assert.equal(result.length,1);assert.equal(result[0].contextId,'current');assert.equal(result[0].role,'counter-evidence');assert.deepEqual(result[0].validation,validation);
});
