import type { CriticReview, ProposalDraft } from '../../../src/contracts/domain.js';
import { EvidenceLinks } from './ProposalView.js';
import { Finding } from './ReviewPanel.js';

/** Reading projection of the saved draft/review, without generating new conclusions. */
export function DecisionBrief({ draft, review, terminal, researcherName, onEvidence, onProposal, onReview }: {
  draft: ProposalDraft; review?: CriticReview; terminal: boolean; researcherName?: string;
  onEvidence: (id: string) => void; onProposal: () => void; onReview: () => void;
}) {
  const matchedReview = review?.target.draftHash === draft.draftHash ? review : undefined;
  const rationale = draft.sections.technicalRationale?.length ? draft.sections.technicalRationale : draft.sections.summary;
  const paragraphs = (entries: { text: string; claimIds: string[] }[]) => entries.map((entry, i) => {
    const evidence = [...new Set(draft.claims.filter(claim => entry.claimIds.includes(claim.id)).flatMap(claim => claim.evidenceIds))];
    return <div className="brief-paragraph" key={i}><p>{entry.text}</p><EvidenceLinks ids={evidence} onEvidence={onEvidence} /></div>;
  });
  return <article className="decision-brief" aria-label="Decision overview">
    <header className="brief-heading"><span className="eyebrow">Proposed partner</span><h2>{researcherName ?? draft.pair.researcherId}</h2><span className="small muted">{draft.pair.researcherId} · Draft v{draft.version}</span></header>
    <section className="brief-section"><div className="section-heading"><h3>Why this partner</h3><button className="text-button" onClick={onProposal}>Full proposal</button></div>{paragraphs(rationale.slice(0, 1))}</section>
    <section className="brief-section brief-review"><div className="section-heading"><h3>{matchedReview?.verdict === 'approve' ? 'Review notes' : 'What needs resolving'}</h3><button className="text-button" onClick={onReview}>Read review</button></div>
      {matchedReview ? <><p className="small muted">Review v{matchedReview.version} · {matchedReview.findings.filter(f => f.severity === 'blocking').length} blocking · {matchedReview.findings.filter(f => f.severity !== 'blocking').length} advisory</p>{[...matchedReview.findings].sort((a, b) => Number(b.severity === 'blocking') - Number(a.severity === 'blocking')).slice(0, 2).map(finding => <Finding key={finding.id} finding={finding} onEvidence={onEvidence} />)}{matchedReview.findings.length > 2 ? <button className="text-button" onClick={onReview}>View all {matchedReview.findings.length} findings</button> : null}{!matchedReview.findings.length ? <p>No findings recorded for this draft.</p> : null}</> : <p className="muted">{terminal ? "No review saved for this draft." : "No review saved for this draft yet."}</p>}
      {!matchedReview && review ? <div className="notice warning"><p>Draft v{draft.version} is unreviewed. The latest saved review targets draft v{review.target.draftVersion}.</p><button className="text-button" onClick={onReview}>Read the earlier findings</button></div> : null}
      {!matchedReview && terminal ? <p className="small muted">This analysis has ended. No further review is running.</p> : null}
      {draft.sections.unknowns?.length ? <details className="brief-questions"><summary>Open questions in the proposal</summary>{paragraphs(draft.sections.unknowns)}</details> : null}
    </section>
    <section className="brief-section"><h3>Next experiment</h3>{draft.sections.validation?.length ? paragraphs(draft.sections.validation) : <p className="muted">No validation plan recorded in this draft.</p>}</section>
    {draft.sections.constraints?.length ? <section className="brief-section"><h3>Conditions to confirm</h3>{paragraphs(draft.sections.constraints)}</section> : null}
  </article>;
}
