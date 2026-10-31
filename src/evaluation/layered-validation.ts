/** New v2-only bounded entry. Importing cannot open a store or make a request. */
import {readFile,writeFile,open,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';import {z} from 'zod';
import {RunInputSchema} from '../contracts/domain.js';import {HashSchema,UuidSchema,DATASET_COMMIT} from '../contracts/primitives.js';
import {DEFAULT_LIMITS} from '../contracts/config.js';import {canonicalizeArtifact} from '../contracts/canonical.js';
import {hashArtifact,sha256Bytes} from '../evidence/hashing.js';import {deepFreeze} from '../data/records.js';
import {loadSnapshot} from '../data/snapshot.js';import {RunStore} from '../storage/run-store.js';
import {HistoricalRecoveryAuthorizationSchema} from '../storage/historical-recovery.js';import {Scheduler} from '../supervisor/scheduler.js';import {ProcessHost} from '../supervisor/process-host.js';
import {collectCriticProductFingerprints,summarizeCriticRequestIntervals,summarizeCriticToolRoundTrips,diffReviewedDrafts} from './run-critic-eval.js';
import {analyzeL05Chain,finalizeBoundedEvidence} from './bounded-validation.js';import {buildCriticCase} from './critic-cases.js';
import {analyzeProtocolProbeV2} from './protocol-probe-v2.js';
const SCOPE='task7t_layered_protocol_then_single_L05';
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function ensure(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const Plan=z.strictObject({scope:z.literal(SCOPE),hash:HashSchema,
 probe:z.strictObject({runId:UuidSchema,input:RunInputSchema,researcherId:z.string().regex(/^R\d{4}$/),contractVersion:z.literal('protocol-probe-v2'),
  contractSha256:HashSchema.optional(),contract:z.unknown().optional(),promptHashes:z.record(z.string(),HashSchema).optional(),effectivePrompts:z.unknown().optional(),poolHash:HashSchema.optional()}),
 l05:z.strictObject({runId:UuidSchema,input:RunInputSchema,variantId:z.literal('L05'),manifest:z.unknown().optional()}),
 limits:z.strictObject({probeRequests:z.literal(4),l05Requests:z.literal(16),totalRequests:z.literal(20),requestTimeoutMs:z.literal(40000),runTimeoutMs:z.literal(180000),maxConcurrentModelRequests:z.literal(2)}),
 automaticRetry:z.literal(false),showcaseEligible:z.literal(false),createdAt:z.string().optional(),schemaVersion:z.literal(1).optional(),model:z.string().optional(),gatewayBaseURL:z.string().optional(),
 productFingerprints:z.array(z.strictObject({file:z.string(),sha256:HashSchema})).optional(),sourceFiles:z.unknown().optional(),promptContract:z.unknown().optional(),
 promptHashes:z.record(z.string(),HashSchema).optional(),existingAuthorization:z.unknown().optional(),authorizationFileSha256:HashSchema.optional(),resolutionFileSha256:HashSchema.optional(),
 engineeringGate:z.strictObject({file:z.string(),sha256:HashSchema}).optional()});
export function validateLayeredPlan(value:unknown){const p=Plan.parse(value);ensure(hashArtifact(value)===p.hash,'LAYERED_FREEZE_HASH');
 ensure(p.probe.runId!==p.l05.runId&&p.probe.input.runId===p.probe.runId&&p.l05.input.runId===p.l05.runId
  &&p.probe.input.mode==='adversarial'&&p.l05.input.mode==='adversarial','LAYERED_RUN_BINDING');return deepFreeze(p);}
export async function acquireLayeredAttempt(folder:string,value:unknown){const p=validateLayeredPlan(value),h=await open(join(folder,'attempt.json'),'wx');
 try{await h.writeFile(JSON.stringify({scope:SCOPE,freezeHash:p.hash,probeRunId:p.probe.runId,l05RunId:p.l05.runId,createdAt:new Date().toISOString(),maxGrantedRequests:20,automaticRetry:false})+'\n');await h.sync();}finally{await h.close();}}
type Row=Record<string,any>&{runId:string};
function clean(r:Row){return !r.errorCode&&r.safetyHold===false&&r.record?.runId===r.runId&&r.record.cleanupState==='confirmed'
 &&r.cleanups?.length===1&&r.cleanups.every((c:any)=>c.runId===r.runId&&c.confirmed===true)
 &&r.permitSnapshot?.inFlight===0&&r.permitSnapshot.runs?.length===1&&r.permitSnapshot.runs.every((p:any)=>p.runId===r.runId&&p.inFlight===0&&p.pending===0);}
function verifyGrants(r:Row,id:string,max:number){ensure(r.runId===id&&Array.isArray(r.events),'LAYERED_RESULT_IDENTITY');
 const grants=r.events.filter((e:any)=>e.type==='permit.granted');ensure(grants.length<=max,'LAYERED_REQUEST_LIMIT');const requests=new Set(),permits=new Set();
 for(const g of grants){ensure(g.runId===id&&UuidSchema.safeParse(g.payload?.requestId).success&&UuidSchema.safeParse(g.payload?.permitId).success&&!requests.has(g.payload.requestId)&&!permits.has(g.payload.permitId),'LAYERED_GRANT_BINDING');requests.add(g.payload.requestId);permits.add(g.payload.permitId);}}
export async function runLayeredSequence(value:unknown,run:{probe():Promise<Row>;l05():Promise<Row>}){
 const p=validateLayeredPlan(value),rows:Row[]=[];let stopReason:string|null=null;
 const count=()=>new Set(rows.flatMap(r=>Array.isArray(r.events)?r.events:[]).filter((e:any)=>e.type==='permit.granted').map((e:any)=>JSON.stringify([e.runId,e.payload?.requestId,e.payload?.permitId]))).size;
 try{const r=await run.probe();rows.push(r);verifyGrants(r,p.probe.runId,4);ensure(clean(r)&&['passed','transportPassed','modelReceiptsPassed','evidenceComplete','executionPassed','cleanupConfirmed'].every(k=>r.analysis?.[k]===true),'LAYERED_PROBE_NOT_PASSED');}
 catch{stopReason='LAYERED_PROBE_STOPPED';if(!rows.length)rows.push({runId:p.probe.runId,status:'technical_failure',errorCode:stopReason});}
 if(stopReason){rows.push({runId:p.l05.runId,status:'unexecuted',reasonCodes:[stopReason]});return deepFreeze({rows,totalGranted:count(),stopReason});}
 try{const r=await run.l05();rows.push(r);verifyGrants(r,p.l05.runId,16);ensure(count()<=20&&clean(r),'LAYERED_L05_STOPPED');
  if(r.record?.status!=='approved'||r.l05Analysis?.structuralChainObserved!==true)stopReason='L05_TARGET_NOT_ACHIEVED';}
 catch{stopReason='LAYERED_L05_STOPPED';if(rows.length<2)rows.push({runId:p.l05.runId,status:'technical_failure',errorCode:stopReason});}
 return deepFreeze({rows,totalGranted:count(),stopReason});
}
const root=fileURLToPath(new URL('../../../',import.meta.url)),shaText=(s:string)=>sha256Bytes(Buffer.from(s,'utf8'));
export async function collectLayeredProductFingerprints(){const rows=await collectCriticProductFingerprints(root);
 for(const file of ['scripts/prepare-task7t-validation.mjs'])rows.push({file,sha256:sha256Bytes(await readFile(resolve(root,file)))});
 return rows.sort((a,b)=>a.file.localeCompare(b.file,'en'));}
export async function verifyLayeredHistory(){const b=JSON.parse(await readFile(resolve(root,'docs/implementation/task-7t-baseline.json'),'utf8'));
 for(const f of [...b.historicalImplementation,...b.historicalStore.files,...b.protectedUntrackedJson])ensure(sha256Bytes(await readFile(f.file))===f.sha256,'LAYERED_HISTORY_CHANGED');return b;}
async function evidence(path:string){try{const rows=(await readFile(path,'utf8')).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));ensure(rows.every(object),'LAYERED_EVIDENCE_SHAPE');return{rows,errorCode:null};}catch{return{rows:[] as Record<string,any>[],errorCode:'LAYERED_EVIDENCE_MISSING_OR_INVALID'};}}
const safe=(e:unknown,fallback:string)=>{const c=object(e)?e.code:undefined;return typeof c==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(c)?c:e instanceof Error&&/^[A-Z][A-Z0-9_]{0,95}$/.test(e.message)?e.message:fallback;};
export async function runLayeredLiveValidation(){
 const out=resolve(root,'docs/implementation/task-7t-live'),freezeFile=join(out,'freeze.json'),raw=await readFile(freezeFile),p=validateLayeredPlan(JSON.parse(raw.toString('utf8')));
 ensure(p.productFingerprints&&p.engineeringGate&&p.existingAuthorization&&p.model&&p.gatewayBaseURL&&p.promptContract,'LAYERED_FREEZE_INCOMPLETE');
 const gateRaw=await readFile(resolve(root,p.engineeringGate.file)),gate=JSON.parse(gateRaw.toString('utf8'));
 ensure(sha256Bytes(gateRaw)===p.engineeringGate.sha256&&gate.engineeringVerified===true&&gate.independentReviewPassed===true&&canonicalizeArtifact(gate.productFingerprints)===canonicalizeArtifact(p.productFingerprints),'LAYERED_ENGINEERING_GATE');
 ensure(canonicalizeArtifact(await collectLayeredProductFingerprints())===canonicalizeArtifact(p.productFingerprints),'LAYERED_PRODUCT_CHANGED');
 ensure(process.env.EINSTEIN_GATEWAY_API_KEY&&process.env.EINSTEIN_GATEWAY_MODEL===p.model&&process.env.EINSTEIN_GATEWAY_BASE_URL===p.gatewayBaseURL,'LAYERED_CONFIGURATION_CHANGED');
 const b=await verifyLayeredHistory();await acquireLayeredAttempt(out,p);
 const a=HistoricalRecoveryAuthorizationSchema.parse(p.existingAuthorization),authRaw=await readFile(resolve(root,'docs/implementation/task-7s-authorization.json'));
 ensure(sha256Bytes(authRaw)===p.authorizationFileSha256&&canonicalizeArtifact(JSON.parse(authRaw.toString('utf8')))===canonicalizeArtifact(a),'LAYERED_EXISTING_AUTHORIZATION_CHANGED');
 const snapshotPath=resolve(root,'reference/einstein-matchmaker-data'),loadOfficial=()=>loadSnapshot(snapshotPath,DATASET_COMMIT);
 let store:RunStore|undefined,execution:unknown,errorCode:string|null=null;
 try{
  store=await RunStore.open(b.historicalStore.root,{historicalRecovery:a,publicationSnapshot:loadOfficial});
  const resolutionFile=join(b.historicalStore.root,'historical-recovery',a.runId+'.resolution.json');
  ensure(sha256Bytes(await readFile(resolutionFile))===p.resolutionFileSha256&&store.historicalResolutions.length===1&&!store.safetyHold,'LAYERED_STORE_HOLD_OR_RESOLUTION');
  await writeFile(join(out,'store-startup.json'),JSON.stringify({scope:SCOPE,safetyHold:store.safetyHold,diagnostics:store.diagnostics,unresolved:store.unresolvedDiagnostics,
   resolutions:store.historicalResolutions,historicalRecord:store.getRun(a.runId),recoveryApplyCalls:0,newRiskExceptions:0})+'\n',{flag:'wx'});
  const cwd=await mkdtemp(join(tmpdir(),'einstein task7t empty cwd '));
  const runOne=async(kind:'probe'|'l05'):Promise<Row>=>{
   const planned=p[kind],folder=join(out,'runs',planned.runId);await mkdir(folder);
   await writeFile(join(folder,'attempt.json'),JSON.stringify({kind,runId:planned.runId,freezeHash:p.hash,startedAt:new Date().toISOString(),automaticRetry:false})+'\n',{flag:'wx'});
   ensure(sha256Bytes(await readFile(freezeFile))===sha256Bytes(raw)&&canonicalizeArtifact(await collectLayeredProductFingerprints())===canonicalizeArtifact(p.productFingerprints),'LAYERED_FREEZE_OR_PRODUCT_CHANGED');
   const scheduler=new Scheduler({store:store!,runnerMode:'live',snapshotPath,limits:{...DEFAULT_LIMITS,maxModelRequests:kind==='probe'?4:16},
    publicationContext:async input=>{ensure(kind==='l05'&&input.runId===p.l05.runId,'LAYERED_PROBE_PUBLISH_FORBIDDEN');return buildCriticCase(await loadOfficial(),'L05',input.runId).research;},
    createHost:callbacks=>new ProcessHost({workerPath:resolve(root,'dist/server/evaluation',kind==='probe'?'protocol-probe-worker-v2.js':'layered-critic-worker.js'),cwd,
     workerArgs:['--validation-freeze',freezeFile,'--validation-freeze-hash',sha256Bytes(raw)],...callbacks})});
   ensure(scheduler.permits.snapshot().runs.length===0&&scheduler.permits.snapshot().inFlight===0,'LAYERED_MANAGER_NOT_EMPTY');
   let failure:string|null=null;try{await scheduler.submit(planned.input);await scheduler.waitForIdle(205000);}catch(e){failure=safe(e,'LAYERED_RUN_FAILED');}
   finally{try{await scheduler.close();}catch(e){failure??=safe(e,'LAYERED_CLOSE_FAILED');}}
   const record=store!.getRun(planned.runId),events=record?store!.eventsAfter(planned.runId,0):[];
   const native=await evidence(join(folder,'worker-evidence.jsonl')),diagnostics=await evidence(join(folder,'answer-diagnostics.jsonl'));
   failure??=native.errorCode??diagnostics.errorCode;
   const artifacts=native.rows.filter(r=>r.kind==='artifact').map(r=>r.artifact),drafts=artifacts.filter(a=>a.kind==='proposal_draft').map(a=>a.artifact),reviews=artifacts.filter(a=>a.kind==='critic_review').map(a=>a.artifact);
   const cleanups=scheduler.cleanupEvidence.map(c=>{const{stdout,stderr,...exit}=c.exit;return{...c,exit,outputHashes:{stdout:shaText(stdout),stderr:shaText(stderr)}};});
   let terminalOutcome:unknown=null;try{terminalOutcome=JSON.parse(await readFile(join(b.historicalStore.root,planned.runId,'terminal.json'),'utf8')).outcome;}catch{failure??='LAYERED_TERMINAL_MISSING';}
   const base={runId:planned.runId,kind,status:record?.status??'technical_failure',record:record??null,runnerMode:'live',events,cleanups,terminalOutcome,
    safetyHold:scheduler.safetyHold,errorCode:failure,permitSnapshot:scheduler.permits.snapshot(),publication:store!.getPublication(planned.runId)??null,
    requests:summarizeCriticRequestIntervals(native.rows.filter(r=>r.kind==='request').map(r=>r.trace)),reviewVersions:reviews,draftVersions:drafts,
    loadedReviewSnapshots:native.rows.filter(r=>r.kind==='review.dispatch'),nativeToolRoundTrips:summarizeCriticToolRoundTrips(native.rows),
    versionDifferences:drafts.length===2?diffReviewedDrafts(drafts[0],drafts[1]):[],answerDiagnostics:diagnostics.rows,
    ...(kind==='l05'?{caseManifest:p.l05.manifest}:{}),showcaseEligible:false,humanLabels:0,qualityMetrics:'NA',automaticRetries:0};
   const result={...base,...(kind==='probe'?{analysis:analyzeProtocolProbeV2({...base,expected:{companyId:planned.input.companyId,challengeId:planned.input.challengeId,researcherId:p.probe.researcherId},records:[...native.rows,...diagnostics.rows]})}:{l05Analysis:analyzeL05Chain(base)}),finishedAt:new Date().toISOString()};
   await writeFile(join(folder,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});await verifyLayeredHistory();return result;
  };
  execution=await runLayeredSequence(p,{probe:()=>runOne('probe'),l05:()=>runOne('l05')});
 }catch(e){errorCode=safe(e,'LAYERED_VALIDATION_STOPPED');}
 finally{const final=await finalizeBoundedEvidence({close:async()=>{if(store)await store.close();},verify:async()=>{await verifyLayeredHistory();},
  summary:{scope:SCOPE,freezeHash:p.hash,execution:execution??null,errorCode,finishedAt:new Date().toISOString(),humanLabels:0,qualityMetrics:'NA',holdout:'unopened',recoveryApplyCalls:0,newRiskExceptions:0,batchStillLocked:true,Task8Started:false},
  save:async value=>{await writeFile(join(out,'summary.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx'});}});errorCode=final.errorCode;}
 return{execution,errorCode};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runLayeredLiveValidation().then(r=>{if(r.errorCode||(object(r.execution)&&r.execution.stopReason))process.exitCode=1;}).catch(()=>{console.error('LAYERED_VALIDATION_STOPPED_NO_RETRY');process.exitCode=1;});
