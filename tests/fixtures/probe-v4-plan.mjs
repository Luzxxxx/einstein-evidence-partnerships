// Controlled offline-only freeze material. No Store, model, live attempt,
// worker or recovery action is created by this fixture builder.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {input as inputFixture} from './contracts.mjs';
import {v4Research,sha} from './probe-v4-harness.mjs';
import {hashArtifact,hashRunInput,hashEvidenceSnapshot,sha256Bytes} from '../../dist/server/evidence/hashing.js';
import {createResearchTools} from '../../dist/server/runtime/tools.js';
import {PROTOCOL_PROBE_V3_INSTRUCTION} from '../../dist/server/evaluation/probe-contract-guard.js';
import {PROTOCOL_PROBE_V4_CONTRACT,protocolProbeV4ToolDefinitions} from '../../dist/server/evaluation/protocol-probe-v4.js';
import {validateV4Plan,collectV4ProductFingerprints,V4_SCOPE,V4_WORKER_PATH,V4_GENERIC_DISPATCH} from '../../dist/server/evaluation/protocol-probe-v4-plan.js';

export async function buildV4PlanFixture(runId=randomUUID()){
 const input={...inputFixture(),runId,mode:'adversarial',promptVersion:'task7x-protocol-v4',configVersion:'task7x-bounded-v4'},research=await v4Research(input);
 const baselineBytes=await readFile('docs/implementation/task-7x-baseline.json'),baseline=JSON.parse(baselineBytes),old=JSON.parse(await readFile('docs/implementation/task-7v-live/freeze.json','utf8'));
 const productFingerprints=await collectV4ProductFingerprints(),userTask={runId,companyId:input.companyId,challengeId:input.challengeId,researcherId:research.pool.candidates[0].researcherId};
 const tools=createResearchTools({...research,input,signal:new AbortController().signal}),file='docs/superpowers/specs/2026-10-30-interface-contracts.md',text=await readFile(file,'utf8');
 const content={scope:V4_SCOPE,schemaVersion:4,createdAt:new Date().toISOString(),model:'offline_fixture',gatewayBaseURL:'https://offline.invalid/v1',workerPath:V4_WORKER_PATH,
  probe:{runId,input,inputHash:hashRunInput(input),researcherId:userTask.researcherId,contractVersion:'protocol-probe-v4-staged',contract:PROTOCOL_PROBE_V4_CONTRACT,contractSha256:hashArtifact(PROTOCOL_PROBE_V4_CONTRACT),
   effectiveInstructionText:PROTOCOL_PROBE_V3_INSTRUCTION,effectiveInstructionSha256:sha(PROTOCOL_PROBE_V3_INSTRUCTION),userTask,pool:research.pool,poolHash:research.pool.poolHash,evidenceSnapshotHash:hashEvidenceSnapshot(research.evidence),toolDefinitions:protocolProbeV4ToolDefinitions(tools)},
  sourceFiles:research.snapshot.files,sourceIntegrity:baseline.officialSources.map(f=>({file:f.datasetRelative,bytes:f.bytes,expectedSha256:f.sha256,actualSha256:f.sha256,unchanged:true})),
  limits:{probeRequests:4,perContextRequests:2,totalRequests:4,requestTimeoutMs:40000,runTimeoutMs:180000,maxConcurrentModelRequests:2,maxActiveRuns:1,maxQueuedRuns:3,queueTimeoutMs:120000},automaticRetry:false,showcaseEligible:false,
  baseline:{file:'docs/implementation/task-7x-baseline.json',sha256:sha256Bytes(baselineBytes),storeRoot:baseline.historicalStore.root},
  promptContract:{version:'task7x-effective-v4',probeInstruction:PROTOCOL_PROBE_V3_INSTRUCTION,probeInstructionSha256:sha(PROTOCOL_PROBE_V3_INSTRUCTION),genericDispatchText:V4_GENERIC_DISPATCH,genericDispatchSha256:sha(V4_GENERIC_DISPATCH),interfaceContract:{file,text,sha256:sha(text)}},
  productFingerprints,approvedRuntimeChanges:await Promise.all(['src/supervisor/permits.ts','dist/server/supervisor/permits.js'].map(async file=>({file,beforeSha256:baseline.oldRuntime.find(r=>r.file===file).sha256,afterSha256:sha256Bytes(await readFile(resolve(file)))}))),
  engineeringSourceCommit:baseline.head,existingAuthorization:old.existingAuthorization,authorizationFileSha256:old.authorizationFileSha256,resolutionFileSha256:old.resolutionFileSha256,
  engineeringGate:{file:'docs/implementation/task-7x-pre-live-gate.json',sha256:'0'.repeat(64)}};
 return validateV4Plan({...content,hash:hashArtifact(content)});
}
