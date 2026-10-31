import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash,randomUUID} from 'node:crypto';
const fixture=JSON.parse(await readFile(new URL('../fixtures/permit-settlement-history.json',import.meta.url),'utf8'));
const proof=()=>{const p=structuredClone(fixture.parent);return{runId:p.record.runId,...p};};
const helper=async()=>{const module=await import('../helpers/permit-settlement.mjs');assert.equal(typeof module.verifyPermitSettlement,'function');return module.verifyPermitSettlement;};
const pointer=(value,path)=>path.split('/').slice(1).reduce((v,key)=>v[key.replaceAll('~1','/').replaceAll('~0','~')],value);
function resequence(p){p.events.forEach((e,index)=>{e.seq=index+1;});p.record.lastSeq=p.events.length;return p;}
function insert(p,event,before){p.events.splice(before,0,event);return resequence(p);}

test('the exact archived regression copy retains 4 requests/tools, 2 reverse-order answers, 3 releases and 4 charged attempts',async()=>{
 assert.equal(fixture.runnerMode,'offline_fixture');assert.equal(fixture.sourceArchiveSha256,'469ac542b58d2e76db1af2bc7bdf6716625e65af2b923e45ab886390b2293c4e');
 const p=proof(),events=p.events,protocol=fixture.protocol;
 assert.equal(events.filter(e=>e.type==='permit.granted').length,4);assert.equal(events.filter(e=>e.type==='permit.released').length,3);
 assert.equal(events.filter(e=>e.type==='model.request.started').length,4);assert.equal(events.filter(e=>e.type==='model.request.completed').length,4);
 assert.equal(protocol.wireCount,4);assert.equal(protocol.requestTraces.filter(r=>r.trace.type==='request.started').length,4);
 assert.equal(protocol.nativeCalls.filter(r=>r.type==='function_call.completed').length,4);assert.equal(protocol.answers.length,2);
 for(const answer of protocol.answers)assert.deepEqual(answer.answer.receipts.map(r=>r.toolName),['read_candidate_bundle','read_company_challenge']);
 assert.equal(p.snapshot.runs[0].attempts,4);assert.equal(p.record.status,'insufficient');
 // On a clean checkout the tracked raw-value copy suffices. When the protected
 // source is present, prove every selected value still equals that exact file.
 let raw;try{raw=await readFile(new URL('../../'+fixture.sourceArchive,import.meta.url));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(raw){assert.equal(createHash('sha256').update(raw).digest('hex'),fixture.sourceArchiveSha256);const source=JSON.parse(raw);
  for(const item of fixture.copiedFieldManifest)assert.deepEqual(pointer(fixture,item.target),pointer(source,item.source));}
});

test('archived 3 explicit releases plus one independently confirmed cleanup reclaim settle four unique original grants without refund',async()=>{
 const verify=await helper(),p=proof(),before=JSON.stringify(p),result=verify(p);
 assert.equal(result.valid,true,JSON.stringify(result));assert.equal(result.fullySettled,true);assert.equal(result.permits.length,4);
 assert.equal(result.explicitReleaseCount,3);assert.equal(result.cleanupReclaimedCount,1);assert.equal(result.unconfirmedCount,0);
 assert.equal(result.permits.filter(r=>r.disposition==='confirmed_cleanup_reclaim').length,1);
 assert.equal(new Set(result.permits.map(r=>r.permitId)).size,4);assert.equal(new Set(result.permits.map(r=>r.requestId)).size,4);
 assert.equal(p.snapshot.runs[0].attempts,4);assert.equal(JSON.stringify(p),before,'the checker cannot mutate evidence or manufacture a release event');
});

for(const hold of ['active','missing'])test('complete cleanup and zero quota cannot authorize cleanup reclamation when safetyHold is '+hold,async()=>{
 const verify=await helper(),p=proof();
 assert.equal(p.safetyHold,false,'the tracked historical copy retains its actual no-hold field');
 if(hold==='active')p.safetyHold=true;else delete p.safetyHold;
 assert.equal(p.snapshot.inFlight,0);assert.equal(p.cleanup.confirmed,true);assert.equal(p.record.cleanupState,'confirmed');
 const result=verify(p);assert.equal(result.valid,false,JSON.stringify(result));assert.equal(result.cleanupReclaimedCount,0);
 assert.equal(result.unconfirmedCount,1);assert.equal(p.events.filter(e=>e.type==='permit.released').length,3);
});

for(const fault of ['duplicate_grant_permit','duplicate_grant_request','duplicate_release','alien_release_run','alien_release_permit','wrong_release_request','release_before_grant','request_grant_mismatch','duplicate_event_sequence'])
 test('permit settlement rejects '+fault+' instead of masking it through a Set or cleanup',async()=>{
  const verify=await helper(),p=proof(),grant=p.events.find(e=>e.type==='permit.granted'),release=p.events.find(e=>e.type==='permit.released');
  if(fault==='duplicate_grant_permit'){const duplicate=structuredClone(grant);duplicate.payload.requestId=randomUUID();insert(p,duplicate,p.events.indexOf(grant)+1);}
  if(fault==='duplicate_grant_request'){const duplicate=structuredClone(grant);duplicate.payload.permitId=randomUUID();insert(p,duplicate,p.events.indexOf(grant)+1);}
  if(fault==='duplicate_release')insert(p,structuredClone(release),p.events.indexOf(release)+1);
  if(fault==='alien_release_run')release.runId=randomUUID();
  if(fault==='alien_release_permit')release.payload.permitId=randomUUID();
  if(fault==='wrong_release_request')release.payload.requestId=randomUUID();
  if(fault==='release_before_grant'){p.events.splice(p.events.indexOf(release),1);insert(p,release,0);}
  if(fault==='request_grant_mismatch')p.events.find(e=>e.type==='model.request.started').payload.requestId=randomUUID();
  if(fault==='duplicate_event_sequence')p.events[1].seq=p.events[0].seq;
  const result=verify(p);assert.equal(result.valid,false,JSON.stringify(result));assert.ok(result.reasons.length>0);
 });

for(const fault of ['missing_identity','root_birth_missing','root_pid_mismatch','root_not_absent','exit_run_mismatch','exit_not_observed','close_not_observed','scan_unconfirmed','descendant_unknown','descendant_identity_missing','parent_still_researching','cleanup_after_terminal','attempts_refunded','unknown_cleanup_zero_snapshot'])
 test('missing release cannot become confirmed cleanup reclaim with '+fault,async()=>{
  const verify=await helper(),p=proof();
  if(fault==='missing_identity')p.cleanup.identity=null;
  if(fault==='root_birth_missing')p.cleanup.identity.creationFileTime=null;
  if(fault==='root_pid_mismatch')p.cleanup.exit.pid=p.cleanup.identity.pid+1;
  if(fault==='root_not_absent')p.cleanup.rootVerification='unknown';
  if(fault==='exit_run_mismatch')p.cleanup.exit.runId=randomUUID();
  if(fault==='exit_not_observed')p.cleanup.exit.exitObserved=false;
  if(fault==='close_not_observed')p.cleanup.exit.closeObserved=false;
  if(fault==='scan_unconfirmed')p.cleanup.scanDiagnostics=[{pid:p.cleanup.identity.pid,stage:'offline_fixture',code:'IDENTITY_UNKNOWN'}];
  if(fault==='descendant_unknown')p.cleanup.descendants[0].verification='unknown';
  if(fault==='descendant_identity_missing')p.cleanup.descendants[0].identity=null;
  if(fault==='parent_still_researching')p.record.status='researching';
  if(fault==='cleanup_after_terminal'){const at=p.events.findIndex(e=>e.type==='cleanup.completed'),[event]=p.events.splice(at,1);p.events.push(event);resequence(p);}
  if(fault==='attempts_refunded')p.snapshot.runs[0].attempts=3;
  if(fault==='unknown_cleanup_zero_snapshot'){p.cleanup.confirmed=false;p.cleanup.rootVerification='unknown';p.record.cleanupState='unconfirmed';}
  const result=verify(p);assert.equal(result.valid,false,JSON.stringify(result));assert.equal(result.cleanupReclaimedCount,0);
  assert.ok(result.permits.some(r=>r.disposition==='unconfirmed'));assert.equal(p.events.filter(e=>e.type==='permit.released').length,3);
 });

test('a supplied contradictory terminal envelope cannot override the archived parent record and ordered events',async()=>{
 const verify=await helper(),p=proof();
 p.terminal={schemaVersion:1,record:{...p.record,runId:randomUUID()},outcome:{runId:p.runId,kind:'insufficient',reasonCodes:['OFFLINE_SYNTHETIC_CONTRADICTION']},eventCount:p.events.length};
 const result=verify(p);assert.equal(result.valid,false);assert.equal(result.cleanupReclaimedCount,0);
});
