// New controlled OFFLINE_FIXTURE responses, never reconstructed vendor replies.
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ModelContext,UserMessageItem } from '@mozaik-ai/core';
import { createGatewayRunner } from '../dist/server/model/gateway-runner.js';
const fixtureKey='offline-diagnostic-fixture-key';
const call=(id,name='read_fixture')=>({id,type:'function',function:{name,arguments:'{}'}});
const usage={prompt_tokens:11,completion_tokens:6,total_tokens:17};
const cases=[
  {id:'unsupported_multiple_strict_mode',response:()=>new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[call('one'),call('two')]}}],usage}))},
  {id:'unknown_tool_name',response:()=>new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[call('one','untrusted_provider_tool_name')]}}],usage}))},
  {id:'http_error_with_reported_usage',response:()=>new Response(JSON.stringify({usage}),{status:503})},
  {id:'credential_reflection',response:()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:fixtureKey}}],usage}))},
  {id:'body_limit',response:()=>new Response('x'.repeat(1024*1024+1))},
];
const samples=[];
for(const scenario of cases){
  const context=ModelContext.create().addContextItem(UserMessageItem.create('offline_fixture safe diagnosis'));
  const actor={runId:randomUUID(),agentId:randomUUID(),role:'proposer',loopId:randomUUID(),taskId:randomUUID(),contextId:context.id,attempt:1};
  const events=[];let fetches=0,releases=0,failure;
  const runner=createGatewayRunner({baseURL:'https://offline-fixture.invalid/v1',apiKey:fixtureKey,model:'offline_fixture',signal:new AbortController().signal,
    resolveTask:()=>actor,fetchImpl:async()=>{fetches++;return scenario.response();}},
    {acquire:async()=>({id:randomUUID()}),release:()=>{releases++;}},event=>events.push(event));
  try{await runner.run({model:'offline_fixture',context,streaming:false,tools:[{type:'function',name:'read_fixture',description:'offline fixture only',parameters:{type:'object'},strict:true,invoke:async()=>({ok:true})}]});}
  catch(error){failure={code:error.code,diagnostic:error.diagnostic};}
  samples.push({id:scenario.id,runnerMode:'offline_fixture',requestCount:fetches,releases,failure,events,
    successfulRequestRecorded:events.some(e=>e.type==='request.completed'),reportedUsage:events.filter(e=>e.type==='usage').map(e=>e.usage)});
}
const result={scope:'new_offline_failure_diagnostic_examples_only',liveRequests:0,historicalDetailsReconstructed:false,
  historicUnknown:['exact_call_counts','tool_names','finish_reason','missing_usage'],samples};
const text=JSON.stringify(result,null,2)+'\n';
if(text.includes(fixtureKey)||text.includes('untrusted_provider_tool_name')||samples.some(s=>s.successfulRequestRecorded))throw Error('DIAGNOSTIC_SAMPLE_REDACTION_OR_FAILURE_ACCOUNTING');
await writeFile('docs/implementation/task-7r-diagnostic-samples.json',text,{flag:'wx'});
console.log(JSON.stringify({offlineSamples:samples.length,liveRequests:0,allFailedWithoutSuccess:true,reportedUsageOnProtocolFailure:samples[0].reportedUsage[0]?.totalTokens??null,historicUsage:'unknown'}));
