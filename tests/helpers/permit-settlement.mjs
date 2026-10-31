// Test-only, pure evidence checker. It never releases a permit, opens a Store,
// clears a hold or authorizes admission. Cleanup evidence remains restricted to
// registered original identities; it provides no unknown-orphan guarantee.
import {win32} from 'node:path';
import {StoredEventSchema} from '../../dist/server/contracts/events.js';
import {RunRecordSchema,RunOutcomeSchema} from '../../dist/server/contracts/domain.js';
import {hashRunInput} from '../../dist/server/evidence/hashing.js';
import {canonicalizeArtifact} from '../../dist/server/contracts/canonical.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid=v=>typeof v==='string'&&uuid.test(v),integer=v=>Number.isSafeInteger(v)&&v>=0;
const terminals=new Set(['approved','failed','cancelled','insufficient']);
const same=(a,b)=>canonicalizeArtifact(a)===canonicalizeArtifact(b);
function identity(value){
 return Boolean(value&&Number.isSafeInteger(value.pid)&&value.pid>0&&Number.isSafeInteger(value.parentPid)&&value.parentPid>0
  &&typeof value.creationFileTime==='string'&&/^\d{17,20}$/.test(value.creationFileTime)
  &&typeof value.executablePath==='string'&&win32.isAbsolute(value.executablePath)
  &&typeof value.commandLine==='string'&&value.commandLine.length>0);
}
export function verifyPermitSettlement(input){
 const reasons=[],add=code=>{if(!reasons.includes(code))reasons.push(code);};
 const runId=input?.runId,events=Array.isArray(input?.events)?input.events:[],record=input?.record,snapshot=input?.snapshot,cleanup=input?.cleanup;
 if(!isUuid(runId))add('RUN_ID_INVALID');
 if(!Array.isArray(input?.events)||!events.length) add('PARENT_EVENTS_MISSING');
 for(let index=0;index<events.length;index++){
  const event=events[index];
  if(!StoredEventSchema.safeParse(event).success)add('PARENT_EVENT_INVALID');
  if(event?.runId!==runId)add('EVENT_RUN_MISMATCH');
  if(event?.seq!==index+1)add('EVENT_SEQUENCE_INVALID');
 }
 const parsedRecord=RunRecordSchema.safeParse(record);
 if(!parsedRecord.success)add('PARENT_RECORD_INVALID');
 else{
  if(record.runId!==runId||record.input.runId!==runId||record.inputHash!==hashRunInput(record.input))add('PARENT_RECORD_BINDING_INVALID');
  if(!terminals.has(record.status))add('PARENT_NOT_TERMINAL');
  if(record.lastSeq!==events.length)add('PARENT_RECORD_SEQUENCE_INVALID');
 }
 const statusEvents=events.filter(e=>e.type==='run.status'&&terminals.has(e.payload?.status));
 const finalStatus=statusEvents[0];
 if(statusEvents.length!==1||finalStatus?.payload.status!==record?.status)add('PARENT_TERMINAL_EVENT_INVALID');
 if(finalStatus&&events.some(e=>e.seq>finalStatus.seq&&e.type!=='event.ignored'))add('WORK_AFTER_TERMINAL');
 if(input?.terminal!==undefined){
  const terminal=input.terminal,tRecord=terminal?.record,outcome=terminal?.outcome;
  const validCount=integer(terminal?.eventCount)&&terminal.eventCount<=events.length;
  let agrees=terminal?.schemaVersion===1&&RunRecordSchema.safeParse(tRecord).success&&RunOutcomeSchema.safeParse(outcome).success
   &&validCount&&tRecord.lastSeq===terminal.eventCount&&outcome.runId===runId
   &&(record?.status==='approved'?outcome.kind==='reviewed':outcome.kind===record?.status);
  if(agrees){
   for(const key of ['runId','inputHash','runnerMode','status','cleanupState','createdAt','admittedAt','deadlineAt','revisionCount'])
    if((tRecord[key]??null)!==(record[key]??null))agrees=false;
   if(!same(tRecord.input,record.input)||!finalStatus||finalStatus.seq>terminal.eventCount
    ||events.some(e=>e.seq>terminal.eventCount&&e.type!=='event.ignored'))agrees=false;
  }
  if(!agrees)add('PARENT_TERMINAL_ENVELOPE_INVALID');
 }
 const grants=events.filter(e=>e.type==='permit.granted'),releases=events.filter(e=>e.type==='permit.released');
 const byPermit=new Map(),byRequest=new Map(),invalidPermits=new Set();
 for(const grant of grants){
  const p=grant.payload??{},priorPermit=byPermit.get(p.permitId),priorRequest=byRequest.get(p.requestId);
  if(grant.source!=='supervisor'||grant.runId!==runId||!isUuid(p.permitId)||!isUuid(p.requestId))add('GRANT_BINDING_INVALID');
  if(priorPermit){add('DUPLICATE_GRANT_PERMIT');invalidPermits.add(p.permitId);}else byPermit.set(p.permitId,grant);
  if(priorRequest){add('DUPLICATE_GRANT_REQUEST');invalidPermits.add(priorRequest.payload.permitId);invalidPermits.add(p.permitId);}else byRequest.set(p.requestId,grant);
 }
 const releaseGroups=new Map();
 for(const release of releases){
  const p=release.payload??{},grant=byPermit.get(p.permitId),group=releaseGroups.get(p.permitId)??[];
  group.push(release);releaseGroups.set(p.permitId,group);
  if(group.length>1){add('DUPLICATE_RELEASE');invalidPermits.add(p.permitId);}
  if(release.source!=='supervisor'||release.runId!==runId||!grant||!isUuid(p.permitId)){add('RELEASE_BINDING_INVALID');invalidPermits.add(p.permitId);}
  if(grant&&(p.requestId!==undefined&&p.requestId!==grant.payload.requestId)){add('RELEASE_REQUEST_MISMATCH');invalidPermits.add(p.permitId);}
  if(grant&&(release.seq<=grant.seq||finalStatus&&release.seq>=finalStatus.seq)){add('RELEASE_ORDER_INVALID');invalidPermits.add(p.permitId);}
 }
 for(const event of events.filter(e=>['model.request.started','model.request.completed','model.request.failed'].includes(e.type))){
  const p=event.payload??{},grant=byPermit.get(p.permitId);
  if(!grant||grant.payload.requestId!==p.requestId||event.runId!==runId||event.seq<=grant.seq)add('MODEL_REQUEST_GRANT_MISMATCH');
 }
 const allRuns=Array.isArray(snapshot?.runs)?snapshot.runs:[],runRows=allRuns.filter(r=>r.runId===runId),run=runRows[0];
 if(!integer(snapshot?.inFlight)||!Array.isArray(snapshot?.runs)||new Set(allRuns.map(r=>r.runId)).size!==allRuns.length
  ||!allRuns.every(r=>isUuid(r.runId)&&integer(r.inFlight)&&integer(r.pending)&&integer(r.attempts))
  ||snapshot.inFlight!==allRuns.reduce((n,r)=>n+r.inFlight,0)||runRows.length!==1)add('PERMIT_SNAPSHOT_BINDING_INVALID');
 if(!run||run.attempts!==grants.length||run.attempts!==byPermit.size)add('ATTEMPT_COUNT_MISMATCH');

 const cleanupReasons=[],cleanNeed=(value,code)=>{if(!value&&!cleanupReasons.includes(code))cleanupReasons.push(code);};
 cleanNeed(input?.safetyHold===false,'SAFETY_HOLD_NOT_CLEARED');
 const root=cleanup?.identity,exit=cleanup?.exit;
 cleanNeed(cleanup?.runId===runId&&cleanup?.confirmed===true
  &&cleanup.scope==='registered_identities_only_no_job_object'&&cleanup.unobservedDescendantsNotGuaranteed===true,'CLEANUP_NOT_CONFIRMED');
 cleanNeed(identity(root),'ROOT_IDENTITY_INCOMPLETE');
 cleanNeed(['absent','mismatch'].includes(cleanup?.rootVerification),'ROOT_IDENTITY_NOT_GONE');
 const commandRun=root?.commandLine?.match(/(?:^|[\s"])--supervisor-run-id"?\s+"?([0-9a-f-]{36})(?:[\s"]|$)/i)?.[1];
 const spawned=events.filter(e=>e.type==='worker.spawned');
 cleanNeed(identity(root)&&commandRun===runId&&spawned.length===1&&spawned[0].payload?.pid===root.pid
  &&grants.every(g=>g.seq>spawned[0].seq),'ROOT_RUN_OR_SPAWN_BINDING_INVALID');
 cleanNeed(exit?.runId===runId&&exit?.pid===root?.pid&&exit?.exitObserved===true&&exit?.closeObserved===true
  &&exit?.spawnError===false,'EXIT_CLOSE_NOT_CONFIRMED');
 cleanNeed(Array.isArray(cleanup?.scanDiagnostics)&&cleanup.scanDiagnostics.length===0,'SCAN_UNCONFIRMED');
 const descendants=Array.isArray(cleanup?.descendants)?cleanup.descendants:[];
 cleanNeed(Array.isArray(cleanup?.descendants),'KNOWN_DESCENDANTS_MISSING');
 const identities=new Map(identity(root)?[[root.pid,root]]:[]);
 for(const descendant of descendants){
  const d=descendant?.identity;
  cleanNeed(identity(d),'DESCENDANT_IDENTITY_INCOMPLETE');
  cleanNeed(['absent','mismatch'].includes(descendant?.verification),'DESCENDANT_NOT_GONE');
  if(identity(d)){cleanNeed(!identities.has(d.pid),'DUPLICATE_PROCESS_IDENTITY');identities.set(d.pid,d);}
 }
 for(const descendant of descendants){
  let child=descendant?.identity;const seen=new Set();
  while(identity(child)&&child.pid!==root?.pid){
   if(seen.has(child.pid)){cleanNeed(false,'DESCENDANT_PARENT_CYCLE');break;}seen.add(child.pid);
   const parent=identities.get(child.parentPid);
   if(!identity(parent)){cleanNeed(false,'DESCENDANT_PARENT_UNCONFIRMED');break;}
   cleanNeed(BigInt(child.creationFileTime)>=BigInt(parent.creationFileTime),'DESCENDANT_BIRTH_ORDER_INVALID');child=parent;
  }
 }
 const cleanupEvents=events.filter(e=>e.type==='cleanup.completed');
 cleanNeed(cleanupEvents.length===1&&cleanupEvents[0].source==='supervisor'&&cleanupEvents[0].payload?.confirmed===true
  &&!events.some(e=>e.type==='cleanup.failed'),'PARENT_CLEANUP_EVENT_UNCONFIRMED');
 const cleanupEvent=cleanupEvents[0];
 cleanNeed(finalStatus&&cleanupEvent&&cleanupEvent.seq<finalStatus.seq
  &&grants.every(g=>g.seq<cleanupEvent.seq)&&releases.every(e=>e.seq<cleanupEvent.seq),'CLEANUP_TERMINAL_ORDER_INVALID');
 cleanNeed(parsedRecord.success&&terminals.has(record.status)&&record.cleanupState==='confirmed','PARENT_TERMINAL_UNCONFIRMED');
 cleanNeed(runRows.length===1&&run.inFlight===0&&run.pending===0&&run.stopped===true,'CURRENT_RESERVATION_NOT_RECLAIMED');
 const ledgerValid=reasons.length===0,cleanupConfirmed=ledgerValid&&cleanupReasons.length===0;
 const permits=[...byPermit.values()].map(grant=>{
  const permitId=grant.payload.permitId,requestId=grant.payload.requestId,group=releaseGroups.get(permitId)??[];
  const explicit=group.length===1&&!invalidPermits.has(permitId);
  const disposition=explicit?'explicit_release':cleanupConfirmed&&!invalidPermits.has(permitId)?'confirmed_cleanup_reclaim':'unconfirmed';
  return Object.freeze({runId,requestId,permitId,grantSeq:grant.seq,disposition,
   releaseSeq:explicit?group[0].seq:null,cleanupSeq:disposition==='confirmed_cleanup_reclaim'?cleanupEvent.seq:null,
   basis:explicit?'actual unique parent permit.released event':disposition==='confirmed_cleanup_reclaim'
    ?'unique original grant; complete registered-identity cleanup and ordered parent terminal; current reservation zero; no release event invented'
    :'no sufficient settlement evidence'});
 });
 const explicitReleaseCount=permits.filter(p=>p.disposition==='explicit_release').length,
  cleanupReclaimedCount=permits.filter(p=>p.disposition==='confirmed_cleanup_reclaim').length,
  unconfirmedCount=permits.filter(p=>p.disposition==='unconfirmed').length;
 if(unconfirmedCount)for(const reason of cleanupReasons)add(reason);
 const valid=reasons.length===0&&unconfirmedCount===0;
 return Object.freeze({runId,valid,fullySettled:valid,permits:Object.freeze(permits),explicitReleaseCount,cleanupReclaimedCount,unconfirmedCount,
  chargedAttempts:run?.attempts??null,grantCount:grants.length,reasons:Object.freeze([...reasons]),
  cleanupProof:Object.freeze({confirmed:cleanupConfirmed,reasons:Object.freeze([...cleanupReasons]),
   noSafetyHold:input?.safetyHold===false,
   parentTerminalBasis:input?.terminal===undefined?'archived final parent RunRecord and ordered events; no terminal.json envelope supplied':'supplied parent terminal envelope and ordered events',
   registeredOriginalIdentitiesOnly:true,unknownOrphanGuarantee:false}),
  admissionAuthority:false,releaseAuthority:false,interpretation:'Evidence classification only; no permit, attempt count, Run state or hold is changed.'});
}
