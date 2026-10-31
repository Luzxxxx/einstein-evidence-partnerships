// Read-only offline delivery check. No SDK runtime, model transport, RunStore.open,
// recovery, process termination, lock mutation, staging, commit or push.
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';

const need=(v,c)=>{if(!v)throw Error(c);};
const git=args=>execFileSync('git',args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
const list=args=>git(args).split('\0').filter(Boolean),slash=p=>p.replaceAll('\\','/');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),hash=async file=>sha(await readFile(file));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const folder='docs/implementation',baseline=await json(folder+'/task-7w-baseline.json');
need(baseline.head==='79b6c146b35281c8546256a1db6f5ca792ae29fc'&&baseline.liveRequestAuthorization===0,'W_BASELINE');
need(git(['rev-parse','HEAD']).trim()===baseline.head&&git(['branch','--show-current']).trim()===baseline.branch,'W_GIT_BASELINE_CHANGED');
need(baseline.staged.length===0&&list(['diff','--cached','--name-only','-z']).length===0,'W_PREEXISTING_OR_UNREVIEWED_INDEX_CONTENT');
const tracked=new Set(list(['ls-files','-z'])),untracked=list(['ls-files','--others','--exclude-standard','-z']);
need(baseline.untrackedPaths.every(f=>untracked.includes(f)&&!tracked.has(f)),'W_PRIOR_UNTRACKED_PATH_OR_STATUS_CHANGED');
async function verifyFiles(files){const rows=[];for(const f of files){const actual=await hash(f.file);need(actual===f.sha256,'W_PROTECTED_BYTES_CHANGED');rows.push({file:f.file,sha256:actual,unchanged:true});}return rows;}
const protectedJson=await verifyFiles(baseline.protectedUntrackedJson);
need(protectedJson.every(f=>!tracked.has(f.file)&&untracked.includes(f.file)),'W_PROTECTED_JSON_TRACKED');
const priorDocs=await verifyFiles(baseline.preexistingUntrackedDocuments);
need(priorDocs.every(f=>!tracked.has(f.file)&&untracked.includes(f.file)),'W_PRIOR_DOC_TRACKED');
const priorEdits=await verifyFiles(baseline.trackedChanges),historical=await verifyFiles(baseline.historicalImplementation);
const store=await verifyFiles(baseline.historicalStore.files),decisions=await verifyFiles([baseline.existingAuthorization,baseline.existingResolution]);
async function walk(dir){const paths=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())paths.push(...await walk(p));else if(e.isFile())paths.push(resolve(p));else throw Error('W_UNEXPECTED_LINK');}return paths.sort();}
need(same(await walk(baseline.historicalStore.root),baseline.historicalStore.files.map(f=>resolve(f.file)).sort()),'W_STORE_FILE_SET_CHANGED');
const sources=await verifyFiles(baseline.officialSources);
need(sources.length===8&&git(['-C','reference/einstein-matchmaker-data','rev-parse','HEAD']).trim()===baseline.datasetCommit
 &&git(['-C','reference/einstein-matchmaker-data','status','--porcelain'])===baseline.datasetStatus&&baseline.datasetStatus==='','W_DATASET_CHANGED');
const oldFreeze=await json(folder+'/task-7v-live/freeze.json'),runtime=await verifyFiles(oldFreeze.productFingerprints);
need(runtime.length===131,'W_FROZEN_RUNTIME_COUNT');
const priorPaths=new Set(priorEdits.map(f=>f.file)),allowedModified=new Set(['tests/integration/probe-v3-worker.test.mjs','scripts/verify-task7-processes.mjs']);
const modified=list(['diff','--name-only','-z',baseline.head]);
need(modified.every(f=>priorPaths.has(f)||allowedModified.has(f)),'W_UNEXPECTED_TRACKED_CHANGE');
const explicitNew=new Set([
 'src/evaluation/staged-probe-offline.ts',
 'tests/helpers/permit-settlement.mjs','tests/unit/permit-settlement.test.mjs','tests/fixtures/permit-settlement-history.json',
 'tests/integration/permit-stop-race.test.mjs','tests/integration/staged-probe-offline.test.mjs',
 'tests/fixtures/staged-probe-worker.mjs','tests/fixtures/staged-probe-harness.mjs','tests/integration/staged-probe-worker.test.mjs',
 'scripts/verify-task7w-integrity.mjs','scripts/verify-task7w-stage-control.mjs',
 'docs/superpowers/plans/2026-10-31-task-7w-offline-stage-control.md',
 'docs/implementation/task-7-process-task7w-audit.json','docs/implementation/task-5-process-task7w-audit.json',
 '.planning/.active_plan','.planning/2026-10-31-task7w-offline-stage-control/task_plan.md',
 '.planning/2026-10-31-task7w-offline-stage-control/findings.md','.planning/2026-10-31-task7w-offline-stage-control/progress.md'
]);
const oldUntracked=new Set(baseline.untrackedPaths),historicalPaths=new Set(baseline.historicalImplementation.map(f=>f.file));
const logs=[];for(const name of (await readdir(folder)).filter(n=>/^task-7w-.*\.txt$/.test(n)&&!/^task-7w-integrity.*\.txt$/.test(n)).sort()){
 const bytes=await readFile(join(folder,name)),text=bytes.toString('utf8'),stats={};
 for(const key of ['tests','pass','fail','cancelled','skipped','duration_ms']){const m=[...text.matchAll(new RegExp('(?:ℹ|#)\\s+'+key+'\\s+([0-9.]+)','g'))];if(m.length)stats[key]=Number(m.at(-1)[1]);}
 logs.push({file:folder+'/'+name,sha256:sha(bytes),bytes:bytes.length,...stats});
}
const generated=new Set();
for(const log of logs)for(const m of (await readFile(log.file,'utf8')).matchAll(/docs[\\/]implementation[\\/]([A-Za-z0-9_-]+\.json)/g)){
 const f=folder+'/'+m[1];if(!oldUntracked.has(f)&&!historicalPaths.has(f))generated.add(f);
}
function references(v,out=[]){if(v&&typeof v==='object')for(const [k,c] of Object.entries(v)){if(k==='positiveAuditPath'&&typeof c==='string')out.push(c);else references(c,out);}return out;}
for(const f of [...generated])for(const ref of references(await json(f))){const p=slash(ref),prefix=slash(resolve('.'))+'/docs/implementation/';
 const rel=p.startsWith(folder+'/')?p:p.toLowerCase().startsWith(prefix.toLowerCase())?folder+'/'+p.slice(prefix.length):'';
 need(/^docs\/implementation\/[A-Za-z0-9_-]+\.json$/.test(rel),'W_POSITIVE_AUDIT_REFERENCE');if(!oldUntracked.has(rel)&&!historicalPaths.has(rel))generated.add(rel);
}
const owned=untracked.filter(f=>!oldUntracked.has(f)&&(explicitNew.has(f)||f.startsWith(folder+'/task-7w-')||generated.has(f)));
need(untracked.filter(f=>/^(?:src|tests|scripts)\//.test(f)&&!oldUntracked.has(f)).every(f=>explicitNew.has(f)),'W_UNEXPECTED_NEW_CODE');
const suffix=process.argv[2]??'';need(process.argv.length<=3&&/^(?:-v[1-9][0-9]*)?$/.test(suffix),'W_OUTPUT_SUFFIX');
const outputs=[folder+'/task-7w-file-list'+suffix+'.json',folder+'/task-7w-verification'+suffix+'.json'];
const files=[...new Set([...modified.filter(f=>allowedModified.has(f)),...owned,...outputs])].sort();
need(files.every(f=>!oldUntracked.has(f)&&!priorPaths.has(f)&&!/(^|\/)\.env|^reference\/|^\.agents\/|node_modules/.test(f)),'W_UNSAFE_COMMIT_PATH');
need(untracked.filter(f=>f.startsWith(folder+'/')&&!oldUntracked.has(f)&&!historicalPaths.has(f)).every(f=>files.includes(f)),'W_UNATTRIBUTED_IMPLEMENTATION');
const key=process.env.EINSTEIN_GATEWAY_API_KEY;need(typeof key==='string'&&key.length>0,'W_PRIVATE_SCAN_KEY_REQUIRED');
let secretFindings=0,filesScanned=0;for(const f of files.filter(f=>!outputs.includes(f))){const s=await readFile(f,'utf8');filesScanned++;if(s.includes(key)||/\bsk-[A-Za-z0-9_-]{20,}\b/.test(s))secretFindings++;}
let browserFindings=0;for(const p of await walk('dist/web/assets')){const s=await readFile(p,'utf8');if(s.includes(key)||s.includes('EINSTEIN_GATEWAY_API_KEY'))browserFindings++;}
need(secretFindings===0&&browserFindings===0,'W_SECRET_SCAN');
const offline=logs.find(f=>f.file===folder+'/task-7w-offline-output.txt'),web=logs.find(f=>f.file===folder+'/task-7w-web-output.txt');
need(offline?.tests>0&&offline.pass===offline.tests&&offline.fail===0&&offline.cancelled===0&&offline.skipped===0,'W_OFFLINE_NOT_PASSED');
const offlineText=await readFile(offline.file,'utf8');need(/CHECK_EXIT=0\s*$/.test(offlineText)&&!/(\[ELIFECYCLE\]|Command failed with exit code|Offline checks failed:|error TS\d+)/.test(offlineText),'W_OFFLINE_EXIT_NOT_PASSED');
const webText=web?await readFile(web.file,'utf8'):'';need(web&&/built in [0-9.]+(?:ms|s)/.test(webText)&&/CHECK_EXIT=0\s*$/.test(webText)&&!/(error TS\d+|Command failed with exit code|Web build failed:)/.test(webText),'W_WEB_NOT_PASSED');
const audit=await json(folder+'/task-7-process-task7w-audit.json'),audit5=await json(folder+'/task-5-process-task7w-audit.json');
need(audit.allRegisteredOriginalsGone===true&&audit.liveCount===0&&audit5.allRegisteredOriginalsGone===true&&audit5.liveFixtureCount===0,'W_WINDOWS_AUDIT');
need(audit.pathsUsed.some(p=>slash(p).toLowerCase()===slash(resolve('tests/fixtures/staged-probe-worker.mjs')).toLowerCase()),'W_STAGE_WORKER_NOT_AUDITED');
const evidence=new Set(audit.evidenceFiles);for(const f of owned.filter(p=>/^docs\/implementation\/task-7w-worker-evidence-.*\.json$/.test(p)))need(evidence.has(f.slice((folder+'/').length)),'W_NEW_WORKER_EVIDENCE_NOT_AUDITED');
need(!audit.evidenceFiles.some(f=>f.startsWith('task-7w-permit-race-controlled-')),'W_SYNTHETIC_HOST_COUNTED_AS_ACTUAL_OS');
const result={task:'Task7w',observedAt:new Date().toISOString(),baseline:baseline.head,branch:git(['branch','--show-current']).trim(),head:git(['rev-parse','HEAD']).trim(),
 liveRequests:0,L05Executed:false,batchStillLocked:true,Task8Started:false,Task7Overall:'NOT_PASS',humanLabels:0,qualityMetrics:'NA',holdout:'unopened',
 initialCounts:{protectedJson:protectedJson.length,untrackedPaths:baseline.untrackedPaths.length,untrackedDocuments:priorDocs.length,priorTrackedEdits:priorEdits.length,historicalImplementation:historical.length,historicalStore:store.length},
 priorUntrackedPathAndStatusPreserved:baseline.untrackedPaths.length,untrackedHashCoverage:'Initial raw hashes cover JSON and Markdown; remaining prior untracked paths are checked for presence and untracked status, not asserted to have an initial byte hash.',
 integrity:{protectedJson,priorDocs,priorEdits,historical,store,decisions,sources,frozenRuntime:runtime,originalStoreFilesUnchanged:true,originalStoreOpened:false,recoveryApplyCalls:0},
 logs,offline,web:{...web,typecheckAndBuild:true},windows:{task7RegisteredOriginals:audit.registeredIdentityCount,task7AllOriginalsGone:true,liveWorkers:0,task5RegisteredOriginals:audit5.registeredIdentityCount,task5AllOriginalsGone:true,liveFixtures:0,unknownOrphanGuarantee:false},
 sourceChanges:modified.filter(f=>allowedModified.has(f)),priorTrackedEditsPreserved:priorEdits.map(f=>f.file),newCode:owned.filter(f=>/^(src|tests|scripts)\//.test(f)),generatedByLogs:[...generated].sort(),
 secretScan:{filesScanned,secretFindings,browserFindings},commitPathCount:files.length,noGitAddDot:true,noPush:true,priorUntrackedNeverAdded:true};
await writeFile(outputs[0],JSON.stringify({task:'Task7w',baseline:baseline.head,files,excludedPriorTracked:priorEdits.map(f=>f.file),excludedPriorUntracked:baseline.untrackedPaths},null,2)+'\n',{flag:'wx'});
await writeFile(outputs[1],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({task:'Task7w',protectedJson:protectedJson.length,priorTrackedEdits:priorEdits.length,history:historical.length,store:store.length,frozenRuntime:runtime.length,sources:sources.length,offlineTests:offline.tests,offlinePass:offline.pass,secretFindings,browserFindings,commitPaths:files.length,liveRequests:0,L05Executed:false,Task7Overall:'NOT_PASS'}));
