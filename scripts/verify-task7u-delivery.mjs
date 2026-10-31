// Read-only verification plus wx-only delivery-manifest export. No model,
// RunStore.open, recovery, permit mutation, worker spawn, lock removal or push.
// The executing host supplies the private key through its existing --env-file;
// this script never prints that value or modifies environment configuration.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join,relative} from 'node:path';
import {sha256Bytes} from '../dist/server/evidence/hashing.js';
import {canonicalizeArtifact} from '../dist/server/contracts/canonical.js';
import {collectLayeredProductFingerprints} from '../dist/server/evaluation/layered-validation.js';

const ensure=(value,code)=>{if(!value)throw Error(code);};
const git=args=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true});
const list=args=>git(args).split('\0').filter(Boolean);
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const shaFile=async file=>sha256Bytes(await readFile(file));
const same=(a,b)=>canonicalizeArtifact(a)===canonicalizeArtifact(b);
const slash=p=>p.replaceAll('\\','/');
async function walk(folder){
 const files=[];
 for(const item of await readdir(folder,{withFileTypes:true})){
  const p=join(folder,item.name);
  if(item.isDirectory())files.push(...await walk(p));
  else if(item.isFile())files.push(resolve(p));
  else throw Error('UNEXPECTED_LINK');
 }
 return files.sort();
}
const baseline=await json('docs/implementation/task-7u-baseline.json');
ensure(baseline.head==='27ecfa38be81f0d1c07b4e1a1bf7c10468838d9c'&&baseline.branch==='codex/task-3-evidence'
 &&baseline.liveRequestsAuthorized===0,'OFFLINE_BASELINE_MISMATCH');
const tracked=new Set(list(['ls-files','-z'])),originalUser=new Set(baseline.protectedUntrackedJson.map(f=>f.file));
const userRecords=await Promise.all(baseline.protectedUntrackedJson.map(async f=>({...f,unchanged:await shaFile(f.file)===f.sha256,untracked:!tracked.has(f.file)})));
const historicalImplementation=await Promise.all(baseline.historicalImplementation.map(async f=>({...f,unchanged:await shaFile(f.file)===f.sha256})));
const historicalStore=await Promise.all(baseline.historicalStore.files.map(async f=>({...f,unchanged:await shaFile(f.file)===f.sha256})));
ensure(userRecords.length===117&&historicalImplementation.length===845&&historicalStore.length===94
 &&userRecords.every(f=>f.unchanged&&f.untracked)&&historicalImplementation.every(f=>f.unchanged)&&historicalStore.every(f=>f.unchanged),'BASELINE_INTEGRITY_FAILED');
const expectedStore=baseline.historicalStore.files.map(f=>resolve(f.file)).sort();
ensure(same(await walk(baseline.historicalStore.root),expectedStore),'ORIGINAL_STORE_FILE_SET_CHANGED');
const decisions=await Promise.all([baseline.existingAuthorization,baseline.existingResolution].map(async f=>({...f,unchanged:await shaFile(f.file)===f.sha256})));
ensure(decisions.every(f=>f.unchanged),'EXISTING_DECISION_CHANGED');

const oldIntegrity=await json('docs/implementation/task-6-integrity.json');
const sources=await Promise.all(oldIntegrity.files.map(async f=>{const bytes=await readFile(resolve('reference/einstein-matchmaker-data',f.file)),actualSha256=sha256Bytes(bytes);
 return{file:f.file,bytes:bytes.length,expectedSha256:f.actualSha256,actualSha256,unchanged:actualSha256===f.actualSha256};}));
const datasetStatus=git(['-C','reference/einstein-matchmaker-data','status','--porcelain']).trim();
ensure(sources.length===8&&sources.every(f=>f.unchanged)&&!datasetStatus,'OFFICIAL_DATA_CHANGED');

const explicitModified=new Set(['README.md','task_plan.md','findings.md','progress.md','src/model/tool-batch.ts',
 'src/runtime/task-context.ts','src/runtime/orchestrator.ts','src/runtime/answer-diagnostics.ts','scripts/verify-task7-processes.mjs']);
const baselineTracked=new Set(list(['ls-tree','-r','--name-only','-z',baseline.head]));
const changed=list(['diff','--name-only','-z',baseline.head]);
const modified=changed.filter(f=>baselineTracked.has(f)),addedTracked=changed.filter(f=>!baselineTracked.has(f));
ensure(modified.every(f=>explicitModified.has(f)),'UNEXPECTED_TRACKED_CHANGE');
const protectedPaths=['src/contracts','src/evidence','src/data','src/retrieval','src/publishing','src/server','src/storage','src/supervisor','web',
 'src/runtime/agents','src/runtime/read-tools.ts','src/runtime/worker-client.ts','src/model/gateway-runner.ts',
 'src/evaluation/protocol-probe.ts','src/evaluation/protocol-probe-worker.ts','src/evaluation/protocol-probe-v2.ts','src/evaluation/protocol-probe-worker-v2.ts',
 'src/evaluation/layered-validation.ts','src/evaluation/layered-critic-worker.ts','src/evaluation/bounded-validation.ts',
 'src/evaluation/batch-control.ts','src/evaluation/critic-cases.ts','src/evaluation/critic-worker.ts','src/evaluation/run-critic-eval.ts',
 'tests/fixtures/retrieval-queries.json','tests/fixtures/retrieval-labels.json','tests/fixtures/critic','artifacts/evaluations','package.json','pnpm-lock.yaml'];
const protectedDiff=list(['diff','--name-only','-z',baseline.head,'--',...protectedPaths]);
ensure(protectedDiff.length===0,'PROTECTED_SOURCE_CHANGED');
// Current authorized code differs from Task7t. Record current TS/compiled JS and
// installed SDK fingerprints; comparing them with the old live freeze is wrong.
const currentProductFingerprints=await collectLayeredProductFingerprints();
ensure(currentProductFingerprints.length>0&&currentProductFingerprints.every(f=>typeof f.file==='string'&&/^[a-f0-9]{64}$/.test(f.sha256)),'CURRENT_FINGERPRINTS_INVALID');

const folder='docs/implementation',logs=[];
for(const name of (await readdir(folder)).filter(n=>/^task-7u-.*\.txt$/.test(n)&&!/^task-7u-delivery.*\.txt$/.test(n)).sort()){
 const bytes=await readFile(join(folder,name)),text=bytes.toString('utf8'),stats={};
 for(const key of ['tests','pass','fail','cancelled','skipped','duration_ms']){
  const matches=[...text.matchAll(new RegExp('(?:ℹ|#)\\s+'+key+'\\s+([0-9.]+)','g'))];
  if(matches.length)stats[key]=Number(matches.at(-1)[1]);
 }
 logs.push({file:name,sha256:sha256Bytes(bytes),bytes:bytes.length,commandHeader:text.split(/\r?\n/).find(line=>line.startsWith('$ '))??null,...stats});
}
const offline=logs.find(r=>r.file==='task-7u-offline-output.txt'),web=logs.find(r=>r.file==='task-7u-web-output.txt');
ensure(offline&&offline.tests>0&&offline.pass===offline.tests&&offline.fail===0&&offline.cancelled===0&&offline.skipped===0,'OFFLINE_NOT_VERIFIED');
const offlineText=await readFile(join(folder,offline.file),'utf8'),webText=web?await readFile(join(folder,web.file),'utf8'):'';
const failure=/\[ELIFECYCLE\]|Command failed with exit code|error TS\d+|Web build failed:|Offline checks failed:/;
ensure(!failure.test(offlineText)&&web&&/^\$ node scripts\/build-web\.mjs\s*$/m.test(webText)&&!failure.test(webText),'FINAL_COMMAND_FAILURE');
const built=[...webText.matchAll(/built in\s+([0-9.]+)(ms|s)\b/g)].at(-1);
ensure(built&&/building .*production/.test(webText),'WEB_NOT_VERIFIED');
const webBuildMs=Number(built[1])*(built[2]==='s'?1000:1);
ensure(Number.isFinite(webBuildMs)&&webBuildMs>=0,'WEB_DURATION_INVALID');

const history=await json('docs/implementation/task-7u-history-analysis-v3.json');
ensure(history.liveRequests===0&&history.storeOperations===0&&history.historicalReclassification===false&&history.originalStatus==='failed'
 &&history.originalAnalysisPassed===false&&history.analysis.native.completedCalls===11&&history.analysis.native.status==='verified'
 &&history.analysis.context.status==='verified'&&history.analysis.http.status==='incomplete'&&history.analysis.directBindingCorruption.length===0
 &&history.analysis.batches.filter(b=>b.httpStatus==='verified').length===2
 &&history.analysis.batches.at(-1).httpStatus==='not_observed_after_stop','HISTORICAL_ANALYSIS_MISMATCH');
for(const f of history.sources)ensure(await shaFile(f.file)===f.sha256&&f.unchangedDuringAnalysis===true,'HISTORY_SOURCE_CHANGED');
const task7Audit=await json('docs/implementation/task-7-process-guard-final-audit.json'),task5Audit=await json('docs/implementation/task-5-process-guard-final-audit.json');
ensure(task7Audit.allRegisteredOriginalsGone===true&&task7Audit.liveCount===0&&task7Audit.registeredIdentityCount>0
 &&task5Audit.allRegisteredOriginalsGone===true&&task5Audit.liveFixtureCount===0&&task5Audit.registeredIdentityCount>0,'WINDOWS_AUDIT_NOT_CONFIRMED');
ensure(Array.isArray(task7Audit.evidenceFiles)&&task7Audit.evidenceFiles.some(f=>/(?:^|\/)task-7u-worker-evidence-[^/]+\.json$/.test(slash(f))),'CURRENT_WINDOWS_WORKER_NOT_AUDITED');

const explicitNew=new Set(['src/evaluation/probe-contract-guard.ts','src/evaluation/protocol-probe-analysis-v3.ts','src/evaluation/protocol-probe-v3.ts',
 'tests/integration/probe-contract-guard.test.mjs','tests/integration/probe-instruction-isolation.test.mjs','tests/integration/probe-v3-execution.test.mjs',
 'tests/unit/protocol-probe-analysis-v3.test.mjs','tests/fixtures/probe-v3-worker.mjs','tests/integration/probe-v3-worker.test.mjs',
 'scripts/analyze-task7u-history.mjs','scripts/verify-task7u-delivery.mjs','docs/superpowers/plans/2026-10-31-task-7-offline-probe-guard.md',
 'docs/implementation/task-7-process-guard-final-audit.json','docs/implementation/task-5-process-guard-final-audit.json']);
// Fixture JSON outside this round's task-7u namespace needs actual ownership
// named by a saved task-7u command output. Historical/user rows are never staged.
const historicalPaths=new Set(baseline.historicalImplementation.map(f=>f.file)),generatedByLogs=new Set();
for(const log of logs)for(const m of (await readFile(join(folder,log.file),'utf8')).matchAll(/docs[\\/]implementation[\\/]([A-Za-z0-9_-]+\.json)/g)){
 const file='docs/implementation/'+m[1];if(!originalUser.has(file)&&!historicalPaths.has(file))generatedByLogs.add(file);
}
for(const file of [...generatedByLogs]){
 const row=await json(file);
 if(typeof row.positiveAuditPath==='string'){
  const p=slash(row.positiveAuditPath),at=p.indexOf('/docs/implementation/');
  const rel=p.startsWith('docs/implementation/')?p:at>=0?p.slice(at+1):'';
  ensure(/^docs\/implementation\/[A-Za-z0-9_-]+\.json$/.test(rel),'INVALID_FIXTURE_AUDIT_REFERENCE');
  if(!originalUser.has(rel)&&!historicalPaths.has(rel))generatedByLogs.add(rel);
 }
}
const untracked=list(['ls-files','--others','--exclude-standard','-z']);
const newOwned=[...new Set([...untracked,...addedTracked])].filter(f=>!originalUser.has(f)&&(explicitNew.has(f)||generatedByLogs.has(f)||f.startsWith('docs/implementation/task-7u-')));
ensure(addedTracked.every(f=>newOwned.includes(f)),'UNEXPECTED_TRACKED_ADDITION');
const revision=process.argv[2]??'';ensure(process.argv.length<=3&&/^(?:-v[1-9][0-9]*)?$/.test(revision),'NEW_VERSION_SUFFIX_REQUIRED');
const outputs=[`docs/implementation/task-7u-file-list${revision}.json`,`docs/implementation/task-7u-verification${revision}.json`];
const files=[...new Set([...modified,...newOwned,...outputs])].sort();
ensure(files.includes('scripts/verify-task7u-delivery.mjs'),'VERIFIER_MISSING_FROM_MANIFEST');
ensure(files.every(f=>!originalUser.has(f)&&!/(^|\/)\.env|node_modules|^reference\/|^preparation\/|^\.agents\//.test(f)),'UNSAFE_COMMIT_PATH');
ensure(!files.some(f=>/^docs\/implementation\/task-7u-/.test(f)&&(/(^|\/)(freeze|attempt)\.json$/.test(f)||f.startsWith('docs/implementation/task-7u-live/'))),'LIVE_ARTIFACT_NOT_AUTHORIZED');
const unexplainedImplementation=untracked.filter(f=>f.startsWith('docs/implementation/')&&!originalUser.has(f)&&!historicalPaths.has(f)&&!files.includes(f));
ensure(unexplainedImplementation.length===0,'UNATTRIBUTED_IMPLEMENTATION_FILE');

const secret=process.env.EINSTEIN_GATEWAY_API_KEY;ensure(typeof secret==='string'&&secret.length>0,'PRIVATE_EXACT_KEY_SCAN_REQUIRED');
let exactSecretMatches=0,credentialPatternMatches=0,browserSecretMatches=0,scannedFiles=0;
for(const file of files.filter(f=>!outputs.includes(f))){const text=await readFile(file,'utf8');scannedFiles++;
 if(text.includes(secret))exactSecretMatches++;if(/\bsk-[A-Za-z0-9_-]{20,}\b/.test(text))credentialPatternMatches++;}
for(const file of await walk('dist/web/assets')){const text=await readFile(file,'utf8');
 if(text.includes(secret)||text.includes('EINSTEIN_GATEWAY_API_KEY'))browserSecretMatches++;}
ensure(!exactSecretMatches&&!credentialPatternMatches&&!browserSecretMatches,'SECRET_SCAN_FAILED');

const metadata=await json('package.json'),installedMozaik=await json('node_modules/@mozaik-ai/core/package.json');
ensure(metadata.dependencies['@mozaik-ai/core']==='4.2.0'&&installedMozaik.version==='4.2.0','MOZAIK_VERSION_CHANGED');
const result={scope:'task7u_offline_probe_guard_and_causal_analysis',baseline:baseline.head,recordedAt:new Date().toISOString(),
 versions:{node:process.version,pnpm:execFileSync('cmd.exe',['/d','/s','/c','pnpm --version'],{encoding:'utf8',windowsHide:true}).trim(),
  mozaik:installedMozaik.version,dependenciesInstalled:0},
 offline:{...offline,successfulSummary:true,commandFailureMarker:false},
 web:{...web,typecheck:true,build:true,buildMs:webBuildMs,validationBasis:'build-web executes tsc before Vite; successful production build and no command failure marker'},logs,
 engineering:{offlineChecksPassed:true,productionProbeGuardAdded:true,probeInstructionIsolated:true,versionedCausalAnalysis:true,
  ordinaryBusinessContractPreserved:true,toolBatchSchedulingAlgorithmReplaced:false,historicalUnknownReclassified:false,liveCompatibilityNotRetested:true},
 live:{authorizedRequests:0,executedRequests:0,newProbeRuns:0,L05Runs:0,freezeCreated:false,attemptCreated:false,automaticRetries:0,formalProposals:0},
 recovery:{sameStore:true,applyCalls:0,newRiskExceptions:0,existingResolutionUnchanged:true,historicalFailedUnconfirmedPreserved:true,
  storeFileSetUnchanged:true,currentPermitManagerNotDebited:true,verificationOpenedStore:false},
 historicalAnalysis:{file:'docs/implementation/task-7u-history-analysis-v3.json',originalFailedUnchanged:true,reclassification:false,
  nativeCalls:11,batches:history.analysis.batches.map(b=>({role:b.actor.role,calls:b.callCount,native:b.nativeStatus,context:b.contextStatus,http:b.httpStatus})),
  directBindingCorruption:0,lastCounterHTTP:'not_observed_after_stop',oldTask7sProposerTextAndFailureDetail:'unknown'},
 windows:{task7RegisteredIdentities:task7Audit.registeredIdentityCount,task7AllRegisteredOriginalsGone:true,task7LiveWorkers:0,
  task5RegisteredIdentities:task5Audit.registeredIdentityCount,task5AllRegisteredOriginalsGone:true,task5LiveFixtures:0,unknownOrphanGuarantee:false},
 integrity:{sources,datasetCommit:git(['-C','reference/einstein-matchmaker-data','rev-parse','HEAD']).trim(),datasetGitStatus:datasetStatus,userRecords,
  historicalImplementation,historicalStore,decisions,originalStoreFileCount:expectedStore.length,originalStoreFileSetUnchanged:true,protectedPaths,protectedDiff,
  currentProductFingerprints,fingerprintCount:currentProductFingerprints.length,fingerprintsComparedToOldLiveFreeze:false},
 fixtureOwnership:{namedByLogs:[...generatedByLogs].sort(),neverIncludesProtectedUserJson:true},
 secretScan:{scannedFiles,exactSecretMatches,credentialPatternMatches,browserSecretMatches},
 quality:{humanLabels:0,metrics:'NA',holdout:'unopened',Task4:'PENDING',Task7Overall:'NOT_PASS',CriticRunsThisRound:0,L05ApprovedRevisionGoal:'NOT_ACHIEVED'},
 exactCommitPathCount:files.length,noGitAddDot:true,noPush:true,batchStillLocked:true,Task8Started:false};
await writeFile(outputs[0],JSON.stringify({baseline:baseline.head,scope:result.scope,files,protectedUserUntracked:[...originalUser],
 excludedUntrackedCount:untracked.filter(f=>!files.includes(f)).length},null,2)+'\n',{flag:'wx'});
await writeFile(outputs[1],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({offlineTests:offline.tests,offlinePass:offline.pass,webBuildMs,sourceFiles:sources.length,userJsonUnchanged:userRecords.length,
 historicalImplementationUnchanged:historicalImplementation.length,historicalStoreUnchanged:historicalStore.length,currentSourceFingerprints:currentProductFingerprints.length,
 liveRequests:0,Task7Overall:'NOT_PASS',exactSecretMatches,credentialPatternMatches,browserSecretMatches,commitPaths:files.length}));
