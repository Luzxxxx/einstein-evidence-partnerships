import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeEventStream, followRun } from '../../web/src/transport.ts';

const id='11111111-1111-4111-8111-111111111111';
const event=(seq,extra={})=>({runId:id,seq,schemaVersion:1,source:'supervisor',type:'run.status',elapsedMs:seq,at:'2026-10-31T10:00:00.000Z',payload:{kind:'run_status',status:'researching',reasonCodes:[]},...extra});
const packet=(seq,extra={})=>`id: ${id}:${seq}\nevent: run-event\ndata: ${JSON.stringify(event(seq,extra))}\n\n`;
const detail=(status='researching')=>({run:{runId:id,status,lastSeq:2,input:{runId:id,mode:'research'},runnerMode:'live'},progress:{terminal:['approved','failed','cancelled','insufficient'].includes(status)}});
const response=text=>new Response(text,{headers:{'content-type':'text/event-stream'}});

test('storage hold ends replay of persisted events without pretending terminality or retrying forever',async()=>{
 const held={...detail(),progress:{terminal:false,blockedByService:true}};let requests=0;const states=[],seen=[];
 let reads=0;
 await followRun(id,{signal:new AbortController().signal,loadRun:async()=>{reads++;return held;},fetcher:async()=>{requests++;return response(packet(1)+packet(2));},onRun:()=>{},onEvent:e=>seen.push(e),onConnection:s=>states.push(s),onProblem:()=>{},pause:async()=>{}});
 assert.equal(reads,6);
 assert.equal(requests,1);assert.equal(seen.length,2);assert.equal(states.at(-1),'paused');assert.equal(held.run.status,'researching');
});
test('a held partial stream reports missing saved events and accepts a later terminal record',async()=>{
 let reads=0,requests=0;const problems=[],seen=[];
 await followRun(id,{signal:new AbortController().signal,loadRun:async()=>{reads++;return reads<3?{...detail(),progress:{terminal:false,blockedByService:true}}:detail('failed');},fetcher:async()=>{requests++;return response(packet(1));},onRun:d=>seen.push(d.run.status),onEvent:()=>{},onConnection:()=>{},onProblem:p=>problems.push(p),pause:async()=>{}});
 assert.equal(requests,1);assert.equal(seen.at(-1),'failed');assert.ok(problems.includes('EVENT_REPLAY_INCOMPLETE'));
});
test('a failed held-state refresh does not restart SSE or infer a successful terminal outcome',async()=>{
 let reads=0,requests=0;const problems=[],states=[];
 await followRun(id,{signal:new AbortController().signal,loadRun:async()=>{if(++reads>2)throw Error('NETWORK');return {...detail(),progress:{terminal:false,blockedByService:true}};},fetcher:async()=>{requests++;return response(packet(1)+packet(2));},onRun:()=>{},onEvent:()=>{},onConnection:s=>states.push(s),onProblem:p=>problems.push(p),pause:async()=>{}});
 assert.equal(requests,1);assert.equal(states.at(-1),'paused');assert.ok(problems.includes('RUN_REFRESH_UNAVAILABLE'));
});

test('actual SSE parsing handles UTF-8 chunks, comments and CRLF without duplicate delivery',async()=>{
 const bytes=new TextEncoder().encode(': heartbeat\r\n\r\n'+packet(1,{payload:{text:'🧪'}}).replaceAll('\n','\r\n')+packet(1,{payload:{text:'🧪'}})+packet(2));let cursor=0;
 const stream=new ReadableStream({pull(controller){if(cursor===bytes.length){controller.close();return;}controller.enqueue(bytes.slice(cursor,++cursor));}}),seen=[];
 const last=await consumeEventStream(new Response(stream,{headers:{'content-type':'text/event-stream'}}),id,0,e=>seen.push(e),new AbortController().signal);
 assert.equal(last,2);assert.deepEqual(seen.map(e=>e.seq),[1,2]);assert.equal(seen[0].payload.text,'🧪');
});
test('a packet ID or Run mismatch and a sequence gap fail before rendering the event',async()=>{
 for(const text of [packet(1,{runId:'other'}),packet(2),packet(1).replace(`id: ${id}:1`,'id: other:1')]){const seen=[];await assert.rejects(consumeEventStream(response(text),id,0,e=>seen.push(e),new AbortController().signal));assert.equal(seen.length,0);}
});
test('a truncated or oversized packet is not silently converted into success',async()=>{
 await assert.rejects(consumeEventStream(response(packet(1).slice(0,-1)),id,0,()=>{},new AbortController().signal),/EVENT_TRUNCATED/);
 await assert.rejects(consumeEventStream(response('data: '+'x'.repeat(1024*1024+1)),id,0,()=>{},new AbortController().signal),/EVENT_TOO_LARGE/);
});
test('EOF always checks authoritative GET, and a terminal Run never reconnects',async()=>{
 let loads=0,requests=0;const seen=[],snapshots=[];
 await followRun(id,{signal:new AbortController().signal,loadRun:async()=>{loads++;return detail(loads===1?'reviewing':'failed');},fetcher:async()=>{requests++;return response(packet(1,{type:'review.completed',source:'application',payload:{verdict:'approve'}})+packet(2,{type:'cleanup.completed'}));},onEvent:e=>seen.push(e),onRun:x=>snapshots.push(x.run.status),onConnection:()=>{},onProblem:()=>{},pause:async()=>{throw Error('TERMINAL_MUST_NOT_RECONNECT');}});
 assert.equal(loads,2);assert.equal(requests,1);assert.deepEqual(snapshots,['reviewing','failed']);assert.equal(seen.length,2);
});
test('active reconnect sends exact Last-Event-ID and never POSTs or reruns',async()=>{
 let loads=0;const requests=[],seen=[];
 await followRun(id,{signal:new AbortController().signal,loadRun:async()=>detail(++loads>=3?'cancelled':'researching'),fetcher:async(url,init)=>{requests.push({url,headers:new Headers(init.headers),method:init.method??'GET'});return response(packet(requests.length));},onEvent:e=>seen.push(e.seq),onRun:()=>{},onConnection:()=>{},onProblem:()=>{},pause:async()=>{}});
 assert.deepEqual(seen,[1,2]);assert.equal(requests.length,2);assert.equal(requests[1].headers.get('Last-Event-ID'),`${id}:1`);assert.ok(requests.every(r=>r.method==='GET'));
});
test('stream errors check GET and stop if terminal; missing observation is not approval',async()=>{
 let loads=0,requests=0;const states=[];
 await followRun(id,{signal:new AbortController().signal,loadRun:async()=>detail(++loads===1?'researching':'insufficient'),fetcher:async()=>{requests++;throw Error('connection lost');},onEvent:()=>{},onRun:d=>states.push(d.run.status),onConnection:()=>{},onProblem:()=>{},pause:async()=>{throw Error('NO_RECONNECT');}});
 assert.equal(requests,1);assert.deepEqual(states,['researching','insufficient']);
});
test('navigation abort cancels an open reader and does not fetch another stream',async()=>{
 const controller=new AbortController();let cancelled=false,requests=0;
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(packet(1)));},cancel(){cancelled=true;}});
 await followRun(id,{signal:controller.signal,loadRun:async()=>detail(),fetcher:async()=>{requests++;return new Response(stream,{headers:{'content-type':'text/event-stream'}});},onEvent:()=>controller.abort(),onRun:()=>{},onConnection:()=>{},onProblem:()=>{},pause:async()=>{}});
 assert.equal(requests,1);assert.equal(cancelled,true);
});

test('an interrupted terminal replay remains visibly incomplete instead of clearing its warning',async()=>{
 let requests=0,loads=0;const states=[],problems=[],seen=[];
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(packet(1)));setTimeout(()=>c.error(Error('OFFLINE_FIXTURE_DISCONNECT')),0);}});
 await followRun(id,{signal:new AbortController().signal,loadRun:async()=>{loads++;return detail('failed');},fetcher:async()=>{requests++;return new Response(stream,{headers:{'content-type':'text/event-stream'}});},onEvent:e=>seen.push(e.seq),onRun:()=>{},onConnection:s=>states.push(s),onProblem:p=>problems.push(p),pause:async()=>{throw Error('TERMINAL_MUST_NOT_AUTO_RECONNECT');}});
 assert.equal(requests,1);assert.equal(loads,2);assert.deepEqual(seen,[1]);assert.equal(states.at(-1),'paused');assert.ok(problems.includes('EVENT_REPLAY_INCOMPLETE'));
});
test('clean EOF with fewer events than the saved lastSeq is also incomplete, not a complete replay',async()=>{
 const states=[],problems=[];
 await followRun(id,{signal:new AbortController().signal,loadRun:async()=>detail('approved'),fetcher:async()=>response(packet(1)),onEvent:()=>{},onRun:()=>{},onConnection:s=>states.push(s),onProblem:p=>problems.push(p),pause:async()=>{throw Error('NO_TERMINAL_RECONNECT');}});
 assert.equal(states.at(-1),'paused');assert.ok(problems.includes('EVENT_REPLAY_INCOMPLETE'));
});
