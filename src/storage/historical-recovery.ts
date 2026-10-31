import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute,parse,join,relative,resolve} from 'node:path';
import {z} from 'zod';
import {hashArtifact,sha256Bytes} from '../evidence/hashing.js';
import {deepFreeze} from '../data/records.js';
import {canonicalizeArtifact} from '../contracts/canonical.js';

/** This is one user-authorized infrastructure risk exception, never a cleanup
 * confirmation or a general mechanism for accepting other unknown identities. */
export const HISTORICAL_RECOVERY_SCOPE=Object.freeze({
 runId:'897203e4-d779-4c3e-8696-52ce718d537e',requestId:'fbb7f42d-4112-45b6-a7e8-e3dda1f35f11',permitId:'91c620fb-0ace-4612-b6f7-caea267cfc90',
});
export const HISTORICAL_RECOVERY_FOLDER='historical-recovery';
const risks=z.tuple([z.literal('historical_identity_missing'),z.literal('native_identity_unknown'),z.literal('unknown_descendants')]);
const digest=z.string().regex(/^[a-f0-9]{64}$/),path=z.string().refine(isAbsolute);
const file=z.strictObject({path,sha256:digest});
export const HistoricalRecoveryAuthorizationSchema=z.strictObject({
 policyVersion:z.literal('task7-single-history-risk-v1'),authorizedBy:z.literal('user'),authorizedAt:z.iso.datetime(),storeRoot:path,
 runId:z.literal(HISTORICAL_RECOVERY_SCOPE.runId),requestId:z.literal(HISTORICAL_RECOVERY_SCOPE.requestId),permitId:z.literal(HISTORICAL_RECOVERY_SCOPE.permitId),acceptedRisks:risks,
 originalFiles:z.strictObject({recordSha256:digest,eventsSha256:digest,terminalSha256:digest,result:file,freeze:file}),evidence:file,
});
export type HistoricalRecoveryAuthorization=z.infer<typeof HistoricalRecoveryAuthorizationSchema>;
const resolutionSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('manual_risk_acceptance_resolution'),
 policyVersion:z.literal('task7-single-history-risk-v1'),runId:z.literal(HISTORICAL_RECOVERY_SCOPE.runId),requestId:z.literal(HISTORICAL_RECOVERY_SCOPE.requestId),permitId:z.literal(HISTORICAL_RECOVERY_SCOPE.permitId),
 authorization:HistoricalRecoveryAuthorizationSchema,authorizationHash:digest,evidenceSha256:digest,decidedAt:z.iso.datetime(),
 historicalCleanupConfirmed:z.literal(false),preservedHistoricalStatus:z.literal('failed'),preservedCleanupState:z.literal('unconfirmed'),
 historicalReservationDisposition:z.literal('archived_not_released_in_current_manager'),hash:digest,
});
export type HistoricalRecoveryResolution=z.infer<typeof resolutionSchema>;
export class HistoricalRecoveryError extends Error {constructor(readonly code:string){super(code);this.name='HistoricalRecoveryError';}}
const deny=(code:string):never=>{throw new HistoricalRecoveryError(code);};
function ensure(value:unknown,code:string):asserts value{if(!value)deny(code);}
const same=(a:unknown,b:unknown)=>canonicalizeArtifact(a)===canonicalizeArtifact(b);
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function obj(value:unknown):Record<string,unknown>{ensure(object(value),'RECOVERY_BOUND_CONTENT');return value;}
function array(value:unknown):Record<string,unknown>[]{ensure(Array.isArray(value)&&value.every(object),'RECOVERY_BOUND_CONTENT');return value;}
function time(value:unknown):bigint|null{return typeof value==='string'&&/^\d{17,20}$/.test(value)?BigInt(value):null;}

/** Ordinary bounded files only; no arbitrary worker-controlled paths enter here. */
export async function readRecoveryFile(target:string):Promise<Buffer>{
 ensure(isAbsolute(target),'RECOVERY_PATH');const absolute=resolve(target),root=parse(absolute).root;let current=root;
 for(const piece of relative(root,absolute).split(/[\\/]/).filter(Boolean)){
  current=join(current,piece);const info=await lstat(current);ensure(!info.isSymbolicLink(),'RECOVERY_PATH');
  ensure(current===absolute?info.isFile()&&info.size<=16*1024*1024:info.isDirectory(),'RECOVERY_PATH');
 }
 return readFile(absolute);
}
const decode=(bytes:Buffer)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
function originalGone(observation:Record<string,unknown>,identity:Record<string,unknown>):boolean{
 if(observation.nativeStatus==='absent'&&observation.cimStatus==='absent')return true;
 const actual=time(observation.nativeCreationFileTime),cim=time(observation.cimCreationFileTime),old=time(identity.creationFileTime);
 return observation.nativeStatus==='present'&&observation.cimStatus==='present'&&actual!==null&&cim!==null&&old!==null
  &&(actual>cim?actual-cim:cim-actual)<10n&&actual!==old;
}

/** Recompute exact original-file bytes and validate the complete narrow issue.
 * Freshness is required for a new decision; a durable decision remains a dated
 * accepted observation on restart, while all of its bound bytes are rechecked. */
export async function verifyHistoricalRecoveryAuthorization(value:unknown,root:string,now:number,fresh:boolean):Promise<HistoricalRecoveryAuthorization>{
 const parsed=HistoricalRecoveryAuthorizationSchema.safeParse(value);ensure(parsed.success,'RECOVERY_AUTHORIZATION');const a=deepFreeze(structuredClone(parsed.data));
 ensure(resolve(a.storeRoot)===resolve(root),'RECOVERY_STORE_IDENTITY');
 const runFolder=join(root,a.runId),bound=[
  {path:join(runFolder,'record.json'),sha256:a.originalFiles.recordSha256},
  {path:join(runFolder,'events.jsonl'),sha256:a.originalFiles.eventsSha256},
  {path:join(runFolder,'terminal.json'),sha256:a.originalFiles.terminalSha256},a.originalFiles.result,a.originalFiles.freeze,a.evidence,
 ];
 const bytes:Buffer[]=[];for(const b of bound){const raw=await readRecoveryFile(b.path);ensure(sha256Bytes(raw)===b.sha256,'RECOVERY_HASH_MISMATCH');bytes.push(raw);}
 const record=obj(obj(decode(bytes[0]!)).record),terminal=obj(decode(bytes[2]!)),end=obj(terminal.record),result=obj(decode(bytes[3]!)),freeze=obj(decode(bytes[4]!)),evidence=obj(decode(bytes[5]!));
 ensure(record.runId===a.runId&&end.runId===a.runId&&end.status==='failed'&&end.cleanupState==='unconfirmed'
  &&obj(terminal.outcome).kind==='failed'&&obj(terminal.outcome).runId===a.runId,'RECOVERY_RUN_STATE');
 ensure(result.runId===a.runId&&result.status==='failed'&&same(result.record,end)&&resolve(String(result.storeRoot))===resolve(root),'RECOVERY_RESULT_BINDING');
 const sourceEvents=new TextDecoder('utf-8',{fatal:true}).decode(bytes[1]!).split('\n').filter(Boolean).map(line=>obj(JSON.parse(line)));
 ensure(same(sourceEvents,result.events),'RECOVERY_EVENT_BINDING');
 const grants=sourceEvents.filter(e=>e.type==='permit.granted'),releases=sourceEvents.filter(e=>e.type==='permit.released');
 const unmatched=grants.filter(g=>!releases.some(r=>obj(r.payload).permitId===obj(g.payload).permitId));
 ensure(unmatched.length===1&&unmatched[0]!.runId===a.runId&&obj(unmatched[0]!.payload).requestId===a.requestId&&obj(unmatched[0]!.payload).permitId===a.permitId,'RECOVERY_RESERVATION_BINDING');
 const snapshot=obj(result.permitSnapshot),runReservations=array(snapshot.runs).filter(r=>r.runId===a.runId);
 ensure(snapshot.inFlight===1&&runReservations.length===1&&runReservations[0]!.inFlight===1,'RECOVERY_RESERVATION_BINDING');
 ensure(array(freeze.runs).filter(r=>r.runId===a.runId).length===1,'RECOVERY_FREEZE_BINDING');
 const ended=array(obj(result.requests).intervals).filter(i=>i.requestId===a.requestId&&i.permitId===a.permitId);
 ensure(ended.length===1&&ended[0]!.completion==='failed'&&typeof ended[0]!.endedAt==='string','RECOVERY_REQUEST_NOT_ENDED');
 ensure(evidence.scope==='append_only_read_only_historical_recovery_evidence_not_recovery_authorization'&&resolve(String(evidence.storeRoot))===resolve(root)
  &&evidence.originalHoldPreserved===true&&evidence.originalPermitSnapshotPreserved===true&&evidence.recoveryExecuted===false
  &&evidence.processesTerminated===0&&evidence.storesCreated===0&&evidence.modelRequests===0,'RECOVERY_EVIDENCE_SCOPE');
 const assessments=array(evidence.assessments);ensure(assessments.length===1,'RECOVERY_ADDITIONAL_ISSUE');const issue=assessments[0]!;
 ensure(issue.runId===a.runId&&issue.originalCleanupState==='unconfirmed'&&issue.heldReservations===1
  &&issue.resultSha256===a.originalFiles.result.sha256&&issue.terminalSha256===a.originalFiles.terminalSha256
  &&resolve(String(issue.resultPath))===resolve(a.originalFiles.result.path)&&resolve(String(issue.terminalPath))===resolve(bound[2]!.path),'RECOVERY_EVIDENCE_BINDING');
 const unmatchedEvidence=array(issue.unmatchedPermits);ensure(unmatchedEvidence.length===1&&unmatchedEvidence[0]!.requestId===a.requestId&&unmatchedEvidence[0]!.permitId===a.permitId,'RECOVERY_EVIDENCE_BINDING');
 const diagnostic=obj(issue.diagnostic),assessment=obj(issue.assessment),rootIdentity=obj(issue.rootIdentity),children=array(issue.knownDescendants);
 ensure(diagnostic.pid===30656&&diagnostic.stage==='native_identity'&&diagnostic.code==='DESCENDANT_IDENTITY_UNCONFIRMED'
  &&assessment.pid===30656&&assessment.originalIdentityMissing===true&&assessment.birthConflict===false&&assessment.automaticRecoveryAllowed===false
  &&assessment.historicalCleanupState==='unconfirmed','RECOVERY_EVIDENCE_BINDING');
 const unconfirmed=array(result.cleanups).filter(c=>c.confirmed===false);ensure(unconfirmed.length===1,'RECOVERY_ADDITIONAL_ISSUE');
 const cleanup=unconfirmed[0]!,scans=array(cleanup.scanDiagnostics);
 ensure(same(cleanup.identity,rootIdentity)&&same(cleanup.descendants,children)&&scans.length===1&&same(scans[0],diagnostic),'RECOVERY_EVIDENCE_BINDING');
 const observations=array(evidence.observations),expectedIdentities=[rootIdentity,...children.map(c=>obj(c.identity))];
 ensure(observations.length===expectedIdentities.length+1&&new Set(observations.map(o=>o.pid)).size===observations.length,'RECOVERY_ADDITIONAL_ISSUE');
 for(const identity of expectedIdentities){const current=observations.find(o=>o.pid===identity.pid);ensure(current&&originalGone(current,identity),'RECOVERY_REGISTERED_IDENTITY_UNCONFIRMED');}
 const current=observations.find(o=>o.pid===30656);ensure(current&&same(current,issue.currentObservation),'RECOVERY_EVIDENCE_BINDING');
 const parentBirth=time(rootIdentity.creationFileTime),cimBirth=time(current.cimCreationFileTime),nativeBirth=time(current.nativeCreationFileTime);
 ensure(current.cimStatus==='present'&&current.parentPid===rootIdentity.pid&&parentBirth!==null&&cimBirth!==null&&cimBirth+9n<parentBirth,'RECOVERY_CHRONOLOGY_CONFLICT');
 if(current.nativeStatus==='unknown')ensure(current.nativeErrorCode===5&&nativeBirth===null&&assessment.nativeIdentityUnknown===true&&assessment.currentAssociation==='excluded_by_cim_birth_current_only','RECOVERY_NATIVE_CONFLICT');
 else ensure(current.nativeStatus==='present'&&nativeBirth!==null&&(nativeBirth>cimBirth?nativeBirth-cimBirth:cimBirth-nativeBirth)<10n
  &&nativeBirth+9n<parentBirth&&assessment.currentAssociation==='excluded_by_consistent_birth'&&assessment.nativeIdentityUnknown===false,'RECOVERY_NATIVE_CONFLICT');
 const observed=Date.parse(String(evidence.observedAt)),authorized=Date.parse(a.authorizedAt);
 ensure(Number.isFinite(observed)&&Number.isFinite(authorized)&&authorized<=now+2000,'RECOVERY_OBSERVATION_TIME');
 if(fresh)ensure(observed<=now+2000&&now-observed<=300000,'RECOVERY_STALE_EVIDENCE');
 return a;
}

export function createHistoricalRecoveryResolution(a:HistoricalRecoveryAuthorization,now:number):HistoricalRecoveryResolution{
 const value={schemaVersion:1 as const,kind:'manual_risk_acceptance_resolution' as const,policyVersion:a.policyVersion,runId:a.runId,requestId:a.requestId,permitId:a.permitId,
  authorization:a,authorizationHash:hashArtifact(a),evidenceSha256:a.evidence.sha256,decidedAt:new Date(now).toISOString(),historicalCleanupConfirmed:false as const,
  preservedHistoricalStatus:'failed' as const,preservedCleanupState:'unconfirmed' as const,historicalReservationDisposition:'archived_not_released_in_current_manager' as const};
 return deepFreeze({...value,hash:hashArtifact(value)});
}
export function verifyHistoricalRecoveryResolution(value:unknown,a:HistoricalRecoveryAuthorization):HistoricalRecoveryResolution{
 const parsed=resolutionSchema.safeParse(value);ensure(parsed.success,'RECOVERY_INVALID_RESOLUTION');const {hash,...body}=parsed.data;
 ensure(hashArtifact(body)===hash&&same(body.authorization,a)&&body.authorizationHash===hashArtifact(a)&&body.evidenceSha256===a.evidence.sha256,'RECOVERY_RESOLUTION_BINDING');
 return deepFreeze(structuredClone(parsed.data));
}
