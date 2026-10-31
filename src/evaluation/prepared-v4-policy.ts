/** One user-authorized Task7y execution capability; import performs no I/O. */
import {z} from 'zod';import {HashSchema} from '../contracts/primitives.js';
import {resolve} from 'node:path';import {readEngineeringFile} from './engineering-files.js';import {sha256Bytes} from '../evidence/hashing.js';
import {canonicalizeArtifact} from '../contracts/canonical.js';
export const TASK7Y_AUTHORIZATION_ID='63cce149-3089-4551-8733-5beaa7bf961b';
export const TASK7Y_CANDIDATE_ROOT='docs/implementation/task-7y-live/candidates';
export const TASK7Y_ATTEMPT_FILE='docs/implementation/task-7y-live/attempt.json';
export const TASK7Y_POLICY_V1_FILE='docs/implementation/task-7y-authorization.json';
export const TASK7Y_POLICY_V2_FILE='docs/implementation/task-7y-authorization-v2.json';
const ORIGINAL_POLICY_SHA256='cc2a2f515d2a48be09e22e6463de9ac4307c84b291badc75d4155cf8f3a2ecd6';
const CLEANUP_EVIDENCE_FILE='docs/implementation/task-7x-v4-worker-evidence-forward-1793436712982-3d45253e-4dfd-49fc-9aac-c6fbb350d6e4.json';
const CLEANUP_EVIDENCE_SHA256='96c8758d76855a348e0e00f78618890bc3d153e41659fc11ac16565f6616ab4d';
export const TASK7Y_APPROVED_RUNTIME_PATHS=[
 'src/evaluation/protocol-probe-v4-plan.ts','dist/server/evaluation/protocol-probe-v4-plan.js',
 'src/evaluation/protocol-probe-worker-v4.ts','dist/server/evaluation/protocol-probe-worker-v4.js',
 'src/evaluation/v4-bounded-validation.ts','dist/server/evaluation/v4-bounded-validation.js'] as const;
export const TASK7Y_APPROVED_RUNTIME_PATHS_V2=[...TASK7Y_APPROVED_RUNTIME_PATHS,'src/evaluation/protocol-probe-v4-gate.ts','dist/server/evaluation/protocol-probe-v4-gate.js'] as const;
const common={schemaVersion:z.literal(1),task:z.literal('Task7y'),
 authorizationId:z.literal(TASK7Y_AUTHORIZATION_ID),baselineFile:z.literal('docs/implementation/task-7y-baseline.json'),baselineSha256:HashSchema,
 baselineHead:z.literal('11ff1e460cff9749c3da458679b742136f021a75'),candidateRoot:z.literal(TASK7Y_CANDIDATE_ROOT),globalAttemptFile:z.literal(TASK7Y_ATTEMPT_FILE),storeRoot:z.string().min(1),
 otherPermittedTrackedChanges:z.tuple([z.literal('scripts/verify-task7-processes.mjs'),z.literal('.planning/.active_plan')]),
 protocolVersion:z.literal('protocol-probe-v4-staged'),protocolContractSha256:HashSchema,
 limits:z.strictObject({runs:z.literal(1),maxGrantedRequests:z.literal(4),perContextRequests:z.literal(2),maxConcurrentRequests:z.literal(2),requestTimeoutMs:z.literal(40000),runTimeoutMs:z.literal(180000)}),
 automaticRetry:z.literal(false),preparationMayRepeatBeforeGlobalAttempt:z.literal(true),executionMayRepeat:z.literal(false),L05Authorized:z.literal(false),batchAuthorized:z.literal(false),Task8Authorized:z.literal(false),
 recoveryApplyAuthorized:z.literal(false),newRiskExceptionsAuthorized:z.literal(false),globalAttemptConsumesAuthorizationEvenIfNoHTTP:z.literal(true)};
const V1=z.strictObject({...common,policyVersion:z.literal('task7y-user-2026-10-31-v1'),
 approvedRuntimeChanges:z.array(z.strictObject({file:z.enum(TASK7Y_APPROVED_RUNTIME_PATHS),beforeSha256:HashSchema})).length(6).refine(rows=>new Set(rows.map(r=>r.file)).size===6)});
const V2=z.strictObject({...common,policyVersion:z.literal('task7y-user-2026-10-31-v2'),
 approvedRuntimeChanges:z.array(z.strictObject({file:z.enum(TASK7Y_APPROVED_RUNTIME_PATHS_V2),beforeSha256:HashSchema})).length(8).refine(rows=>new Set(rows.map(r=>r.file)).size===8),
 supersedes:z.strictObject({file:z.literal(TASK7Y_POLICY_V1_FILE),sha256:z.literal(ORIGINAL_POLICY_SHA256)}),
 scopeExtension:z.strictObject({kind:z.literal('cleanup_verification_enum_contract'),evidence:z.strictObject({file:z.literal(CLEANUP_EVIDENCE_FILE),sha256:z.literal(CLEANUP_EVIDENCE_SHA256)}),userApproved:z.literal(true)})});
export const Task7yAuthorizationSchema=z.discriminatedUnion('policyVersion',[V1,V2]);
export class Task7yPolicyError extends Error{constructor(readonly code:string){super(code);}}
function require(value:unknown,code:string):asserts value{if(!value)throw new Task7yPolicyError(code);}
type Metadata={authorizationFile:string;authorizationFileSha256:string;authorizationId:string;baselineFile?:string;baselineSha256?:string;globalAttemptFile?:string};
/** Read-only raw policy chain, never a new capability or recovery application. */
export async function verifyTask7yAuthorizationFile(project:string,meta:Metadata,options:{runnerMode?:'live'|'offline_fixture'}={}){
 const mode=options.runnerMode===undefined?'live':options.runnerMode;require(mode==='live'||mode==='offline_fixture','TASK7Y_POLICY_FILE_INVALID');
 require(meta&&[TASK7Y_POLICY_V1_FILE,TASK7Y_POLICY_V2_FILE].includes(meta.authorizationFile),'TASK7Y_POLICY_FILE_INVALID');
 const raw=await readEngineeringFile(resolve(project),resolve(project,meta.authorizationFile),1024*1024);
 require(sha256Bytes(raw)===meta.authorizationFileSha256,'TASK7Y_POLICY_BINDING');
 let value:unknown;try{value=JSON.parse(raw.toString('utf8'));}catch{throw new Task7yPolicyError('TASK7Y_POLICY_FILE_INVALID');}
 const parsed=Task7yAuthorizationSchema.safeParse(value);require(parsed.success,'TASK7Y_POLICY_FILE_INVALID');const a=parsed.data;
 require(a.authorizationId===meta.authorizationId&&(meta.baselineFile===undefined||a.baselineFile===meta.baselineFile)
  &&(meta.baselineSha256===undefined||a.baselineSha256===meta.baselineSha256)&&(meta.globalAttemptFile===undefined||a.globalAttemptFile===meta.globalAttemptFile),'TASK7Y_POLICY_BINDING');
 if(a.policyVersion==='task7y-user-2026-10-31-v2'){
  require(meta.authorizationFile===TASK7Y_POLICY_V2_FILE,'TASK7Y_POLICY_FILE_INVALID');
  const originalRaw=await readEngineeringFile(resolve(project),resolve(project,a.supersedes.file),1024*1024);
  require(sha256Bytes(originalRaw)===a.supersedes.sha256,'TASK7Y_POLICY_SUPERSEDES');
  let originalValue:unknown;try{originalValue=JSON.parse(originalRaw.toString('utf8'));}catch{throw new Task7yPolicyError('TASK7Y_POLICY_SUPERSEDES');}
  const previous=V1.safeParse(originalValue);require(previous.success&&previous.data.authorizationId===a.authorizationId
   &&previous.data.globalAttemptFile===a.globalAttemptFile&&previous.data.baselineSha256===a.baselineSha256&&previous.data.storeRoot===a.storeRoot,'TASK7Y_POLICY_SUPERSEDES');
  const{policyVersion:_v1,approvedRuntimeChanges:originalChanges,...originalFields}=previous.data;
  const{policyVersion:_v2,approvedRuntimeChanges:expandedChanges,supersedes:_supersedes,scopeExtension:_extension,...expandedFields}=a;
  require(canonicalizeArtifact(originalFields)===canonicalizeArtifact(expandedFields)
   &&canonicalizeArtifact(originalChanges)===canonicalizeArtifact(expandedChanges.slice(0,6))
   &&expandedChanges[6]?.file==='src/evaluation/protocol-probe-v4-gate.ts'
   &&expandedChanges[7]?.file==='dist/server/evaluation/protocol-probe-v4-gate.js','TASK7Y_POLICY_SUPERSEDES');
  const evidence=await readEngineeringFile(resolve(project),resolve(project,a.scopeExtension.evidence.file),1024*1024);
  require(sha256Bytes(evidence)===a.scopeExtension.evidence.sha256,'TASK7Y_POLICY_EVIDENCE');
 }else{require(meta.authorizationFile===TASK7Y_POLICY_V1_FILE,'TASK7Y_POLICY_FILE_INVALID');
  // Isolated fixtures can declare a copied Store/baseline, never live readiness.
  require(mode==='offline_fixture'||sha256Bytes(raw)===ORIGINAL_POLICY_SHA256,'TASK7Y_POLICY_BINDING');}
 return a;
}
