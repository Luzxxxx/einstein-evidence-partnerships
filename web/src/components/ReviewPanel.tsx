import type { CounterReport, CriticReview, ReviewFinding } from '../../../src/contracts/domain.js';
import { EvidenceLinks } from './ProposalView.js';

export function Finding({ finding, onEvidence }: { finding: ReviewFinding; onEvidence: (id: string) => void }) {
  return <article className={`finding ${finding.severity}`}><header><span className={`badge ${finding.severity === 'blocking' ? 'warning' : 'neutral'}`}>{finding.severity === 'blocking' ? 'Blocking' : 'Advisory'}</span><span className="id-text">{finding.code}</span></header><p>{finding.explanation}</p>{finding.recheckQuestion ? <div className="recheck"><strong>Recheck requested</strong><p>{finding.recheckQuestion}</p></div> : null}<p className="small muted">{finding.claimIds.length ? `Claims: ${finding.claimIds.join(', ')}` : 'Run-level finding'}</p><EvidenceLinks ids={finding.evidenceIds} onEvidence={onEvidence} /></article>;
}
export function ReviewPanel({ reviews, counters, onEvidence }: { reviews: CriticReview[]; counters: CounterReport[]; onEvidence: (id: string) => void }) {
  const ordered = [...reviews].sort((a, b) => b.version - a.version);
  const round = (review: CriticReview) => <section className="review-round" key={review.hash}><header className="section-heading"><h3>Review v{review.version}</h3><span className={`badge ${review.verdict === 'approve' ? 'success' : 'warning'}`}>{review.verdict === 'approve' ? 'Approve' : review.verdict === 'revise' ? 'Revise' : 'Insufficient'}</span></header>
      <p className="small muted">Draft v{review.target.draftVersion}</p>
      {review.findings.length ? review.findings.map(f => <Finding key={f.id} finding={f} onEvidence={onEvidence} />) : <p>No findings were recorded in this review.</p>}
      <details className="technical"><summary>Exact review target</summary><dl className="metadata"><dt>Review ID</dt><dd>{review.id}</dd><dt>Review SHA-256</dt><dd>{review.hash}</dd>{Object.entries(review.target).map(([key, value]) => <div className="metadata-row" key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></details>
    </section>;
  return <div className="reading-panel"><h2>Independent review</h2>
    {!ordered.length ? <div className="inline-empty"><h3>No review saved yet</h3></div> : <>{round(ordered[0]!)}{ordered.slice(1).map(review => <details className="earlier-review" key={review.hash}><summary>Earlier review v{review.version}</summary>{round(review)}</details>)}</>}
    <section className="counter-section"><h2>Counter-evidence</h2>{!counters.length ? <p className="muted">No counter-report has been saved.</p> : counters.map(counter => <article key={counter.hash}><h3>Counter-report v{counter.version}</h3><p className="small muted">Checked candidates: {counter.checkedCandidates.join(', ')}</p><details><summary>Checked facets</summary><ul>{counter.checkedFacets.map((text, i) => <li key={i}>{text}</li>)}</ul></details>{counter.findings.map(f => <Finding key={f.id} finding={f} onEvidence={onEvidence} />)}{counter.noCounterEvidenceFound.length ? <div className="absence-note"><h4>Checked, with no counter-evidence found</h4><ul>{counter.noCounterEvidenceFound.map((text, i) => <li key={i}>{text}</li>)}</ul><p className="small muted">A recorded absence is not proof that no counter-evidence exists.</p></div> : null}<details className="technical"><summary>Counter-report identity</summary><dl className="metadata"><dt>ID</dt><dd>{counter.id}</dd><dt>SHA-256</dt><dd>{counter.hash}</dd></dl></details></article>)}</section>
  </div>;
}
