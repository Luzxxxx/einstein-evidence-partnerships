// Task10-only passive capture. Same production engine/tools; no answer seeds.
import {mkdirSync,appendFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {startWorker} from '../dist/server/runtime/worker-entry.js';
import {captureAnswerText} from '../dist/server/runtime/answer-diagnostics.js';
startWorker({configure:async({start})=>{
 const gateway={baseURL:process.env.EINSTEIN_GATEWAY_BASE_URL??'',apiKey:process.env.EINSTEIN_GATEWAY_API_KEY??'',model:process.env.EINSTEIN_GATEWAY_MODEL??''};
 const folder=resolve('docs/implementation/task-10-live',start.runId);mkdirSync(folder,{recursive:true});
 const file=join(folder,'answers.jsonl');writeFileSync(file,JSON.stringify({kind:'header',runId:start.runId,runnerMode:'live',controlledSeed:false})+'\n',{flag:'wx'});
 return{runnerMode:'live',gateway,onNative(event,actor){if(event.type!=='model.answer')return;const captured=captureAnswerText(event.payload.answer?.content?.text,gateway.apiKey,262144);appendFileSync(file,JSON.stringify({kind:'answer',actor,...captured})+'\n');}};
}});
