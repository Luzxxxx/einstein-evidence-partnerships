import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';import {randomUUID} from 'node:crypto';
import {RunRequestSchema} from '../contracts/domain.js';import {UuidSchema,ArtifactIdSchema,DATASET_COMMIT} from '../contracts/primitives.js';
import type {RunStore} from '../storage/run-store.js';import {Scheduler,SchedulerError} from '../supervisor/scheduler.js';
import type {DatasetSnapshot} from '../data/snapshot.js';import {arrayValue,objectValue} from '../data/records.js';
import {verifyEvidence} from '../evidence/validate.js';import {resolveField,type EvidenceSnapshot} from '../evidence/store.js';import {hashEvidenceSnapshot} from '../evidence/hashing.js';
import {buildIndex,retrieveWithTrace} from '../retrieval/index.js';import {listShowcase} from '../showcase/catalog.js';import {proposalPresentation} from '../showcase/presentation.js';import {revisionDiff} from '../showcase/revision-diff.js';
import {staticFile} from './files.js';import {createEventStreams} from './sse.js';import {ApiError} from './errors.js';
type Options={store:RunStore;scheduler:Scheduler;snapshot:DatasetSnapshot;webRoot:string;modelConfigured:()=>boolean;credential?:string};
const terminal=new Set(['approved','failed','insufficient','cancelled']);
async function body(req:IncomingMessage){
 if(req.headers['content-type']?.split(';')[0]?.trim()!=='application/json')throw new ApiError(415,'JSON_REQUIRED','Use application/json.');
 const length=req.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>1024*1024))throw new ApiError(413,'BODY_TOO_LARGE','JSON body must be at most 1 MiB.');
 const chunks:Buffer[]=[];let count=0;for await(const chunk of req){const raw=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);count+=raw.length;if(count>1024*1024)throw new ApiError(413,'BODY_TOO_LARGE','JSON body must be at most 1 MiB.');chunks.push(raw);}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new ApiError(400,'INVALID_JSON','Body must be valid UTF-8 JSON.');}
}
export function createLocalServer(options:Options){
 const {store,scheduler,snapshot}=options;
 const assertSafe=(text:string)=>{if(options.credential&&text.includes(options.credential))throw new ApiError(500,'PRIVATE_DATA_REJECTED','Private data was withheld.');};
 const runBlocked=(id:string)=>{const run=store.getRun(id);return Boolean(run&&!terminal.has(run.status)&&(store.safetyHold||scheduler.diagnostics.some(d=>d.code==='CONTROL_OR_STORAGE_FAILED')||(scheduler.safetyHold&&run.status==='queued')));};
 const streams=createEventStreams(store,assertSafe,runBlocked),research=new Map<string,ReturnType<typeof retrieveWithTrace>>();let index:ReturnType<typeof buildIndex>|undefined;
 function json(res:ServerResponse,status:number,value:unknown){const text=JSON.stringify(value);assertSafe(text);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(text);}
 function getRun(id:string){if(!UuidSchema.safeParse(id).success)throw new ApiError(400,'INVALID_RUN_ID','Invalid Run ID.');const run=store.getRun(id);if(!run)throw new ApiError(404,'RUN_NOT_FOUND','Run not found.');return run;}
 const server=createServer((req,res)=>{res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');void handle(req,res).catch(error=>{
  if(res.headersSent){res.end();return;}let e=error instanceof ApiError?error:new ApiError(500,'INTERNAL_ERROR','The request could not be completed.');
  if(error instanceof SchedulerError){const map:Record<string,[number,string,boolean]>={RUN_QUEUE_FULL:[429,'Run queue is full.',true],RUN_SAFETY_HOLD:[503,'Run admission is blocked by a safety hold.',false],SCHEDULER_CLOSED:[503,'Service is shutting down.',true],RUN_NOT_FOUND:[404,'Run not found.',false],RUN_TERMINAL:[409,'Run has already ended.',false]};const item=map[error.code];if(item)e=new ApiError(item[0],error.code,item[1],item[2]);}
  req.resume();json(res,e.status,{code:e.code,message:e.message,retryable:e.retryable});
 });});
 async function handle(req:IncomingMessage,res:ServerResponse){
  const host=req.headers.host,port=req.socket.localPort;if(host!==`127.0.0.1:${port}`&&host!==`localhost:${port}`)throw new ApiError(403,'INVALID_HOST','Only the local service host is accepted.');
  if(req.method==='POST'){const origin=req.headers.origin;if(origin!==undefined&&![`http://127.0.0.1:${port}`,`http://localhost:${port}`,'http://127.0.0.1:5173','http://localhost:5173'].includes(origin))throw new ApiError(403,'INVALID_ORIGIN','Cross-origin mutation is not allowed.');}
  const raw=(req.url??'/').split('?')[0]!;let path:string;try{path=decodeURIComponent(raw);}catch{throw new ApiError(400,'INVALID_PATH','Invalid path encoding.');}
  if(/[\\\0:%]/.test(path)||path.split('/').some(p=>p==='..'||p==='.'))throw new ApiError(400,'INVALID_PATH','Path traversal is not accepted.');
  const method=(wanted:string)=>{if(req.method!==wanted){res.setHeader('allow',wanted);throw new ApiError(405,'METHOD_NOT_ALLOWED','Method is not allowed for this resource.');}};
  if(path.startsWith('/api/')&&(req.url??'').includes('?'))throw new ApiError(400,'INVALID_QUERY','This API does not accept query parameters.');
  if(path==='/api/catalog'){method('GET');json(res,200,{synthetic:true,datasetCommit:snapshot.datasetCommit,newRunsAvailable:options.modelConfigured()&&!scheduler.safetyHold,companies:snapshot.listRecords('company').map(c=>({id:c.recordId,name:c.record.name,challenges:arrayValue(c.record.challenges).map(ch=>{const v=objectValue(ch);return{id:v.id,text:v.text,detail:v.detail};})}))});return;}
  if(path==='/api/showcase'){method('GET');json(res,200,listShowcase(store,snapshot).map(entry=>({...entry,companyName:snapshot.getRecord('company',entry.companyId)?.record.name,researcherName:snapshot.getRecord('researcher',entry.researcherId)?.record.name})));return;}
  if(path==='/api/runs'){
   if(req.method==='GET'){const runs=[...store.listRuns()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.runId.localeCompare(b.runId));json(res,200,{runs:runs.slice(0,50),total:runs.length,limit:50,...(scheduler.safetyHold?{blockedByService:true,blockedRunIds:runs.filter(r=>runBlocked(r.runId)).map(r=>r.runId)}:{})});return;}
   if(req.method!=='POST'){res.setHeader('allow','GET, POST');throw new ApiError(405,'METHOD_NOT_ALLOWED','Method is not allowed for this resource.');}
   method('POST');const parsed=RunRequestSchema.safeParse(await body(req));if(!parsed.success)throw new ApiError(400,'INVALID_RUN_REQUEST','Provide only an existing companyId and its challengeId.');
   const company=snapshot.getRecord('company',parsed.data.companyId);if(!company||!arrayValue(company.record.challenges).some(c=>objectValue(c).id===parsed.data.challengeId))throw new ApiError(400,'UNKNOWN_COMPANY_CHALLENGE','Company and challenge must exist and belong together.');
   if(!options.modelConfigured())throw new ApiError(503,'MODEL_CONFIG_MISSING','Model configuration is missing. Historical reads remain available.');
   const run=await scheduler.submit({...parsed.data,runId:randomUUID(),datasetCommit:DATASET_COMMIT,promptVersion:'einstein-business-pilot-v2',configVersion:'local-http-v1',mode:'research'});json(res,202,run);return;
  }
  const match=path.match(/^\/api\/runs\/([^/]+)(?:\/(cancel|events|artifacts|evidence)(?:\/([^/]+))?)?$/);
  if(match){const id=match[1]!,run=getRun(id),action=match[2];if(match[3]&&action!=='evidence')throw new ApiError(404,'NOT_FOUND','Resource not found.');
   if(!action){method('GET');json(res,200,{run,progress:{lastSeq:run.lastSeq,terminal:terminal.has(run.status),blockedByService:runBlocked(id),reasonCodes:store.getTerminal(id)?.outcome.reasonCodes??[]},artifactRefs:store.eventsAfter(id,0).filter(e=>e.type==='artifact.validated').map(e=>e.payload)});return;}
   if(action==='cancel'){method('POST');const request=req.headers['transfer-encoding']||Number(req.headers['content-length']??0)>0?await body(req):{};if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).length)throw new ApiError(400,'INVALID_CANCEL_REQUEST','Cancel accepts no body or an empty JSON object.');if(run.status==='cancelled'){json(res,202,run);return;}if(terminal.has(run.status))throw new ApiError(409,'RUN_TERMINAL','An ended Run cannot be cancelled or reopened.');const cancelled=await scheduler.cancel(id);if(cancelled.status!=='cancelled')throw new ApiError(409,'RUN_TERMINAL','Run ended before cancellation could be accepted.');json(res,202,cancelled);return;}
   method('GET');if(action==='events'){streams.open(req,res,id);return;}
   const t=store.getTerminal(id),p=store.getPublication(id);
   if(action==='artifacts'){json(res,200,{runId:id,status:run.status,mode:run.input.mode,runnerMode:run.runnerMode,
    display:{companyName:snapshot.getRecord('company',run.input.companyId)?.record.name,researcherNames:Object.fromEntries((t?.artifacts??[]).flatMap(a=>a.kind==='proposal_draft'?[[a.artifact.pair.researcherId,snapshot.getRecord('researcher',a.artifact.pair.researcherId)?.record.name]]:[]))},
    artifacts:t?.artifacts??[],publication:p?{draftHash:run.publishedDraftHash,reviewHash:run.acceptedReview?.hash,renderedDraft:p.renderedDraft,formalProposal:p.formalProposal,committedAt:p.committedAt}:null,
    presentation:p&&t?.outcome.kind==='reviewed'?proposalPresentation(t.outcome.draft):null,revisionDiff:revisionDiff(t?.artifacts??[])});return;}
   const eid=match[3];if(!eid||!ArtifactIdSchema.safeParse(eid).success)throw new ApiError(400,'INVALID_EVIDENCE_ID','Use a registered Evidence ID.');
   let evidence:EvidenceSnapshot|undefined=p?.proof.evidence;
   if(!evidence&&run.input.mode==='research'){
    let context=research.get(id);if(!context){index??=buildIndex(snapshot);context=retrieveWithTrace(run.input,index);research.set(id,context);}
    if(t?.artifacts.some(a=>a.kind==='proposal_draft'&&(a.artifact.evidenceSnapshotHash!==hashEvidenceSnapshot(context!.evidence)||a.artifact.poolHash!==context!.pool.poolHash)))throw new ApiError(409,'REPLAY_CONTEXT_UNAVAILABLE','Stored draft does not match the current deterministic source context.');evidence=[...context.evidence];
   }
   const e=evidence?.find(e=>e.id===eid);if(!e)throw new ApiError(404,'EVIDENCE_NOT_REGISTERED','Evidence is not registered in this Run context.');
   if(verifyEvidence(e,snapshot).some(i=>i.severity==='error'))throw new ApiError(409,'EVIDENCE_SOURCE_INVALID','Evidence source validation failed.');
   const source={...e.source};delete source.codePointRange;const field=resolveField(source,snapshot);
   json(res,200,{runId:id,evidence:e,originalField:{value:field.value,valueType:field.valueType,text:field.text},flags:snapshot.diagnostics.filter(d=>d.recordId===e.source.recordId||d.relatedId===e.source.recordId),sourceValidation:'verified',semanticSupport:'not_determined_by_source_validation'});return;
  }
  if(path.startsWith('/api'))throw new ApiError(404,'NOT_FOUND','API resource not found.');
  if(req.method!=='GET'&&req.method!=='HEAD')throw new ApiError(405,'METHOD_NOT_ALLOWED','Use GET or HEAD for Web files.');const file=await staticFile(options.webRoot,path);assertSafe(file.type.startsWith('text/')?file.raw.toString('utf8'):'');res.writeHead(200,{'content-type':file.type,'content-length':file.raw.length});res.end(req.method==='HEAD'?undefined:file.raw);
 }
 server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=1000;
 return{server,closeStreams:streams.close};
}
