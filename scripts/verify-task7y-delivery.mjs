// Read-only verification with two wx metadata exports. No model, Store.open,
// worker, recovery, cleanup or Git mutation; staging/commits remain explicit.
import {readFile,readdir,writeFile,access} from 'node:fs/promises';import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {collectV4ProductFingerprints} from '../dist/server/evaluation/protocol-probe-v4-plan.js';
import {verifyTask7yAuthorizationFile,TASK7Y_POLICY_V2_FILE} from '../dist/server/evaluation/prepared-v4-policy.js';
const root=resolve('.'),folder='docs/implementation',mode=process.argv[2],suffix=process.argv[3]??'';
const need=(v,c)=>{if(!v)throw Error(c);},sha=b=>createHash('sha256').update(b).digest('hex');
const git=args=>execFileSync('git',['--no-optional-locks','-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
const list=args=>git(args).split('\0').filter(Boolean),bytes=f=>readFile(resolve(root,f));
const json=async f=>JSON.parse((await bytes(f)).toString('utf8')),hash=async f=>sha(await bytes(f));
async function exists(f){try{await access(resolve(root,f));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function walk(dir){let files=[];for(const e of await readdir(resolve(root,dir),{withFileTypes:true})){const file=resolve(root,dir,e.name);if(e.isDirectory())files.push(...await walk(file));else if(e.isFile())files.push(file);else throw Error('Y_UNEXPECTED_LINK');}return files.sort();}
async function verify(rows){const out=[];for(const r of rows){const b=await bytes(r.file);need(sha(b)===r.sha256&&(r.bytes===undefined||b.length===r.bytes),'Y_PROTECTED_BYTES_CHANGED');out.push({file:r.file,bytes:b.length,sha256:r.sha256,unchanged:true});}return out;}
need(['engineering','final'].includes(mode)&&process.argv.length<=4&&/^(?:-v[1-9][0-9]*)?$/.test(suffix),'Y_VERIFICATION_ARGUMENT');
const baseline=await json(folder+'/task-7y-baseline.json'),policy=await json(TASK7Y_POLICY_V2_FILE);
const authorization=await verifyTask7yAuthorizationFile(root,{authorizationFile:TASK7Y_POLICY_V2_FILE,authorizationFileSha256:await hash(TASK7Y_POLICY_V2_FILE),authorizationId:policy.authorizationId});
need(baseline.head==='11ff1e460cff9749c3da458679b742136f021a75'&&baseline.branch==='codex/task-3-evidence'&&baseline.staged.length===0,'Y_BASELINE');
const head=git(['rev-parse','HEAD']).trim(),branch=git(['branch','--show-current']).trim();
need(branch===baseline.branch&&list(['diff','--cached','--name-only','-z']).length===0,'Y_BRANCH_OR_INDEX');
git(['merge-base','--is-ancestor',baseline.head,head]);
const initial=new Set(baseline.untrackedPaths),untracked=list(['ls-files','--others','--exclude-standard','-z']),tracked=new Set(list(['ls-files','-z']));
need(baseline.untrackedPaths.every(f=>untracked.includes(f)&&!tracked.has(f)),'Y_INITIAL_UNTRACKED_STATUS');
const protectedUntracked=await verify(baseline.protectedUntracked),priorDocs=await verify(baseline.trackedChanges),history=await verify(baseline.historicalImplementation),
 store=await verify(baseline.historicalStore.files),decisions=await verify([baseline.existingAuthorization,baseline.existingResolution]),sources=await verify(baseline.officialSources);
need(protectedUntracked.length===473&&protectedUntracked.filter(f=>f.file.endsWith('.json')).length===262&&priorDocs.length===5&&history.length===1312&&store.length===97&&sources.length===8,'Y_ACTUAL_BASELINE_COUNTS');
need(git(['-C','reference/einstein-matchmaker-data','rev-parse','HEAD']).trim()===baseline.datasetCommit&&git(['-C','reference/einstein-matchmaker-data','status','--porcelain'])===baseline.datasetStatus&&baseline.datasetStatus==='','Y_DATASET_GIT');
const fingerprints=await collectV4ProductFingerprints(),approvedRuntimeChanges=[],unchangedRuntime=[];
for(const f of baseline.oldRuntime){const actual=await hash(f.file),approval=authorization.approvedRuntimeChanges.find(a=>a.file===f.file);
 if(approval){need(approval.beforeSha256===f.sha256,'Y_RUNTIME_APPROVAL');approvedRuntimeChanges.push({file:f.file,beforeSha256:f.sha256,afterSha256:actual,changed:actual!==f.sha256});}
 else{need(actual===f.sha256,'Y_UNAPPROVED_RUNTIME_DELTA');unchangedRuntime.push({...f,unchanged:true});}}
need(approvedRuntimeChanges.length===8&&unchangedRuntime.length===137&&fingerprints.length===165,'Y_RUNTIME_COUNTS');
const reviewFile=folder+'/task-7y-independent-review-v3.json',review=await json(reviewFile);
need(review.schemaVersion===1&&review.task==='Task7y'&&review.remainingConcreteBlockers===0&&review.conclusion==='NO_REMAINING_CONCRETE_BLOCKERS'
 &&JSON.stringify(review.reviewedProductFingerprints)===JSON.stringify(fingerprints)&&Array.isArray(review.sourceHashes)&&review.sourceHashes.length>0,'Y_INDEPENDENT_REVIEW');
await verify(review.sourceHashes);
const entryReview=await json(folder+'/task-7y-entry-test-independent-review.json');
need(entryReview.schemaVersion===1&&entryReview.task==='Task7y'&&entryReview.conclusion?.remainingConcreteStaticBlockers===0,'Y_ENTRY_TEST_REVIEW');
// Source/test hash verification is independent of prose or test counts.
for(const file of ['tests/unit/task7y-entry.test.mjs','tests/integration/prepared-v4-entry-boundary.test.mjs']){
 const text=JSON.stringify(entryReview);need(text.includes(file)&&text.includes(await hash(file)),'Y_ENTRY_TEST_REVIEW_BINDING');}
const targetFile=folder+'/task-7y-targeted-validation-v2.txt',targetRaw=await bytes(targetFile),targetText=targetRaw.toString('utf8');
const targetCounts={};for(const k of ['tests','pass','fail','cancelled','skipped']){const m=targetText.match(new RegExp('(?:ℹ|#)\\s+'+k+'\\s+(\\d+)\\s*(?:\\r?\\n|$)'));need(m,'Y_TARGETED_SUMMARY');targetCounts[k]=Number(m[1]);}
need(targetCounts.tests>0&&targetCounts.pass===targetCounts.tests&&targetCounts.fail===0&&targetCounts.cancelled===0&&targetCounts.skipped===0,'Y_TARGETED_RESULT');
const targetDuration=targetText.match(/(?:ℹ|#)\s+duration_ms\s+([0-9.]+)/);need(targetDuration,'Y_TARGETED_DURATION');
need(/CHECK_EXIT=0\s*$/.test(targetText),'Y_TARGETED_EXIT');
const priorPaths=new Set(priorDocs.map(f=>f.file)),allowedTracked=new Set([...authorization.approvedRuntimeChanges.map(f=>f.file).filter(f=>f.startsWith('src/')),...authorization.otherPermittedTrackedChanges]);
const baselineTracked=new Set(list(['ls-tree','-r','--name-only','-z',baseline.head])),changed=list(['diff','--name-only','-z',baseline.head]);
const modified=changed.filter(f=>baselineTracked.has(f)),addedTracked=changed.filter(f=>!baselineTracked.has(f));need(modified.every(f=>priorPaths.has(f)||allowedTracked.has(f)),'Y_UNEXPECTED_TRACKED_EDIT');
const newCode=new Set([
 'src/evaluation/engineering-material.ts','src/evaluation/engineering-files.ts','src/evaluation/prepared-v4-policy.ts','src/evaluation/prepared-v4-preflight.ts','src/evaluation/task7y-preparation.ts',
 'scripts/prepare-task7y-validation.mjs','scripts/capture-task7y-checks.mjs','scripts/execute-task7y-validation.mjs','scripts/verify-task7y-delivery.mjs','scripts/audit-task7y-execution.mjs',
 'tests/unit/engineering-material.test.mjs','tests/unit/prepared-v4-plan.test.mjs','tests/unit/task7y-entry.test.mjs','tests/unit/prepared-dataset-git.test.mjs',
 'tests/unit/v4-cleanup-status.test.mjs','tests/unit/task7y-policy-revision.test.mjs','tests/unit/task7y-policy-chain.test.mjs',
 'tests/integration/prepared-v4-preflight.test.mjs','tests/integration/prepared-v4-entry-boundary.test.mjs',
 'tests/helpers/engineering-material-fixture.mjs','tests/helpers/prepared-v4-fixture.mjs','tests/fixtures/task7y-capture-context-reproduction.mjs']);
const logFiles=(await readdir(resolve(root,folder))).filter(f=>/^task-7y-.*\.txt$/.test(f)).map(f=>resolve(root,folder,f)),generated=new Set();
if(await exists(folder+'/task-7y-checks'))logFiles.push(...(await walk(folder+'/task-7y-checks')).filter(f=>f.endsWith('.txt')));
for(const f of logFiles){const text=await readFile(f,'utf8');for(const m of text.matchAll(/docs[\\/]implementation[\\/]([A-Za-z0-9_.-]+\.json)/g))generated.add(folder+'/'+m[1]);}
function extraRefs(v,out=[]){if(v&&typeof v==='object')for(const[k,value]of Object.entries(v)){if(k==='positiveAuditPath'&&typeof value==='string')out.push(value);else extraRefs(value,out);}return out;}
for(const f of generated){if(initial.has(f)||!await exists(f))continue;for(const ref of extraRefs(await json(f))){const normalized=ref.replaceAll('\\','/'),absoluteRoot=root.replaceAll('\\','/')+'/';
 const rel=normalized.startsWith(folder+'/')?normalized:normalized.startsWith(absoluteRoot)?normalized.slice(absoluteRoot.length):'';
 need(/^docs\/implementation\/[A-Za-z0-9_.-]+\.json$/.test(rel),'Y_AUDIT_REFERENCE');generated.add(rel);}}
function ownNew(f){return!initial.has(f)&&(newCode.has(f)||f.startsWith(folder+'/task-7y-')||generated.has(f)||f.startsWith('.planning/2026-10-31-task7y/')
 ||f.startsWith('.planning/2026-10-31-task7y-preparation/')||f==='docs/superpowers/plans/2026-10-31-task7y-preparation-and-v4.md');}
const allNew=[...new Set([...untracked,...addedTracked])];need(allNew.filter(f=>/^(src|scripts|tests)\//.test(f)&&!initial.has(f)).every(f=>newCode.has(f)),'Y_UNEXPECTED_NEW_CODE');
need(addedTracked.every(ownNew),'Y_UNEXPECTED_TRACKED_ADDITION');
const outputs=[folder+'/task-7y-'+mode+'-file-list'+suffix+'.json',folder+'/task-7y-'+mode+'-verification'+suffix+'.json'];
const allOwned=[...new Set([...allNew.filter(ownNew),...modified.filter(f=>allowedTracked.has(f)),...outputs])].sort();
need(allOwned.every(f=>!initial.has(f)&&!priorPaths.has(f)&&!/(^|\/)\.env|^reference\/|^\.agents\/|node_modules/.test(f)),'Y_UNSAFE_COMMIT_PATH');
const working=new Set(list(['diff','--name-only','-z']));const files=mode==='engineering'?allOwned:allOwned.filter(f=>untracked.includes(f)||working.has(f)||outputs.includes(f));
const secret=process.env.EINSTEIN_GATEWAY_API_KEY;need(typeof secret==='string'&&secret.length>0,'Y_PRIVATE_SCAN_KEY_MISSING');let scanned=0;
for(const f of allOwned.filter(f=>!outputs.includes(f))){const text=(await bytes(f)).toString('utf8');need(!text.includes(secret)&&!/\bsk-[A-Za-z0-9_-]{20,}\b/.test(text),'Y_SECRET_FOUND');scanned++;}
for(const f of await walk('dist/web/assets')){const text=await readFile(f,'utf8');need(!text.includes(secret)&&!text.includes('EINSTEIN_GATEWAY_API_KEY'),'Y_BROWSER_SECRET_FOUND');}
const actualStoreFiles=await walk(baseline.historicalStore.root),originalStoreSet=store.map(f=>resolve(root,f.file));
let selected=null;if(await exists('docs/implementation/task-7y-live/attempt.json'))selected=await json('docs/implementation/task-7y-live/attempt.json');
if(mode==='engineering')need(!selected&&JSON.stringify(actualStoreFiles)===JSON.stringify(originalStoreSet.sort()),'Y_PREEXECUTION_STATE_CHANGED');
else if(selected){const expected=['record.json','events.jsonl','terminal.json'].map(f=>resolve(baseline.historicalStore.root,selected.probeRunId,f)),extras=actualStoreFiles.filter(f=>!originalStoreSet.includes(f));
 need(extras.every(f=>expected.includes(f)),'Y_UNEXPECTED_STORE_ADDITION');}
const result={task:'Task7y',mode,observedAt:new Date().toISOString(),baseline:baseline.head,head,branch,
 initialCounts:{untracked:473,json:262,priorDocs:5,historicalImplementation:1312,originalStoreFiles:97,oldRuntime:145},
 integrity:{protectedUntracked,priorDocs,history,store,decisions,sources,unchangedRuntime,approvedRuntimeChanges,currentFingerprints:fingerprints,allInitialBytesAndUntrackedStatusPreserved:true},
 targeted:{file:targetFile,sha256:sha(targetRaw),...targetCounts,exitCode:0,durationMs:Number(targetDuration[1])},
 independentReview:{file:reviewFile,sha256:await hash(reviewFile),remainingConcreteBlockers:0},
 entryReview:{file:folder+'/task-7y-entry-test-independent-review.json',sha256:await hash(folder+'/task-7y-entry-test-independent-review.json')},
 completeOffline:mode==='engineering'?'pending_actual_capture_at_fixed_engineering_commit':'see_immutable_captured_receipts',
 originalStoreFileCount:actualStoreFiles.length,globalAttemptObserved:Boolean(selected),globalAttempt:selected,
 secretScan:{filesScanned:scanned,actualSecretMatches:0,credentialPatternMatches:0,browserSecretMatches:0},
 sourceChanges:modified.filter(f=>allowedTracked.has(f)),generatedByLogs:[...generated].sort(),commitPaths:files.length,
 Task7Overall:'NOT_PASS',humanLabels:0,qualityMetrics:'NA',holdout:'unopened',L05Executed:false,batchStillLocked:true,Task8Started:false,noGitAddDot:true,noPush:true};
await writeFile(resolve(root,outputs[0]),JSON.stringify({task:'Task7y',mode,baseline:baseline.head,head,files,allTaskOwnedPaths:allOwned,excludedPriorDocs:[...priorPaths],excludedPriorUntracked:baseline.untrackedPaths},null,2)+'\n',{flag:'wx'});
await writeFile(resolve(root,outputs[1]),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({mode,head,initialUntracked:473,protectedJson:262,oldRuntimeUnchanged:137,approvedRuntimeChanges:8,currentFingerprints:165,targeted:targetCounts.tests,commitPaths:files.length,globalAttemptObserved:Boolean(selected),actualModelRequestsByVerifier:0,Task7Overall:'NOT_PASS'}));
