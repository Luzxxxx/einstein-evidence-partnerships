import type { Catalog, ShowcaseEntry } from '../types.js';
import { Icon } from './Icons.js';

export function Showcase({ entries, catalog, loading, error, onRetry }: {
  entries: ShowcaseEntry[]; catalog: Catalog | null; loading: boolean; error: string | null; onRetry: () => void;
}) {
  return <section className="page-content" aria-labelledby="showcase-heading">
    <div className="page-heading"><div><h1 id="showcase-heading">Research proposals</h1><p>Reviewed partnerships, with the evidence behind each decision.</p></div><span className="count-tag">{entries.length} available</span></div>
    {loading ? <p role="status" className="loading-line">Loading proposals…</p> : error ? <div className="notice error" role="alert"><p>{error}</p><button className="button secondary" onClick={onRetry}>Reload proposals</button></div> : entries.length === 0 ?
      <div className="empty-state"><span className="empty-symbol"><Icon name="book" size={36} /></span><h2>No proposals yet</h2><p>Approved research proposals will appear here.<br />Start an analysis or open a recorded run.</p><a className="button secondary" href="#analyze">Choose a challenge</a></div> :
      <div className="proposal-grid">{entries.map(entry => {
        const company = catalog?.companies.find(c => c.id === entry.companyId), challenge = company?.challenges.find(c => c.id === entry.challengeId);
        return <a className="proposal-card" key={entry.pairKey} href={`#run=${entry.runId}`}><span className="badge success">Published</span><h2>{entry.companyName ?? company?.name ?? entry.companyId}</h2><p className="pair-label">{entry.researcherName ?? entry.researcherId}</p><p>{challenge?.text ?? entry.challengeId}</p><footer><span>Reviewed draft v{entry.draftVersion}</span><span className="link-text">Read proposal <Icon name="chevron" size={16} /></span></footer></a>;
      })}</div>}
  </section>;
}
