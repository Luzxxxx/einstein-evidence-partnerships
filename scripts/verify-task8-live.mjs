// One user-authorized normal research HTTP Run. No probe, seed, retries or replacement Run.
import {readFile,writeFile,access} from 'node:fs/promises';import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {startLocalService,modelConfigurationReady} from '../dist/server/server/service.js';import {DEFAULT_LIMITS} from '../dist/server/contracts/config.js';
const output='docs/implementation/task-8-live-result.json';try{await access(output);throw Error('TASK8_LIVE_RESULT_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
if(!modelConfigurationReady()||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Error('MODEL_CONFIGURATION_UNAVAILABLE');
if(DEFAULT_LIMITS.maxModelRequests!==16||DEFAULT_LIMITS.runTimeoutMs!==180000||DEFAULT_LIMITS.requestTimeoutMs!==40000||DEFAULT_LIMITS.maxConcurrentModelRequests!==2)throw Error('TASK8_LIMITS_CHANGED');
const baseline=JSON.parse(await readFile('docs/implementation/task-8-baseline.json','utf8'));
const app=await startLocalService({storeRoot:baseline.historicalStore.root,historicalRecovery:JSON.parse(await readFile(baseline.existingAuthorization.file,'utf8')),port:0});
let result,runId,shutdownError=null;
try{
 if(app.scheduler.safetyHold)throw Error('RUN_SAFETY_HOLD');
 const post=await fetch(app.url+'/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({companyId:'C001',challengeId:'C001-CH1'})}),created=await post.json();
 if(post.status!==202||!created.runId)throw Error('TASK8_HTTP_POST_NOT_ACCEPTED');runId=created.runId;
 console.log(JSON.stringify({phase:'research_run_created',runId,httpStatus:post.status,maxRequests:16,runTimeoutMs:180000,automaticRetries:0}));
 await app.scheduler.waitForIdle(205000);
 const detail=await(await fetch(app.url+`/api/runs/${runId}`)).json(),artifacts=await(await fetch(app.url+`/api/runs/${runId}/artifacts`)).json(),showcase=await(await fetch(app.url+'/api/showcase')).json(),events=app.store.eventsAfter(runId,0),terminal=app.store.getTerminal(runId),manager=app.scheduler.permits.snapshot();
 const cleanups=app.scheduler.cleanupEvidence.map(c=>{const{stdout,stderr,...exit}=c.exit;return{...c,exit,stdoutSha256:createHash('sha256').update(stdout).digest('hex'),stderrSha256:createHash('sha256').update(stderr).digest('hex')};});
 const grants=events.filter(e=>e.type==='permit.granted'),usage=events.filter(e=>e.type==='model.usage').map(e=>e.payload.usage),totals={};for(const k of ['promptTokens','completionTokens','totalTokens','cachedInputTokens']){const reported=usage.filter(u=>Number.isSafeInteger(u[k]));totals[k]={reportedRequests:reported.length,grantDenominator:grants.length,knownSubtotal:reported.length?reported.reduce((n,u)=>n+u[k],0):null,completeTotal:reported.length===grants.length&&grants.length>0?reported.reduce((n,u)=>n+u[k],0):null};}
 const accepted=new Set(['approved','insufficient','failed','cancelled']),settled=accepted.has(detail.run.status)&&detail.run.cleanupState==='confirmed'&&!app.scheduler.safetyHold&&manager.inFlight===0&&manager.runs.every(r=>r.pending===0)&&cleanups.length===1&&cleanups[0].confirmed;
 result={task:'Task8',kind:'one_actual_research_http_run',runId,created,detail,artifacts,events,terminal,manager,cleanups,safetyHold:app.scheduler.safetyHold,showcase,grants:grants.length,usage:totals,usageMeaning:'Only actual valid gateway reports; absent usage remains unknown. No cost estimate.',parentPermitExplicitReleases:events.filter(e=>e.type==='permit.released').map(e=>e.payload.permitId),qualifiedFormalEntry:showcase.find(e=>e.runId===runId)??null,
  integrationPassed:settled&&grants.length<=16&&(detail.run.status!=='approved'||showcase.some(e=>e.runId===runId)),businessOutcome:detail.run.status,automaticRetries:0,probeRuns:0,controlledSeed:false,Task9Started:false,humanLabels:0,qualityMetrics:'NA',holdout:'unopened'};
}catch(error){result={task:'Task8',kind:'one_actual_research_http_run',runId:runId??null,integrationPassed:false,code:typeof error?.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'TASK8_LIVE_STOPPED',manager:app.scheduler.permits.snapshot(),safetyHold:app.scheduler.safetyHold,events:runId?app.store.eventsAfter(runId,0):[],automaticRetries:0};}
finally{try{await app.close();}catch{shutdownError='SERVICE_SHUTDOWN_OR_HOLD';}}
result.shutdownError=shutdownError;if(shutdownError)result.integrationPassed=false;
let text=JSON.stringify(result,null,2)+'\n';if(text.includes(process.env.EINSTEIN_GATEWAY_API_KEY))text=JSON.stringify({task:'Task8',runId:runId??null,integrationPassed:false,code:'EVIDENCE_PRIVATE_DATA_WITHHELD',byteLength:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),automaticRetries:0})+'\n';
await writeFile(output,text,{flag:'wx'});console.log(JSON.stringify({runId:runId??null,integrationPassed:result.integrationPassed,businessOutcome:result.businessOutcome??null,grants:result.grants??null,shutdownError,automaticRetries:0}));if(!result.integrationPassed)process.exitCode=1;
