import type { CriticReview, ProposalDraft } from '../../../src/contracts/domain.js';
import { EvidenceLinks } from './ProposalView.js';
import { Finding } from './ReviewPanel.js';
import { matchingReview, meetingSections } from '../reading.js';
import type { Company } from '../types.js';
import './reading.css';

/** Reading projection of the saved draft/review, without generating new conclusions. */
export function DecisionBrief({ draft, review, terminal, published = false, challenge, researcherName, onEvidence, onProposal, onReview }: {
  draft: ProposalDraft; review?: CriticReview; terminal: boolean; published?: boolean; challenge?: Company['challenges'][number]; researcherName?: string;
  onEvidence: (id: string) => void; onProposal: () => void; onReview: () => void;
}) {
  const matchedReview = matchingReview(draft, review);
  const sections = meetingSections(draft);
  const paragraphs = (entries: { text: string; claimIds: string[] }[]) => entries.map((entry, i) => {
    const evidence = [...new Set(draft.claims.filter(claim => entry.claimIds.includes(claim.id)).flatMap(claim => claim.evidenceIds))];
    return <div className="brief-paragraph" key={i}><p>{entry.text}</p><EvidenceLinks ids={evidence} onEvidence={onEvidence} /></div>;
  });
  return <article className="decision-brief" aria-label="Decision overview">
    <header className="brief-heading"><span className="eyebrow">Proposed partner</span><h2>{researcherName ?? draft.pair.researcherId}</h2><span className="small muted">{draft.pair.researcherId} · Draft v{draft.version}</span><p className="meeting-intro">A brief for the first conversation. Read the proposed work, the validation plan and the conditions still to agree.</p><button className="text-button" onClick={onProposal}>Read the full proposal and claims</button></header>
    {published ? <aside className="meeting-approved-note"><strong>System review approved</strong><p>The parent service saved this reviewed draft. Collaboration, availability and real-world outcomes still need confirmation. {matchedReview?.findings.length ? `${matchedReview.findings.length} review ${matchedReview.findings.length === 1 ? 'point remains' : 'points remain'} available below.` : ''}</p></aside> : null}
    {challenge ? <section className="meeting-context"><h3>The company’s original challenge</h3><p>{challenge.text}</p>{challenge.detail ? <details><summary>Read the full original requirements</summary><p>{challenge.detail}</p></details> : null}</section> : null}
    <nav className="meeting-nav" aria-label="Read the meeting brief">{sections.map(s => <a key={s.key} href={`#meeting-${s.key}`} onClick={event => {event.preventDefault();const target=document.getElementById(`meeting-${s.key}`);target?.scrollIntoView({block:'start',behavior:'instant'});target?.focus({preventScroll:true});}}>{s.title}</a>)}</nav>
    {sections.map(s => <section className={`brief-section meeting-section${s.key === 'unknowns' ? ' meeting-open-questions' : ''}`} id={`meeting-${s.key}`} tabIndex={-1} key={s.key}><h3>{s.title}</h3>{s.paragraphs.length ? paragraphs(s.paragraphs) : <p className="muted">Not recorded in this draft. Confirm it before planning the collaboration.</p>}</section>)}
    <section className="brief-section brief-review"><div className="section-heading"><h3>{matchedReview?.verdict === 'approve' ? 'Review notes' : 'What needs resolving'}</h3><button className="text-button" onClick={onReview}>Read review</button></div>
      {matchedReview ? <><p className="small muted">Review v{matchedReview.version} · {matchedReview.findings.filter(f => f.severity === 'blocking').length} blocking · {matchedReview.findings.filter(f => f.severity !== 'blocking').length} advisory</p>{[...matchedReview.findings].sort((a, b) => Number(b.severity === 'blocking') - Number(a.severity === 'blocking')).map((finding, index) => <details key={finding.id} className="brief-finding" open={finding.severity === 'blocking'}><summary>{finding.severity === 'blocking' ? 'Blocking' : 'Advisory'} review point {index + 1}{finding.claimIds.length ? ` · ${finding.claimIds.join(', ')}` : ''}</summary><Finding finding={finding} onEvidence={onEvidence} /></details>)}{!matchedReview.findings.length ? <p>No findings recorded for this draft.</p> : null}</> : <p className="muted">{terminal ? "No review saved for this draft." : "No review saved for this draft yet."}</p>}
      {!matchedReview && review ? <div className="notice warning"><p>Draft v{draft.version} is unreviewed. The latest saved review targets draft v{review.target.draftVersion}.</p><button className="text-button" onClick={onReview}>Read the earlier findings</button></div> : null}
      {!matchedReview && terminal ? <p className="small muted">This analysis has ended. No further review is running.</p> : null}
    </section>
  </article>;
}
