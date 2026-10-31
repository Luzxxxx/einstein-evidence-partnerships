// Read-only delivery/ownership checks. Writes only new wx Task9 manifests.
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const folder = 'docs/implementation';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', ['--no-optional-locks', ...args], { encoding: 'utf8', windowsHide: true });
const paths = args => git(args).split('\0').filter(Boolean);
const need = (value, code) => { if (!value) throw Error(code); };
const baseline = await json(folder + '/task-9-baseline.json');
const suffix = process.argv[2] ?? '';
need(/^(?:-v[1-9][0-9]*)?$/.test(suffix) && process.argv.length <= 3, 'TASK9_VERIFIER_ARGUMENT');
const ownCode = [
  '.planning/.active_plan', ...['task_plan','findings','progress'].map(n => `.planning/2026-10-31-task9-interface-and-replay/${n}.md`),
  'docs/superpowers/specs/2026-10-31-task9-workspace-design.md', 'docs/superpowers/plans/2026-10-31-task9-interface-and-replay.md',
  'src/server/routes.ts', 'tsconfig.web.json', 'vite.config.ts', 'web/index.html', 'web/public/favicon.svg',
  ...['main.tsx','App.tsx','api.ts','state.ts','transport.ts','types.ts','useRun.ts','styles.css'].map(n => 'web/src/' + n),
  ...['ChallengePicker','Showcase','ProposalView','ReviewPanel','DecisionEvolution','Timeline','EvidenceInspector','RunWorkspace','Icons'].map(n => `web/src/components/${n}.tsx`),
  'tests/unit/web-state.test.mjs','tests/unit/web-transport.test.mjs','tests/integration/web-handoff.test.mjs','tests/integration/scheduler.test.mjs',
  ...['verify-task9-browser','verify-task9-dev-proxy','verify-task9-fixture-restart','audit-task9-processes','verify-task9-delivery'].map(n => 'scripts/' + n + '.mjs'),
];
const matchingCommit = 'e8bb0e0e5e086ce3a853a819e5a279e3dfd83ea2';
const matchingPaths = paths(['diff-tree','--no-commit-id','--name-only','-r','-z',matchingCommit]);
need(matchingPaths.length === 54 && !matchingPaths.some(file => ownCode.includes(file)), 'MATCHING_COMMIT_SCOPE_OVERLAP');
need(git(['rev-parse','HEAD']).trim() === matchingCommit && git(['rev-parse',matchingCommit+'^']).trim() === baseline.head, 'INTEGRATION_HEAD');
const untracked = paths(['ls-files','--others','--exclude-standard','-z']);
need(baseline.untrackedPaths.every(file => untracked.includes(file)), 'INITIAL_FILE_TRACKING_CHANGED');
async function changes(rows) {
  const result = [];
  for (const row of rows) { const bytes = await readFile(row.file); if (bytes.length !== row.bytes || sha(bytes) !== row.sha256) result.push({ file: row.file, before: row, after: { bytes: bytes.length, sha256: sha(bytes) } }); }
  return result;
}
need((await changes(baseline.protectedUntracked)).length === 0, 'INITIAL_UNTRACKED_BYTES_CHANGED');
need((await changes(baseline.officialSources)).length === 0, 'OFFICIAL_SOURCE_BYTES_CHANGED');
need((await changes(baseline.historicalStore.files)).length === 0, 'OLD_STORE_BYTES_CHANGED');
need((await changes([baseline.existingAuthorization,baseline.existingResolution])).length === 0, 'EXISTING_RESOLUTION_CHANGED');
const priorDocumentChanges = await changes(baseline.priorTrackedEdits);
const trackedChanges = paths(['diff','--name-only','-z']);
const external = [...new Set([...matchingPaths,...trackedChanges.filter(file => !ownCode.includes(file) && !baseline.priorTrackedEdits.some(row => row.file === file))])];
const protectedChanges = await changes(baseline.protectedTracked);
need(protectedChanges.every(row => ownCode.includes(row.file) || external.includes(row.file)), 'UNCLASSIFIED_TRACKED_CHANGE');
need(git(['-C','reference/einstein-matchmaker-data','rev-parse','HEAD']).trim() === '4fb99b3749adf0d10b5977089ff4c73f4f522240'
  && git(['-C','reference/einstein-matchmaker-data','status','--porcelain']) === '', 'DATA_GIT_CHANGED');
need(paths(['diff','--cached','--name-only','-z']).length === 0, 'INDEX_HAS_OTHER_WORK');

const docs = (await readdir(folder)).filter(n => /^task-9-[a-zA-Z0-9_.-]+\.(json|md|txt|png)$/.test(n)).map(n => folder + '/' + n);
const outputs = [folder + '/task-9-file-list'+suffix+'.json',folder + '/task-9-verification'+suffix+'.json'];
const activeOutput = folder + '/task-9-delivery-output'+suffix+'.txt';
const files = [...new Set([...ownCode,...docs,...outputs])].sort();
const initial = new Set(baseline.untrackedPaths);
need(files.every(file => !initial.has(file) && !external.includes(file) && !baseline.priorTrackedEdits.some(row => row.file === file)
  && !/(^|\/)\.env|^reference\/|^\.agents\/|node_modules/.test(file)), 'UNSAFE_COMMIT_SCOPE');
const fileFingerprints = [];
const secretValues = [process.env.EINSTEIN_GATEWAY_API_KEY];
try { const env = await readFile('.env.local','utf8'); const m = env.match(/^EINSTEIN_GATEWAY_API_KEY\s*=\s*["']?([^\r\n"']+)["']?\s*$/m); if (m) secretValues.push(m[1]); } catch (e) { if (e.code !== 'ENOENT') throw e; }
for (const file of files.filter(file => !outputs.includes(file))) {
  const info = await lstat(file); need(info.isFile() && !info.isSymbolicLink(), 'DELIVERY_FILE_LINK');
  const bytes = await readFile(file), text = bytes.toString('utf8');
  need(!secretValues.filter(v => typeof v === 'string' && v.length > 10).some(v => text.includes(v)) && !/\bsk-[A-Za-z0-9_-]{20,}\b/.test(text), 'SECRET_IN_DELIVERY');
  if (file !== activeOutput) fileFingerprints.push({ file, bytes: bytes.length, sha256: sha(bytes) });
}
for (const name of await readdir('dist/web/assets')) {
  const text = await readFile('dist/web/assets/' + name,'utf8');
  need(!text.includes('EINSTEIN_GATEWAY_API_KEY') && !text.includes('node:fs') && !secretValues.filter(v => v?.length > 10).some(v => text.includes(v)) && !/\bsk-[A-Za-z0-9_-]{20,}\b/.test(text), 'BROWSER_SECRET_OR_NODE_DEPENDENCY');
}
function stats(text) { const result = {}; for (const key of ['tests','pass','fail','cancelled','skipped']) { const m = text.match(new RegExp('(?:ℹ|#)\\s+'+key+'\\s+(\\d+)')); need(m,'MISSING_TEST_STATS'); result[key]=Number(m[1]); } return result; }
const targetedRaw = await readFile(folder + '/task-9-targeted-integrated.txt'), fullRaw = await readFile(folder + '/task-9-offline-final.txt'), webRaw = await readFile(folder + '/task-9-web-delivery.txt');
const targeted = stats(targetedRaw.toString()), full = stats(fullRaw.toString());
need(targeted.tests === 19 && targeted.pass === 19 && targeted.fail === 0 && /CHECK_EXIT=0\s*$/.test(targetedRaw.toString()), 'TASK9_TARGETED_FAILURE');
need(full.tests === 1303 && full.pass === 1302 && full.fail === 1 && full.cancelled === 0 && full.skipped === 0 && /CHECK_EXIT=1\s*$/.test(fullRaw.toString()), 'SHARED_FAILURE_RECORD_CHANGED');
need(/CHECK_EXIT=0\s*$/.test(webRaw.toString()) && webRaw.toString().includes('built in'), 'WEB_NOT_PASSED');
const integratedRaw = await readFile(folder + '/task-9-offline-delivery.txt'), integrated = stats(integratedRaw.toString());
need(integrated.tests === 1309 && integrated.pass === integrated.tests && integrated.fail === 0 && integrated.cancelled === 0 && integrated.skipped === 0
  && /CHECK_EXIT=0\s*$/.test(integratedRaw.toString()), 'INTEGRATED_SUITE_NOT_PASSED');
const browser = await json(folder + '/task-9-browser-sixth.json'), mobile = await json(folder + '/task-9-browser-seventh.json');
const repaired = await json(folder + '/task-9-browser-repaired.json');
need(browser.passed && mobile.passed && browser.actualModelRequests === 0 && mobile.actualModelRequests === 0 && browser.exceptions.length === 0 && mobile.exceptions.length === 0, 'BROWSER_NOT_PASSED');
need(browser.fixture.runs.length === 4 && browser.fixture.manager.inFlight === 0 && browser.fixture.manager.runs.every(r => r.pending === 0)
  && browser.fixture.cleanups.length === 1 && browser.fixture.cleanups.every(c => c.confirmed && c.exit.exitObserved && c.exit.closeObserved && !c.scanDiagnostics.length), 'FIXTURE_CLEANUP');
const restart = await json(folder + '/task-9-fixture-restart.json');
need(browser.fixture.safetyHold === true && restart.passed && restart.priorFieldObservedAfterStoreClose && restart.safetyHoldBeforeClose === false
  && restart.fixtureFileBytesUnchanged && restart.newRuns === 0 && restart.modelRequests === 0 && restart.newManager.runs.length === 0,
  'CLOSED_GETTER_MISINTERPRETED_AS_ACTIVE_HOLD_SNAPSHOT');
need(mobile.fixture.managerCreated === false && mobile.fixture.manager === null && mobile.fixture.runs === null, 'READ_ONLY_MANAGER_INVENTED');
need(browser.original.managerRuns === 0 && mobile.original.managerRuns === 0 && browser.originalStoreNewRuns === 0 && mobile.originalStoreNewRuns === 0, 'ORIGINAL_RUN_CREATED');
need(repaired.passed && repaired.actualModelRequests === 0 && repaired.original.managerRuns === 0 && repaired.requests.every(r => r.method === 'GET')
  && repaired.original.historicalId === 'b738ce31-0d8d-4eba-a01e-f4deac26a632' && repaired.fixture.managerCreated === false, 'REPAIRED_REPLAY');
const audit = await json(folder + '/task-9-process-audit.json'), followup = await json(folder + '/task-9-process-audit-followup.json');
need(audit.rows.length === 9 && audit.missing.length === 0 && audit.rows.filter(r => r.observed === 'unknown').length === 1
  && followup.rows.length === 1 && followup.rows[0].nativeStatus === 'absent' && followup.rows[0].cim.status === 'absent', 'PROCESS_AUDIT_EVIDENCE');
const finalAudit = await json(folder + '/task-9-process-audit-v3.json');
need(finalAudit.registeredIdentities === 10 && finalAudit.allCapturedOriginalsGone && finalAudit.allBirthIdentitiesCaptured
  && finalAudit.modelRequests === 0 && finalAudit.terminationCalls === 0, 'FINAL_PROCESS_AUDIT');
async function walk(path) { let out=[];for(const e of await readdir(path,{withFileTypes:true})){const file=join(path,e.name);if(e.isDirectory())out.push(...await walk(file));else{need(e.isFile(),'STORE_LINK');out.push(resolve(file));}}return out.sort(); }
const originalSet = new Set(baseline.historicalStore.files.map(row => resolve(row.file))), storeNow = await walk(baseline.historicalStore.root);
const extraStoreFiles = storeNow.filter(file => !originalSet.has(file));
const priorSet = new Set(baseline.untrackedPaths), ownSet = new Set(files);
const retainedNewUntracked = [];
for (const file of untracked.filter(file => !priorSet.has(file) && !ownSet.has(file))) { const bytes = await readFile(file); retainedNewUntracked.push({ file, bytes: bytes.length, sha256: sha(bytes), ownership: 'retained_not_task9_commit' }); }
const report = {
  task:'Task9',observedAt:new Date().toISOString(),baseline:baseline.head,head:git(['rev-parse','HEAD']).trim(),branch:git(['branch','--show-current']).trim(),
  integratedMatchingCommit:matchingCommit,matchingPathsNotStaged:matchingPaths,
  ownFiles:files.length,fileFingerprints,ongoingStdoutExcludedFromFinalFingerprint:activeOutput,
  protectedInitialUntracked:baseline.protectedUntracked.length,allInitialUntrackedBytesAndTrackingPreserved:true,
  originalDocuments:baseline.priorTrackedEdits.map(row=>row.file),priorDocumentChangesByOtherWork:priorDocumentChanges,
  parallelAuthorizedTrackedChanges:external,parallelDiffsFromBaseline:protectedChanges.filter(row=>external.includes(row.file)),
  officialSources:8,officialSourcesUnchanged:true,dataGitClean:true,originalStoreFiles:baseline.historicalStore.files.length,oldStoreBytesUnchanged:true,
  actualStoreFiles:storeNow.length,extraStoreFiles,Task9OriginalStoreNewRuns:0,existingAuthorizationAndResolutionUnchanged:true,
  targeted:{...targeted,exitCode:0,sha256:sha(targetedRaw)},earlierSharedSuite:{...full,exitCode:1,passed:false,sha256:sha(fullRaw),historicalIssue:'old full-pool assertion; subsequently corrected in matching commit'},
  finalIntegratedSuite:{...integrated,exitCode:0,passed:true,sha256:sha(integratedRaw),previousSharedAssertionFixedByMatchingOwner:true},
  web:{exitCode:0,sha256:sha(webRaw)},browser:{fullFlowPassed:true,readOnlyMobilePassed:true,repairedResearchReplayPassed:true,actualModelRequests:0,fixtureRuns:4,originalModelRuns:0,diagnosticTraceEvents:97},
  processAudit:{initialCaptured:9,initialUnknown:1,followupNativeAbsent:true,followupCimAbsent:true,finalCaptured:10,finalAllCapturedOriginalsGone:true,initialFailurePreserved:true,unknownOrphanGuarantee:false},
  fixtureCloseMetadata:{historicalSafetyHoldGetterAfterStoreClose:true,notAnActiveHoldSnapshot:true,restartIsSeparateNewManager:true,restartSafetyHoldBeforeClose:false,oldManagerNotDecremented:true},
  retainedNewUntracked,secretScan:{actualCredentialMatches:0,genericCredentialMatches:0,browserCredentialOrNodeFsMatches:0},
  Task10Started:false,humanLabels:0,qualityMetrics:'NA',holdout:'unopened',pushed:false,
};
await writeFile(outputs[0],JSON.stringify({task:'Task9',baseline:baseline.head,files,excludedExistingUserEdits:baseline.priorTrackedEdits.map(row=>row.file),excludedParallelWork:external},null,2)+'\n',{flag:'wx'});
await writeFile(outputs[1],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({head:report.head,commitPaths:files.length,priorEdits:baseline.priorTrackedEdits.length,initialUntracked:baseline.untrackedPaths.length,matchingCommitPaths:matchingPaths.length,
  protectedUntrackedPreserved:true,officialSourcesUnchanged:true,originalStorePreserved:true,storeFiles:storeNow.length,extraStoreFiles:extraStoreFiles.length,targeted:'19/19',earlierSharedSuite:'1302/1303_failure_preserved',integratedSuite:'1309/1309',webExit:0,browserPassed:true,modelRequests:0}));
