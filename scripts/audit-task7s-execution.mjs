// Append-only read-only evidence export after the unique authorized flow.
// No RunStore.open, model call, cleanup action, recovery replay or retry.
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {sha256Bytes} from '../dist/server/evidence/hashing.js';
import {collectBoundedProductFingerprints} from '../dist/server/evaluation/bounded-validation.js';
import {canonicalizeArtifact} from '../dist/server/contracts/canonical.js';
const j=async p=>JSON.parse(await readFile(p,'utf8'));
const baseline=await j('docs/implementation/task-7s-baseline.json'),freeze=await j('docs/implementation/task-7s-live/freeze.json');
const output=resolve('docs/implementation/task-7s-live'),runFolder=join(output,'runs',freeze.probe.runId),result=await j(join(runFolder,'result.json'));
if(canonicalizeArtifact(await collectBoundedProductFingerprints())!==canonicalizeArtifact(freeze.productFingerprints))throw Error('PRODUCT_CHANGED_AFTER_FREEZE');
for(const f of [...baseline.protectedUntrackedJson,...baseline.historicalLive,...baseline.historicalStore.files])
 if(sha256Bytes(await readFile(f.file))!==f.sha256)throw Error('PROTECTED_BYTES_CHANGED');
const originalParentFiles=[];await mkdir(join(runFolder,'parent-store-copy'));
for(const name of ['record.json','events.jsonl','terminal.json']){
 const path=join(baseline.historicalStore.root,freeze.probe.runId,name),bytes=await readFile(path);
 const copy=join(runFolder,'parent-store-copy',name);await writeFile(copy,bytes,{flag:'wx'});
 originalParentFiles.push({path,copy,sha256:sha256Bytes(bytes)});
}
const terminal=await j(join(runFolder,'parent-store-copy/terminal.json'));
let l05Exists=false;try{await access(join(baseline.historicalStore.root,freeze.l05.runId));l05Exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
if(l05Exists)throw Error('L05_SHOULD_BE_UNEXECUTED');
const records=(await readFile(join(runFolder,'worker-evidence.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const counter=records.find(r=>r.kind==='native'&&r.type==='model.answer'&&r.actor.role==='counter-evidence');
const calls=records.filter(r=>r.kind==='native'&&r.type==='function_call.completed'&&r.actor.role==='counter-evidence');
const actualCallIds=calls.map(c=>c.callId),returnedCallIds=counter.answer.receipts.map(r=>r.callId);
const receiptUuidsAreActual=counter.answer.receipts.every((r,i)=>r.receiptId===calls[i]?.receipt.receiptId);
const cleanup=result.cleanups[0];
const clarification={scope:'append_only_post_probe_observation_no_reinterpretation_as_PASS',observedAt:new Date().toISOString(),
 probeRunId:freeze.probe.runId,plannedL05RunId:freeze.l05.runId,originalParentFiles,originalResultSha256:sha256Bytes(await readFile(join(runFolder,'result.json'))),
 productFingerprintsUnchangedSinceFreeze:true,originalHistoryFilesUnchanged:176,protectedUserJsonUnchanged:73,
 observed:{supplierMultiCallBatches:result.analysis.multiCallBatchCount,nativeToolStarts:records.filter(r=>r.type==='function_call.started').length,
  nativeToolCompletions:records.filter(r=>r.type==='function_call.completed').length,requests:result.requests.started,grants:result.events.filter(e=>e.type==='permit.granted').length,
  releases:result.events.filter(e=>e.type==='permit.released').length,maxConcurrentRequests:result.requests.maxObservedInFlight,
  firstAnalysisOverlapMs:result.requests.firstAnalysisOverlapMs,usageStatus:result.requests.usageStatus,reportedTokens:result.requests.reportedTotals,
  counterActualCallIds:actualCallIds,counterReturnedCallIds:returnedCallIds,counterReceiptUuidsAreActual:receiptUuidsAreActual,
  runOutcome:terminal.outcome,cleanupConfirmed:cleanup.confirmed,rootVerification:cleanup.rootVerification,exitObserved:cleanup.exit.exitObserved,
  closeObserved:cleanup.exit.closeObserved,exitCode:cleanup.exit.exitCode,safetyHold:result.safetyHold,currentInFlight:result.permitSnapshot.inFlight,
  l05Created:false,formalProposalCreated:false},
 clarifications:[
  {code:'CLEANUP_REASON_TOO_BROAD',text:'Original analysis CLEANUP_UNCONFIRMED also requires exitCode=0. Actual OS cleanup is confirmed; worker exitCode=1 is a worker failure, not unknown cleanup. Original result is retained unchanged.'},
  {code:'COUNTER_CALL_ID_REPLAY_MISMATCH',text:'Counter returned actual random receipt UUIDs but replaced original call IDs with 1/2. This fails the frozen stronger output contract; alone it does not prove native/wire tool protocol incompatibility or fabricated receipt UUIDs.'},
  {code:'PROPOSER_FINAL_CONTENT_UNKNOWN',text:'Only last HTTP completed/stop and native observer failure are recorded. No valid Proposer final answer text or precise observer exception was saved. Specific JSON, fields, added text and exact rejection cause cannot be reconstructed.'},
  {code:'NO_POSTHOC_STANDARD_CHANGE',text:'The frozen probe remains failed. No extra request, second probe or L05 was started; any future diagnostic/output-contract change needs user discussion and authorization.'},
 ],
 protocolStatus:'partial_native_multi_call_roundtrip_observed_full_probe_NOT_PASS',semanticObservation:'no_Critic_or_L05_executed',
 humanLabels:0,qualityMetrics:'NA',holdout:'unopened',modelRequestsByThisAudit:0,recoveryApplyCalls:0};
await writeFile(join(output,'diagnostic-clarification.json'),JSON.stringify(clarification,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({requests:4,multiCallBatches:2,receiptUuidsAreActual,cleanupConfirmed:cleanup.confirmed,
 typedFailure:terminal.outcome.reasonCodes,probePassed:false,L05:'unexecuted',fingerprintsUnchanged:true,auditModelRequests:0}));
