// Read-only validation with wx-only manifest export. No model request,
// RunStore.open, recovery apply, worker spawn, permit mutation, lock deletion,
// git add, commit or push. The private key is supplied by the host's env-file
// solely for an exact local scan; it is never printed or placed in an artifact.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join,relative,win32} from 'node:path';
import {canonicalizeArtifact} from '../dist/server/contracts/canonical.js';
import {sha256Bytes,hashRunInput} from '../dist/server/evidence/hashing.js';
import {validateV3Plan,collectV3ProductFingerprints} from '../dist/server/evaluation/v3-bounded-validation.js';
import {evaluateV3ProbeGate} from '../dist/server/evaluation/protocol-probe-v3-gate.js';

const ensure=(value,code)=>{if(!value)throw Error(code);};
const git=args=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true});
const list=args=>git(args).split('\0').filter(Boolean);
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const optional=async file=>{try{return await json(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const shaFile=async file=>sha256Bytes(await readFile(file));
const same=(a,b)=>canonicalizeArtifact(a)===canonicalizeArtifact(b),slash=p=>p.replaceAll('\\','/');
const implementation='docs/implementation',live=implementation+'/task-7v-live',project=slash(resolve('.'));
async function walk(folder){
 const result=[];for(const entry of await readdir(folder,{withFileTypes:true})){
  const path=join(folder,entry.name);
  if(entry.isDirectory())result.push(...await walk(path));else if(entry.isFile())result.push(resolve(path));else throw Error('UNEXPECTED_LINK');
 }return result.sort();
}
const baselineFile=implementation+'/task-7v-baseline.json',baselineRaw=await readFile(baselineFile),baseline=JSON.parse(baselineRaw.toString('utf8'));
ensure(baseline.head==='c2fcaea67a57eff3a56b2f98b6b8cf80024a677f'&&baseline.branch==='codex/task-3-evidence','V3_DELIVERY_BASELINE');
const freeze=validateV3Plan(await json(live+'/freeze.json')),summary=await json(live+'/summary.json');
ensure(freeze.baseline.file===baselineFile&&freeze.baseline.sha256===sha256Bytes(baselineRaw)
 &&resolve(freeze.baseline.storeRoot)===resolve(baseline.historicalStore.root),'V3_DELIVERY_BASELINE_BINDING');
ensure(summary.scope===freeze.scope&&summary.freezeHash===freeze.hash&&summary.recoveryApplyCalls===0&&summary.newRiskExceptions===0
 &&summary.humanLabels===0&&summary.qualityMetrics==='NA'&&summary.holdout==='unopened'&&summary.batchStillLocked===true
 &&summary.Task8Started===false,'V3_DELIVERY_SUMMARY_BOUNDARY');
const tracked=new Set(list(['ls-files','-z'])),originalUser=new Set(baseline.protectedUntrackedJson.map(f=>slash(f.file)));
const currentBranch=git(['branch','--show-current']).trim();ensure(currentBranch===baseline.branch,'V3_DELIVERY_BRANCH_CHANGED');
const protectedUser=await Promise.all(baseline.protectedUntrackedJson.map(async f=>({...f,unchanged:await shaFile(f.file)===f.sha256,untracked:!tracked.has(slash(f.file))})));
const historicalImplementation=await Promise.all(baseline.historicalImplementation.map(async f=>({...f,unchanged:await shaFile(f.file)===f.sha256})));
const historicalStore=await Promise.all(baseline.historicalStore.files.map(async f=>({...f,unchanged:await shaFile(f.file)===f.sha256})));
ensure(protectedUser.length===142&&originalUser.size===142&&historicalImplementation.length===939&&historicalStore.length===94
 &&protectedUser.every(f=>f.unchanged&&f.untracked)&&historicalImplementation.every(f=>f.unchanged)&&historicalStore.every(f=>f.unchanged),'V3_DELIVERY_HISTORY_CHANGED');
const decisions=await Promise.all([baseline.existingAuthorization,baseline.existingResolution].map(async f=>({...f,unchanged:await shaFile(f.file)===f.sha256})));
ensure(decisions.every(f=>f.unchanged),'V3_DELIVERY_EXISTING_DECISION_CHANGED');
ensure(freeze.authorizationFileSha256===baseline.existingAuthorization.sha256
 &&freeze.resolutionFileSha256===baseline.existingResolution.sha256,'V3_DELIVERY_DECISION_BINDING');

const oldIntegrity=await json(implementation+'/task-6-integrity.json');
ensure(same(freeze.sourceIntegrity,oldIntegrity.files),'V3_DELIVERY_SOURCE_MANIFEST');
const sources=await Promise.all(oldIntegrity.files.map(async f=>{const bytes=await readFile(resolve('reference/einstein-matchmaker-data',f.file)),actualSha256=sha256Bytes(bytes);
 return{file:f.file,bytes:bytes.length,expectedSha256:f.actualSha256,actualSha256,unchanged:actualSha256===f.actualSha256};}));
const datasetStatus=git(['-C','reference/einstein-matchmaker-data','status','--porcelain']).trim();
const datasetCommit=git(['-C','reference/einstein-matchmaker-data','rev-parse','HEAD']).trim();
ensure(sources.length===8&&sources.every(f=>f.unchanged)&&!datasetStatus&&datasetCommit===freeze.probe.input.datasetCommit,'V3_DELIVERY_OFFICIAL_DATA_CHANGED');
const fingerprints=await collectV3ProductFingerprints();
ensure(same(fingerprints,freeze.productFingerprints),'V3_DELIVERY_FROZEN_PRODUCT_CHANGED');
const preliveGate=await json(freeze.engineeringGate.file);
ensure(await shaFile(freeze.engineeringGate.file)===freeze.engineeringGate.sha256&&preliveGate.task==='Task7v'
 &&preliveGate.engineeringVerified===true&&preliveGate.independentReviewPassed===true&&same(preliveGate.productFingerprints,fingerprints),'V3_DELIVERY_ENGINEERING_GATE');

const executionRows=Array.isArray(summary.execution?.rows)?summary.execution.rows:[];
ensure(executionRows.length<=2&&new Set(executionRows.map(r=>r.runId)).size===executionRows.length
 &&executionRows.every(r=>[freeze.probe.runId,freeze.l05.runId].includes(r.runId)),'V3_DELIVERY_EXECUTION_ROWS');
const attempt=await optional(live+'/attempt.json');
ensure(attempt&&attempt.scope===freeze.scope&&attempt.freezeHash===freeze.hash&&attempt.probeRunId===freeze.probe.runId
 &&attempt.l05RunId===freeze.l05.runId&&attempt.maxGrantedRequests===20&&attempt.automaticRetry===false,'V3_DELIVERY_ATTEMPT');
const actualRuns=[],expectedStore=baseline.historicalStore.files.map(f=>resolve(f.file));
for(const kind of ['probe','l05']){
 const planned=freeze[kind],recordFile=join(baseline.historicalStore.root,planned.runId,'record.json'),initialEnvelope=await optional(recordFile);
 const row=executionRows.find(r=>r.runId===planned.runId);
 if(!initialEnvelope){ensure(!row||row.status==='unexecuted'||row.status==='technical_failure','V3_DELIVERY_MISSING_RUN_RECORD');continue;}
 // record.json retains the admission snapshot inside its versioned envelope;
 // terminal.json owns the final record. Neither file is rewritten here.
 ensure(initialEnvelope.schemaVersion===1&&initialEnvelope.record&&typeof initialEnvelope.record==='object','V3_DELIVERY_INITIAL_RECORD_ENVELOPE');
 const initial=initialEnvelope.record,terminal=await json(join(baseline.historicalStore.root,planned.runId,'terminal.json'));
 ensure(terminal.schemaVersion===1&&terminal.record&&typeof terminal.record==='object','V3_DELIVERY_TERMINAL_ENVELOPE');
 const record=terminal.record;
 ensure(row&&row.status!=='unexecuted'&&initial.runId===planned.runId&&same(initial.input,planned.input)
  &&initial.inputHash===hashRunInput(planned.input)&&initial.runnerMode==='live','V3_DELIVERY_STORED_RUN_BINDING');
 ensure(record.runId===planned.runId&&same(record.input,planned.input)&&record.inputHash===initial.inputHash
  &&record.runnerMode===initial.runnerMode&&record.createdAt===initial.createdAt
  &&record.admittedAt===initial.admittedAt&&record.deadlineAt===initial.deadlineAt,'V3_DELIVERY_TERMINAL_RECORD_BINDING');
 const resultFile=live+'/runs/'+planned.runId+'/result.json',result=await json(resultFile),marker=await json(live+'/runs/'+planned.runId+'/attempt.json');
 ensure(marker.kind===kind&&marker.runId===planned.runId&&marker.freezeHash===freeze.hash&&marker.automaticRetry===false,'V3_DELIVERY_RUN_ATTEMPT');
 ensure(result.runId===planned.runId&&result.runnerMode==='live'&&result.status===record.status&&row.status===record.status
  &&same(result.record,record)&&same(row.record,record)
  &&same(result.events,row.events)&&same(result.permitSnapshot,row.permitSnapshot)&&same(result.terminalOutcome,row.terminalOutcome)
  &&same(result.cleanups,row.cleanups)&&same(result.records,row.records),'V3_DELIVERY_RESULT_SUMMARY_BINDING');
 const parentFiles=[];for(const name of ['record.json','events.jsonl','terminal.json']){
  const file=join(baseline.historicalStore.root,planned.runId,name);expectedStore.push(resolve(file));parentFiles.push({file,sha256:await shaFile(file)});
 }
 const parentEvents=(await readFile(join(baseline.historicalStore.root,planned.runId,'events.jsonl'),'utf8')).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
 ensure(parentEvents.length===terminal.eventCount&&parentEvents.length===record.lastSeq&&same(parentEvents,result.events)
  &&parentEvents.every((event,index)=>event.schemaVersion===1&&event.runId===planned.runId&&event.seq===index+1),'V3_DELIVERY_PARENT_EVENT_BINDING');
 ensure(same(terminal.outcome,result.terminalOutcome)&&same(terminal.publication??null,result.publication??null),'V3_DELIVERY_TERMINAL_BINDING');
 ensure(result.publication?.formalProposal==null,'V3_DELIVERY_FORMAL_PROPOSAL_FORBIDDEN');
 const permits=result.permitSnapshot?.runs?.filter(r=>r.runId===planned.runId)??[],grants=result.events.filter(e=>e.type==='permit.granted');
 ensure(permits.length===1&&Number.isSafeInteger(permits[0].attempts)&&permits[0].attempts===grants.length
  &&grants.length<=(kind==='probe'?4:16),'V3_DELIVERY_REQUEST_BUDGET');
 const traces=result.records.filter(r=>r.kind==='request').map(r=>r.trace);
 actualRuns.push({kind,runId:planned.runId,status:record.status,result,resultFile,resultSha256:await shaFile(resultFile),parentFiles,
  grantedAttempts:permits[0].attempts,requestFacts:{gatewayStarted:traces.filter(t=>t.type==='request.started').length,
   gatewayCompleted:traces.filter(t=>t.type==='request.completed').length,gatewayFailed:traces.filter(t=>t.type==='request.failed').length,
   wireRequests:result.records.filter(r=>r.kind==='wire.request').length,effectivePromptObservations:result.records.filter(r=>r.kind==='wire.effective_prompt').length},
  releaseEvents:result.events.filter(e=>e.type==='permit.released').length,currentPermitSnapshot:result.permitSnapshot,
  cleanupConfirmed:result.cleanups.length===1&&result.cleanups.every(c=>c.confirmed===true),safetyHold:result.safetyHold});
}
ensure(same(await walk(baseline.historicalStore.root),expectedStore.sort()),'V3_DELIVERY_ORIGINAL_STORE_FILE_SET');
const probe=actualRuns.find(r=>r.kind==='probe'),l05=actualRuns.find(r=>r.kind==='l05');
const l05Row=executionRows.find(r=>r.runId===freeze.l05.runId),l05Marker=await optional(live+'/runs/'+freeze.l05.runId+'/attempt.json');
const l05WasAttempted=Boolean(l05||l05Marker||l05Row&&l05Row.status!=='unexecuted');
const l05Status=l05?.status??l05Row?.status??(l05Marker?'attempted_without_stored_run':'unexecuted');
const probeGate=probe?evaluateV3ProbeGate({...probe.result,expected:{companyId:freeze.probe.input.companyId,challengeId:freeze.probe.input.challengeId,researcherId:freeze.probe.researcherId},
 effectiveInstructionSha256:freeze.probe.effectiveInstructionSha256,genericDispatchSha256:freeze.promptContract.genericDispatchSha256}):null;
// A failed gate can contain an unobserved optional interval endpoint. Compare
// its actual JSON representation, without changing either historical artifact
// or claiming that an omitted observation was present.
if(probe)ensure(same(JSON.parse(JSON.stringify(probeGate)),executionRows.find(r=>r.runId===probe.runId).probeGate),'V3_DELIVERY_SAVED_GATE_MISMATCH');
if(l05WasAttempted)ensure(probe&&probeGate.passed===true&&probeGate.liveEligible===true
 &&executionRows.find(r=>r.runId===probe.runId).probeGate.passed===true,'V3_DELIVERY_L05_WITHOUT_COMPLETE_PROBE');
const totalGranted=actualRuns.reduce((n,r)=>n+r.grantedAttempts,0);
ensure(totalGranted<=20&&(!summary.execution||summary.execution.totalGranted===totalGranted),'V3_DELIVERY_TOTAL_BUDGET');
if(!l05)ensure(!executionRows.some(r=>r.runId===freeze.l05.runId&&r.status!=='unexecuted'&&r.status!=='technical_failure'),'V3_DELIVERY_L05_STATUS');

const explicitModified=new Set(['README.md','task_plan.md','findings.md','progress.md','scripts/verify-task7-processes.mjs']);
const baselineTracked=new Set(list(['ls-tree','-r','--name-only','-z',baseline.head])),changed=list(['diff','--name-only','-z',baseline.head]);
const modified=changed.filter(f=>baselineTracked.has(f)),addedTracked=changed.filter(f=>!baselineTracked.has(f));
ensure(modified.every(f=>explicitModified.has(f)),'V3_DELIVERY_UNEXPECTED_TRACKED_CHANGE');
const protectedPaths=['src','tests','web','artifacts/evaluations','package.json','pnpm-lock.yaml'];
const protectedDiff=modified.filter(f=>protectedPaths.some(p=>f===p||f.startsWith(p+'/')));
ensure(protectedDiff.length===0,'V3_DELIVERY_OLD_CODE_CHANGED');
const explicitNew=new Set(['src/evaluation/protocol-probe-v3-gate.ts','src/evaluation/v3-bounded-validation.ts',
 'src/evaluation/protocol-probe-worker-v3.ts','src/evaluation/v3-critic-worker.ts','src/evaluation/v3-worker-evidence.ts',
 'tests/unit/protocol-probe-v3-gate.test.mjs','tests/unit/v3-bounded-validation.test.mjs','tests/unit/v3-workers.test.mjs',
 'tests/fixtures/v3-gate.mjs','tests/fixtures/v3-plan.mjs','tests/fixtures/v3-entry-worker.mjs','tests/integration/v3-entry-e2e.test.mjs',
 'scripts/prepare-task7v-validation.mjs','scripts/audit-task7v-execution.mjs','scripts/verify-task7v-delivery.mjs',
 'docs/superpowers/plans/2026-10-31-task-7-v3-bounded-live.md',
 implementation+'/task-7-process-v3-pre-live-audit.json',implementation+'/task-5-process-v3-pre-live-audit.json',
 implementation+'/task-7-process-v3-final-audit.json',implementation+'/task-5-process-v3-final-audit.json']);
const logs=[];for(const name of (await readdir(implementation)).filter(n=>/^task-7v-.*\.txt$/.test(n)&&!/^task-7v-delivery.*\.txt$/.test(n)).sort()){
 const bytes=await readFile(join(implementation,name)),text=bytes.toString('utf8'),stats={};
 for(const key of ['tests','pass','fail','cancelled','skipped','duration_ms']){
  const matches=[...text.matchAll(new RegExp('(?:ℹ|#)\\s+'+key+'\\s+([0-9.]+)','g'))];if(matches.length)stats[key]=Number(matches.at(-1)[1]);
 }logs.push({file:name,sha256:sha256Bytes(bytes),bytes:bytes.length,commandHeader:text.split(/\r?\n/).find(s=>s.startsWith('$ '))??null,...stats});
}
const offline=logs.find(r=>r.file==='task-7v-offline-output.txt'),web=logs.find(r=>r.file==='task-7v-web-output.txt');
ensure(offline?.tests>0&&offline.pass===offline.tests&&offline.fail===0&&offline.cancelled===0&&offline.skipped===0,'V3_DELIVERY_OFFLINE_NOT_VERIFIED');
const commandFailure=/\[ELIFECYCLE\]|Command failed with exit code|error TS\d+|Web build failed:|Offline checks failed:/;
const offlineText=await readFile(join(implementation,offline.file),'utf8'),webText=web?await readFile(join(implementation,web.file),'utf8'):'';
const built=[...webText.matchAll(/built in\s+([0-9.]+)(ms|s)\b/g)].at(-1);
ensure(!commandFailure.test(offlineText)&&web&&/^\$ node scripts\/build-web\.mjs\s*$/m.test(webText)
 &&!commandFailure.test(webText)&&built&&/building .*production/.test(webText),'V3_DELIVERY_FINAL_COMMAND_FAILURE');
const webBuildMs=Number(built[1])*(built[2]==='s'?1000:1);ensure(Number.isFinite(webBuildMs),'V3_DELIVERY_WEB_DURATION');

const task7Audit=await json(implementation+'/task-7-process-v3-final-audit.json'),task5Audit=await json(implementation+'/task-5-process-v3-final-audit.json');
ensure(task7Audit.allRegisteredOriginalsGone===true&&task7Audit.liveCount===0&&task7Audit.registeredIdentityCount>0
 &&task5Audit.allRegisteredOriginalsGone===true&&task5Audit.liveFixtureCount===0&&task5Audit.registeredIdentityCount>0,'V3_DELIVERY_WINDOWS_AUDIT');
const evidenceFiles=new Set(task7Audit.evidenceFiles.map(slash)),pathsUsed=new Set(task7Audit.pathsUsed.map(p=>slash(p).toLowerCase()));
for(const path of ['tests/fixtures/v3-entry-worker.mjs','dist/server/evaluation/protocol-probe-worker-v3.js','dist/server/evaluation/v3-critic-worker.js'])
 ensure(pathsUsed.has(slash(resolve(path)).toLowerCase()),'V3_DELIVERY_NEW_WORKER_PATH_NOT_AUDITED');
const currentE2E=(await readdir(implementation)).filter(n=>/^task-7v-e2e-evidence-.*\.json$/.test(n));
ensure(currentE2E.length>0&&currentE2E.every(name=>evidenceFiles.has(name)),'V3_DELIVERY_E2E_NOT_AUDITED');
for(const run of actualRuns)ensure(evidenceFiles.has('task-7v-live/runs/'+run.runId+'/result.json'),'V3_DELIVERY_LIVE_NOT_AUDITED');
const auditedIdentities=new Set(task7Audit.known.map(r=>r.pid+':'+r.creationFileTime));
function checkIdentityCoverage(value){if(!value||typeof value!=='object')return;
 if(Number.isSafeInteger(value.pid)&&value.pid>0&&/^\d{17,20}$/.test(value.creationFileTime??'')&&win32.isAbsolute(value.executablePath??''))
  ensure(auditedIdentities.has(value.pid+':'+value.creationFileTime),'V3_DELIVERY_RUN_IDENTITY_NOT_AUDITED');
 for(const child of Object.values(value))checkIdentityCoverage(child);
}
for(const run of actualRuns)checkIdentityCoverage(run.result.cleanups);

const historicalPaths=new Set(baseline.historicalImplementation.map(f=>slash(f.file))),generatedByLogs=new Set();
for(const log of logs)for(const match of (await readFile(join(implementation,log.file),'utf8')).matchAll(/docs[\\/]implementation[\\/]([A-Za-z0-9_-]+\.json)/g)){
 const file=implementation+'/'+match[1];if(!originalUser.has(file)&&!historicalPaths.has(file))generatedByLogs.add(file);
}
function positiveReferences(value,refs=[]){if(!value||typeof value!=='object')return refs;
 for(const [key,child] of Object.entries(value)){if(key==='positiveAuditPath'&&typeof child==='string')refs.push(child);else positiveReferences(child,refs);}return refs;}
for(const file of [...generatedByLogs])for(const ref of positiveReferences(await json(file))){
 const normalized=slash(ref),prefix=project+'/docs/implementation/';
 const rel=normalized.startsWith('docs/implementation/')?normalized:normalized.toLowerCase().startsWith(prefix.toLowerCase())?implementation+'/'+normalized.slice(prefix.length):'';
 ensure(/^docs\/implementation\/[A-Za-z0-9_-]+\.json$/.test(rel),'V3_DELIVERY_POSITIVE_AUDIT_REFERENCE');
 if(!originalUser.has(rel)&&!historicalPaths.has(rel))generatedByLogs.add(rel);
}
const untracked=list(['ls-files','--others','--exclude-standard','-z']);
const owned=[...new Set([...untracked,...addedTracked])].filter(f=>!originalUser.has(f)&&(explicitNew.has(f)||generatedByLogs.has(f)||f.startsWith(implementation+'/task-7v-')));
ensure(addedTracked.every(f=>owned.includes(f)),'V3_DELIVERY_UNEXPECTED_TRACKED_ADDITION');
ensure(untracked.filter(f=>/^(?:src|tests)\//.test(f)).every(f=>explicitNew.has(f)),'V3_DELIVERY_UNEXPECTED_NEW_CODE');
const revision=process.argv[2]??'';ensure(process.argv.length<=3&&/^(?:-v[1-9][0-9]*)?$/.test(revision),'V3_DELIVERY_VERSION_SUFFIX');
const outputs=[implementation+'/task-7v-file-list'+revision+'.json',implementation+'/task-7v-verification'+revision+'.json'];
const files=[...new Set([...modified,...owned,...outputs])].sort();
ensure(files.includes('scripts/verify-task7v-delivery.mjs')&&files.every(f=>!originalUser.has(f)
 &&!/(^|\/)\.env|node_modules|^reference\/|^preparation\/|^\.agents\//.test(f)),'V3_DELIVERY_UNSAFE_COMMIT_PATH');
const unknownImplementation=untracked.filter(f=>f.startsWith(implementation+'/')&&!originalUser.has(f)&&!historicalPaths.has(f)&&!files.includes(f));
ensure(unknownImplementation.length===0,'V3_DELIVERY_UNATTRIBUTED_IMPLEMENTATION');

const secret=process.env.EINSTEIN_GATEWAY_API_KEY;ensure(typeof secret==='string'&&secret.length>0,'PRIVATE_EXACT_KEY_SCAN_REQUIRED');
let exactSecretMatches=0,credentialPatternMatches=0,browserSecretMatches=0,scannedFiles=0;
for(const file of files.filter(f=>!outputs.includes(f))){const text=await readFile(file,'utf8');scannedFiles++;
 if(text.includes(secret))exactSecretMatches++;if(/\bsk-[A-Za-z0-9_-]{20,}\b/.test(text))credentialPatternMatches++;}
for(const file of await walk('dist/web/assets')){const text=await readFile(file,'utf8');if(text.includes(secret)||text.includes('EINSTEIN_GATEWAY_API_KEY'))browserSecretMatches++;}
ensure(!exactSecretMatches&&!credentialPatternMatches&&!browserSecretMatches,'V3_DELIVERY_SECRET_SCAN');
const metadata=await json('package.json'),sdk=await json('node_modules/@mozaik-ai/core/package.json');
ensure(metadata.dependencies['@mozaik-ai/core']==='4.2.0'&&sdk.version==='4.2.0','V3_DELIVERY_MOZAIK_VERSION');
const l05Observed=Boolean(l05&&l05.status==='approved'&&l05.result.l05Analysis?.structuralChainObserved===true);
const result={scope:freeze.scope,baseline:baseline.head,recordedAt:new Date().toISOString(),
 versions:{node:process.version,pnpm:execFileSync('cmd.exe',['/d','/s','/c','pnpm --version'],{encoding:'utf8',windowsHide:true}).trim(),mozaik:sdk.version,dependenciesInstalled:0},
 offline:{...offline,successfulSummary:true,commandFailureMarker:false},web:{...web,typecheck:true,build:true,buildMs:webBuildMs,
  validationBasis:'build-web runs TypeScript before Vite; successful production output without command failure marker'},logs,
 engineering:{offlineChecksPassed:true,independentPreLiveGatePassed:true,oldRuntimeAndUContractsUnchanged:true,liveResultNotInferredFromOffline:true},
 live:{summaryFile:live+'/summary.json',summarySha256:await shaFile(live+'/summary.json'),freezeSha256:await shaFile(live+'/freeze.json'),
  authorizationLimit:20,totalGranted,actualRunCount:actualRuns.length,probeRunId:freeze.probe.runId,L05RunId:freeze.l05.runId,
  probeGate,L05Status:l05Status,L05WasAttempted:l05WasAttempted,L05StructuralRevisionChainObserved:l05Observed,
  runs:actualRuns.map(({result,...run})=>run),summaryErrorCode:summary.errorCode??null,stopReason:summary.execution?.stopReason??null,
  automaticRetries:0,formalProposals:0,unspentAuthorizationNotReused:true},
 recovery:{sameOriginalStore:true,applyCalls:0,newRiskExceptions:0,existingResolutionUnchanged:true,historicalFailedUnconfirmedBytesPreserved:true,
  currentPermitManagerNotDebitedByHistoricalCount:true,verificationOpenedStore:false,verificationPerformedRestart:false,
  externalRestart:'not_asserted_by_this_read_only_verifier'},
 windows:{task7RegisteredIdentities:task7Audit.registeredIdentityCount,task7AllRegisteredOriginalsGone:true,task7LiveWorkers:0,
  task5RegisteredIdentities:task5Audit.registeredIdentityCount,task5AllRegisteredOriginalsGone:true,task5LiveFixtures:0,newEntryAndLivePathsAudited:true,unknownOrphanGuarantee:false},
 integrity:{sources,datasetCommit,datasetGitStatus:datasetStatus,
  protectedUser,historicalImplementation,historicalStore,decisions,originalStoreFileCount:94,actualAddedRunFiles:actualRuns.length*3,
  currentStoreFileCount:expectedStore.length,storeFileSetExactlyMatchesPlannedActualRuns:true,protectedPaths,protectedDiff,
  currentProductFingerprints:fingerprints,fingerprintCount:fingerprints.length,fingerprintsMatchCurrentFreeze:true},
 fixtureOwnership:{namedByLogs:[...generatedByLogs].sort(),protectedUserNeverIncluded:true},
 secretScan:{scannedFiles,exactSecretMatches,credentialPatternMatches,browserSecretMatches},
 quality:{humanLabels:0,metrics:'NA',holdout:'unopened',Task4:'PENDING',Task7Overall:'NOT_PASS',
  L05Goal:l05Observed?'STRUCTURAL_CHAIN_OBSERVED_PENDING_HUMAN_SEMANTIC_REVIEW':l05?'NOT_ACHIEVED':'UNEXECUTED',
  interpretation:'A protocol observation or approved controlled diagnostic is neither human quality acceptance nor formal Showcase.'},
 git:{branch:currentBranch,head:git(['rev-parse','HEAD']).trim(),modified,newSourceFiles:owned.filter(f=>f.startsWith('src/'))},
 exactCommitPathCount:files.length,noGitAddDot:true,noPush:true,batchStillLocked:true,Task8Started:false};
await writeFile(outputs[0],JSON.stringify({baseline:baseline.head,scope:result.scope,files,protectedUserUntracked:[...originalUser],
 excludedUntrackedCount:untracked.filter(f=>!files.includes(f)).length},null,2)+'\n',{flag:'wx'});
await writeFile(outputs[1],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({offlineTests:offline.tests,offlinePass:offline.pass,webBuildMs,protectedUserJson:protectedUser.length,
 historicalImplementation:historicalImplementation.length,historicalStore:historicalStore.length,storeFiles:expectedStore.length,
 actualRuns:actualRuns.length,totalGranted,probePassed:probeGate?.passed??false,L05Status:l05Status,
 fingerprints:fingerprints.length,exactSecretMatches,credentialPatternMatches,browserSecretMatches,commitPaths:files.length,Task7Overall:'NOT_PASS'}));
