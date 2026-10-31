// Read-only final verification + exact commit manifest. No model, worker,
// RunStore.open, recovery execution, quota mutation, lock removal or push.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join,relative} from 'node:path';
import {sha256Bytes} from '../dist/server/evidence/hashing.js';
import {canonicalizeArtifact} from '../dist/server/contracts/canonical.js';
import {collectBoundedProductFingerprints} from '../dist/server/evaluation/bounded-validation.js';
const git=args=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const list=args=>git(args).split('\0').filter(Boolean),j=async p=>JSON.parse(await readFile(p,'utf8'));
const shaFile=async p=>sha256Bytes(await readFile(p));
const baseline=await j('docs/implementation/task-7s-baseline.json'),freeze=await j('docs/implementation/task-7s-live/freeze.json');
const originalUser=new Set(baseline.protectedUntrackedJson.map(f=>f.file)),tracked=new Set(list(['ls-files','-z']));
const userRecords=await Promise.all(baseline.protectedUntrackedJson.map(async f=>({...f,unchanged:await shaFile(f.file)===f.sha256,untracked:!tracked.has(f.file)})));
const historical=await Promise.all([...baseline.historicalLive,...baseline.historicalStore.files].map(async f=>({...f,unchanged:await shaFile(f.file)===f.sha256})));
async function walk(root){const result=[];for(const row of await readdir(root,{withFileTypes:true})){const p=join(root,row.name);
 if(row.isDirectory())result.push(...await walk(p));else if(row.isFile())result.push(resolve(p));else throw Error('UNEXPECTED_LINK');}return result.sort();}
const expectedStore=[...baseline.historicalStore.files.map(f=>resolve(f.file)),
 resolve(baseline.historicalStore.root,'historical-recovery',freeze.recoveryAuthorization.runId+'.resolution.json'),
 ...['record.json','events.jsonl','terminal.json'].map(n=>resolve(baseline.historicalStore.root,freeze.probe.runId,n))].sort();
const oldIntegrity=await j('docs/implementation/task-6-integrity.json');
const sources=await Promise.all(oldIntegrity.files.map(async f=>{const bytes=await readFile(resolve('reference/einstein-matchmaker-data',f.file));
 return{file:f.file,bytes:bytes.length,expectedSha256:f.actualSha256,actualSha256:sha256Bytes(bytes),unchanged:sha256Bytes(bytes)===f.actualSha256};}));
const datasetStatus=git(['-C','reference/einstein-matchmaker-data','status','--porcelain']).trim();
const protectedPaths=['src/contracts','src/evidence','src/data','src/retrieval','src/publishing','src/server','web','src/model',
 'src/supervisor','src/evaluation/batch-control.ts','src/evaluation/critic-cases.ts','src/evaluation/critic-worker.ts','src/evaluation/run-critic-eval.ts',
 'tests/fixtures/retrieval-queries.json','tests/fixtures/retrieval-labels.json','tests/fixtures/critic','artifacts/evaluations','package.json','pnpm-lock.yaml'];
const protectedDiff=list(['diff','--name-only','-z',baseline.head,'--',...protectedPaths]);
if(userRecords.length!==73||historical.length!==176||sources.length!==8||userRecords.some(r=>!r.unchanged||!r.untracked)||historical.some(r=>!r.unchanged)
 ||sources.some(r=>!r.unchanged)||datasetStatus||protectedDiff.length
 ||canonicalizeArtifact(await walk(baseline.historicalStore.root))!==canonicalizeArtifact(expectedStore)
 ||canonicalizeArtifact(await walk('docs/implementation/task-7-live'))!==canonicalizeArtifact(baseline.historicalLive.map(f=>resolve(f.file)).sort()))throw Error('PROTECTED_INTEGRITY_FAILED');
const productFingerprints=await collectBoundedProductFingerprints();
if(canonicalizeArtifact(productFingerprints)!==canonicalizeArtifact(freeze.productFingerprints))throw Error('PRODUCT_CHANGED_SINCE_FREEZE');
const summary=await j('docs/implementation/task-7s-live/summary.json'),restart=await j('docs/implementation/task-7s-post-probe-restart.json');
const probe=await j(`docs/implementation/task-7s-live/runs/${freeze.probe.runId}/result.json`);
const audit=await j('docs/implementation/task-7-process-bounded-final-audit.json'),task5=await j('docs/implementation/task-5-process-bounded-final-audit.json');
if(summary.execution.totalGranted!==4||summary.execution.rows[1].status!=='unexecuted'||probe.analysis.valid!==false
 ||probe.permitSnapshot.inFlight!==0||probe.cleanups.length!==1||!probe.cleanups[0].confirmed||probe.safetyHold||restart.safetyHold||restart.l05Record!==null
 ||restart.historicalRecord.status!=='failed'||restart.historicalRecord.cleanupState!=='unconfirmed'||restart.resolutions.length!==1
 ||!audit.allRegisteredOriginalsGone||audit.liveCount||!task5.allRegisteredOriginalsGone||task5.liveFixtureCount)throw Error('ACTUAL_OUTCOME_MISMATCH');
const filesOnDisk=await readdir('docs/implementation');
const logs=[];
for(const name of filesOnDisk.filter(n=>/^task-7s-.*\.txt$/.test(n)&&!/^task-7s-delivery.*\.txt$/.test(n)).sort()){
 const bytes=await readFile('docs/implementation/'+name),text=bytes.toString('utf8'),stats={};
 for(const k of ['tests','pass','fail','cancelled','skipped','duration_ms']){const m=text.match(new RegExp('ℹ '+k+' ([0-9.]+)'));if(m)stats[k]=Number(m[1]);}
 logs.push({file:name,sha256:sha256Bytes(bytes),bytes:bytes.length,commandHeader:text.split(/\r?\n/).find(l=>l.startsWith('$ '))??null,...stats});
}
const offline=logs.find(r=>r.file==='task-7s-offline-first-output.txt');
if(offline.tests!==633||offline.pass!==633||offline.fail!==0||offline.cancelled!==0||offline.skipped!==0)throw Error('OFFLINE_NOT_VERIFIED');
const web=await readFile('docs/implementation/task-7s-web-output.txt','utf8');if(!web.includes('built in 147ms'))throw Error('WEB_NOT_VERIFIED');
const modified=list(['diff','--name-only','-z',baseline.head]);
const explicitModified=new Set(['README.md','task_plan.md','findings.md','progress.md','docs/superpowers/specs/2026-10-30-interface-contracts.md',
 'src/storage/run-store.ts','src/runtime/task-context.ts','src/runtime/orchestrator.ts','scripts/verify-task7-processes.mjs']);
if(modified.some(f=>!explicitModified.has(f)))throw Error('UNEXPECTED_TRACKED_CHANGE');
const explicitNew=new Set(['src/storage/historical-recovery.ts','src/evaluation/protocol-probe.ts','src/evaluation/protocol-probe-worker.ts',
 'src/evaluation/bounded-validation.ts','src/evaluation/bounded-critic-worker.ts','tests/integration/historical-recovery-store.test.mjs',
 'tests/unit/protocol-probe.test.mjs','tests/unit/bounded-validation.test.mjs','tests/unit/bounded-critic-worker.test.mjs','tests/unit/l05-chain.test.mjs',
 'scripts/prepare-task7s-validation.mjs','scripts/audit-task7s-execution.mjs','scripts/verify-task7s-delivery.mjs',
 'docs/superpowers/plans/2026-10-31-task-7-bounded-validation.md','docs/implementation/task-7r-recovery-evidence-v2.json',
 'docs/implementation/task-7-process-bounded-final-audit.json','docs/implementation/task-5-process-bounded-final-audit.json',
 // Actual positive-control audit referenced by this round's fetch-wait worker JSON;
 // its test does not print the separate audit filename to the test stdout.
 'docs/implementation/task-6-process-positive-1793416073147-49757880-1457-4f0d-85e9-3a194c63c0fb.json']);
// Native offline test JSONs must be explicitly named in this round's raw logs,
// rather than every new task-5/6 JSON (which might belong to the user's audit).
const generatedByLogs=new Set();
for(const log of logs){const text=await readFile('docs/implementation/'+log.file,'utf8');
 for(const match of text.matchAll(/docs[\\/]implementation[\\/]([A-Za-z0-9_-]+\.json)/g))generatedByLogs.add('docs/implementation/'+match[1]);}
const untracked=list(['ls-files','--others','--exclude-standard','-z']);
const newOwned=untracked.filter(f=>!originalUser.has(f)&&(explicitNew.has(f)||generatedByLogs.has(f)||f.startsWith('docs/implementation/task-7s-')));
const revision=process.argv[2]??'';if(!/^(?:-v[1-9][0-9]*)?$/.test(revision))throw Error('NEW_VERSION_SUFFIX_REQUIRED');
const outputs=[`docs/implementation/task-7s-file-list${revision}.json`,`docs/implementation/task-7s-verification${revision}.json`];
const files=[...new Set([...modified,...newOwned,...outputs])].sort();
if(files.some(f=>originalUser.has(f)||/(^|\/)\.env|node_modules|^reference\/|^preparation\/|^\.agents\//.test(f)))throw Error('UNSAFE_COMMIT_PATH');
const secret=process.env.EINSTEIN_GATEWAY_API_KEY;if(!secret)throw Error('PRIVATE_EXACT_KEY_SCAN_REQUIRED');
let secretMatches=0,credentialPatternMatches=0,browserSecretMatches=0,scannedFiles=0;
for(const file of files.filter(f=>!outputs.includes(f))){const text=await readFile(file,'utf8');scannedFiles++;if(text.includes(secret))secretMatches++;if(/sk-[A-Za-z0-9]{20,}/.test(text))credentialPatternMatches++;}
for(const name of await readdir('dist/web/assets')){const text=await readFile('dist/web/assets/'+name,'utf8');if(text.includes(secret)||text.includes('EINSTEIN_GATEWAY_API_KEY'))browserSecretMatches++;}
if(secretMatches||credentialPatternMatches||browserSecretMatches)throw Error('SECRET_SCAN_FAILED');
const result={scope:'one_restricted_recovery_and_one_failed_protocol_probe_L05_unexecuted',baseline:baseline.head,
 versions:{node:process.version,pnpm:execFileSync('cmd.exe',['/d','/s','/c','pnpm --version'],{encoding:'utf8',windowsHide:true}).trim(),mozaik:'4.2.0',dependenciesInstalled:0},
 offline:{...offline,exitCode:0},web:{typecheck:true,build:true,exitCode:0,buildMs:147},logs,
 recovery:{actualApplyCalls:1,sameStore:true,journalOnly:true,historicalCleanupConfirmed:false,resolutionHash:restart.resolutions[0].hash,
  restartSafetyHold:false,diagnosticsPreserved:true,currentPermitManagerNotDebited:true,otherUnknownHoldTestedOffline:true},
 live:{executionExitCode:1,probeRunId:freeze.probe.runId,L05RunId:freeze.l05.runId,L05Status:'unexecuted',L05Requests:0,
  grantedRequests:4,actualHTTP:4,globalGrantLimit:20,multiCallBatches:2,nativeToolCalls:4,firstAnalysisOverlapMs:5754.9461,maxConcurrentRequests:2,
  gatewayReportedTokens:probe.requests.reportedTotals,fullProtocolProbePassed:false,cleanupConfirmed:true,currentInFlight:0,safetyHold:false,automaticRetries:0,formalProposals:0,
  currentModelAndGatewayUnchanged:true,productFingerprintCount:productFingerprints.length,productFingerprintsUnchangedSinceFreeze:true},
 windows:{registeredOriginalIdentities:audit.registeredIdentityCount,allRegisteredOriginalsGone:true,liveWorkers:0,task5Identities:task5.registeredIdentityCount,liveFixtures:0,unknownOrphanGuarantee:false},
 integrity:{sources,datasetCommit:git(['-C','reference/einstein-matchmaker-data','rev-parse','HEAD']).trim(),datasetGitStatus:datasetStatus,
  userRecords,historical,originalStoreFileBytesUnchanged:true,storeFileCount:expectedStore.length,storeOnlyAdded:'one_resolution_plus_probe_record_events_terminal',protectedPaths,protectedDiff},
 secretScan:{scannedFiles,secretMatches,credentialPatternMatches,browserSecretMatches},
 quality:{humanLabels:0,metrics:'NA',holdout:'unopened',Task4:'PENDING',Task7Overall:'NOT_PASS',CriticRunsThisRound:0,L05ApprovedRevisionGoal:'NOT_ACHIEVED'},
 exactCommitPathCount:files.length,noGitAddDot:true,noPush:true,batchStillLocked:true,Task8Started:false};
await writeFile(outputs[0],JSON.stringify({baseline:baseline.head,scope:result.scope,files,protectedUserUntracked:[...originalUser],
 excludedUntrackedCount:untracked.filter(f=>!files.includes(f)).length},null,2)+'\n',{flag:'wx'});
await writeFile(outputs[1],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({offline:633,sourceFiles:8,userJsonUnchanged:73,historyUnchanged:176,storeFiles:expectedStore.length,
 sourceFingerprints:106,modelRequests:4,L05:'unexecuted',probePassed:false,cleanupConfirmed:true,currentPermit:0,secretMatches,credentialPatternMatches,browserSecretMatches,commitPaths:files.length}));
