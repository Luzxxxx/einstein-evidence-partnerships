/** One explicitly authorized sequence. Importing never opens a store or model. */
import {open,readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {RunInputSchema,ProposalDraftSchema,CriticReviewSchema} from '../contracts/domain.js';
import {UuidSchema,HashSchema,TimestampSchema,DATASET_COMMIT} from '../contracts/primitives.js';
import {DEFAULT_LIMITS} from '../contracts/config.js';
import {canonicalizeArtifact} from '../contracts/canonical.js';
import {deepFreeze} from '../data/records.js';
import {hashArtifact,sha256Bytes} from '../evidence/hashing.js';
import {loadSnapshot} from '../data/snapshot.js';
import {RunStore} from '../storage/run-store.js';
import {HistoricalRecoveryAuthorizationSchema} from '../storage/historical-recovery.js';
import {Scheduler} from '../supervisor/scheduler.js';
import {ProcessHost} from '../supervisor/process-host.js';
import {buildCriticCase} from './critic-cases.js';
import {collectCriticProductFingerprints,summarizeCriticRequestIntervals,summarizeCriticToolRoundTrips,diffReviewedDrafts} from './run-critic-eval.js';
// Implemented separately and validated with real SDK/native offline fixtures.
import {analyzeProtocolProbe} from './protocol-probe.js';

const scope='task7s_bounded_protocol_then_single_L05';
const hashes=z.record(z.string(),HashSchema);
const PlanSchema=z.strictObject({scope:z.literal(scope),hash:HashSchema,
 probe:z.strictObject({runId:UuidSchema,input:RunInputSchema,researcherId:z.string().regex(/^R\d{4}$/),promptHashes:hashes.optional(),poolHash:HashSchema.optional()}),
 l05:z.strictObject({runId:UuidSchema,input:RunInputSchema,variantId:z.literal('L05'),manifest:z.unknown().optional()}),
 limits:z.strictObject({probeRequests:z.literal(4),l05Requests:z.literal(16),totalRequests:z.literal(20),
  requestTimeoutMs:z.literal(40000),runTimeoutMs:z.literal(180000),maxConcurrentModelRequests:z.literal(2)}),
 automaticRetry:z.literal(false),showcaseEligible:z.literal(false),
 schemaVersion:z.literal(1).optional(),createdAt:TimestampSchema.optional(),model:z.string().min(1).max(128).optional(),gatewayBaseURL:z.string().optional(),
 promptHashes:hashes.optional(),productFingerprints:z.array(z.strictObject({file:z.string(),sha256:HashSchema})).optional(),
 sourceFiles:z.unknown().optional(),recoveryAuthorization:z.unknown().optional(),authorizationFileSha256:HashSchema.optional(),
 engineeringGate:z.strictObject({file:z.string(),sha256:HashSchema}).optional()});
export type BoundedPlan=z.infer<typeof PlanSchema>;
function ensure(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function validateBoundedPlan(value:unknown):BoundedPlan{
 const p=PlanSchema.parse(value);
 ensure(hashArtifact(value)===p.hash,'BOUNDED_FREEZE_HASH');
 ensure(p.probe.runId!==p.l05.runId&&p.probe.input.runId===p.probe.runId&&p.l05.input.runId===p.l05.runId,'BOUNDED_RUN_BINDING');
 ensure(p.probe.input.mode==='adversarial'&&p.l05.input.mode==='adversarial','BOUNDED_ADVERSARIAL_ONLY');
 return deepFreeze(p);
}
export async function acquireBoundedAttempt(folder:string,value:unknown){
 const p=validateBoundedPlan(value),path=join(folder,'attempt.json');
 const h=await open(path,'wx');
 try{const marker={scope,freezeHash:p.hash,probeRunId:p.probe.runId,l05RunId:p.l05.runId,
  createdAt:new Date().toISOString(),automaticRetry:false,maxGrantedRequests:20};
  await h.writeFile(JSON.stringify(marker,null,2)+'\n');await h.sync();return deepFreeze(marker);
 }finally{await h.close();}
}
type Observation=Record<string,unknown> & {runId:string};
/** Diagnostic target check only, never a production publication rule or a
 * semantic gold label. A reviewer still assesses the actual correction text. */
export function analyzeL05Chain(value:unknown){
 const reasons:string[]=[],need=(ok:unknown,code:string)=>{if(!ok)reasons.push(code);};
 try{
  ensure(object(value),'L05_ROW_REQUIRED');const row=value;
  const drafts=Array.isArray(row.draftVersions)?row.draftVersions.map(d=>ProposalDraftSchema.parse(d)):[];
  const reviews=Array.isArray(row.reviewVersions)?row.reviewVersions.map(r=>CriticReviewSchema.parse(r)):[];
  need(drafts.length===2&&drafts[0]?.version===1&&drafts[1]?.version===2,'L05_TWO_DRAFTS_REQUIRED');
  need(reviews.length===2&&reviews[0]?.verdict==='revise'&&reviews[1]?.verdict==='approve','L05_REVISE_APPROVE_REQUIRED');
  if(drafts.length===2&&reviews.length===2){
   const [d1,d2]=drafts,[r1,r2]=reviews;
   need(drafts.every(d=>d.runId===row.runId&&d.draftHash===hashArtifact(d))&&reviews.every(r=>r.runId===row.runId&&r.hash===hashArtifact(r)),'L05_ARTIFACT_HASH_OR_RUN');
   need(canonicalizeArtifact({claims:d1!.claims,sections:d1!.sections})!==canonicalizeArtifact({claims:d2!.claims,sections:d2!.sections}),'L05_ONLY_VERSION_CHANGE');
   const manifest=object(row.caseManifest)?row.caseManifest:undefined;
   const paper=Array.isArray(manifest?.sources)?manifest.sources.find(s=>object(s)&&s.alias==='paper-abstract'):undefined;
   need(object(paper)&&r1!.findings.some(f=>f.severity==='blocking'&&f.claimIds.includes('C-GUARANTEE')&&f.evidenceIds.includes(String(paper.evidenceId))),'L05_SPECIFIC_FINDING_REQUIRED');
   const dispatches=Array.isArray(row.loadedReviewSnapshots)?row.loadedReviewSnapshots.filter(object):[];
   need(dispatches.length===2,'L05_DISPATCHES_REQUIRED');
   for(let i=0;i<2;i++){
    const r=reviews[i]!,d=drafts[i]!,snapshot=object(dispatches[i]?.snapshot)?dispatches[i]!.snapshot:undefined;
    need(object(snapshot)&&canonicalizeArtifact(snapshot.target)===canonicalizeArtifact(r.target),'L05_REVIEW_SNAPSHOT_BINDING');
    need(r.target.inputHash===d.inputHash&&r.target.poolHash===d.poolHash&&r.target.poolVersion===d.poolVersion
     &&r.target.draftVersion===d.version&&r.target.draftHash===d.draftHash&&r.target.evidenceSnapshotHash===d.evidenceSnapshotHash,'L05_EXACT_TARGET_BINDING');
   }
   const a1=object(dispatches[0]?.actor)?dispatches[0]!.actor:undefined,a2=object(dispatches[1]?.actor)?dispatches[1]!.actor:undefined;
   need(object(a1)&&object(a2)&&a1.role==='critic'&&a2.role==='critic'&&a1.agentId===a2.agentId&&a1.attempt===1&&a2.attempt===2
    &&a1.taskId!==a2.taskId&&a1.contextId!==a2.contextId,'L05_NEW_CRITIC_CONTEXT_REQUIRED');
   const publication=object(row.publication)?row.publication:undefined;
   need(publication?.mode==='adversarial'&&publication.runnerMode==='live'&&publication.formalProposal===null,'L05_DIAGNOSTIC_ONLY');
   need(typeof publication?.renderedDraft==='string'&&canonicalizeArtifact(JSON.parse(publication.renderedDraft))===canonicalizeArtifact(d2),'L05_EXACT_RENDER_REQUIRED');
  }
  const record=object(row.record)?row.record:undefined;
  need(record?.status==='approved'&&record.runnerMode==='live'&&record.cleanupState==='confirmed'&&record.revisionCount===1,'L05_PARENT_APPROVAL_REQUIRED');
 }catch{reasons.push('L05_CHAIN_MALFORMED');}
 return deepFreeze({structuralChainObserved:reasons.length===0,reasons,semanticQuality:'unadjudicated',
  interpretation:'Hash-bound revision causality only; specific finding and substantive correction remain descriptive model observations, not human gold or accuracy metrics.'});
}
function grants(row:Observation,runId:string,limit:number):number{
 ensure(row.runId===runId,'BOUNDED_RESULT_RUN_IDENTITY');
 ensure(Array.isArray(row.events),'BOUNDED_EVENTS_REQUIRED');
 const g=row.events.filter(e=>object(e)&&e.type==='permit.granted');
 ensure(g.length<=limit,'BOUNDED_REQUEST_BUDGET');
 const requests=new Set(),permits=new Set();
 for(const e of g){ensure(object(e)&&e.runId===runId&&object(e.payload),'BOUNDED_GRANT_RUN');
  UuidSchema.parse(e.payload.requestId);UuidSchema.parse(e.payload.permitId);
  ensure(!requests.has(e.payload.requestId)&&!permits.has(e.payload.permitId),'BOUNDED_DUPLICATE_GRANT');
  requests.add(e.payload.requestId);permits.add(e.payload.permitId);
 }return g.length;
}
function clear(row:Observation):boolean{
 return !row.errorCode&&row.safetyHold===false&&object(row.permitSnapshot)&&row.permitSnapshot.inFlight===0
  &&(row.permitSnapshot.waiting===undefined||row.permitSnapshot.waiting===0)
  &&Array.isArray(row.permitSnapshot.runs)&&row.permitSnapshot.runs.length===1
  &&row.permitSnapshot.runs.every(r=>object(r)&&r.runId===row.runId&&r.inFlight===0&&r.pending===0)
  &&Array.isArray(row.cleanups)&&row.cleanups.length===1&&row.cleanups.every(c=>object(c)&&c.runId===row.runId&&c.confirmed===true)
  &&object(row.record)&&row.record.runId===row.runId&&row.record.cleanupState==='confirmed';
}
/** Parents hard-cap each Scheduler at 4/16 before any request. This independently
 * validates the resulting ledger; it never uses old Run grants or retries. */
export async function runConditionalValidation(value:unknown,execute:{probe():Promise<Observation>;l05():Promise<Observation>}){
 const p=validateBoundedPlan(value),rows:Observation[]=[];let totalGranted=0,stopReason:string|null=null;
 const observedGrants=()=>new Set(rows.flatMap(r=>Array.isArray(r.events)?r.events:[])
  .filter(e=>object(e)&&e.type==='permit.granted'&&object(e.payload))
  .map(e=>JSON.stringify([e.runId,e.payload.requestId,e.payload.permitId]))).size;
 try{const row=await execute.probe();rows.push(row);totalGranted=observedGrants();grants(row,p.probe.runId,4);
  ensure(clear(row)&&object(row.analysis)&&row.analysis.valid===true,'PROTOCOL_PROBE_NOT_PASSED');
 }catch{stopReason='BOUNDED_PROBE_STOPPED';if(!rows.length)rows.push({runId:p.probe.runId,status:'technical_failure',errorCode:stopReason});}
 if(stopReason){rows.push({runId:p.l05.runId,status:'unexecuted',reasonCodes:[stopReason]});return deepFreeze({rows,totalGranted,stopReason});}
 try{const row=await execute.l05();rows.push(row);totalGranted=observedGrants();grants(row,p.l05.runId,16);
  ensure(totalGranted<=20&&clear(row),'BOUNDED_L05_TECHNICAL_STOP');
  if(!object(row.record)||row.record.status!=='approved'||!object(row.l05Analysis)||row.l05Analysis.structuralChainObserved!==true)stopReason='L05_TARGET_NOT_ACHIEVED';
 }catch{stopReason='BOUNDED_L05_STOPPED';if(rows.length<2)rows.push({runId:p.l05.runId,status:'technical_failure',errorCode:stopReason});}
 return deepFreeze({rows,totalGranted,stopReason});
}

const root=fileURLToPath(new URL('../../../',import.meta.url));
const digestText=(s:string)=>sha256Bytes(Buffer.from(s,'utf8'));
export async function collectBoundedProductFingerprints(){
 const rows=await collectCriticProductFingerprints(root);
 for(const file of ['scripts/prepare-task7s-validation.mjs','scripts/audit-task7r-historical-recovery.mjs'])
  rows.push({file,sha256:sha256Bytes(await readFile(resolve(root,file)))});
 return rows.sort((a,b)=>a.file.localeCompare(b.file,'en'));
}
function safeCode(error:unknown,fallback:string){const c=object(error)?error.code:undefined;
 if(typeof c==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(c))return c;
 return error instanceof Error&&/^[A-Z][A-Z0-9_]{0,95}$/.test(error.message)?error.message:fallback;}
export async function finalizeBoundedEvidence(options:{close():Promise<void>;verify():Promise<void>;
 save(value:Record<string,unknown>&{errorCode:string|null;historyUnchanged:boolean|null}):Promise<void>;summary:Record<string,unknown>&{errorCode:string|null}}){
 let errorCode=options.summary.errorCode,historyUnchanged:boolean|null=null;
 try{await options.close();}catch(error){errorCode??=safeCode(error,'BOUNDED_STORE_CLOSE_FAILED');}
 try{await options.verify();historyUnchanged=true;}catch(error){historyUnchanged=false;errorCode??=safeCode(error,'BOUNDED_FINAL_HISTORY_CHECK_FAILED');}
 const value={...options.summary,errorCode,historyUnchanged};await options.save(value);return value;
}
async function readEvidence(path:string){try{const text=await readFile(path,'utf8');return{text,records:text.split(/\r?\n/).filter(Boolean).map(line=>{
 const v:unknown=JSON.parse(line);ensure(object(v),'BOUNDED_EVIDENCE_LINE');return v;})};}catch{return{text:'',records:[] as Record<string,unknown>[]};}}
async function verifyOriginals(baseline:Record<string,any>){for(const f of [...baseline.historicalLive,...baseline.historicalStore.files])
 ensure(sha256Bytes(await readFile(f.file))===f.sha256,'BOUNDED_HISTORY_CHANGED');}

/** Explicit one-shot entry; called only after the offline engineering gate is
 * produced and independently reviewed. The legacy matrix stays hard-locked. */
export async function runBoundedLiveValidation(){
 const output=resolve(root,'docs/implementation/task-7s-live'),freezePath=join(output,'freeze.json');
 const freezeBytes=await readFile(freezePath),freeze=validateBoundedPlan(JSON.parse(freezeBytes.toString('utf8')));
 ensure(freeze.productFingerprints&&freeze.engineeringGate&&freeze.model&&freeze.gatewayBaseURL&&freeze.recoveryAuthorization,'BOUNDED_FREEZE_INCOMPLETE');
 const gateBytes=await readFile(resolve(root,freeze.engineeringGate.file));ensure(sha256Bytes(gateBytes)===freeze.engineeringGate.sha256,'BOUNDED_ENGINEERING_GATE_HASH');
 const gate=JSON.parse(gateBytes.toString('utf8'));
 ensure(gate.engineeringVerified===true&&gate.independentReviewPassed===true
  &&canonicalizeArtifact(gate.productFingerprints)===canonicalizeArtifact(freeze.productFingerprints),'BOUNDED_ENGINEERING_GATE');
 ensure(canonicalizeArtifact(await collectBoundedProductFingerprints())===canonicalizeArtifact(freeze.productFingerprints),'BOUNDED_PRODUCT_CHANGED');
 ensure(process.env.EINSTEIN_GATEWAY_API_KEY&&process.env.EINSTEIN_GATEWAY_MODEL===freeze.model&&process.env.EINSTEIN_GATEWAY_BASE_URL===freeze.gatewayBaseURL,'BOUNDED_CONFIG_CHANGED');
 const baseline=JSON.parse(await readFile(resolve(root,'docs/implementation/task-7s-baseline.json'),'utf8'));
 await verifyOriginals(baseline);
 await acquireBoundedAttempt(output,freeze); // exclusive before recovery/store/model side effects
 const snapshotPath=resolve(root,'reference/einstein-matchmaker-data');
 const loadOfficial=()=>loadSnapshot(snapshotPath,DATASET_COMMIT);
 const authorization=HistoricalRecoveryAuthorizationSchema.parse(freeze.recoveryAuthorization);
 const authorizationBytes=await readFile(resolve(root,'docs/implementation/task-7s-authorization.json'));
 ensure(sha256Bytes(authorizationBytes)===freeze.authorizationFileSha256
  &&canonicalizeArtifact(JSON.parse(authorizationBytes.toString('utf8')))===canonicalizeArtifact(authorization),'BOUNDED_AUTHORIZATION_FILE_HASH');
 const openStore=()=>RunStore.open(baseline.historicalStore.root,{historicalRecovery:authorization,publicationSnapshot:loadOfficial});
 let store:RunStore|undefined,summary:unknown,failed:string|null=null;
 try{
  store=await openStore();const before={diagnostics:store.diagnostics,run:store.getRun(authorization.runId),safetyHold:store.safetyHold};
  const resolution=await store.applyHistoricalRecovery();await verifyOriginals(baseline);
  const immediate={safetyHold:store.safetyHold,diagnostics:store.diagnostics,unresolved:store.unresolvedDiagnostics};
  ensure(!store.safetyHold,'BOUNDED_RECOVERY_OTHER_HOLD');await store.close();store=await openStore();
  const restart={safetyHold:store.safetyHold,run:store.getRun(authorization.runId),diagnostics:store.diagnostics,unresolved:store.unresolvedDiagnostics,resolutions:store.historicalResolutions};
  await writeFile(join(output,'recovery-result.json'),JSON.stringify({scope,runnerMode:'not_model_run',before,resolution,immediate,restart,
   historyUnchanged:true,currentPermitManagerNotTouched:true,historicalCleanupConfirmed:false},null,2)+'\n',{flag:'wx'});
  ensure(!store.safetyHold&&restart.resolutions.length===1,'BOUNDED_RECOVERY_RESTART');await verifyOriginals(baseline);
  const cwd=await mkdtemp(join(tmpdir(),'einstein task7s empty worker cwd '));
  const runOne=async(kind:'probe'|'l05'):Promise<Observation>=>{
   const planned=freeze[kind],folder=join(output,'runs',planned.runId);await mkdir(folder);
   await writeFile(join(folder,'attempt.json'),JSON.stringify({kind,runId:planned.runId,freezeHash:freeze.hash,createdAt:new Date().toISOString(),automaticRetry:false})+'\n',{flag:'wx'});
   ensure(sha256Bytes(await readFile(freezePath))===sha256Bytes(freezeBytes),'BOUNDED_FREEZE_CHANGED');
   ensure(canonicalizeArtifact(await collectBoundedProductFingerprints())===canonicalizeArtifact(freeze.productFingerprints),'BOUNDED_PRODUCT_CHANGED');
   const scheduler=new Scheduler({store:store!,runnerMode:'live',snapshotPath,limits:{...DEFAULT_LIMITS,maxModelRequests:kind==='probe'?4:16},
    publicationContext:async input=>{ensure(kind==='l05'&&input.runId===freeze.l05.runId,'BOUNDED_PROBE_PUBLISH_FORBIDDEN');
     return buildCriticCase(await loadOfficial(),'L05',input.runId).research;},
    createHost:callbacks=>new ProcessHost({workerPath:resolve(root,'dist/server/evaluation',kind==='probe'?'protocol-probe-worker.js':'bounded-critic-worker.js'),
     workerArgs:['--validation-freeze',freezePath,'--validation-freeze-hash',sha256Bytes(freezeBytes)],cwd,...callbacks})});
   ensure(scheduler.permits.snapshot().inFlight===0&&scheduler.permits.snapshot().runs.length===0,'BOUNDED_NEW_PERMIT_MANAGER_NOT_EMPTY');
   let errorCode:string|null=null;
   try{await scheduler.submit(planned.input);await scheduler.waitForIdle(205000);}catch(error){errorCode=safeCode(error,'BOUNDED_RUN_FAILED');}
   finally{try{await scheduler.close();}catch(error){errorCode??=safeCode(error,'BOUNDED_SCHEDULER_CLOSE_FAILED');}}
   const record=store!.getRun(planned.runId),events=record?store!.eventsAfter(planned.runId,0):[];
   const cleanups=scheduler.cleanupEvidence.map(c=>{const{stdout,stderr,...exit}=c.exit;return{...c,exit,
    outputHashes:{stdout:digestText(stdout),stderr:digestText(stderr)},outputBytes:{stdout:Buffer.byteLength(stdout),stderr:Buffer.byteLength(stderr)}};});
   const evidence=await readEvidence(join(folder,'worker-evidence.jsonl'));
   if(!evidence.records.length)errorCode??='BOUNDED_WORKER_EVIDENCE_MISSING';
   const requests=summarizeCriticRequestIntervals(evidence.records.filter(r=>r.kind==='request').map(r=>r.trace as any));
   const artifacts=evidence.records.filter(r=>r.kind==='artifact').map(r=>r.artifact as any),drafts=artifacts.filter(a=>a.kind==='proposal_draft').map(a=>a.artifact),reviews=artifacts.filter(a=>a.kind==='critic_review').map(a=>a.artifact);
   const base={runId:planned.runId,kind,runnerMode:'live',controlledAdversarial:true,showcaseEligible:false,record:record??null,status:record?.status??'technical_failure',
    events,cleanups,errorCode,safetyHold:scheduler.safetyHold,diagnostics:scheduler.diagnostics,permitSnapshot:scheduler.permits.snapshot(),
    ...(kind==='l05'?{caseManifest:freeze.l05.manifest}:{}),
    requests,publication:store!.getPublication(planned.runId)??null,reviewVersions:reviews,draftVersions:drafts,
    loadedReviewSnapshots:evidence.records.filter(r=>r.kind==='review.dispatch'),nativeToolRoundTrips:summarizeCriticToolRoundTrips(evidence.records),
    versionDifferences:drafts.length>=2?diffReviewedDrafts(drafts[0],drafts[1]):[],qualityMetrics:'NA_NO_HUMAN_LABELS',automaticRetries:0};
   const protocol=kind==='probe'?analyzeProtocolProbe({...base,expected:{companyId:planned.input.companyId,challengeId:planned.input.challengeId,researcherId:freeze.probe.researcherId},records:evidence.records}):undefined;
   const result={...base,analysis:protocol?{...protocol,valid:protocol.passed}:{valid:false,status:'requires_raw_semantic_observation'},
    ...(kind==='l05'?{l05Analysis:analyzeL05Chain(base)}:{}),finishedAt:new Date().toISOString()};
   await writeFile(join(folder,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
   await verifyOriginals(baseline);return result;
  };
  summary=await runConditionalValidation(freeze,{probe:()=>runOne('probe'),l05:()=>runOne('l05')});
 }catch(error){failed=safeCode(error,'BOUNDED_VALIDATION_STOPPED');}
 finally{
  const final=await finalizeBoundedEvidence({close:async()=>{if(store)await store.close();},verify:()=>verifyOriginals(baseline),
   summary:{scope,freezeHash:freeze.hash,finishedAt:new Date().toISOString(),execution:summary??null,errorCode:failed,
    humanLabels:0,qualityMetrics:'NA',holdout:'unopened',showcaseEligible:false,batchStillLocked:true,Task8Started:false},
   save:async value=>{await writeFile(join(output,'summary.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx'});}});
  failed=final.errorCode;
 }
 return{summary,errorCode:failed};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runBoundedLiveValidation().then(value=>{
 if(value.errorCode||(object(value.summary)&&value.summary.stopReason))process.exitCode=1;
}).catch(()=>{console.error('BOUNDED_VALIDATION_STOPPED_NO_RETRY');process.exitCode=1;});
