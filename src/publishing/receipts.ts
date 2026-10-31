import { canonicalizeArtifact } from '../contracts/canonical.js';
import type { ReviewExpectation } from '../contracts/domain.js';
import type { WorkerEvent } from '../contracts/events.js';
import type { TypedArtifact } from '../contracts/ipc.js';
import type { TaskIdentity } from '../model/gateway-runner.js';
import { hashArtifact } from '../evidence/hashing.js';

type Role=TaskIdentity['role'];
const kinds={proposer:'proposal_draft','counter-evidence':'counter_report',critic:'critic_review'} as const;
const equal=(a:unknown,b:unknown)=>canonicalizeArtifact(a)===canonicalizeArtifact(b);
type Receipt={actor:TaskIdentity;answered:boolean;validated?:TypedArtifact;completed:boolean;reviewCompleted?:boolean};
const actorOf=(e:WorkerEvent):TaskIdentity=>{
  if(e.attempt!==1&&e.attempt!==2)throw Error('RECEIPT_ATTEMPT_INVALID');
  return {runId:e.runId,role:e.role!,agentId:e.agentId!,taskId:e.taskId!,contextId:e.contextId!,loopId:e.loopId!,attempt:e.attempt};
};
/** Parent ledger of events received on the exact spawned worker IPC handle.
 * It authenticates the application task sequence, not natural-language truth. */
export class PublicationReceipts {
  readonly #participants=new Map<Role,string>();readonly #tasks=new Map<string,Receipt>();readonly #contexts=new Set<string>();
  readonly #dispatches=new Map<number,ReviewExpectation>();
  constructor(readonly runId:string){}
  dispatch(expectation:ReviewExpectation){
    if(this.#dispatches.has(expectation.reviewVersion))throw Error('DUPLICATE_REVIEW_DISPATCH');
    const draft=[...this.#tasks.values()].find(t=>t.completed&&t.validated?.kind==='proposal_draft'&&t.validated.artifact.draftHash===expectation.target.draftHash&&t.actor.attempt===expectation.reviewVersion);
    const counter=[...this.#tasks.values()].find(t=>t.completed&&t.validated?.kind==='counter_report'&&t.validated.artifact.hash===expectation.target.counterReportHash);
    if(!draft||!counter)throw Error('REVIEW_DISPATCH_MISSING_ANALYSIS_RECEIPTS');
    const first=this.#dispatches.get(1);
    if(expectation.reviewVersion===2&&(!first||first.actor.agentId!==expectation.actor.agentId||first.actor.contextId===expectation.actor.contextId||first.actor.taskId===expectation.actor.taskId))throw Error('INVALID_REVIEW_REENTRY');
    if(expectation.reviewVersion===2&&!this.#revisionAuthorized())throw Error('REVIEW_REVISION_NOT_AUTHORIZED');
    this.#dispatches.set(expectation.reviewVersion,expectation);
  }
  hasArtifact(artifact:TypedArtifact){return [...this.#tasks.values()].some(t=>t.completed&&t.validated&&equal(t.validated,artifact));}
  hasCurrentArtifact(artifact:TypedArtifact){
    const latest=[...this.#tasks.values()].filter(t=>t.completed&&t.validated?.kind===artifact.kind).sort((a,b)=>b.actor.attempt-a.actor.attempt)[0];
    return Boolean(latest?.validated&&equal(latest.validated,artifact));
  }
  #revisionAuthorized(){return [...this.#tasks.values()].some(t=>t.reviewCompleted&&t.validated?.kind==='critic_review'&&t.validated.artifact.version===1&&t.validated.artifact.verdict==='revise');}
  actorForReview(reviewHash:string){return [...this.#tasks.values()].find(t=>t.completed&&t.reviewCompleted&&t.actor.role==='critic'&&t.validated?.kind==='critic_review'&&t.validated.artifact.hash===reviewHash)?.actor;}
  accept(e:WorkerEvent,artifacts:readonly TypedArtifact[]){
    if(e.runId!==this.runId)throw Error('RECEIPT_RUN_MISMATCH');
    if(e.type==='participant.joined'&&e.payload.participantKind==='agent'){
      if(!e.role||e.agentId!==e.payload.participantId||this.#participants.has(e.role)||[...this.#participants.values()].includes(e.agentId))throw Error('RECEIPT_PARTICIPANT_MISMATCH');
      this.#participants.set(e.role,e.agentId);return;
    }
    if(!['task.started','model.answer','artifact.validated','task.completed','review.completed'].includes(e.type))return;
    const actor=actorOf(e);
    if(this.#participants.get(actor.role)!==actor.agentId)throw Error('RECEIPT_PRODUCER_MISMATCH');
    if(e.type==='task.started'){
      if(this.#tasks.has(actor.taskId)||this.#contexts.has(actor.contextId)||[...this.#tasks.values()].some(t=>t.actor.role===actor.role&&t.actor.attempt===actor.attempt))throw Error('RECEIPT_TASK_REENTRY');
      if(actor.attempt===2&&!this.#revisionAuthorized())throw Error('RECEIPT_REVISION_NOT_AUTHORIZED');
      if(actor.role==='critic'){
        const dispatch=this.#dispatches.get(actor.attempt);const {runId:_r,loopId:_l,...reviewActor}=actor;
        if(!dispatch||!equal(dispatch.actor,reviewActor))throw Error('RECEIPT_CRITIC_DISPATCH_MISMATCH');
      }
      this.#tasks.set(actor.taskId,{actor,answered:false,completed:false});this.#contexts.add(actor.contextId);return;
    }
    const task=this.#tasks.get(actor.taskId);if(!task||!equal(task.actor,actor))throw Error('RECEIPT_TASK_MISMATCH');
    if(e.type==='model.answer'){if(task.answered||task.completed)throw Error('DUPLICATE_NATIVE_ANSWER');task.answered=true;return;}
    if(e.type==='artifact.validated'||e.type==='task.completed'){
      if(e.payload.kind!=='artifact_ref'||e.payload.artifactKind!==kinds[actor.role]||e.payload.version!==actor.attempt||!task.answered||task.completed)throw Error('RECEIPT_ARTIFACT_MISMATCH');
      const payload=e.payload;
      const artifact=artifacts.find(a=>a.kind===payload.artifactKind&&a.artifact.version===payload.version&&(a.kind==='proposal_draft'?a.artifact.draftHash:a.artifact.hash)===payload.artifactRef.hash);
      if(!artifact||(artifact.kind==='proposal_draft'?`draft_${artifact.artifact.version}`:artifact.artifact.id)!==e.payload.artifactRef.id)throw Error('RECEIPT_ARTIFACT_MISSING');
      if(artifact.kind==='proposal_draft'&&artifact.artifact.version===2){
        const first=[...this.#tasks.values()].find(t=>t.completed&&t.validated?.kind==='proposal_draft'&&t.validated.artifact.version===1)?.validated;
        if(first?.kind!=='proposal_draft'||hashArtifact({researcherId:first.artifact.pair.researcherId,claims:first.artifact.claims,sections:first.artifact.sections})
          ===hashArtifact({researcherId:artifact.artifact.pair.researcherId,claims:artifact.artifact.claims,sections:artifact.artifact.sections}))throw Error('RECEIPT_NON_SUBSTANTIVE_REVISION');
      }
      if(e.type==='artifact.validated'){if(task.validated)throw Error('DUPLICATE_ARTIFACT_RECEIPT');task.validated=artifact;}
      else {if(!task.validated||!equal(task.validated,artifact))throw Error('RECEIPT_UNVALIDATED_COMPLETION');task.completed=true;}
    }else if(e.type==='review.completed'){
      if(task.reviewCompleted||!task.completed||task.validated?.kind!=='critic_review'||e.payload.kind!=='review_ref'
        ||task.validated.artifact.hash!==e.payload.reviewRef.hash||task.validated.artifact.id!==e.payload.reviewRef.id
        ||task.validated.artifact.verdict!==e.payload.verdict||task.validated.artifact.target.draftVersion!==e.payload.draftVersion)throw Error('REVIEW_COMPLETION_MISMATCH');
      task.reviewCompleted=true;
    }
  }
}
