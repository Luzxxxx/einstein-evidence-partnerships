// Audit/export first-round evidence only. No model, worker spawn, cleanup action or hold reset.
import { readFile,writeFile,readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve,dirname } from 'node:path';
import { collectCriticProductFingerprints } from '../dist/server/evaluation/run-critic-eval.js';
import { canonicalizeArtifact } from '../dist/server/contracts/canonical.js';
import { sha256Bytes } from '../dist/server/evidence/hashing.js';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const git=(args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const list=(args)=>git(args).split('\0').filter(Boolean);
const baseline=await json('docs/implementation/task-7-baseline.json'),gate=await json('docs/implementation/task-7-pre-live-gate.json');
const original=new Set(baseline.untrackedJson.map(f=>f.file));
const summary=await json('docs/implementation/task-7-live/summary.json'),freeze=await json('docs/implementation/task-7-live/freeze.json');
const rows=[];
for(const row of summary.rows)if(row.status!=='unexecuted')rows.push(await json(`docs/implementation/task-7-live/runs/${row.runId}/result.json`));
const requests=rows.flatMap(r=>r.requests.intervals),codes={};for(const r of requests)codes[r.code??r.completion]=(codes[r.code??r.completion]??0)+1;
const contextIDs=rows.flatMap(r=>r.events.filter(e=>e.type==='task.started').map(e=>e.contextId));
const sourceFingerprints=await collectCriticProductFingerprints();
if(canonicalizeArtifact(sourceFingerprints)!==canonicalizeArtifact(gate.sourceFingerprints))throw Error('PRODUCT_CHANGED_SINCE_PRELIVE');
const old=await json('docs/implementation/task-6-integrity.json');
const files=await Promise.all(old.files.map(async f=>{const bytes=await readFile(resolve('reference/einstein-matchmaker-data',f.file));return{file:f.file,bytes:bytes.length,expectedSha256:f.actualSha256,actualSha256:sha256Bytes(bytes),unchanged:sha256Bytes(bytes)===f.actualSha256};}));
const trackedNow=new Set(list(['ls-files','-z']));
const userRecords=await Promise.all(baseline.untrackedJson.map(async f=>({...f,unchanged:sha256Bytes(await readFile(f.file))===f.sha256,untracked:!trackedNow.has(f.file)})));
const protectedPaths=['src/contracts/domain.ts','src/contracts/state.ts','src/contracts/canonical.ts','src/contracts/primitives.ts','src/evidence','src/data','src/retrieval',
  'src/supervisor/process-host.ts','src/supervisor/permits.ts','src/supervisor/deadline.ts','src/server','web','artifacts/evaluations',
  'tests/fixtures/retrieval-queries.json','tests/fixtures/retrieval-labels.json','package.json','pnpm-lock.yaml'];
const protectedDiff=list(['diff','--name-only','-z',baseline.head,'--',...protectedPaths]);
const datasetStatus=git(['-C','reference/einstein-matchmaker-data','status','--porcelain']).trim();
if(files.some(f=>!f.unchanged)||userRecords.some(f=>!f.unchanged||!f.untracked)||protectedDiff.length||datasetStatus)throw Error('PROTECTED_BASELINE_CHANGED');
const modified=list(['diff','--name-only','-z','HEAD']);
const explicitModified=new Set(['README.md','findings.md','progress.md','task_plan.md','docs/superpowers/specs/2026-10-30-interface-contracts.md',
 'docs/superpowers/plans/2026-10-30-einstein-mvp-implementation.md','src/contracts/ipc.ts','src/runtime/agents/critic.ts','src/runtime/orchestrator.ts',
 'src/runtime/task-context.ts','src/runtime/worker-entry.ts','src/storage/run-store.ts','src/supervisor/scheduler.ts','tests/fixtures/mozaik-worker.mjs',
 'tests/integration/descendant-scan.test.mjs','tests/integration/runtime-worker.test.mjs']);
if(modified.some(f=>!explicitModified.has(f)))throw Error('UNEXPECTED_TRACKED_CHANGE');
const untracked=list(['ls-files','--others','--exclude-standard','-z']);
const explicitNew=new Set(['src/publishing/gate.ts','src/publishing/render.ts','src/publishing/receipts.ts','src/evaluation/critic-cases.ts',
 'src/evaluation/critic-worker.ts','src/evaluation/run-critic-eval.ts','tests/unit/publication.test.mjs','tests/unit/critic-snapshot.test.mjs',
 'tests/unit/critic-cases.test.mjs','tests/unit/critic-eval-runner.test.mjs','tests/integration/publication-parent.test.mjs','tests/fixtures/critic/labels.json',
 'scripts/prepare-task7-live-gate.mjs','scripts/verify-task7-cases.mjs','scripts/verify-task7-processes.mjs','scripts/verify-task7-delivery.mjs',
 'docs/superpowers/plans/2026-10-31-task-7-publication.md','docs/startup/critic-adversarial-design.md']);
const generated=untracked.filter(f=>!original.has(f)&&(f.startsWith('docs/implementation/task-7-')
 ||/^docs\/implementation\/task-[56]-[A-Za-z0-9_-]+\.json$/.test(f)));
const outputFiles=['docs/implementation/task-7-file-list.json','docs/implementation/task-7-verification.json'];
const allowlist=[...new Set([...modified,...untracked.filter(f=>explicitNew.has(f)),...generated,...outputFiles])].sort();
if(allowlist.some(f=>original.has(f)||/(^|\/)\.env|node_modules|^reference\/|^preparation\/|^\.agents\//.test(f)))throw Error('UNSAFE_COMMIT_PATH');
await writeFile(outputFiles[0],JSON.stringify({baseline:baseline.head,scope:'Task7 only, includes all real failures; no quality PASS',files:allowlist,
 protectedUserUntracked:baseline.untrackedJson.map(f=>f.file),excludedUntrackedCount:untracked.filter(f=>!allowlist.includes(f)).length},null,2)+'\n',{flag:'wx'});
const secret=process.env.EINSTEIN_GATEWAY_API_KEY;if(!secret)throw Error('PRIVATE_EXACT_KEY_SCAN_REQUIRES_EXISTING_ENV');
let secretMatches=0,credentialPatternMatches=0,scannedFiles=0;
for(const f of allowlist.filter(f=>!outputFiles.includes(f))){const text=await readFile(f,'utf8');scannedFiles++;if(text.includes(secret))secretMatches++;if(/sk-[A-Za-z0-9]{20,}/.test(text))credentialPatternMatches++;}
let browserSecretMatches=0;for(const f of await readdir('dist/web/assets')){const text=await readFile('dist/web/assets/'+f,'utf8');if(text.includes(secret)||text.includes('EINSTEIN_GATEWAY_API_KEY'))browserSecretMatches++;}
if(secretMatches||credentialPatternMatches||browserSecretMatches)throw Error('SECRET_SCAN_FAILED');
const audit=await json('docs/implementation/task-7-process-final-audit.json'),oldAudit=await json('docs/implementation/task-5-process-task-7-final-audit.json');
const restart=await json('docs/implementation/task-7-live-restart-audit.json');
const result={scope:'engineering_and_evidence_audit_not_quality_acceptance',baseline:baseline.head,
 versions:{node:process.version,pnpm:(process.platform==='win32'
   ?execFileSync('cmd.exe',['/d','/s','/c','pnpm --version'],{encoding:'utf8',windowsHide:true})
   :execFileSync('pnpm',['--version'],{encoding:'utf8'})).trim(),mozaik:'4.2.0',dependenciesInstalled:0},
 offline:{tests:476,pass:476,fail:0,exitCode:0,durationMs:116715.5846,output:'task-7-offline-final-pre-live-output.txt'},web:{typecheck:true,exitCode:0},
 productSourceAndExecutableUnchangedSinceFreeze:true,fingerprintCount:sourceFingerprints.length,
 live:{commandExitCode:1,planned:freeze.plannedRunCount,executed:rows.length,unexecuted:summary.rows.filter(r=>r.status==='unexecuted').length,
  requests:requests.length,codes,permitBeforeRequest:rows.flatMap(r=>r.requestPermitProof).filter(p=>p.valid).length,
  contextIds:contextIDs.length,uniqueContextIds:new Set(contextIDs).size,criticTasks:rows.flatMap(r=>r.events).filter(e=>e.type==='task.started'&&e.role==='critic').length,
  acceptedDrafts:0,reviews:rows.reduce((n,r)=>n+r.reviewVersions.length,0),realToolRoundTrips:rows.reduce((n,r)=>n+r.nativeToolRoundTrips.length,0),
  approved:rows.filter(r=>r.status==='approved').length,usage:'unknown',stopReason:summary.stopReason,
  cleanupConfirmed:rows.filter(r=>r.cleanups.every(c=>c.confirmed)).length,cleanupUnconfirmed:rows.filter(r=>r.cleanups.some(c=>!c.confirmed)).length,
  finalHistoricalInFlightReservation:rows.at(-1)?.permitSnapshot.inFlight??null,automaticRetries:0,extraModelCallsAfterMatrix:0},
 windows:{task7RegisteredOriginals:audit.registeredIdentityCount,allKnownOriginalsGone:audit.allRegisteredOriginalsGone,liveWorkers:audit.liveCount,
  task5RegressionOriginals:oldAudit.registeredIdentityCount,task5LiveFixtures:oldAudit.liveFixtureCount??oldAudit.liveCount??0,unknownIdentityHoldCleared:false},
 restart:{actualArchivedRuns:restart.runs.length,safetyHold:restart.safetyHold,approved:restart.approvedCount,automaticResume:false},
 integrity:{files,userRecords,datasetGitStatus:datasetStatus,protectedDiff},secretScan:{scannedFiles,secretMatches,credentialPatternMatches,browserSecretMatches},
 quality:{humanLabels:0,effectiveCriticReviewDenominator:0,metrics:'NA',L05ApprovedRevisionGoal:'NOT_ACHIEVED',Task7Overall:'NOT_PASS',Task4:'PENDING',holdout:'unopened'},
 exactCommitPathCount:allowlist.length,noPush:true,noGitAddDot:true,Task8Started:false};
await writeFile(outputFiles[1],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
for(const f of allowlist)await readFile(f); // every intended commit path really exists
console.log(JSON.stringify({offline:476,planned:result.live.planned,executed:result.live.executed,unexecuted:result.live.unexecuted,requests:requests.length,
 knownOriginalsGone:audit.registeredIdentityCount,liveWorkers:audit.liveCount,persistentHold:restart.safetyHold,sourceFiles:files.length,userJson:userRecords.length,
 secretMatches,credentialPatternMatches,browserSecretMatches,commitPaths:allowlist.length,quality:'NA',overall:'NOT_PASS'}));
