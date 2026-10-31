import {Icon} from './Icons.js';
import './public-showcase.css';

export function PublicShowcaseHero({count, loading, firstRunId, query, onQuery}: {
  count: number; loading: boolean; firstRunId?: string; query: string; onQuery: (query: string) => void;
}) {
  const first = firstRunId ? `#run=${firstRunId}` : '#proposal-collection';
  return <div className="proof-hero">
    <a className="proof-note proof-blue" href={first}>
      <span className="proof-pill">Research fit</span><h2>A promising<br />starting point.</h2>
      <p>A company challenge. A research direction. Evidence connecting the two.</p>
      <div className="proof-connection" aria-hidden="true"><span>Industry</span><span className="proof-dotted-line" /><Icon name="source" size={22} /><span className="proof-dotted-line" /><span>Research</span></div>
    </a>
    <div className="proof-center">
      <p className="proof-handnote">Good questions. Better connections.</p>
      <h1 id="showcase-heading">who’s your next<br />research partner?</h1>
      <p className="proof-lead">Find the fit. Challenge the claim.<br />Read the evidence for yourself.</p>
      <label className="proof-search"><span className="sr-only">Search saved proposals</span><Icon name="search" size={20} /><input type="search" value={query} onChange={event=>onQuery(event.target.value)} placeholder="Search saved proposals…" autoComplete="off" /></label>
      <a className="proof-main-action" href="#proposal-collection">Explore the proposals <span><Icon name="arrow" size={20} /></span></a>
      <p className="proof-caption">Real saved runs. No API key needed.</p>
    </div>
    <a className="proof-note proof-peach" href="#proposal-collection">
      <span className="proof-pill">Saved results</span><h2>Ready to inspect.</h2>
      <div className="proof-big-number"><strong>{loading ? '—' : count}</strong><span>published<br />partnerships</span></div>
      <p>Source evidence, review decisions and a pilot plan for every pair.</p>
    </a>
    <a className="proof-note proof-mint" href="#run=b738ce31-0d8d-4eba-a01e-f4deac26a632&view=changes">
      <span className="proof-pill">Independent review</span><h2>Ask the difficult<br />questions.</h2>
      <p>A Critic can request changes or withhold approval. See a real revision.</p>
      <span className="proof-card-link">Follow the review <Icon name="arrow" size={17} /></span>
    </a>
    <a className="proof-note proof-lavender" href={first}>
      <span className="proof-pill">Evidence</span><h2>Go straight<br />to the source.</h2>
      <p>Original records, exact excerpts and the saved trail behind each recommendation.</p>
      <span className="proof-card-link"><Icon name="source" size={17} /> Open a proposal’s citations</span>
    </a>
  </div>;
}
