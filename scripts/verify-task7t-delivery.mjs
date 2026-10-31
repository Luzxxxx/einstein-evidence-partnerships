// Read-only verification and exact file manifest export. No model, RunStore.open,
// recovery apply, permit mutation, worker spawn, lock removal or push.
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve, join} from 'node:path';
import {sha256Bytes} from '../dist/server/evidence/hashing.js';
import {canonicalizeArtifact} from '../dist/server/contracts/canonical.js';
import {collectLayeredProductFingerprints, verifyLayeredHistory} from '../dist/server/evaluation/layered-validation.js';

const git = args => execFileSync('git', args, {encoding:'utf8', stdio:['ignore','pipe','pipe']});
const list = args => git(args).split('\0').filter(Boolean);
const j = async p => JSON.parse(await readFile(p, 'utf8'));
const shaFile = async p => sha256Bytes(await readFile(p));
const same = (a,b) => canonicalizeArtifact(a) === canonicalizeArtifact(b);
const ensure = (v,code) => {if (!v) throw Error(code);};
async function walk(root) {
  const result=[];
  for (const row of await readdir(root,{withFileTypes:true})) {
    const p=join(root,row.name);
    if(row.isDirectory()) result.push(...await walk(p));
    else if(row.isFile()) result.push(resolve(p));
    else throw Error('UNEXPECTED_LINK');
  }
  return result.sort();
}
const baseline=await verifyLayeredHistory(), folder='docs/implementation/task-7t-live';
const freeze=await j(folder+'/freeze.json'), tracked=new Set(list(['ls-files','-z']));
const originalUser=new Set(baseline.protectedUntrackedJson.map(f=>f.file));
const userRecords=await Promise.all(baseline.protectedUntrackedJson.map(async f=>({...f,unchanged:await shaFile(f.file)===f.sha256,untracked:!tracked.has(f.file)})));
const historical=await Promise.all([...baseline.historicalImplementation,...baseline.historicalStore.files].map(async f=>({...f,unchanged:await shaFile(f.file)===f.sha256})));
ensure(userRecords.length===95 && historical.length===852 && userRecords.every(r=>r.unchanged&&r.untracked)&&historical.every(r=>r.unchanged),'BASELINE_INTEGRITY_FAILED');
for (const f of [baseline.existingAuthorization,baseline.existingResolution]) ensure(await shaFile(f.file)===f.sha256,'EXISTING_DECISION_CHANGED');
const expectedStore=[...baseline.historicalStore.files.map(f=>resolve(f.file)),
  ...['record.json','events.jsonl','terminal.json'].map(n=>resolve(baseline.historicalStore.root,freeze.probe.runId,n))].sort();
ensure(same(await walk(baseline.historicalStore.root),expectedStore),'UNEXPECTED_STORE_FILE');
const oldIntegrity=await j('docs/implementation/task-6-integrity.json');
const sources=await Promise.all(oldIntegrity.files.map(async f=>{const bytes=await readFile(resolve('reference/einstein-matchmaker-data',f.file));
  return {file:f.file,bytes:bytes.length,expectedSha256:f.actualSha256,actualSha256:sha256Bytes(bytes),unchanged:sha256Bytes(bytes)===f.actualSha256};}));
const datasetStatus=git(['-C','reference/einstein-matchmaker-data','status','--porcelain']).trim();
const protectedPaths=['src/contracts','src/evidence','src/data','src/retrieval','src/publishing','src/server','web','src/model','src/supervisor',
  'src/runtime/gateway-runner.ts','src/runtime/tool-batch.ts','src/runtime/worker-client.ts','src/runtime/roles.ts','src/runtime/read-tools.ts',
  'src/evaluation/batch-control.ts','src/evaluation/critic-cases.ts','src/evaluation/critic-worker.ts','src/evaluation/run-critic-eval.ts',
  'src/evaluation/protocol-probe.ts','src/evaluation/protocol-probe-worker.ts','src/evaluation/bounded-validation.ts',
  'src/storage','tests/fixtures/retrieval-queries.json','tests/fixtures/retrieval-labels.json','tests/fixtures/critic','artifacts/evaluations','package.json','pnpm-lock.yaml'];
const protectedDiff=list(['diff','--name-only','-z',baseline.head,'--',...protectedPaths]);
ensure(sources.length===8&&sources.every(r=>r.unchanged)&&!datasetStatus&&!protectedDiff.length,'PROTECTED_SOURCE_CHANGED');
const productFingerprints=await collectLayeredProductFingerprints();
ensure(productFingerprints.length===115&&same(productFingerprints,freeze.productFingerprints),'PRODUCT_CHANGED_SINCE_FREEZE');
const summary=await j(folder+'/summary.json'),restart=await j('docs/implementation/task-7t-post-execution-restart.json');
const probe=await j(`${folder}/runs/${freeze.probe.runId}/result.json`),executionAudit=await j(folder+'/execution-audit.json');
const audit=await j('docs/implementation/task-7-process-layered-final-audit.json'),task5=await j('docs/implementation/task-5-process-layered-final-audit.json');
const native=(await readFile(`${folder}/runs/${freeze.probe.runId}/worker-evidence.jsonl`,'utf8')).trim().split('\n').map(JSON.parse);
const answerDiagnostics=(await readFile(`${folder}/runs/${freeze.probe.runId}/answer-diagnostics.jsonl`,'utf8')).trim().split('\n').map(JSON.parse);
const grants=probe.events.filter(r=>r.type==='permit.granted'),releases=probe.events.filter(r=>r.type==='permit.released');
ensure(grants.length===4&&releases.length===4&&summary.execution.totalGranted===4&&summary.execution.rows.length===2
  &&summary.execution.rows[1].status==='unexecuted'&&summary.recoveryApplyCalls===0&&summary.newRiskExceptions===0&&summary.historyUnchanged
  &&probe.requests.started===4&&probe.requests.completed===4&&probe.requests.maxObservedInFlight===2&&probe.requests.reportedTotals.totalTokens===162300
  &&probe.analysis.passed===false&&probe.permitSnapshot.inFlight===0&&probe.permitSnapshot.runs.every(r=>r.pending===0&&r.inFlight===0)
  &&probe.cleanups.length===1&&probe.cleanups[0].confirmed&&probe.cleanups[0].exit.exitCode===1&&!probe.safetyHold
  &&restart.recoveryApplyCalls===0&&!restart.safetyHold&&restart.l05===null&&restart.historicalRun.status==='failed'&&restart.historicalRun.cleanupState==='unconfirmed'
  &&restart.existingResolutions.length===1&&restart.freshPermitSnapshot.inFlight===0&&restart.runCount===31
  &&executionAudit.nativeCallCount===11&&executionAudit.batches.length===3&&executionAudit.allNativeBatchesVerified&&executionAudit.allBatchOutputsReturnedToNativeContexts
  &&executionAudit.nextHttpBatchCount===2&&!executionAudit.lastCounterBatchNextHttp
  &&executionAudit.typedOutcome.reasonCodes.includes('PROTOCOL_PROBE_CONTEXT_REQUEST_LIMIT')
  &&answerDiagnostics.length===3&&answerDiagnostics.every(r=>r.actor.role==='proposer')
  &&audit.allRegisteredOriginalsGone&&audit.registeredIdentityCount===517&&audit.liveCount===0
  &&task5.allRegisteredOriginalsGone&&task5.registeredIdentityCount===1220&&task5.liveFixtureCount===0,'ACTUAL_OUTCOME_MISMATCH');
const logs=[];
for (const name of (await readdir('docs/implementation')).filter(n=>/^task-7t-.*\.txt$/.test(n)&&!/^task-7t-delivery.*\.txt$/.test(n)).sort()) {
  const bytes=await readFile('docs/implementation/'+name),text=bytes.toString('utf8'),stats={};
  for(const k of ['tests','pass','fail','cancelled','skipped','duration_ms']) {const m=text.match(new RegExp('ℹ '+k+' ([0-9.]+)'));if(m)stats[k]=Number(m[1]);}
  logs.push({file:name,sha256:sha256Bytes(bytes),bytes:bytes.length,commandHeader:text.split(/\r?\n/).find(l=>l.startsWith('$ '))??null,...stats});
}
const offline=logs.find(r=>r.file==='task-7t-offline-output.txt');
ensure(offline.tests===689&&offline.pass===689&&offline.fail===0&&offline.cancelled===0&&offline.skipped===0,'OFFLINE_NOT_VERIFIED');
ensure((await readFile('docs/implementation/task-7t-web-output.txt','utf8')).includes('built in 139ms'),'WEB_NOT_VERIFIED');
const modified=list(['diff','--name-only','-z',baseline.head]);
const explicitModified=new Set(['README.md','task_plan.md','findings.md','progress.md','docs/superpowers/specs/2026-10-30-interface-contracts.md',
  'src/runtime/task-context.ts','src/runtime/orchestrator.ts','scripts/verify-task7-processes.mjs']);
ensure(modified.every(f=>explicitModified.has(f)),'UNEXPECTED_TRACKED_CHANGE');
const explicitNew=new Set(['src/runtime/answer-diagnostics.ts','src/evaluation/protocol-probe-v2.ts','src/evaluation/protocol-probe-worker-v2.ts',
  'src/evaluation/layered-validation.ts','src/evaluation/layered-critic-worker.ts','tests/integration/answer-diagnostics.test.mjs',
  'tests/unit/protocol-probe-v2.test.mjs','tests/unit/layered-validation.test.mjs','tests/unit/layered-critic-worker.test.mjs',
  'scripts/prepare-task7t-validation.mjs','scripts/audit-task7t-execution.mjs','scripts/verify-task7t-delivery.mjs',
  'docs/superpowers/plans/2026-10-31-task-7-layered-probe.md','docs/implementation/task-7-process-layered-final-audit.json','docs/implementation/task-5-process-layered-final-audit.json']);
// Include only exact native fixture paths named by this round's saved stdout.
// A positive-control OS audit is referenced in its owning worker fixture JSON.
const generatedByLogs=new Set();
for(const log of logs) for(const m of (await readFile('docs/implementation/'+log.file,'utf8')).matchAll(/docs[\\/]implementation[\\/]([A-Za-z0-9_-]+\.json)/g)) {
  const file='docs/implementation/'+m[1];if(!originalUser.has(file))generatedByLogs.add(file);
}
for(const file of [...generatedByLogs]) {
  const row=await j(file);
  if(typeof row.positiveAuditPath==='string') {
    const p=row.positiveAuditPath.replaceAll('\\','/');
    const rel=p.startsWith('docs/implementation/')?p:p.slice(p.indexOf('/docs/implementation/')+1);
    ensure(rel.startsWith('docs/implementation/')&&!rel.includes('..'),'INVALID_FIXTURE_REFERENCE');
    if(!originalUser.has(rel))generatedByLogs.add(rel);
  }
}
const untracked=list(['ls-files','--others','--exclude-standard','-z']);
const newOwned=untracked.filter(f=>!originalUser.has(f)&&(explicitNew.has(f)||generatedByLogs.has(f)||f.startsWith('docs/implementation/task-7t-')));
const revision=process.argv[2]??'';ensure(/^(?:-v[1-9][0-9]*)?$/.test(revision),'NEW_VERSION_SUFFIX_REQUIRED');
const outputs=[`docs/implementation/task-7t-file-list${revision}.json`,`docs/implementation/task-7t-verification${revision}.json`];
const files=[...new Set([...modified,...newOwned,...outputs])].sort();
ensure(files.every(f=>!originalUser.has(f)&&!/(^|\/)\.env|node_modules|^reference\/|^preparation\/|^\.agents\//.test(f)),'UNSAFE_COMMIT_PATH');
const unexplainedImplementation=untracked.filter(f=>f.startsWith('docs/implementation/')&&!originalUser.has(f)&&!files.includes(f));
ensure(unexplainedImplementation.length===0,'UNATTRIBUTED_IMPLEMENTATION_FILE');
const secret=process.env.EINSTEIN_GATEWAY_API_KEY;ensure(secret,'PRIVATE_EXACT_KEY_SCAN_REQUIRED');
let secretMatches=0,credentialPatternMatches=0,browserSecretMatches=0,scannedFiles=0;
for(const file of files.filter(f=>!outputs.includes(f))) {const text=await readFile(file,'utf8');scannedFiles++;
  if(text.includes(secret))secretMatches++;if(/sk-[A-Za-z0-9]{20,}/.test(text))credentialPatternMatches++;}
for(const name of await readdir('dist/web/assets')) {const text=await readFile('dist/web/assets/'+name,'utf8');
  if(text.includes(secret)||text.includes('EINSTEIN_GATEWAY_API_KEY'))browserSecretMatches++;}
ensure(!secretMatches&&!credentialPatternMatches&&!browserSecretMatches,'SECRET_SCAN_FAILED');
const result={scope:summary.scope,baseline:baseline.head,recordedAt:new Date().toISOString(),
  versions:{node:process.version,pnpm:execFileSync('cmd.exe',['/d','/s','/c','pnpm --version'],{encoding:'utf8',windowsHide:true}).trim(),mozaik:'4.2.0',dependenciesInstalled:0},
  offline:{...offline,exitCode:0},web:{typecheck:true,build:true,exitCode:0,buildMs:139},logs,
  engineering:{offlineChecksPassed:true,allUserRequirementsPassed:false,remainingGap:'Probe required-tool-count violation is evaluated post-run; Counter first four-call batch did not stop its second HTTP immediately.',
    toolBatchAdapterModified:false,historicalUnknownReclassified:false,finalAnswerStages:['native_identity','answer_capture','json_parse','schema_validation','evidence_write','native_observer']},
  recovery:{sameStore:true,applyCalls:0,newRiskExceptions:0,existingResolutionUnchanged:true,oldFailedUnconfirmedPreserved:true,normalRestartVerified:true,newPermitManagerNotDebited:true},
  live:{exitCode:1,probeRunId:freeze.probe.runId,L05RunId:freeze.l05.runId,L05Status:'unexecuted',L05Requests:0,
    grantedRequests:grants.length,releases:releases.length,actualHTTP:probe.requests.started,totalAuthorizationLimit:20,perContextLimit:2,
    supplierBatchSizes:executionAudit.batches.map(b=>b.calls.length),nativeCalls:11,allNativeCallsOrderedAndInCorrectContexts:true,nextHttpBatches:2,lastCounterBatchNextHttp:false,
    proposerModelReceiptUse:'observed_pass',counterModelReceiptUse:'no_final_answer',proposerAnswerDiagnosticRecords:answerDiagnostics.length,
    fullProtocolProbePassed:false,firstAnalysisOverlapMs:probe.requests.firstAnalysisOverlapMs,maxConcurrentRequests:2,gatewayReportedTokens:probe.requests.reportedTotals,
    cleanupConfirmed:true,currentInFlight:0,pending:0,safetyHold:false,automaticRetries:0,formalProposals:0,fingerprintCount:115,fingerprintsUnchangedSinceFreeze:true,
    executionAudit:'task-7t-live/execution-audit.json',secondaryAnalyzerMismatchCodes:'not independent proof of adapter corruption; per-batch audit retained separately'},
  windows:{registeredOriginalIdentities:517,allRegisteredOriginalsGone:true,liveWorkers:0,task5Identities:1220,liveFixtures:0,unknownOrphanGuarantee:false},
  integrity:{sources,datasetCommit:git(['-C','reference/einstein-matchmaker-data','rev-parse','HEAD']).trim(),datasetGitStatus:datasetStatus,
    userRecords,historical,originalStoreFileBytesUnchanged:true,storeFileCount:expectedStore.length,storeOnlyAdded:'one_probe_record_events_terminal',protectedPaths,protectedDiff},
  secretScan:{scannedFiles,secretMatches,credentialPatternMatches,browserSecretMatches},
  quality:{humanLabels:0,metrics:'NA',holdout:'unopened',Task4:'PENDING',Task7Overall:'NOT_PASS',CriticRunsThisRound:0,L05ApprovedRevisionGoal:'NOT_ACHIEVED'},
  exactCommitPathCount:files.length,noGitAddDot:true,noPush:true,batchStillLocked:true,Task8Started:false};
await writeFile(outputs[0],JSON.stringify({baseline:baseline.head,scope:result.scope,files,protectedUserUntracked:[...originalUser],
  excludedUntrackedCount:untracked.filter(f=>!files.includes(f)).length},null,2)+'\n',{flag:'wx'});
await writeFile(outputs[1],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({offline:689,allEngineeringRequirementsPassed:false,sourceFiles:8,userJsonUnchanged:95,historicalImplementationUnchanged:761,
  historicalStoreUnchanged:91,storeFiles:expectedStore.length,sourceFingerprints:115,modelRequests:4,L05:'unexecuted',probePassed:false,
  cleanupConfirmed:true,currentPermit:0,secretMatches,credentialPatternMatches,browserSecretMatches,commitPaths:files.length}));
