// Freeze metadata and one fresh read-only OS observation. Never opens the store,
// runs a worker/model, removes a lock, or executes the recovery decision.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {collectBoundedProductFingerprints,validateBoundedPlan} from '../dist/server/evaluation/bounded-validation.js';
import {HistoricalRecoveryAuthorizationSchema,verifyHistoricalRecoveryAuthorization,HISTORICAL_RECOVERY_SCOPE} from '../dist/server/storage/historical-recovery.js';
import {protocolProbePromptHashes} from '../dist/server/evaluation/protocol-probe.js';
import {auditHistoricalRecovery} from './audit-task7r-historical-recovery.mjs';
import {loadSnapshot} from '../dist/server/data/snapshot.js';
import {buildIndex,retrieveWithTrace} from '../dist/server/retrieval/index.js';
import {buildCriticCase} from '../dist/server/evaluation/critic-cases.js';
import {hashArtifact,sha256Bytes} from '../dist/server/evidence/hashing.js';
import {canonicalizeArtifact} from '../dist/server/contracts/canonical.js';
import {DATASET_COMMIT} from '../dist/server/contracts/primitives.js';
import {PROPOSER_INSTRUCTION} from '../dist/server/runtime/agents/proposer.js';
import {COUNTER_INSTRUCTION} from '../dist/server/runtime/agents/counter-evidence.js';
import {CRITIC_INSTRUCTION} from '../dist/server/runtime/agents/critic.js';
import {SINGLE_TOOL_CALL_POLICY,CONTROLLED_PROPOSER_REPRODUCTION_POLICY} from '../dist/server/runtime/task-context.js';
const j=async p=>JSON.parse(await readFile(p,'utf8'));
const shaFile=async p=>sha256Bytes(await readFile(p));
const shaText=s=>sha256Bytes(Buffer.from(s,'utf8'));
function ensure(v,code){if(!v)throw Error(code);}
const baseline=await j('docs/implementation/task-7s-baseline.json');
const gateFile='docs/implementation/task-7s-pre-live-gate.json',gate=await j(gateFile);
const fingerprints=await collectBoundedProductFingerprints();
ensure(gate.task==='Task7s'&&gate.engineeringVerified===true&&gate.independentReviewPassed===true
 &&canonicalizeArtifact(gate.productFingerprints)===canonicalizeArtifact(fingerprints),'BOUNDED_GATE_NOT_VERIFIED');
const oldFreeze=await j('docs/implementation/task-7-live/freeze.json');
const baseURL=process.env.EINSTEIN_GATEWAY_BASE_URL,model=process.env.EINSTEIN_GATEWAY_MODEL,credential=process.env.EINSTEIN_GATEWAY_API_KEY;
ensure(credential&&baseURL===oldFreeze.gatewayBaseURL&&model===oldFreeze.model,'BOUNDED_EXISTING_CONFIGURATION_REQUIRED');
ensure(!baseURL.includes(credential)&&!model.includes(credential),'BOUNDED_CREDENTIAL_IN_PUBLIC_CONFIG');
const url=new URL(baseURL);ensure(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash,'BOUNDED_GATEWAY_CONFIGURATION');
for(const f of [...baseline.historicalLive,...baseline.historicalStore.files,...baseline.protectedUntrackedJson])
 ensure(await shaFile(f.file)===f.sha256,'BOUNDED_PROTECTED_CHANGED');
// This exclusive directory is never reused, even when preparation or a later run fails.
const folder=resolve('docs/implementation/task-7s-live');await mkdir(folder);await mkdir(join(folder,'runs'));
await auditHistoricalRecovery('task-7r-recovery-evidence-v2.json');
const storeRoot=baseline.historicalStore.root,runId=HISTORICAL_RECOVERY_SCOPE.runId;
const resultPath=resolve('docs/implementation/task-7-live/runs',runId,'result.json'),freezePath=resolve('docs/implementation/task-7-live/freeze.json');
const evidencePath=resolve('docs/implementation/task-7r-recovery-evidence-v2.json');
const authorization=HistoricalRecoveryAuthorizationSchema.parse({policyVersion:'task7-single-history-risk-v1',authorizedBy:'user',
 authorizedAt:new Date().toISOString(),storeRoot,...HISTORICAL_RECOVERY_SCOPE,
 acceptedRisks:['historical_identity_missing','native_identity_unknown','unknown_descendants'],
 originalFiles:{recordSha256:await shaFile(join(storeRoot,runId,'record.json')),eventsSha256:await shaFile(join(storeRoot,runId,'events.jsonl')),
  terminalSha256:await shaFile(join(storeRoot,runId,'terminal.json')),result:{path:resultPath,sha256:await shaFile(resultPath)},freeze:{path:freezePath,sha256:await shaFile(freezePath)}},
 evidence:{path:evidencePath,sha256:await shaFile(evidencePath)}});
await verifyHistoricalRecoveryAuthorization(authorization,storeRoot,Date.now(),true);
const authorizationPath='docs/implementation/task-7s-authorization.json';
await writeFile(authorizationPath,JSON.stringify(authorization,null,2)+'\n',{flag:'wx'});
const probeId=randomUUID(),l05Id=randomUUID(),snapshot=await loadSnapshot(resolve('reference/einstein-matchmaker-data'),DATASET_COMMIT);
const probeInput={runId:probeId,companyId:'C001',challengeId:'C001-CH1',datasetCommit:DATASET_COMMIT,
 promptVersion:'task7s-protocol-v1',configVersion:'task7s-bounded-v1',mode:'adversarial'};
const research=retrieveWithTrace(probeInput,buildIndex(snapshot));ensure(research.pool.candidates.length>0,'BOUNDED_PROBE_POOL_EMPTY');
const sample=buildCriticCase(snapshot,'L05',l05Id);
const promptHashes={proposer:shaText(PROPOSER_INSTRUCTION),counter:shaText(COUNTER_INSTRUCTION),critic:shaText(CRITIC_INSTRUCTION),
 singleToolCallPolicy:shaText(SINGLE_TOOL_CALL_POLICY),controlledProposerReproductionPolicy:shaText(CONTROLLED_PROPOSER_REPRODUCTION_POLICY),
 effectiveProposer:shaText(PROPOSER_INSTRUCTION+'\n'+SINGLE_TOOL_CALL_POLICY),
 effectiveControlledProposer:shaText(PROPOSER_INSTRUCTION+'\n'+SINGLE_TOOL_CALL_POLICY+'\n'+CONTROLLED_PROPOSER_REPRODUCTION_POLICY),
 effectiveCounter:shaText(COUNTER_INSTRUCTION+'\n'+SINGLE_TOOL_CALL_POLICY),effectiveCritic:shaText(CRITIC_INSTRUCTION+'\n'+SINGLE_TOOL_CALL_POLICY)};
const content={schemaVersion:1,scope:'task7s_bounded_protocol_then_single_L05',createdAt:new Date().toISOString(),
 model,gatewayBaseURL:baseURL,probe:{runId:probeId,input:probeInput,researcherId:research.pool.candidates[0].researcherId,
  promptHashes:protocolProbePromptHashes(),poolHash:research.pool.poolHash},
 l05:{runId:l05Id,input:sample.input,variantId:'L05',manifest:sample.manifest},
 limits:{probeRequests:4,l05Requests:16,totalRequests:20,requestTimeoutMs:40000,runTimeoutMs:180000,maxConcurrentModelRequests:2},
 automaticRetry:false,showcaseEligible:false,promptHashes,productFingerprints:fingerprints,sourceFiles:snapshot.files,
 recoveryAuthorization:authorization,authorizationFileSha256:await shaFile(authorizationPath),engineeringGate:{file:gateFile,sha256:await shaFile(gateFile)}};
const freeze=validateBoundedPlan({...content,hash:hashArtifact(content)});
await writeFile(join(folder,'freeze.json'),JSON.stringify(freeze,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({scope:freeze.scope,probeRunId:probeId,l05RunId:l05Id,maxGrantedRequests:20,storeRoot,
 sourceFiles:8,latestEvidenceSha256:authorization.evidence.sha256,recoveryExecuted:false,modelRequests:0,freezeHash:freeze.hash}));
