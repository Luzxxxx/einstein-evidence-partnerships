// Read-only integrity and exact-path commit manifest export. No models, cleanup,
// RunStore.open, hold reset, lock deletion or changes to historical records.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const git=args=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const list=args=>git(args).split('\0').filter(Boolean);
const baseline=await json('docs/implementation/task-7r-baseline.json');
const protectedUser=new Set(baseline.protectedUntrackedJson.map(f=>f.file));
const tracked=new Set(list(['ls-files','-z']));
const userRecords=await Promise.all(baseline.protectedUntrackedJson.map(async f=>({...f,
 unchanged:sha(await readFile(f.file))===f.sha256,untracked:!tracked.has(f.file)})));
const historical=await Promise.all([...baseline.historicalLive,...baseline.historicalStore.files].map(async f=>({...f,unchanged:sha(await readFile(f.file))===f.sha256})));
async function walk(root){const files=[];for(const entry of await readdir(root,{withFileTypes:true})){
 const path=resolve(root,entry.name);if(entry.isDirectory())files.push(...await walk(path));else if(entry.isFile())files.push(path);else throw Error('UNEXPECTED_HISTORICAL_LINK');
}return files.sort();}
const storeExpected=baseline.historicalStore.files.map(f=>resolve(f.file)).sort();
const storeActual=await walk(baseline.historicalStore.root);
const historyExpected=baseline.historicalLive.map(f=>resolve(f.file)).sort();
const historyActual=await walk('docs/implementation/task-7-live');
const oldSources=await json('docs/implementation/task-6-integrity.json');
const sources=await Promise.all(oldSources.files.map(async f=>{const bytes=await readFile(resolve('reference/einstein-matchmaker-data',f.file));
 return{file:f.file,bytes:bytes.length,expectedSha256:f.actualSha256,actualSha256:sha(bytes),unchanged:sha(bytes)===f.actualSha256};}));
const datasetStatus=git(['-C','reference/einstein-matchmaker-data','status','--porcelain']).trim();
const datasetCommit=git(['-C','reference/einstein-matchmaker-data','rev-parse','HEAD']).trim();
const protectedPaths=['src/contracts/domain.ts','src/contracts/state.ts','src/contracts/canonical.ts','src/contracts/primitives.ts',
 'src/evidence','src/data','src/retrieval','src/publishing','src/supervisor/scheduler.ts','src/supervisor/permits.ts','src/supervisor/deadline.ts',
 'src/storage','src/server','web','artifacts/evaluations','tests/fixtures/retrieval-queries.json','tests/fixtures/retrieval-labels.json',
 'tests/fixtures/critic','package.json','pnpm-lock.yaml'];
const protectedDiff=list(['diff','--name-only','-z',baseline.head,'--',...protectedPaths]);
if(userRecords.length!==50||historical.length!==176||sources.length!==8||userRecords.some(f=>!f.unchanged||!f.untracked)
 ||historical.some(f=>!f.unchanged)||sources.some(f=>!f.unchanged)||protectedDiff.length||datasetStatus
 ||JSON.stringify(storeActual)!==JSON.stringify(storeExpected)||JSON.stringify(historyActual)!==JSON.stringify(historyExpected))throw Error('PROTECTED_BASELINE_CHANGED');

const explicitModified=new Set(['README.md','task_plan.md','findings.md','progress.md',
 'docs/superpowers/specs/2026-10-30-interface-contracts.md','src/contracts/events.ts','src/evaluation/critic-worker.ts',
 'src/evaluation/run-critic-eval.ts','src/model/gateway-runner.ts','src/runtime/orchestrator.ts','src/runtime/task-context.ts',
 'src/supervisor/process-host.ts','tests/fixtures/mozaik-worker.mjs','tests/integration/descendant-scan.test.mjs',
 'tests/integration/gateway-runner.test.mjs','tests/integration/runtime-worker.test.mjs','tests/tooling/contracts-browser.test.mjs',
 'tests/unit/critic-snapshot.test.mjs','tests/unit/events-ipc.test.mjs','scripts/verify-task7-processes.mjs']);
const modified=list(['diff','--name-only','-z',baseline.head]);
if(modified.some(f=>!explicitModified.has(f)))throw Error('UNEXPECTED_TRACKED_CHANGE');
const explicitNew=new Set(['src/model/tool-batch.ts','src/evaluation/batch-control.ts',
 'tests/integration/tool-batch.test.mjs','tests/integration/runtime-batch.test.mjs','tests/integration/descendant-birth.test.mjs',
 'tests/unit/batch-control.test.mjs','tests/unit/historical-recovery.test.mjs',
 'scripts/audit-task7r-historical-recovery.mjs','scripts/export-task7r-diagnostic-samples.mjs','scripts/verify-task7r-delivery.mjs',
 'docs/superpowers/plans/2026-10-31-task-7-offline-repair.md']);
const untracked=list(['ls-files','--others','--exclude-standard','-z']);
const generated=untracked.filter(f=>!protectedUser.has(f)&&(f.startsWith('docs/implementation/task-7r-')
 ||/^docs\/implementation\/task-[56]-(?:process-evidence|scheduler-evidence|runtime-worker|process-positive)[A-Za-z0-9_-]*\.json$/.test(f)
 ||['docs/implementation/task-7-process-repair-final-audit.json','docs/implementation/task-5-process-repair-final-audit.json'].includes(f)));
const revision=process.argv[2]??'';
if(!/^(?:-v[1-9][0-9]*)?$/.test(revision))throw Error('NEW_VERSION_SUFFIX_REQUIRED');
const outputs=[`docs/implementation/task-7r-file-list${revision}.json`,`docs/implementation/task-7r-verification${revision}.json`];
const files=[...new Set([...modified,...untracked.filter(f=>explicitNew.has(f)),...generated,...outputs])].sort();
if(files.some(f=>protectedUser.has(f)||/(^|\/)\.env|node_modules|^reference\/|^preparation\/|^\.agents\//.test(f)))throw Error('UNSAFE_COMMIT_PATH');
const logs=[];
// The redirected delivery stdout is still open during this export; it cannot
// truthfully be fingerprinted here. Preserve it, but exclude self-referential logs.
for(const name of (await readdir('docs/implementation')).filter(n=>/^task-7r-.*\.txt$/.test(n)&&!/^task-7r-delivery-.*\.txt$/.test(n)).sort()){
 const bytes=await readFile('docs/implementation/'+name),text=bytes.toString('utf8');
 const stats={};for(const key of ['tests','pass','fail','cancelled','skipped','duration_ms']){const match=text.match(new RegExp('ℹ '+key+' ([0-9.]+)'));if(match)stats[key]=Number(match[1]);}
 logs.push({file:name,sha256:sha(bytes),bytes:bytes.length,commandHeader:text.split(/\r?\n/).find(l=>l.startsWith('$ '))??null,...stats});
}
const final=logs.find(l=>l.file==='task-7r-offline-final-output.txt');
if(final?.tests!==542||final.pass!==542||final.fail!==0||final.cancelled!==0||final.skipped!==0)throw Error('FINAL_OFFLINE_VERIFICATION_MISSING');
const web=await readFile('docs/implementation/task-7r-web-final-output.txt','utf8');
if(!web.includes('built in 197ms')||web.includes('error TS'))throw Error('WEB_VERIFICATION_MISSING');
const audit=await json('docs/implementation/task-7-process-repair-final-audit.json');
const task5=await json('docs/implementation/task-5-process-repair-final-audit.json');
if(!audit.allRegisteredOriginalsGone||audit.liveCount||!task5.allRegisteredOriginalsGone||task5.liveFixtureCount)throw Error('WINDOWS_IDENTITY_AUDIT_FAILED');
const recovery=await json('docs/implementation/task-7r-recovery-evidence-v1.json');
if(recovery.recoveryExecuted!==false||recovery.modelRequests!==0||recovery.storesCreated!==0||recovery.processesTerminated!==0
 ||!recovery.originalHoldPreserved||!recovery.originalPermitSnapshotPreserved||recovery.assessments.length!==1)throw Error('RECOVERY_BOUNDARY_VIOLATED');
const secret=process.env.EINSTEIN_GATEWAY_API_KEY;
if(!secret)throw Error('PRIVATE_EXACT_KEY_SCAN_REQUIRES_EXISTING_ENV');
let secretMatches=0,credentialPatternMatches=0,browserSecretMatches=0,scannedFiles=0;
for(const file of files.filter(f=>!outputs.includes(f))){const text=await readFile(file,'utf8');scannedFiles++;
 if(text.includes(secret))secretMatches++;if(/sk-[A-Za-z0-9]{20,}/.test(text))credentialPatternMatches++;}
for(const name of await readdir('dist/web/assets')){const text=await readFile('dist/web/assets/'+name,'utf8');
 if(text.includes(secret)||text.includes('EINSTEIN_GATEWAY_API_KEY'))browserSecretMatches++;}
if(secretMatches||credentialPatternMatches||browserSecretMatches)throw Error('SECRET_SCAN_FAILED');
const mozaik=await json('node_modules/@mozaik-ai/core/package.json');
const result={scope:'Task7_offline_repair_only_pending_user_acceptance',baseline:baseline.head,branch:git(['branch','--show-current']).trim(),
 versions:{node:process.version,pnpm:execFileSync('cmd.exe',['/d','/s','/c','pnpm --version'],{encoding:'utf8',windowsHide:true}).trim(),mozaik:mozaik.version,dependenciesInstalled:0},
 offline:{...final,exitCode:0},web:{typecheck:true,build:true,exitCode:0,buildMs:197},logs,
 windows:{registeredOriginalIdentities:audit.registeredIdentityCount,allRegisteredOriginalsGone:true,liveWorkers:0,
  task5RegisteredOriginalIdentities:task5.registeredIdentityCount,task5LiveFixtures:0,
  unknownOrphanGuarantee:false,historicalHoldCleared:false},
 noLive:{actualRequestsThisRound:0,legacyMatrixLocked:true,remainingSevenExecuted:false,matrixRerun:false},
 recovery:{executed:false,historicalHoldUnchanged:true,heldHistoricalReservation:1,
  evidence:'task-7r-recovery-evidence-v1.json',issueCount:recovery.assessments.length},
 integrity:{sources,datasetCommit,datasetGitStatus:datasetStatus,userRecords,historical,
  historicalStoreFileSetUnchanged:true,historicalLiveFileSetUnchanged:true,protectedPaths,protectedDiff},
 secretScan:{scannedFiles,secretMatches,credentialPatternMatches,browserSecretMatches},
 quality:{humanLabels:0,metrics:'NA',holdout:'unopened',Task4:'PENDING',Task7Overall:'NOT_PASS',L05ApprovedRevisionGoal:'NOT_ACHIEVED'},
 exactCommitPathCount:files.length,noGitAddDot:true,noPush:true,Task8Started:false};
await writeFile(outputs[0],JSON.stringify({baseline:baseline.head,scope:result.scope,files,
 protectedUserUntracked:[...protectedUser],excludedUntrackedCount:untracked.filter(f=>!files.includes(f)).length},null,2)+'\n',{flag:'wx'});
await writeFile(outputs[1],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({offline:542,web:0,liveRequests:0,registeredIdentities:audit.registeredIdentityCount,
 task5Identities:task5.registeredIdentityCount,protectedJson:50,historicalFiles:176,sources:8,
 historicalHoldCleared:false,secretMatches,credentialPatternMatches,browserSecretMatches,commitPaths:files.length,overall:'NOT_PASS'}));
