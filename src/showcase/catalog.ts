import {RunStore} from '../storage/run-store.js';import type {DatasetSnapshot} from '../data/snapshot.js';
import {StoredEventSchema,WorkerEventSchema,type StoredEvent} from '../contracts/events.js';
import {canonicalizeArtifact} from '../contracts/canonical.js';import {hashArtifact,hashEvidenceSnapshot} from '../evidence/hashing.js';
import {evaluatePublication} from '../publishing/gate.js';import {renderApprovedDraft} from '../publishing/render.js';import {PublicationReceipts} from '../publishing/receipts.js';import {transitionRun} from '../contracts/state.js';
import {buildReviewSnapshot} from '../runtime/orchestrator.js';import {proposalPresentation} from './presentation.js';import {revisionDiff} from './revision-diff.js';
export class ShowcaseError extends Error{constructor(readonly code:string){super(code);}}
const need=(v:unknown,code:string)=>{if(!v)throw new ShowcaseError(code);};const same=(a:unknown,b:unknown)=>canonicalizeArtifact(a)===canonicalizeArtifact(b);
const actor=(e:StoredEvent)=>[e.role,e.agentId,e.taskId,e.contextId,e.attempt].join(':');
function concurrency(events:readonly StoredEvent[]){
 const spans=events.filter(e=>e.type==='model.request.started').map(start=>{
  need(start.payload.kind==='request','TRACE_REQUEST_INVALID');const p=start.payload as {requestId:string;permitId:string};
  const ends=events.filter(e=>e.type==='model.request.completed'&&e.payload.kind==='request'&&e.payload.requestId===p.requestId&&e.payload.permitId===p.permitId&&actor(e)===actor(start));
  need(ends.length===1&&ends[0]!.seq>start.seq&&ends[0]!.elapsedMs>=start.elapsedMs,'TRACE_REQUEST_INCOMPLETE');
  need(events.some(e=>e.type==='permit.granted'&&e.seq<start.seq&&e.payload.kind==='permit'&&e.payload.requestId===p.requestId&&e.payload.permitId===p.permitId),'TRACE_PERMIT_MISSING');
  return {role:start.role!,agentId:start.agentId!,taskId:start.taskId!,contextId:start.contextId!,requestId:p.requestId,permitId:p.permitId,startSeq:start.seq,endSeq:ends[0]!.seq,startMs:start.elapsedMs,endMs:ends[0]!.elapsedMs};
 });
 need(new Set(spans.map(s=>s.requestId)).size===spans.length,'TRACE_REQUEST_DUPLICATE');
 let overlapMs=0;for(const p of spans.filter(s=>s.role==='proposer'))for(const c of spans.filter(s=>s.role==='counter-evidence'))overlapMs=Math.max(overlapMs,Math.min(p.endMs,c.endMs)-Math.max(p.startMs,c.startMs));
 need(spans.some(s=>s.role==='proposer')&&spans.some(s=>s.role==='counter-evidence'),'TRACE_ANALYSIS_REQUESTS_MISSING');
 return{kind:'persisted_client_model_request_spans' as const,overlapMs,spans,scope:'Parent-observed client model request spans; not provider-internal scheduling or a separate raw-fetch timestamp audit.'};
}
/** Read qualification reuses the sole publication gate and parent receipts; it grants no new publication authority. */
export function readApproved(store:RunStore,runId:string,snapshot:DatasetSnapshot){
 const run=store.getRun(runId),bundle=store.getTerminal(runId),p=store.getPublication(runId);need(run&&bundle&&p,'NO_COMMITTED_PUBLICATION');
 if(!run||!bundle||!p||bundle.outcome.kind!=='reviewed')throw new ShowcaseError('NO_COMMITTED_PUBLICATION');
 need(run.status==='approved'&&run.input.mode==='research'&&run.runnerMode==='live'&&run.cleanupState==='confirmed','NOT_FORMAL_RESEARCH_LIVE');
 const {draft,counter,review}=bundle.outcome,proof=p.proof,events=store.eventsAfter(runId,0);
 need(events.length===run.lastSeq&&bundle.eventCount<=events.length&&events.every((e,n)=>StoredEventSchema.safeParse(e).success&&e.seq===n+1&&e.runId===runId)&&events.slice(bundle.eventCount).every(e=>e.type==='event.ignored'),'TRACE_INCOMPLETE');
 need(events.filter(e=>e.type==='cleanup.completed').length===1&&!events.some(e=>e.type==='cleanup.failed'),'CLEANUP_TRACE_UNCONFIRMED');
 const decision=evaluatePublication({run:proof.reviewedRecord,draft,counter,review,pool:proof.pool,evidence:proof.evidence,evidenceSnapshotHash:hashEvidenceSnapshot(proof.evidence),snapshot,actor:proof.actor,now:p.committedAt});
 need(decision.allowed,'STALE_OR_INVALID_APPROVAL');
 const transition=transitionRun(proof.reviewedRecord,{runId,seq:proof.reviewedRecord.lastSeq+1,action:'publication_committed',reviewId:review.id,reviewHash:review.hash,draftHash:draft.draftHash});
 need(transition.kind==='changed'&&same({...transition.state,lastSeq:bundle.eventCount},bundle.record)&&same({...bundle.record,lastSeq:run.lastSeq},run),'PUBLICATION_STATE_MISMATCH');
 need(p.renderedDraft===renderApprovedDraft(draft)&&p.renderedHash===hashArtifact({renderedDraft:p.renderedDraft})&&p.mode==='research'&&p.runnerMode==='live','RENDERED_DRAFT_MISMATCH');
 const formal={id:`proposal_${runId}`,pairKey:`${draft.pair.companyId}:${draft.pair.researcherId}`,runId,mode:'research',draft,reviewId:review.id,reviewHash:review.hash,committedAt:p.committedAt};need(same(p.formalProposal,formal),'FORMAL_PROPOSAL_MISMATCH');
 need(same(proof.reviewSnapshot,buildReviewSnapshot({input:run.input,snapshot,pool:proof.pool,evidence:proof.evidence,draft,counter})),'REVIEW_LOAD_PROOF_MISMATCH');
 const receipts=new PublicationReceipts(runId);for(const raw of events.slice(0,bundle.eventCount)){
  const {schemaVersion:_v,seq:_s,at:_a,elapsedMs:_m,...rest}=raw,e=WorkerEventSchema.safeParse(rest);if(!e.success)continue;
  if(e.data.type==='task.started'&&e.data.role==='critic'){const r=bundle.artifacts.find(a=>a.kind==='critic_review'&&a.artifact.version===e.data.attempt);need(r?.kind==='critic_review','REVIEW_TRACE_MISSING');if(r?.kind==='critic_review')receipts.dispatch({actor:{role:'critic',agentId:e.data.agentId,taskId:e.data.taskId,contextId:e.data.contextId,attempt:e.data.attempt},reviewVersion:e.data.attempt,target:r.artifact.target});}
  receipts.accept(e.data,bundle.artifacts);
 }
 for(const artifact of [{kind:'proposal_draft' as const,artifact:draft},{kind:'counter_report' as const,artifact:counter},{kind:'critic_review' as const,artifact:review}])need(receipts.hasCurrentArtifact(artifact),'ARTIFACT_TRACE_MISSING');
 const who=receipts.actorForReview(review.hash);need(who,'REVIEW_ACTOR_TRACE_MISSING');if(who){const{runId:_r,loopId:_l,...a}=who;need(same(a,proof.actor),'REVIEW_ACTOR_TRACE_MISMATCH');}
 return{run,proposal:formal,draft,counter,review,evidence:proof.evidence,events,artifacts:bundle.artifacts,concurrency:concurrency(events),presentation:proposalPresentation(draft),revisionDiff:revisionDiff(bundle.artifacts)};
}
export type ApprovedArchive=ReturnType<typeof readApproved>;
export function listShowcase(store:RunStore,snapshot:DatasetSnapshot){
 const results=new Map<string,{id:string;pairKey:string;runId:string;companyId:string;researcherId:string;challengeId:string;draftVersion:number;draftHash:string;reviewHash:string;committedAt:string;concurrency:ApprovedArchive['concurrency'];links:{run:string;artifacts:string;events:string}}>();
 for(const run of [...store.listRuns()].sort((a,b)=>a.runId.localeCompare(b.runId))){if(run.status!=='approved'||run.input.mode!=='research'||run.runnerMode!=='live')continue;try{
  const a=readApproved(store,run.runId,snapshot),p=a.proposal,entry={id:p.id,pairKey:p.pairKey,runId:run.runId,companyId:a.draft.pair.companyId,researcherId:a.draft.pair.researcherId,challengeId:a.draft.challengeId,draftVersion:a.draft.version,draftHash:a.draft.draftHash,reviewHash:a.review.hash,committedAt:p.committedAt,concurrency:a.concurrency,links:{run:`/api/runs/${run.runId}`,artifacts:`/api/runs/${run.runId}/artifacts`,events:`/api/runs/${run.runId}/events`}};
  const previous=results.get(entry.pairKey);if(!previous||entry.committedAt>previous.committedAt)results.set(entry.pairKey,entry);
 }catch{/* A nonqualifying archive cannot enter the public index. Detailed export returns a controlled reason. */}}
 return [...results.values()].sort((a,b)=>a.pairKey.localeCompare(b.pairKey));
}
