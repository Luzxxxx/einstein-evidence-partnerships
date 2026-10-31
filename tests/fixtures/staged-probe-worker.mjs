// Explicit offline_fixture: actual SDK, native source tools, real worker IPC,
// controlled fetch only. This entry cannot select a provider/model/credential.
import {writeFileSync} from 'node:fs';
import {startWorker} from '../../dist/server/runtime/worker-entry.js';
import {createStagedHarness,sha} from './staged-probe-harness.mjs';

const arg=name=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw Error('OFFLINE_FIXTURE_ARGUMENT_REQUIRED');return process.argv[i+1];};
const mode=arg('--mode'),evidencePath=arg('--evidence-path');
if(!['reverse','second_tools'].includes(mode))throw Error('OFFLINE_FIXTURE_MODE_INVALID');
globalThis.fetch=async()=>{throw Error('OFFLINE_FIXTURE_NETWORK_FORBIDDEN');};
let harness;
// This one temporary test snapshot is mutable while its owned worker runs.
// The parent captures final bytes into a new wx audit after actual cleanup.
// Source content, credentials, headers and full provider bodies are omitted.
const persist=()=>{
 if(!harness)return;
 const value={runnerMode:'offline_fixture',transientFixtureSnapshot:true,providerRequests:0,transport:'controlled_fake_fetch',mode,
  expected:harness.expected,http:harness.http.map(h=>({actor:h.actor,requestId:h.requestId,permitId:h.permitId,stage:h.stage,
   bodySha256:sha(h.rawBody),toolNames:h.body.tools?.map(t=>t.function.name)??[],toolChoice:h.body.tool_choice??null})),
  records:harness.records,diagnostics:harness.diagnostics};
 if(Buffer.byteLength(JSON.stringify(value))>6*1024*1024)throw Error('OFFLINE_FIXTURE_SNAPSHOT_LIMIT');
 writeFileSync(evidencePath,JSON.stringify(value,null,2)+'\n');
};
startWorker({async configure({start,signal,permitClient}){
 harness=await createStagedHarness({input:start.runInput,snapshotPath:start.snapshotPath,signal,permitClient,
  reverse:mode==='reverse',...(mode==='second_tools'?{fault:'second_tools'}:{}),recordSink:persist,diagnosticSink:persist});
 persist();return harness.execution;
}});
