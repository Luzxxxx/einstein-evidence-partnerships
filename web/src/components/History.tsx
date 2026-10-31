import { useEffect, useState } from 'react';
import { api, errorCopy } from '../api.js';
import { runPresentation } from '../state.js';
import type { Catalog, RunHistory } from '../types.js';
import { Icon } from './Icons.js';

export function History({ catalog }: { catalog: Catalog | null }) {
  const [data, setData] = useState<RunHistory | null>(null), [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(null); setData(null);
    void api.history(controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(errorCopy(reason).message); });
    return () => controller.abort();
  }, [reload]);
  return <section className="saved-history" aria-label="Saved analyses">
    <div className="section-heading"><h2>Saved analyses{data ? <span className="count-tag">{data.total}</span> : null}</h2><button className="button secondary compact" onClick={() => setReload(value => value + 1)}>Refresh history</button></div>
    {error ? <div className="notice error" role="alert">{error}</div> : !data ? <p role="status">Loading history…</p> : !data.runs.length ? <div className="inline-empty"><Icon name="book" size={28} /><h3>No saved analyses</h3><p>Your analyses will appear here.</p><a className="button secondary" href="#analyze">Choose a challenge</a></div> : <>
      {data.total > data.limit ? <p className="small muted">Showing the {data.limit} most recent. Older runs remain available by ID.</p> : null}
      <div className="history-list">{data.runs.map(run => {
        const company = catalog?.companies.find(value => value.id === run.input.companyId);
        const challenge = company?.challenges.find(value => value.id === run.input.challengeId), state = runPresentation(run, data.blockedRunIds?.includes(run.runId) ?? data.blockedByService);
        return <a className="history-card" key={run.runId} href={`#run=${run.runId}`}><div><div className="history-heading"><h3>{company?.name ?? run.input.companyId}</h3><span className={`badge ${state.tone}`}>{state.title}</span>{state.label ? <span className="badge diagnostic">{state.label}</span> : null}</div><p>{challenge?.text ?? run.input.challengeId}</p><span className="small muted">{run.input.challengeId} · <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</time></span></div><Icon name="chevron" size={20} /></a>;
      })}</div>
    </>}
  </section>;
}
