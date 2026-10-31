// Explicit offline_fixture readiness material. Real command capture/producer,
// isolated file tree and copied historical specimens; never a live decision,
// historical-store recovery or model run. Original workspace/store are READ ONLY.
import {readFile,writeFile,mkdir,readdir,unlink,symlink,readlink,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute,sep} from 'node:path';import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createEngineeringMaterialFixture,engineeringSha as sha} from './engineering-material-fixture.mjs';
import {hashArtifact,hashRunInput} from '../../dist/server/evidence/hashing.js';
import {canonicalizeArtifact} from '../../dist/server/contracts/canonical.js';
import {PROTOCOL_PROBE_V4_CONTRACT} from '../../dist/server/evaluation/protocol-probe-v4.js';

const workspace=resolve('.');
const allowed=['src/evaluation/protocol-probe-v4-plan.ts','dist/server/evaluation/protocol-probe-v4-plan.js','src/evaluation/protocol-probe-worker-v4.ts','dist/server/evaluation/protocol-probe-worker-v4.js','src/evaluation/v4-bounded-validation.ts','dist/server/evaluation/v4-bounded-validation.js'];
const digest=bytes=>sha(Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes));
export async function preparedTree(root){const rows=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.isFile()){const bytes=await readFile(p);rows.push({file:relative(root,p).replaceAll('\\','/'),bytes:bytes.length,sha256:digest(bytes)});}else if(e.isSymbolicLink())rows.push({file:relative(root,p).replaceAll('\\','/'),linkTarget:await readlink(p)});else throw Error('OFFLINE_FIXTURE_LINK');}}await walk(root);return rows.sort((a,b)=>a.file.localeCompare(b.file,'en'));}
export async function createPreparedV4Fixture(t){
 const engineering=await createEngineeringMaterialFixture(t),root=engineering.root,rootStore=await mkdtemp(join(tmpdir(),'einstein task7y external fixture store ')),materialApi=engineering.api;
 t.after(async()=>{const absolute=resolve(rootStore);if(!absolute.startsWith(resolve(tmpdir())+sep)||!absolute.includes('einstein task7y external fixture store '))throw Error('OFFLINE_FIXTURE_STORE_PATH');await rm(absolute,{recursive:true,force:true});});
 const write=async(file,value)=>{const path=isAbsolute(file)?file:join(root,file);await mkdir(dirname(path),{recursive:true});await writeFile(path,value);return path;};
 const ref=async(file)=>{const bytes=await readFile(isAbsolute(file)?file:join(root,file));return{file,bytes:bytes.length,sha256:digest(bytes)};};
 const original=JSON.parse(await readFile(join(workspace,'docs/implementation/task-7x-live/freeze.json'),'utf8'));
 const yAuth=JSON.parse(await readFile(join(workspace,'docs/implementation/task-7y-authorization.json'),'utf8'));
 const xBaseline=JSON.parse(await readFile(join(workspace,'docs/implementation/task-7x-baseline.json'),'utf8'));
 const historyAuth=structuredClone(original.existingAuthorization),historyRun=historyAuth.runId;
 // Immutable repository specimens replace machine-specific historical paths.
 // The archived JSON itself remains byte-for-byte unchanged.
 const historyFixture=join(workspace,'tests/fixtures/historical-recovery');
 for(const name of['record.json','events.jsonl','terminal.json'])await write(join(rootStore,historyRun,name),await readFile(join(historyFixture,historyRun,name)));
 const resultFile='docs/offline-history/result.json',freezeFile='docs/offline-history/freeze.json',evidenceFile='docs/offline-history/evidence.json',legacyAuthFile='docs/implementation/task-7s-authorization.json';
 const historyResult=JSON.parse(await readFile(join(workspace,'docs/implementation/task-7-live/runs',historyRun,'result.json'),'utf8')),historyEvidence=JSON.parse(await readFile(join(workspace,'docs/implementation/task-7r-recovery-evidence-v2.json'),'utf8'));
 historyResult.storeRoot=rootStore;historyResult.offline_fixture_copy=true;await write(resultFile,JSON.stringify(historyResult)+'\n');
 await write(freezeFile,await readFile(join(workspace,'docs/implementation/task-7-live/freeze.json')));
 historyEvidence.storeRoot=rootStore;historyEvidence.offline_fixture_copy=true;
 historyEvidence.assessments[0].resultPath=join(root,resultFile);historyEvidence.assessments[0].resultSha256=(await ref(resultFile)).sha256;
 historyEvidence.assessments[0].terminalPath=join(rootStore,historyRun,'terminal.json');await write(evidenceFile,JSON.stringify(historyEvidence)+'\n');
 historyAuth.storeRoot=rootStore;historyAuth.originalFiles.result={path:join(root,resultFile),sha256:(await ref(resultFile)).sha256};historyAuth.originalFiles.freeze={path:join(root,freezeFile),sha256:(await ref(freezeFile)).sha256};historyAuth.evidence={path:join(root,evidenceFile),sha256:(await ref(evidenceFile)).sha256};
 await write(legacyAuthFile,JSON.stringify(historyAuth)+'\n');
 const oldResolution=JSON.parse(await readFile(join(historyFixture,'historical-recovery',historyRun+'.resolution.json'),'utf8')),resolutionFile=join(rootStore,'historical-recovery',historyRun+'.resolution.json');
 const resolution={...oldResolution,authorization:historyAuth,authorizationHash:hashArtifact(historyAuth),evidenceSha256:historyAuth.evidence.sha256};resolution.hash=hashArtifact(resolution);await write(resolutionFile,JSON.stringify(resolution)+'\n');
 const fpPaths=[...allowed,'src/supervisor/permits.ts','dist/server/supervisor/permits.js','src/unchanged-fixture.ts'],oldRuntime=[];
 for(const file of fpPaths){const before=Buffer.from(`// explicit offline fixture baseline ${file}\n`),after=allowed.includes(file)?Buffer.from(`// explicit offline fixture approved update ${file}\n`):before;
  await write(file,after);oldRuntime.push({file,bytes:before.length,sha256:digest(before)});}
 // A real pnpm-shaped installed-package junction in THIS temporary root only.
 // The bytes are parser specimens, not a substitute SDK or vendor validation.
 const actualSdk=join(root,'node_modules/.pnpm/@mozaik-ai+core@4.2.0_fixture/node_modules/@mozaik-ai/core'),logicalSdk=join(root,'node_modules/@mozaik-ai/core');
 await mkdir(actualSdk,{recursive:true});await mkdir(dirname(logicalSdk),{recursive:true});
 for(const file of['package.json','dist/index.d.ts','dist/index.js','dist/index.mjs']){
  const content=file==='package.json'?Buffer.from('{"name":"@mozaik-ai/core","version":"4.2.0"}\n'):Buffer.from('// offline_fixture installed SDK path specimen\n');
  await write(join(actualSdk,file),content);const logical='node_modules/@mozaik-ai/core/'+file;fpPaths.push(logical);oldRuntime.push({file:logical,bytes:content.length,sha256:digest(content)});
 }
 await symlink(actualSdk,logicalSdk,'junction');
 const collector=async()=>Promise.all(fpPaths.map(async file=>({file,sha256:(await ref(file)).sha256})));
 const fingerprints=(await collector()).sort((a,b)=>a.file.localeCompare(b.file,'en'));
 const sources=[];for(const f of original.sourceIntegrity){const bytes=await readFile(join(workspace,'reference/einstein-matchmaker-data',f.file));await write(join('reference/einstein-matchmaker-data',f.file),bytes);sources.push({file:'reference/einstein-matchmaker-data/'+f.file,bytes:bytes.length,sha256:digest(bytes),datasetRelative:f.file});}
 const iface=original.promptContract.interfaceContract;await write(iface.file,Buffer.from(iface.text,'utf8'));
 const protectedFile='docs/offline-history/prior-preserved.txt';await write(protectedFile,'offline_fixture preserved prior bytes\n');
 const five=['README.md','findings.md','progress.md','task_plan.md','docs/superpowers/plans/2026-10-30-einstein-mvp-implementation.md'];for(const file of five)await write(file,'offline_fixture preserved existing document\n');
 const fixtureX={...xBaseline,historicalStore:{...xBaseline.historicalStore,root:rootStore},oldRuntime:[{file:'src/supervisor/permits.ts',sha256:digest('before x deadline source')},{file:'dist/server/supervisor/permits.js',sha256:digest('before x deadline compiled')}],officialSources:sources};
 const xFile='docs/implementation/task-7x-baseline.json';await write(xFile,JSON.stringify(fixtureX)+'\n');
 const storeFiles=(await preparedTree(rootStore)).map(f=>({...f,file:join(rootStore,f.file)}));
 const baseline={task:'Task7y',capturedAt:new Date().toISOString(),head:yAuth.baselineHead,branch:'offline_fixture',trackedChanges:await Promise.all(five.map(ref)),protectedUntracked:[await ref(protectedFile)],
  historicalImplementation:await Promise.all([resultFile,freezeFile,evidenceFile,xFile].map(ref)),historicalStore:{root:rootStore,files:storeFiles},officialSources:sources,
  existingAuthorization:await ref(legacyAuthFile),existingResolution:await ref(resolutionFile),oldRuntime,datasetCommit:original.probe.input.datasetCommit};
 const baselineFile='docs/implementation/task-7y-baseline.json';await write(baselineFile,JSON.stringify(baseline)+'\n');
 const authorization={...yAuth,protocolContractSha256:hashArtifact(PROTOCOL_PROBE_V4_CONTRACT),storeRoot:rootStore,baselineSha256:(await ref(baselineFile)).sha256,approvedRuntimeChanges:allowed.map(file=>({file,beforeSha256:oldRuntime.find(r=>r.file===file).sha256}))};
 const authorizationFile='docs/implementation/task-7y-authorization.json';await write(authorizationFile,JSON.stringify(authorization)+'\n');
 const candidateId=randomUUID(),candidateFolder=`docs/implementation/task-7y-live/candidates/${candidateId}`;await mkdir(join(root,candidateFolder),{recursive:true});
 // The expanded runtime specimen is captured AGAIN after creation. Never
 // relabel the shared helper's earlier one-file capture as a nine-file test.
 const beforeFingerprints=(await collector()).sort((a,b)=>a.file.localeCompare(b.file,'en'));
 const preparedOffline=await materialApi.captureEngineeringCommand({root,kind:'offline',runnerMode:'offline_fixture',command:process.execPath,argv:engineering.offline.argv,
  logFile:'logs/prepared-offline.log',receiptFile:'logs/prepared-offline.receipt.json'});
 const preparedWeb=await materialApi.captureEngineeringCommand({root,kind:'web',runnerMode:'offline_fixture',command:process.execPath,argv:engineering.web.argv,
  logFile:'logs/prepared-web.log',receiptFile:'logs/prepared-web.receipt.json'});
 const afterFingerprints=(await collector()).sort((a,b)=>a.file.localeCompare(b.file,'en'));
 const preparedCommands={offline:{file:'logs/prepared-offline.receipt.json',sha256:(await ref('logs/prepared-offline.receipt.json')).sha256},web:{file:'logs/prepared-web.receipt.json',sha256:(await ref('logs/prepared-web.receipt.json')).sha256}};
 const capture={schemaVersion:1,kind:'engineering_capture_provenance',runnerMode:'offline_fixture',sourceCommitBefore:engineering.sourceCommit,sourceCommitAfter:engineering.sourceCommit,
  fingerprintsBefore:beforeFingerprints,fingerprintsAfter:afterFingerprints,commands:preparedCommands};
 const captureFile='prepared-capture.json';await write(captureFile,JSON.stringify(capture)+'\n');
 const review={schemaVersion:1,kind:'independent_engineering_review',task:'Task7y',runnerMode:'offline_fixture',sourceCommit:engineering.sourceCommit,fingerprints,reviewer:'offline_fixture_independent_review_not_human_gold',remainingBlockers:0,passed:true};
 const reviewFile='prepared-review.json';await write(reviewFile,JSON.stringify(review)+'\n');
 const producerOptions={...engineering.options,fingerprints,commands:preparedCommands,capture:{file:captureFile,sha256:(await ref(captureFile)).sha256},independentReview:{file:reviewFile,sha256:(await ref(reviewFile)).sha256}};
 const material=await materialApi.produceEngineeringMaterial(producerOptions,{root}),engineeringFile=candidateFolder+'/engineering.json';await write(engineeringFile,JSON.stringify(material)+'\n');
 const runId=randomUUID(),input={...original.probe.input,runId},definitions=structuredClone(original.probe.toolDefinitions);for(const d of definitions){const run=d.parameters?.properties?.runId;if(run?.const)run.const=runId;}
 const p={...original,createdAt:new Date().toISOString(),engineeringSourceCommit:engineering.sourceCommit,productFingerprints:fingerprints,existingAuthorization:historyAuth,authorizationFileSha256:(await ref(legacyAuthFile)).sha256,resolutionFileSha256:(await ref(resolutionFile)).sha256,
  // This new temporary candidate uses today's contract. The archived freeze
  // remains an immutable historical specimen with its original contract/hash.
  probe:{...original.probe,contract:structuredClone(PROTOCOL_PROBE_V4_CONTRACT),contractSha256:hashArtifact(PROTOCOL_PROBE_V4_CONTRACT),runId,input,inputHash:hashRunInput(input),userTask:{...original.probe.userTask,runId},toolDefinitions:definitions},baseline:{file:xFile,sha256:(await ref(xFile)).sha256,storeRoot:rootStore},
  approvedRuntimeChanges:fixtureX.oldRuntime.map(r=>({file:r.file,beforeSha256:r.sha256,afterSha256:fingerprints.find(f=>f.file===r.file).sha256})),
  engineeringGate:{file:engineeringFile,sha256:(await ref(engineeringFile)).sha256},preparation:{schemaVersion:1,task:'Task7y',candidateId,candidateFolder,authorizationId:authorization.authorizationId,authorizationFile,authorizationFileSha256:(await ref(authorizationFile)).sha256,
   globalAttemptFile:authorization.globalAttemptFile,baselineFile,baselineSha256:(await ref(baselineFile)).sha256}};
 p.hash=hashArtifact(p);const candidateFreeze=candidateFolder+'/freeze.json';await write(candidateFreeze,JSON.stringify(p)+'\n');
 const options={root,runnerMode:'offline_fixture',phase:'frozen',env:{EINSTEIN_GATEWAY_API_KEY:'fixture_key_not_for_network',EINSTEIN_GATEWAY_MODEL:p.model,EINSTEIN_GATEWAY_BASE_URL:p.gatewayBaseURL},currentCommit:engineering.sourceCommit,
  collectFingerprints:async()=>{const rows=await collector();return rows.sort((a,b)=>a.file.localeCompare(b.file,'en'));}};
 const originals=new Map();async function edit(file,fn){const path=isAbsolute(file)?file:join(root,file);if(!originals.has(path)){try{originals.set(path,await readFile(path));}catch(e){if(e.code!=='ENOENT')throw e;originals.set(path,null);}}
  const before=originals.get(path),value=await fn(before);if(value===null){try{await unlink(path);}catch(e){if(e.code!=='ENOENT')throw e;}}else await write(path,value);}
 async function reset(){for(const[path,bytes]of originals){if(bytes===null){try{await unlink(path);}catch(e){if(e.code!=='ENOENT')throw e;}}else await write(path,bytes);}originals.clear();}
 async function savePlan(plan){plan.hash=hashArtifact(plan);await edit(candidateFreeze,()=>JSON.stringify(plan)+'\n');}
 return{...engineering,offline:preparedOffline,web:preparedWeb,materialApi,root,rootStore,baseline,authorization,p,options,candidateId,candidateFolder,candidateFreeze,engineeringFile,material,producerOptions,fingerprints,fpPaths,legacyAuthFile,resolutionFile,
  write,ref,edit,reset,savePlan,rehash:value=>({...value,hash:hashArtifact(value)}),canonicalizeArtifact,tree:async()=>({project:await preparedTree(root),externalStore:await preparedTree(rootStore)})};
}
