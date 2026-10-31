import type {IncomingMessage,ServerResponse} from 'node:http';import type {RunStore} from '../storage/run-store.js';import {ApiError} from './errors.js';
const terminal=new Set(['approved','insufficient','failed','cancelled']);
/** No event is synthesized. Store reads see only fsync/rename-confirmed parent writes. */
export function createEventStreams(store:RunStore,assertSafe:(text:string)=>void,isBlocked:(runId:string)=>boolean=()=>store.safetyHold){
 const clients=new Set<()=>void>();
 function open(req:IncomingMessage,res:ServerResponse,runId:string){
  const run=store.getRun(runId);if(!run)throw new ApiError(404,'RUN_NOT_FOUND','Run not found.');let cursor=0;const last=req.headers['last-event-id'];
  if(last!==undefined){if(typeof last!=='string'||!last.startsWith(runId+':')||!/^\d+$/.test(last.slice(runId.length+1)))throw new ApiError(400,'INVALID_EVENT_CURSOR','Use a cursor belonging to this Run.');cursor=Number(last.slice(runId.length+1));if(!Number.isSafeInteger(cursor)||cursor<0)throw new ApiError(400,'INVALID_EVENT_CURSOR','Invalid event sequence.');if(cursor>run.lastSeq)throw new ApiError(409,'EVENT_CURSOR_AHEAD','Cursor exceeds the persisted event log.');}
  res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform',connection:'keep-alive','x-accel-buffering':'no'});res.flushHeaders();let stopped=false,blocked=false;
  const close=()=>{if(stopped)return;stopped=true;clearInterval(timer);clearInterval(heartbeat);clients.delete(close);res.end();};
  const pump=()=>{if(stopped||blocked)return;try{for(const e of store.eventsAfter(runId,cursor)){
    if(e.runId!==runId||e.seq!==cursor+1)throw Error('PERSISTED_SEQUENCE_INVALID');const packet=`id: ${runId}:${e.seq}\nevent: run-event\ndata: ${JSON.stringify(e)}\n\n`;assertSafe(packet);const ready=res.write(packet);cursor=e.seq;
    if(res.writableLength>2*1024*1024){res.destroy();close();return;}if(!ready){blocked=true;return;}
   }const current=store.getRun(runId);if(isBlocked(runId)||(current&&terminal.has(current.status)&&cursor>=current.lastSeq))close();}catch{close();}};
  const timer=setInterval(pump,100),heartbeat=setInterval(()=>{if(!stopped&&!blocked)res.write(': heartbeat\n\n');},10000);timer.unref();heartbeat.unref();
  clients.add(close);res.once('close',close);res.on('drain',()=>{blocked=false;pump();});pump();
 }
 return{open,close:()=>{for(const close of [...clients])close();},get size(){return clients.size;}};
}
