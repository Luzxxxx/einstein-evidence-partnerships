// Read-only audit plus two explicitly named wx exports. Never runs a model,
// Runtime, worker, test, build, RunStore.open, recovery, kill or Git mutation.
import {readFile,readdir,writeFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectV4ProductFingerprints,validateV4Plan} from '../dist/server/evaluation/protocol-probe-v4-plan.js';
import {v4GateExpectations} from '../dist/server/evaluation/v4-bounded-validation.js';
import {evaluateV4ProbeGate} from '../dist/server/evaluation/protocol-probe-v4-gate.js';
import {hashRunInput} from '../dist/server/evidence/hashing.js';

const root=fileURLToPath(new URL('../',import.meta.url)),folder='docs/implementation',live=folder+'/task-7x-live';
const need=(v,c)=>{if(!v)throw Error(c);},slash=p=>p.replaceAll('\\','/'),sha=b=>createHash('sha256').update(b).digest('hex');
const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
const list=args=>git(args).split('\0').filter(Boolean),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const bytes=f=>readFile(resolve(root,f)),json=async f=>JSON.parse((await bytes(f)).toString('utf8')),hash=async f=>sha(await bytes(f));
async function exists(f){try{await access(resolve(root,f));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function optional(f){return await exists(f)?json(f):null;}
async function walk(dir){const out=[];for(const e of await readdir(resolve(root,dir),{withFileTypes:true})){const f=join(resolve(root,dir),e.name);if(e.isDirectory())out.push(...await walk(f));else if(e.isFile())out.push(resolve(f));else throw Error('X_UNEXPECTED_LINK');}return out.sort();}
async function verifyFiles(files){const out=[];for(const f of files){const b=await bytes(f.file),actual=sha(b);need(actual===f.sha256&&(f.bytes===undefined||b.length===f.bytes),'X_PROTECTED_BYTES_CHANGED');out.push({file:f.file,bytes:b.length,sha256:actual,unchanged:true});}return out;}
const mode=process.argv[2],suffix=process.argv[3]??'';
need(['engineering','final'].includes(mode)&&process.argv.length<=4&&/^(?:-v[1-9][0-9]*)?$/.test(suffix),'X_MODE_OR_SUFFIX');
const baselineRaw=await bytes(folder+'/task-7x-baseline.json'),baseline=JSON.parse(baselineRaw.toString('utf8'));
need(baseline.head==='c7480c7a75493c5641c9a5a9fcca153533e06df1'&&baseline.branch==='codex/task-3-evidence'
 &&baseline.protectedUntracked.length===424&&baseline.untrackedPaths.length===424&&baseline.trackedChanges.length===5
 &&baseline.historicalImplementation.length===1149&&baseline.historicalStore.files.length===97&&baseline.oldRuntime.length===131,'X_BASELINE');
const head=git(['rev-parse','HEAD']).trim(),branch=git(['branch','--show-current']).trim();
need(branch===baseline.branch&&baseline.staged.length===0&&list(['diff','--cached','--name-only','-z']).length===0,'X_BRANCH_OR_NONEMPTY_INDEX');
if(mode==='engineering')need(head===baseline.head,'X_ENGINEERING_HEAD_CHANGED');
else git(['merge-base','--is-ancestor',baseline.head,head]);
const tracked=new Set(list(['ls-files','-z'])),untracked=list(['ls-files','--others','--exclude-standard','-z']),oldUntracked=new Set(baseline.untrackedPaths);
need(baseline.untrackedPaths.every(f=>untracked.includes(f)&&!tracked.has(f)),'X_INITIAL_UNTRACKED_STATUS_CHANGED');
const protectedUntracked=await verifyFiles(baseline.protectedUntracked),priorTracked=await verifyFiles(baseline.trackedChanges),
 historical=await verifyFiles(baseline.historicalImplementation),store=await verifyFiles(baseline.historicalStore.files),
 decisions=await verifyFiles([baseline.existingAuthorization,baseline.existingResolution]),sources=await verifyFiles(baseline.officialSources);
need(protectedUntracked.filter(f=>f.file.endsWith('.json')).length===216,'X_PROTECTED_JSON_COUNT');
need(sources.length===8&&git(['-C','reference/einstein-matchmaker-data','rev-parse','HEAD']).trim()===baseline.datasetCommit
 &&git(['-C','reference/einstein-matchmaker-data','status','--porcelain'])===baseline.datasetStatus&&baseline.datasetStatus==='','X_DATASET_CHANGED');
const review=await json(folder+'/task-7x-independent-review.json');
need(review.task==='Task7x'&&review.baseline.head===baseline.head&&review.baseline.sha256===sha(baselineRaw)
 &&review.conclusion.remainingConcreteStaticBlockers===0&&review.conclusion.staticReview==='NO_REMAINING_CONCRETE_BLOCKERS'
 &&review.reviewerScope.reviewerExecutedTests===false&&review.reviewerScope.reviewerCompiled===false&&review.reviewerScope.reviewerModelRequests===0
 &&review.sourceHashes.length===16&&new Set(review.sourceHashes.map(f=>f.file)).size===16,'X_INDEPENDENT_REVIEW');
await verifyFiles(review.sourceHashes);
const approvedRuntimePaths=new Set(['src/supervisor/permits.ts','dist/server/supervisor/permits.js']),runtime=[],approvedRuntimeChanges=[];
need(review.approvedPriorRuntimeChanges.length===2,'X_RUNTIME_CHANGE_COUNT');
for(const old of baseline.oldRuntime){const actual=await hash(old.file);
 if(approvedRuntimePaths.has(old.file)){const approval=review.approvedPriorRuntimeChanges.find(f=>f.file===old.file);
  need(approval?.beforeSha256===old.sha256&&approval.afterSha256===actual&&actual!==old.sha256,'X_APPROVED_RUNTIME_CHANGE_MISMATCH');
  approvedRuntimeChanges.push({file:old.file,beforeSha256:old.sha256,afterSha256:actual,approvedChange:true});}
 else{need(actual===old.sha256,'X_UNAPPROVED_RUNTIME_CHANGE');runtime.push({file:old.file,sha256:actual,unchanged:true});}}
need(runtime.length===129&&approvedRuntimeChanges.length===2,'X_RUNTIME_PARTITION');
const fingerprints=await collectV4ProductFingerprints();
const priorPaths=new Set(priorTracked.map(f=>f.file)),allowedModified=new Set(['src/supervisor/permits.ts','tests/fixtures/staged-probe-harness.mjs','scripts/verify-task7-processes.mjs','.planning/.active_plan']);
const baselineTracked=new Set(list(['ls-tree','-r','--name-only','-z',baseline.head])),changed=list(['diff','--name-only','-z',baseline.head]);
const modified=changed.filter(f=>baselineTracked.has(f)),addedTracked=changed.filter(f=>!baselineTracked.has(f));
need(modified.every(f=>priorPaths.has(f)||allowedModified.has(f)),'X_UNEXPECTED_OLD_TRACKED_CHANGE');
const explicitNew=new Set([
 'src/evaluation/protocol-probe-v4.ts','src/evaluation/protocol-probe-v4-plan.ts','src/evaluation/protocol-probe-v4-gate.ts',
 'src/evaluation/protocol-probe-worker-v4.ts','src/evaluation/v4-worker-evidence.ts','src/evaluation/v4-bounded-validation.ts',
 'tests/unit/permit-deadline-boundary.test.mjs','tests/integration/scheduler-deadline-boundary.test.mjs',
 'tests/unit/protocol-probe-v4-plan.test.mjs','tests/unit/protocol-probe-v4-gate.test.mjs','tests/unit/v4-bounded-validation.test.mjs',
 'tests/integration/protocol-probe-v4-execution.test.mjs','tests/integration/protocol-probe-v4-worker.test.mjs',
 'tests/fixtures/probe-v4-plan.mjs','tests/fixtures/probe-v4-harness.mjs','tests/fixtures/probe-v4-entry-worker.mjs','tests/fixtures/v4-gate.mjs',
 'scripts/prepare-task7x-validation.mjs','scripts/verify-task7x-delivery.mjs','scripts/audit-task7x-live.mjs',
 '.planning/2026-10-31-task7x-v4-bounded-probe/task_plan.md','.planning/2026-10-31-task7x-v4-bounded-probe/findings.md','.planning/2026-10-31-task7x-v4-bounded-probe/progress.md',
 'docs/superpowers/plans/2026-10-31-task7x-v4-bounded-probe.md',
 folder+'/task-7-process-task7x-pre-live.json',folder+'/task-5-process-task7x-pre-live.json',
 folder+'/task-7-process-task7x-final.json',folder+'/task-5-process-task7x-final.json'
]);
const logs=[];
for(const name of (await readdir(resolve(root,folder))).filter(n=>/^task-7x-.*\.txt$/.test(n)&&!/^task-7x-(?:engineering|final)-delivery/.test(n)).sort()){
 const b=await bytes(folder+'/'+name),text=b.toString('utf8'),stats={};
 for(const k of ['tests','pass','fail','cancelled','skipped','duration_ms']){const m=[...text.matchAll(new RegExp('(?:ℹ|#)\\s+'+k+'\\s+([0-9.]+)','g'))];if(m.length)stats[k]=Number(m.at(-1)[1]);}
 logs.push({file:folder+'/'+name,sha256:sha(b),bytes:b.length,...stats});
}
const failure=/\[ELIFECYCLE\]|Command failed with exit code|error TS\d+|Web build failed:|Offline checks failed:/;
async function requireGreen(name,minTests,exactTests){const row=logs.find(r=>r.file===folder+'/'+name),text=row?await readFile(resolve(root,row.file),'utf8'):'';
 need(row&&row.tests>=minTests&&(exactTests===undefined||row.tests===exactTests)&&row.pass===row.tests&&row.fail===0&&row.cancelled===0&&row.skipped===0
  &&/CHECK_EXIT=0\s*$/.test(text)&&!failure.test(text),'X_TEST_COMMAND_NOT_GREEN');return row;}
const offline=await requireGreen('task-7x-offline-output.txt',940),targeted=await requireGreen('task-7x-final-targeted.txt',162,162);
need(/^\$ node scripts\/test-offline\.mjs\s*$/m.test(await readFile(resolve(root,offline.file),'utf8')),'X_FULL_OFFLINE_HEADER');
const web=logs.find(r=>r.file===folder+'/task-7x-web-output.txt'),webText=web?await readFile(resolve(root,web.file),'utf8'):'';
need(web&&/^\$ node scripts\/build-web\.mjs\s*$/m.test(webText)&&/built in 127ms\b/.test(webText)&&/CHECK_EXIT=0\s*$/.test(webText)&&!failure.test(webText),'X_WEB_COMMAND_NOT_GREEN');
const auditSuffix=mode==='engineering'?'pre-live':'final',audit=await json(folder+'/task-7-process-task7x-'+auditSuffix+'.json'),audit5=await json(folder+'/task-5-process-task7x-'+auditSuffix+'.json');
need(audit.allRegisteredOriginalsGone===true&&audit.liveCount===0&&audit.registeredIdentityCount>0&&audit5.allRegisteredOriginalsGone===true&&audit5.liveFixtureCount===0,'X_WINDOWS_AUDIT');
const auditPaths=new Set(audit.pathsUsed.map(p=>slash(p).toLowerCase())),auditedEvidence=new Set(audit.evidenceFiles.map(slash));
for(const p of ['tests/fixtures/probe-v4-entry-worker.mjs','dist/server/evaluation/protocol-probe-worker-v4.js'])need(auditPaths.has(slash(resolve(root,p)).toLowerCase()),'X_V4_WORKER_PATH_NOT_AUDITED');
const currentWorkerEvidence=(await readdir(resolve(root,folder))).filter(n=>/^task-7x-v4-worker-evidence-.*\.json$/.test(n));
need(currentWorkerEvidence.length>0&&currentWorkerEvidence.every(f=>auditedEvidence.has(f))&&!audit.evidenceFiles.some(f=>f.startsWith('task-7x-deadline-controlled-')),'X_ACTUAL_WORKER_AUDIT_COVERAGE');

let freeze=null,summary=null,attempt=null,actualRun=null,recomputedGate=null,liveFacts={executed:false,totalGranted:0,L05Executed:false};
const expectedStore=baseline.historicalStore.files.map(f=>resolve(root,f.file));
if(mode==='engineering')need(!await exists(live+'/freeze.json')&&!await exists(live+'/attempt.json')&&!await exists(live+'/summary.json')
 &&(!await exists(live)||(await readdir(resolve(root,live))).length===0),'X_ENGINEERING_LIVE_ALREADY_STARTED');
else{
 const freezeRaw=await bytes(live+'/freeze.json'),rawSha=sha(freezeRaw);freeze=validateV4Plan(JSON.parse(freezeRaw.toString('utf8')));
 need(freeze.engineeringSourceCommit===head&&same(freeze.productFingerprints,fingerprints)&&freeze.baseline.sha256===sha(baselineRaw)
  &&resolve(freeze.baseline.storeRoot)===resolve(baseline.historicalStore.root)&&freeze.authorizationFileSha256===baseline.existingAuthorization.sha256
  &&freeze.resolutionFileSha256===baseline.existingResolution.sha256&&same(freeze.existingAuthorization,await json(baseline.existingAuthorization.file)),'X_FINAL_FROZEN_BINDING');
 summary=await optional(live+'/summary.json');attempt=await optional(live+'/attempt.json');
 if(summary)need(summary.scope===freeze.scope&&summary.freezeHash===freeze.hash&&summary.rawFreezeFileSha256===rawSha&&summary.L05Executed===false&&summary.batchStillLocked===true
  &&summary.Task8Started===false&&summary.humanLabels===0&&summary.qualityMetrics==='NA'&&summary.holdout==='unopened'&&summary.recoveryApplyCalls===0&&summary.newRiskExceptions===0&&summary.automaticRetries===0,'X_FINAL_SUMMARY_BOUNDARY');
 if(attempt)need(attempt.scope===freeze.scope&&attempt.freezeHash===freeze.hash&&attempt.probeRunId===freeze.probe.runId&&attempt.maxGrantedRequests===4&&attempt.perContextRequests===2&&attempt.automaticRetry===false&&attempt.sourceCommit===head,'X_FINAL_ATTEMPT');
 const runs=await exists(live+'/runs')?await readdir(resolve(root,live+'/runs')):[];
 need(runs.length<=1&&runs.every(id=>id===freeze.probe.runId),'X_EXTRA_LIVE_RUN_OR_L05');
 const runDir=join(baseline.historicalStore.root,freeze.probe.runId),initial=await optional(join(runDir,'record.json')),
  result=await optional(live+'/runs/'+freeze.probe.runId+'/result.json'),rows=summary?.execution?.rows??[];
 need(Array.isArray(rows)&&rows.length<=1&&rows.every(r=>r.runId===freeze.probe.runId),'X_EXTRA_SUMMARY_RUN');
 if(initial){
  need(attempt&&initial.schemaVersion===1&&initial.record?.runId===freeze.probe.runId&&same(initial.record.input,freeze.probe.input)
   &&initial.record.inputHash===hashRunInput(freeze.probe.input)&&initial.record.runnerMode==='live','X_INITIAL_RUN_BINDING');
  const terminal=await json(join(runDir,'terminal.json')),events=(await readFile(join(runDir,'events.jsonl'),'utf8')).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  for(const name of ['record.json','events.jsonl','terminal.json'])expectedStore.push(resolve(runDir,name));
  need(terminal.schemaVersion===1&&terminal.record?.runId===freeze.probe.runId&&same(terminal.record.input,initial.record.input)
   &&terminal.record.inputHash===initial.record.inputHash&&terminal.record.createdAt===initial.record.createdAt&&terminal.record.admittedAt===initial.record.admittedAt
   &&terminal.record.deadlineAt===initial.record.deadlineAt&&events.length===terminal.eventCount&&events.length===terminal.record.lastSeq
   &&events.every((e,i)=>e.runId===freeze.probe.runId&&e.seq===i+1)&&terminal.publication==null,'X_TERMINAL_PARENT_BINDING');
  if(result){
   const observed=rows[0];need(observed&&same(result.record,terminal.record)&&same(result.events,events)&&same(result.terminalOutcome,terminal.outcome)&&result.publication===null
    &&['record','events','records','cleanups','permitSnapshot','terminalOutcome','publication','safetyHold','errorCode'].every(k=>same(result[k],observed[k])),'X_RESULT_SUMMARY_BINDING');
   const runMarker=await json(live+'/runs/'+freeze.probe.runId+'/attempt.json');need(runMarker.scope===freeze.scope&&runMarker.kind==='probe'&&runMarker.runId===freeze.probe.runId&&runMarker.freezeHash===freeze.hash&&runMarker.rawFreezeFileSha256===rawSha&&runMarker.maxGrantedRequests===4&&runMarker.automaticRetry===false,'X_RUN_ATTEMPT');
   const grants=events.filter(e=>e.type==='permit.granted'),permitRows=result.permitSnapshot?.runs?.filter(r=>r.runId===freeze.probe.runId)??[];
   need(permitRows.length===1&&Number.isSafeInteger(permitRows[0].attempts)&&permitRows[0].attempts===grants.length&&grants.length<=4,'X_GRANTED_BUDGET');
   // Saved results cannot override any immutable host expectation.
   recomputedGate=evaluateV4ProbeGate({...result,...v4GateExpectations(freeze,rawSha),runId:freeze.probe.runId});
   need(same(JSON.parse(JSON.stringify(recomputedGate)),observed.probeGate)&&same(observed.probeGate,result.probeGate),'X_SAVED_GATE_MISMATCH');
   const traces=result.records.filter(r=>r.kind==='request').map(r=>r.trace),starts=traces.filter(r=>r.type==='request.started'),usage=traces.filter(r=>r.type==='usage');
   need(starts.length<=4&&new Set(starts.map(r=>r.requestId)).size===starts.length,'X_HTTP_REQUEST_BUDGET');
   need(auditedEvidence.has('task-7x-live/runs/'+freeze.probe.runId+'/result.json'),'X_LIVE_NOT_AUDITED');
   const known=new Set(audit.known.map(r=>r.pid+':'+r.creationFileTime));
   function identities(v){if(!v||typeof v!=='object')return;if(Number.isSafeInteger(v.pid)&&v.pid>0&&/^\d{17,20}$/.test(v.creationFileTime??'')&&win32.isAbsolute(v.executablePath??''))need(known.has(v.pid+':'+v.creationFileTime),'X_LIVE_IDENTITY_NOT_AUDITED');for(const child of Object.values(v))identities(child);}
   identities(result.cleanups);actualRun={runId:freeze.probe.runId,status:terminal.record.status,resultFile:live+'/runs/'+freeze.probe.runId+'/result.json',resultSha256:await hash(live+'/runs/'+freeze.probe.runId+'/result.json')};
   liveFacts={executed:true,totalGranted:grants.length,gatewayStarted:starts.length,gatewayCompleted:traces.filter(r=>r.type==='request.completed').length,gatewayFailed:traces.filter(r=>r.type==='request.failed').length,
    usageObservations:usage.map(r=>({requestId:r.requestId,status:r.usage?.status??'unknown',usage:r.usage??null})),usageMissingOrUnknown:'Missing requests remain unknown; no historical or failed-request usage is inferred.',
    usageByRequest:starts.map(start=>{const found=usage.filter(r=>r.requestId===start.requestId&&r.permitId===start.permitId&&same(r.actor,start.actor));
     return{requestId:start.requestId,permitId:start.permitId,observations:found.length,status:found.length===1?found[0].usage?.status??'unknown':'unknown',usage:found.length===1?found[0].usage??null:null};}),
    gatePassed:recomputedGate.passed,gateLiveEligible:recomputedGate.liveEligible,
    fullProbePassed:recomputedGate.passed===true&&recomputedGate.liveEligible===true&&summary.passed===true&&summary.execution?.passed===true&&summary.errorCode===null,
    finalizerErrorCode:summary.errorCode??null,L05Executed:false,cleanupConfirmed:result.cleanups.length===1&&result.cleanups[0].confirmed===true,currentPermitSnapshot:result.permitSnapshot,safetyHold:result.safetyHold};
   need(summary.execution.totalGranted===grants.length&&summary.totalGranted===grants.length,'X_SUMMARY_BUDGET');
  }else liveFacts={executed:true,totalGranted:null,evidenceIncomplete:true,reason:'stored Run exists but bounded result is missing',L05Executed:false};
 }else{
  if(result){
   need(rows.length===1&&same(result.record??null,null)&&same(rows[0].record??null,null)&&result.runId===freeze.probe.runId
    &&result.runnerMode==='live'&&result.status==='technical_failure'&&result.publication===null&&Array.isArray(result.events)&&result.events.length===0
    &&Array.isArray(result.records)&&!result.records.some(r=>r.kind==='request')&&result.permitSnapshot?.inFlight===0
    &&Array.isArray(result.permitSnapshot?.runs)&&result.permitSnapshot.runs.length===0&&summary?.passed===false&&summary.totalGranted===0,'X_UNSTORED_TECHNICAL_FAILURE_NOT_PROVEN');
  }else need(rows.length===0,'X_RESULT_WITHOUT_STORED_RUN');
  liveFacts={executed:false,totalGranted:summary?.totalGranted??null,reason:summary?.errorCode??'startup evidence unobserved',L05Executed:false};
 }
 need(summary?.passed!==true||recomputedGate?.passed===true&&recomputedGate.liveEligible===true,'X_FALSE_FULL_PROBE_PASS');
}
need(same(await walk(baseline.historicalStore.root),expectedStore.sort()),'X_ORIGINAL_STORE_FILE_SET');

const historicalPaths=new Set(historical.map(f=>f.file)),generated=new Set();
for(const log of logs)for(const match of (await readFile(resolve(root,log.file),'utf8')).matchAll(/docs[\\/]implementation[\\/]([A-Za-z0-9_-]+\.json)/g)){
 const f=folder+'/'+match[1];if(!oldUntracked.has(f)&&!historicalPaths.has(f))generated.add(f);}
function references(v,out=[]){if(v&&typeof v==='object')for(const[k,c]of Object.entries(v)){if(k==='positiveAuditPath'&&typeof c==='string')out.push(c);else references(c,out);}return out;}
for(const f of generated){for(const ref of references(await json(f))){const normalized=slash(ref),prefix=slash(resolve(root,folder))+'/';
 const rel=normalized.startsWith(folder+'/')?normalized:normalized.toLowerCase().startsWith(prefix.toLowerCase())?folder+'/'+normalized.slice(prefix.length):'';
 need(/^docs\/implementation\/[A-Za-z0-9_-]+\.json$/.test(rel),'X_POSITIVE_AUDIT_REFERENCE');if(!oldUntracked.has(rel)&&!historicalPaths.has(rel))generated.add(rel);}}
const allNew=[...new Set([...untracked,...addedTracked])],owned=allNew.filter(f=>!oldUntracked.has(f)&&(explicitNew.has(f)||f.startsWith(folder+'/task-7x-')||generated.has(f)));
need(allNew.filter(f=>/^(?:src|tests|scripts)\//.test(f)&&!oldUntracked.has(f)).every(f=>explicitNew.has(f)),'X_UNEXPECTED_NEW_CODE');
need(addedTracked.every(f=>owned.includes(f)),'X_UNEXPECTED_TRACKED_ADDITION');
const outputs=[folder+'/task-7x-'+mode+'-file-list'+suffix+'.json',folder+'/task-7x-'+mode+'-verification'+suffix+'.json'];
const allOwned=[...new Set([...modified.filter(f=>allowedModified.has(f)),...owned,...outputs])].sort();
const workingChanges=new Set(list(['diff','--name-only','-z']));
const files=mode==='engineering'?allOwned:allOwned.filter(f=>untracked.includes(f)||workingChanges.has(f)||outputs.includes(f));
need(allOwned.every(f=>!oldUntracked.has(f)&&!priorPaths.has(f)&&!/(^|\/)\.env|^reference\/|^\.agents\/|node_modules/.test(f)),'X_UNSAFE_COMMIT_PATH');
need(untracked.filter(f=>f.startsWith(folder+'/')&&!oldUntracked.has(f)&&!historicalPaths.has(f)).every(f=>allOwned.includes(f)),'X_UNATTRIBUTED_IMPLEMENTATION');
const key=process.env.EINSTEIN_GATEWAY_API_KEY;need(typeof key==='string'&&key.length>0,'X_PRIVATE_SCAN_KEY_REQUIRED');
let exactSecretMatches=0,credentialPatternMatches=0,browserSecretMatches=0,filesScanned=0;
for(const f of allOwned.filter(f=>!outputs.includes(f))){const text=(await bytes(f)).toString('utf8');filesScanned++;if(text.includes(key))exactSecretMatches++;if(/\bsk-[A-Za-z0-9_-]{20,}\b/.test(text))credentialPatternMatches++;}
for(const f of await walk('dist/web/assets')){const text=(await bytes(f)).toString('utf8');if(text.includes(key)||text.includes('EINSTEIN_GATEWAY_API_KEY'))browserSecretMatches++;}
need(!exactSecretMatches&&!credentialPatternMatches&&!browserSecretMatches,'X_SECRET_SCAN');
const result={task:'Task7x',mode,observedAt:new Date().toISOString(),baseline:baseline.head,branch,head,sourceCommit:freeze?.engineeringSourceCommit??null,
 engineeringVerified:true,independentReviewPassed:true,offline,targeted,web:{...web,typecheck:true,build:true,buildMs:127},logs,
 initialCounts:{untrackedFiles:424,protectedJson:216,priorTrackedEdits:5,historicalImplementation:1149,historicalStore:97,oldRuntime:131},
 integrity:{protectedUntracked,priorTracked,historical,store,decisions,sources,unchangedPriorRuntime:runtime,approvedRuntimeChanges,currentProductFingerprints:fingerprints,
  originalStoreOpened:false,recoveryApplyCalls:0,allInitialUntrackedBytesAndStatusPreserved:true,priorRuntimeStatement:'129 original runtime files unchanged; two explicitly approved source/compiled permits files changed.'},
 windows:{task7RegisteredOriginals:audit.registeredIdentityCount,task5RegisteredOriginals:audit5.registeredIdentityCount,allRegisteredOriginalsGone:true,liveWorkers:0,liveFixtures:0,unknownOrphanGuarantee:false,auditFile:folder+'/task-7-process-task7x-'+auditSuffix+'.json'},
 live:liveFacts,actualRun,recomputedGate,originalStoreFileCount:expectedStore.length,existingResolutionReapplied:false,newRiskExceptions:0,
 Task7Overall:'NOT_PASS',humanLabels:0,qualityMetrics:'NA',holdout:'unopened',L05Executed:false,batchStillLocked:true,Task8Started:false,
 sourceChanges:modified.filter(f=>allowedModified.has(f)),newCode:owned.filter(f=>/^(src|tests|scripts)\//.test(f)),generatedByLogs:[...generated].sort(),
 secretScan:{filesScanned,exactSecretMatches,credentialPatternMatches,browserSecretMatches},commitPathCount:files.length,noGitAddDot:true,noPush:true,priorUntrackedNeverAdded:true};
await writeFile(resolve(root,outputs[0]),JSON.stringify({task:'Task7x',mode,baseline:baseline.head,head,files,allTaskOwnedPaths:allOwned,excludedPriorTracked:priorTracked.map(f=>f.file),excludedPriorUntracked:baseline.untrackedPaths},null,2)+'\n',{flag:'wx'});
await writeFile(resolve(root,outputs[1]),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({task:'Task7x',mode,protectedFiles:424,protectedJson:216,priorEdits:5,history:1149,originalStore:97,unchangedPriorRuntime:129,approvedRuntimeChanges:2,
 offlineTests:offline.tests,offlinePass:offline.pass,commitPaths:files.length,live:liveFacts.executed,totalGranted:liveFacts.totalGranted,L05Executed:false,Task7Overall:'NOT_PASS'}));
