import type {CriticReview, ProposalDraft, RunStatus} from '../../../src/contracts/domain.js';
import type {RevisionDiff} from '../types.js';
import {sectionNames} from '../state.js';
import {laterReviewForComparison, reviewStory} from '../reading.js';
import {Finding} from './ReviewPanel.js';

type Change = NonNullable<RevisionDiff['claims']>[number];
function ClaimComparison({change}: {change: Change}) {
  return <article className="claim-comparison"><header><span className="id-text">{change.id}</span><span className="badge neutral">{change.change}</span></header><div className="comparison-grid"><section><h4>Before</h4><p>{change.before?.text ?? 'Not present in this version.'}</p>{change.before?.limitations.length ? <ul>{change.before.limitations.map((l,i)=><li key={i}>{l}</li>)}</ul> : null}</section><section><h4>After</h4><p>{change.after?.text ?? 'Not present in this version.'}</p>{change.after?.limitations.length ? <ul>{change.after.limitations.map((l,i)=><li key={i}>{l}</li>)}</ul> : null}</section></div></article>;
}

export function DecisionEvolution({runId, diff, drafts, reviews, status, onEvidence}: {
  runId: string; diff: RevisionDiff | null; drafts: ProposalDraft[]; reviews: CriticReview[]; status: RunStatus; onEvidence: (id: string)=>void;
}) {
  if (!diff?.available) return <div className="inline-empty"><h2>No revision comparison yet</h2><p>Two saved draft versions are required. A revision is never created just for this view.</p></div>;
  const later = laterReviewForComparison(diff, drafts, reviews, runId);
  const laterLabel = later?.verdict === 'approve' ? diff.laterApproval?.hash === later.hash && diff.laterApproval.id === later.id ? 'Approve' : 'Approval binding unavailable'
    : later?.verdict === 'insufficient' ? 'Insufficient evidence' : later?.verdict === 'revise' ? 'Revise' : 'No matching later review';
  const stories = reviewStory(diff);
  const outcome = status === 'insufficient' ? 'Insufficient evidence' : status === 'approved' ? 'Review approved' : status === 'failed' ? 'Failed' : status === 'cancelled' ? 'Cancelled' : 'Still in progress';
  return <section className="reading-panel"><h2>A decision, challenged.</h2><p className="muted">Follow the saved finding and its linked Claim changes. Every passage below is original recorded text.</p>
    <div className="story-status"><strong>Draft v{diff.from?.version} → review → draft v{diff.to?.version}</strong><p>Later review of v{diff.to?.version}: <b>{laterLabel}</b>. Recorded Run outcome: <b>{outcome}</b>.</p><p>A text change or later approval does not prove that every finding was resolved.</p></div>
    <h3>What the Critic challenged</h3>
    {stories.length ? stories.map((story,index)=><details className="review-story-card" key={story.finding.id} open={index===0}><summary>Review point {index+1}{story.finding.claimIds.length ? ` · ${story.finding.claimIds.join(', ')}` : ' · Run-level finding'}<span className="small muted"> · {story.changes.length} changed {story.changes.length===1?'claim':'claims'}</span></summary>
      <Finding finding={story.finding} onEvidence={onEvidence}/>
      {story.changes.length ? <><h4>Linked passages before and after</h4>{story.changes.map(change=><ClaimComparison key={change.id} change={change}/>)}</> : <p className="small muted">No changed Claim is linked to this finding by ID. The complete section comparison remains available below.</p>}
      {story.unchangedClaimIds.length ? <p className="story-unchanged">Linked claims with no recorded change: {story.unchangedClaimIds.join(', ')}.</p> : null}
      <p className="small muted">This view associates Claim IDs. It does not determine whether the change resolves the finding.</p>
    </details>) : <p>No first-review finding was recorded in this comparison.</p>}
    <details className="story-complete"><summary>Read the complete draft comparison</summary><h3>All claims</h3>{diff.claims?.map(change=><ClaimComparison key={change.id} change={change}/>)}
      <h3>All sections</h3>{diff.sections?.map(section=><details className="section-comparison" key={section.name}><summary>{sectionNames[section.name]??section.name} <span className="small muted">{section.changed?'Changed':'Unchanged'}</span></summary><div className="comparison-grid"><section><h4>Before</h4>{section.before?.length?section.before.map((p,i)=><p key={i}>{p.text}</p>):<p>Not present.</p>}</section><section><h4>After</h4>{section.after?.length?section.after.map((p,i)=><p key={i}>{p.text}</p>):<p>Not present.</p>}</section></div></details>)}
    </details>
    <details className="technical"><summary>Comparison bindings</summary><dl className="metadata"><dt>Before SHA-256</dt><dd>{diff.from?.hash}</dd><dt>After SHA-256</dt><dd>{diff.to?.hash}</dd><dt>Bound later approval</dt><dd>{diff.laterApproval?.hash??'Not available'}</dd></dl></details>
  </section>;
}
