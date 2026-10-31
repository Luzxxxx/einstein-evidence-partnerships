import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunRecord } from '../../src/contracts/domain.js';
import type { Catalog, ShowcaseEntry } from './types.js';
import { api, errorCopy, validRunId } from './api.js';
import { ChallengePicker } from './components/ChallengePicker.js';
import { RunWorkspace } from './components/RunWorkspace.js';
import { Showcase } from './components/Showcase.js';
import { History } from './components/History.js';
import { BrandMark, Icon } from './components/Icons.js';
import './styles.css';
import { savedDemo, demoAssetPath } from './saved-demo.js';

function readRoute() {
  const hash = window.location.hash.slice(1);
  return hash.startsWith('run=') ? { page: 'run', id: hash.slice(4) } : { page: hash === 'showcase' ? 'showcase' : hash === 'replay' ? 'replay' : savedDemo ? 'showcase' : 'analyze', id: '' };
}

function ReplayForm({ compact = false }: { compact?: boolean }) {
  const [id, setId] = useState(''), [error, setError] = useState(false);
  const inputId = compact ? 'sidebar-run-id' : 'recorded-run-id';
  return <form className={compact ? 'replay-form compact-replay' : 'replay-form'} onSubmit={e => {
    e.preventDefault(); const value = id.trim().toLowerCase();
    if (!validRunId(value)) { setError(true); return; }
    setError(false); window.location.hash = `run=${value}`;
  }}><label htmlFor={inputId}>{compact ? 'Open a recorded run' : 'Recorded Run ID'}</label><div className="replay-input"><input id={inputId} value={id} onChange={e => { setId(e.target.value); setError(false); }} placeholder="Paste a Run ID" spellCheck={false} autoComplete="off" aria-invalid={error || undefined} aria-describedby={error ? `${inputId}-error` : undefined} /><button className={compact ? 'icon-button' : 'button primary'} type="submit" aria-label="Open replay">{compact ? <Icon name="arrow" size={18} /> : 'Open replay'}</button></div>{error ? <p className="field-error" id={`${inputId}-error`} role="alert">Enter a valid Run ID.</p> : null}</form>;
}

export default function App() {
  const [route, setRoute] = useState(readRoute);
  const [catalog, setCatalog] = useState<Catalog | null>(null), [showcase, setShowcase] = useState<ShowcaseEntry[]>([]);
  const [catalogError, setCatalogError] = useState<ReturnType<typeof errorCopy> | null>(null), [showcaseError, setShowcaseError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [reload, setReload] = useState(0);
  const [showcaseLoading, setShowcaseLoading] = useState(true);
  const showcaseRequested = useRef(false);
  const [companyId, setCompanyId] = useState(''), [challengeId, setChallengeId] = useState('');
  const [creating, setCreating] = useState(false), [createError, setCreateError] = useState<ReturnType<typeof errorCopy> | null>(null);
  const [recent, setRecent] = useState<RunRecord[]>([]);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const createInFlight = useRef(false);

  useEffect(() => { const changed = () => setRoute(readRoute()); window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setCatalogError(null);
    void api.catalog(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setCatalog(value);
      setCompanyId(previous => previous || value.companies[0]?.id || '');
      setChallengeId(previous => previous || value.companies[0]?.challenges[0]?.id || '');
    }).catch(e => { if (!controller.signal.aborted) setCatalogError(errorCopy(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => {
    if (route.page !== 'showcase' && showcaseRequested.current) return;
    showcaseRequested.current = true;
    const controller = new AbortController(); setShowcaseLoading(true); setShowcaseError(null);
    void api.showcase(controller.signal).then(value => { if (!controller.signal.aborted) setShowcase(value); })
      .catch(e => { if (!controller.signal.aborted) setShowcaseError(errorCopy(e).message); })
      .finally(() => { if (!controller.signal.aborted) setShowcaseLoading(false); });
    return () => controller.abort();
  }, [route.page, reload]);
  useEffect(() => { document.title = route.page === 'run' ? 'Run | ProofBridge' : route.page === 'showcase' ? 'Proposals | ProofBridge' : route.page === 'replay' ? 'History | ProofBridge' : 'Research workspace | ProofBridge'; }, [route.page]);
  useEffect(() => {
    setMobileControlsOpen(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [route.page, route.id]);
  const onSeen = useCallback((run: RunRecord) => setRecent(values => [run, ...values.filter(v => v.runId !== run.runId)].slice(0, 8)), []);
  const company = catalog?.companies.find(c => c.id === companyId), challenge = company?.challenges.find(c => c.id === challengeId);
  const create = async () => {
    if (createInFlight.current || !catalog?.newRunsAvailable || !company || !challenge) return;
    createInFlight.current = true; setCreating(true); setCreateError(null);
    try { const run = await api.create(company.id, challenge.id); onSeen(run); window.location.hash = `run=${run.runId}`; }
    catch (e) { const failure = errorCopy(e); setCreateError(failure.code === 'SERVICE_UNAVAILABLE' ? { ...failure, message: 'Run creation could not be confirmed. Check the service before trying again.' } : failure); }
    finally { createInFlight.current = false; setCreating(false); }
  };
  return <>
    <a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
    <header className={`app-header${savedDemo ? ' proof-header' : ''}`}><a href={savedDemo ? '#showcase' : '#analyze'} className="brand" aria-label="ProofBridge home"><BrandMark /><span><strong>ProofBridge</strong><span>Science to business</span></span></a><nav className="main-nav" aria-label="Main navigation">{!savedDemo ? <a className={route.page === 'analyze' || route.page === 'run' ? 'selected' : ''} href="#analyze">Analyze</a> : null}<a className={route.page === 'showcase' ? 'selected' : ''} href="#showcase">Proposals<span className="nav-count">{showcase.length}</span></a><a className={route.page === 'replay' ? 'selected' : ''} href="#replay">History</a>{savedDemo ? <a href={demoAssetPath('guide.html')}>How it works</a> : null}</nav><span className="local-label"><span className={`status-dot ${catalogError ? 'error' : loading ? 'neutral' : 'success'}`} />{catalogError ? 'Service unavailable' : savedDemo ? 'Saved demo' : 'Local workspace'}</span></header>
    {savedDemo ? <div className="saved-demo-note"><span>Explore real saved results. No API key needed.</span><a href={demoAssetPath('guide.html')}>Run your own analysis <Icon name="arrow" size={14} /></a></div> : null}
    <div className={`app-layout ${savedDemo ? 'saved-demo-layout' : ''} ${route.page !== 'analyze' ? 'reading-view' : ''} ${mobileControlsOpen ? 'controls-open' : ''}`}>
    {!savedDemo && route.page !== 'analyze' ? <button className="mobile-controls-toggle" aria-expanded={mobileControlsOpen} aria-controls="analysis-controls" onClick={() => setMobileControlsOpen(v => !v)}><Icon name="search" size={16} />{mobileControlsOpen ? 'Hide analysis controls' : 'Show analysis controls'}</button> : null}
    {!savedDemo ? <aside className="sidebar" id="analysis-controls" aria-label="Analysis controls">
      {catalog ? <ChallengePicker catalog={catalog} companyId={companyId} challengeId={challengeId} onCompany={id => { setCompanyId(id); setChallengeId(catalog.companies.find(c => c.id === id)?.challenges[0]?.id ?? ''); setCreateError(null); }} onChallenge={id => { setChallengeId(id); setCreateError(null); }} creating={creating} onCreate={() => void create()} /> : <section className="sidebar-loading">{loading ? <p role="status">Loading companies…</p> : <><h2>Companies unavailable</h2><p className="small muted">{catalogError?.message}</p><button className="button secondary" onClick={() => setReload(n => n + 1)}>Reload companies</button></>}</section>}
      {createError ? <div className="notice error" role="alert"><p>{createError.message}</p><details className="technical"><summary>Technical details</summary><code>{createError.code}</code></details></div> : null}
      <section className="sidebar-replay"><ReplayForm compact />{recent.length ? <div className="recent-runs"><h3>Opened this session</h3>{recent.map(run => <a className={route.id === run.runId ? 'selected' : ''} key={run.runId} href={`#run=${run.runId}`}><span>{run.input.challengeId}</span><span className="small muted">{run.status}</span></a>)}</div> : null}</section>
      <footer className="sidebar-footer"><Icon name="book" size={16} /><span>Official synthetic dataset<br /><span className="small">Evidence remains traceable to its source.</span></span></footer>
    </aside> : null}
    <main id="main-content" className="main-content" tabIndex={-1}>
      {route.page === 'run' ? <RunWorkspace key={route.id} runId={route.id} catalog={catalog} onSeen={onSeen} /> : null}
      {route.page === 'showcase' ? <Showcase entries={showcase} catalog={catalog} loading={showcaseLoading} error={showcaseError} onRetry={() => setReload(n => n + 1)} /> : null}
      {route.page === 'replay' ? <section className="page-content replay-page"><div className="page-heading"><div><h1>Analysis history</h1><p>Revisit the evidence, decisions and next steps.</p></div></div><History catalog={catalog} /><details className="history-lookup"><summary>Open an older run by ID</summary><ReplayForm /></details></section> : null}
      {route.page === 'analyze' ? <section className="page-content analyze-page"><div className="page-heading"><div><h1>Find a research partner.</h1><p>Match a company challenge with research, evidence and a pilot plan.</p></div></div>
        <section className="selected-challenge"><div className="section-heading"><h2>Your starting point</h2>{challenge ? <span className="id-text">{challenge.id}</span> : null}</div>{challenge ? <><h3>{company?.name}</h3><p className="challenge-quote">{challenge.text}</p>{challenge.detail ? <details className="challenge-context"><summary>Read the complete challenge</summary><p>{challenge.detail}</p></details> : null}</> : <p>Choose a company and challenge from the panel.</p>}</section>
        <section className="process-intro"><h2>Three perspectives. One traceable decision.</h2><div className="process-steps"><article><span className="process-marker proposer" /><h3>Proposer</h3><p>Connects the challenge to research and builds a sourced draft.</p></article><article><span className="process-marker counter" /><h3>Counter-evidence</h3><p>Checks the limits, conflicts and reasons the match may fail.</p></article><article><span className="process-marker critic" /><h3>Critic</h3><p>Challenges the draft and can request a recheck or withhold approval.</p></article></div></section>
        <div className="workspace-note"><Icon name="source" /><p>Read the sources and review alongside the recommendation. A run may end without a proposal.</p></div>
      </section> : null}
    </main></div>
  </>;
}
