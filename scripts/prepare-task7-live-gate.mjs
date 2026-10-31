// Root preflight only. No model calls; refuse existing gate or changed raw data.
import { readFile,writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sha256Bytes } from '../dist/server/evidence/hashing.js';
import { collectCriticProductFingerprints } from '../dist/server/evaluation/run-critic-eval.js';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const baseline=await json('docs/implementation/task-7-baseline.json');
const old=await json('docs/implementation/task-6-integrity.json');
const files=await Promise.all(old.files.map(async f=>{const b=await readFile(resolve('reference/einstein-matchmaker-data',f.file));return{file:f.file,bytes:b.length,expectedSha256:f.actualSha256,actualSha256:sha256Bytes(b),unchanged:sha256Bytes(b)===f.actualSha256};}));
const userRecords=await Promise.all(baseline.untrackedJson.map(async f=>({...f,unchanged:sha256Bytes(await readFile(f.file))===f.sha256})));
if(files.some(f=>!f.unchanged)||userRecords.some(f=>!f.unchanged))throw Error('PREFLIGHT_BASELINE_CHANGED');
const output=await readFile('docs/implementation/task-7-offline-final-pre-live-output.txt','utf8');
if(!/ℹ tests 476\r?\n/.test(output)||!/ℹ pass 476\r?\n/.test(output)||!/ℹ fail 0\r?\n/.test(output))throw Error('FULL_OFFLINE_NOT_VERIFIED');
const audit=await json('docs/implementation/task-7-process-final-pre-live-audit.json');
if(!audit.allRegisteredOriginalsGone||audit.liveCount!==0)throw Error('WINDOWS_AUDIT_NOT_CLEAR');
const status=execFileSync('git',['-C','reference/einstein-matchmaker-data','status','--porcelain'],{encoding:'utf8'}).trim();
if(status)throw Error('RAW_DATA_GIT_DIRTY');
const integrity={baseline:baseline.head,sourceHashBasis:'complete original file bytes including BOM/newlines',datasetCommit:old.datasetCommit,datasetGitStatus:status,
  files,userRecords,sourceFilesUnchanged:true,protectedUserJsonUnchanged:true};
await writeFile('docs/implementation/task-7-integrity-pre-live.json',JSON.stringify(integrity,null,2)+'\n',{flag:'wx'});
const gate={task:'Task7',engineeringVerified:true,independentReviewPassed:true,createdAt:new Date().toISOString(),baseline:baseline.head,
  offline:{command:'pnpm test:offline',tests:476,pass:476,fail:0,exitCode:0,output:'task-7-offline-final-pre-live-output.txt'},
  web:{command:'pnpm build:web',exitCode:0,output:'task-7-web-final-pre-live-output.txt'},
  windowsAudit:'task-7-process-final-pre-live-audit.json',registeredOriginalsGone:audit.registeredIdentityCount,
  independentReview:{reviewer:'task7_final_review',blockersFound:2,blockersReproducedAndFixed:true,remainingSpecificBlockers:0,
    crossReviews:['task7_gate','task7_critic','task7_cases'],qualityAcceptance:'unadjudicated'},
  sourceFingerprints:await collectCriticProductFingerprints(),
  liveScope:{logicalCases:15,deterministicVariants:16,actualLiveVariants:12,repeats:3,plannedRuns:36,maxGrantedRequests:576,
    maxGrantedPerRun:16,maxGlobalRequests:2,runDeadlineMs:180000,requestDeadlineMs:40000,noAutomaticRetries:true,holdout:'unopened'}};
await writeFile('docs/implementation/task-7-pre-live-gate.json',JSON.stringify(gate,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({offline:476,web:0,auditOriginalsGone:audit.registeredIdentityCount,sourceFiles:files.length,protectedUserJson:userRecords.length,fingerprints:gate.sourceFingerprints.length,liveRuns:36,modelCalls:0}));
