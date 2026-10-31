// One explicit real Run on the user's running local service; never retries POST.
// Default production limits remain 16 attempts / 180 seconds. No fixture answers.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
const [companyId,challengeId]=process.argv.slice(2);
if(process.argv.length!==4||!/^C\d{3}$/.test(companyId??'')||!new RegExp(`^${companyId}-CH[1-9]\\d?$`).test(challengeId??'')||['C040','C061','C112'].includes(companyId))throw Error('EXPLICIT_NON_HOLDOUT_CASE_REQUIRED');
const url='http://127.0.0.1:3000',attemptId=randomUUID(),folder=resolve('docs/implementation/task-10-live',attemptId);
await mkdir(folder,{recursive:true});
const save=(name,value)=>writeFile(join(folder,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
await save('attempt.json',{attemptId,companyId,challengeId,startedAt:new Date().toISOString(),endpoint:url,automaticRetries:0,maximumAttempts:16,deadlineSeconds:180,mode:'research'});
let runId,result;
try{
 const created=await fetch(url+'/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({companyId,challengeId}),signal:AbortSignal.timeout(20000)});
 const admission=await created.json();await save('admission.json',{httpStatus:created.status,body:admission});
 if(created.status!==202||!admission.runId)throw Error('RUN_NOT_ADMITTED');
 runId=admission.runId;console.log(JSON.stringify({phase:'started',attemptId,runId,companyId,challengeId}));
 const end=Date.now()+225000;let detail;
 while(Date.now()<end){
  const response=await fetch(`${url}/api/runs/${runId}`,{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('RUN_READ_FAILED');detail=await response.json();
  if(detail.progress.blockedByService)break;
  if(['approved','insufficient','failed','cancelled'].includes(detail.run.status)&&['confirmed','unconfirmed'].includes(detail.run.cleanupState))break;
  await new Promise(yes=>setTimeout(yes,1000));
 }
 if(!detail?.progress.terminal&&!detail?.progress.blockedByService)throw Error('RUN_OBSERVATION_TIMEOUT');
 const artifacts=await(await fetch(`${url}/api/runs/${runId}/artifacts`)).json();
 const raw=await(await fetch(`${url}/api/runs/${runId}/events`)).text();
 const events=raw.split(/\r?\n/).filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
 const grants=events.filter(e=>e.type==='permit.granted').length,usages=events.filter(e=>e.type==='model.usage').map(e=>e.payload.usage);
 const reported=usages.filter(u=>Number.isSafeInteger(u.totalTokens));
 result={attemptId,runId,companyId,challengeId,detail,artifacts,events,grants,modelRequests:events.filter(e=>e.type==='model.request.started').length,
  usage:{reportedRequests:reported.length,knownSubtotal:reported.length?reported.reduce((sum,u)=>sum+u.totalTokens,0):null,completeTotal:detail.progress.terminal&&!detail.progress.blockedByService&&reported.length===grants?reported.reduce((sum,u)=>sum+u.totalTokens,0):null},
  blockedByService:detail.progress.blockedByService??false,cleanup:detail.run.cleanupState,publication:Boolean(artifacts.publication?.formalProposal),actualModel:true,controlledSeed:false,automaticRetries:0,humanQuality:{labels:0,metrics:'NA',holdout:'unopened'}};
}catch(error){result={attemptId,runId:runId??null,companyId,challengeId,observationError:true,code:/^[A-Z_]+$/.test(error.message)?error.message:'LOCAL_ANALYSIS_OBSERVATION_FAILED',automaticRetries:0};}
await save('result.json',result);
console.log(JSON.stringify({phase:'finished',file:join(folder,'result.json'),runId,status:result.detail?.run.status??'unknown',reasonCodes:result.detail?.progress.reasonCodes,grants:result.grants,cleanup:result.cleanup,publication:result.publication,usage:result.usage,observationError:result.observationError??false}));
if(result.observationError||result.cleanup!=='confirmed')process.exitCode=1;
