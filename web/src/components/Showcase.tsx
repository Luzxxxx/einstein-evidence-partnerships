import type { Catalog, ShowcaseEntry } from '../types.js';
import { Icon } from './Icons.js';
import { useState } from 'react';
import { savedDemo } from '../saved-demo.js';
import { filterShowcaseEntries } from '../showcase-search.js';
import { PublicShowcaseHero } from './PublicShowcaseHero.js';
import { ReadingGuide } from './ReadingGuide.js';

export function Showcase({ entries, catalog, loading, error, onRetry }: {
  entries: ShowcaseEntry[]; catalog: Catalog | null; loading: boolean; error: string | null; onRetry: () => void;
}) {
  const [query, setQuery] = useState('');
  const visible = savedDemo ? filterShowcaseEntries(entries, catalog, query) : entries;
  return <section className={`page-content${savedDemo ? ' proof-page' : ''}`} aria-labelledby="showcase-heading">
    {savedDemo ? <PublicShowcaseHero count={entries.length} loading={loading} firstRunId={entries[0]?.runId} query={query} onQuery={setQuery} /> : null}
    {savedDemo ? <ReadingGuide firstRunId={entries[0]?.runId} /> : null}
    <div className="page-heading" id="proposal-collection"><div>{savedDemo ? <h2>Partnerships, with the receipts.</h2> : <h1 id="showcase-heading">Research proposals</h1>}<p>Reviewed partnerships, with the evidence behind each decision.</p></div><span className="count-tag">{visible.length} available</span></div>
    {loading ? <p role="status" className="loading-line">Loading proposals…</p> : error ? <div className="notice error" role="alert"><p>{error}</p><button className="button secondary" onClick={onRetry}>Reload proposals</button></div> : entries.length === 0 ?
      <div className="empty-state"><span className="empty-symbol"><Icon name="book" size={36} /></span><h2>No proposals yet</h2><p>Approved research proposals will appear here.<br />Start an analysis or open a recorded run.</p><a className="button secondary" href="#analyze">Choose a challenge</a></div> :
      !visible.length ? <div className="inline-empty"><h2>No saved proposals match that search</h2><p>Try a company name, researcher name or challenge keyword.</p><button className="button secondary" onClick={()=>setQuery('')}>Show all proposals</button></div> : <div className="proposal-grid">{visible.map(entry => {
        const company = catalog?.companies.find(c => c.id === entry.companyId), challenge = company?.challenges.find(c => c.id === entry.challengeId);
        return <a className="proposal-card" key={entry.pairKey} href={`#run=${entry.runId}`}><span className="badge success">Published</span><h2>{entry.companyName ?? company?.name ?? entry.companyId}</h2><p className="pair-label">{entry.researcherName ?? entry.researcherId}</p><p>{challenge?.text ?? entry.challengeId}</p><footer><span>Reviewed draft v{entry.draftVersion}</span><span className="link-text">Read proposal <Icon name="chevron" size={16} /></span></footer></a>;
      })}</div>}
    {savedDemo ? <><p className="proof-collection-note">Official synthetic dataset. Proposed pilots, with conditions to confirm. These are not completed business deployments.</p><section className="proof-story"><div><h2>A good answer can be “not yet.”</h2><p>Watch a real research proposal change after independent review, then stop at insufficient evidence. Every draft and finding remains available.</p></div><a href="#run=b738ce31-0d8d-4eba-a01e-f4deac26a632&view=changes">Read the review story</a></section></> : null}
  </section>;
}
