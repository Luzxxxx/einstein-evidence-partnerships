import type {TypedArtifact} from '../contracts/ipc.js';import {CriticReviewSchema} from '../contracts/domain.js';import {hashArtifact} from '../evidence/hashing.js';import {canonicalizeArtifact} from '../contracts/canonical.js';
/** Mechanical changes only. A later approval is not proof that every finding is semantically correct. */
export function revisionDiff(artifacts:readonly TypedArtifact[]){
 const drafts=artifacts.filter(a=>a.kind==='proposal_draft').map(a=>a.artifact).filter(d=>hashArtifact(d)===d.draftHash).sort((a,b)=>a.version-b.version);
 const before=drafts.find(d=>d.version===1),after=drafts.find(d=>d.version===2);if(!before||!after)return {available:false as const,reason:'NO_TWO_STORED_DRAFT_VERSIONS'};
 const second=artifacts.find(a=>{
  if(a.kind!=='critic_review'||!CriticReviewSchema.safeParse(a.artifact).success||a.artifact.verdict!=='approve'||a.artifact.runId!==after.runId||a.artifact.version!==after.version||hashArtifact(a.artifact)!==a.artifact.hash)return false;
  const r=a.artifact,t=r.target,c=artifacts.find(x=>x.kind==='counter_report'&&x.artifact.hash===t.counterReportHash&&x.artifact.runId===after.runId&&hashArtifact(x.artifact)===x.artifact.hash);
  return c?.kind==='counter_report'&&c.artifact.inputHash===after.inputHash&&c.artifact.poolHash===after.poolHash&&c.artifact.poolVersion===after.poolVersion&&t.inputHash===after.inputHash&&t.poolVersion===after.poolVersion&&t.poolHash===after.poolHash&&t.draftVersion===after.version&&t.draftHash===after.draftHash&&t.evidenceSnapshotHash===after.evidenceSnapshotHash;
 });
 const ids=[...new Set([...before.claims,...after.claims].map(c=>c.id))];
 return {available:true as const,from:{version:before.version,hash:before.draftHash},to:{version:after.version,hash:after.draftHash},
  laterApproval:second?.kind==='critic_review'?{id:second.artifact.id,hash:second.artifact.hash}:null,
  claims:ids.map(id=>{const a=before.claims.find(c=>c.id===id)??null,b=after.claims.find(c=>c.id===id)??null;return{id,before:a,after:b,change:!a?'added':!b?'removed':canonicalizeArtifact(a)===canonicalizeArtifact(b)?'unchanged':'changed'};}),
  sections:Object.keys({...before.sections,...after.sections}).map(name=>({name,before:before.sections[name as keyof typeof before.sections]??null,after:after.sections[name as keyof typeof after.sections]??null,
   changed:canonicalizeArtifact(before.sections[name as keyof typeof before.sections]??null)!==canonicalizeArtifact(after.sections[name as keyof typeof after.sections]??null)})),
  findings:artifacts.filter(a=>a.kind==='critic_review'&&a.artifact.version===1).flatMap(a=>a.kind==='critic_review'?a.artifact.findings.map(f=>({...f,reviewHash:a.artifact.hash,laterReviewHash:second?.kind==='critic_review'?second.artifact.hash:null,resolution:'semantic_resolution_not_inferred_by_diff'})):[])};
}
