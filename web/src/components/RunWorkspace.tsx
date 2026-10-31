import { useEffect, useMemo, useState } from 'react';
import type { RunRecord } from '../../../src/contracts/domain.js';
import type { Catalog } from '../types.js';
import { api, errorCopy } from '../api.js';
import { answerDiagnostics, emptyResult, isTerminal, publicationVisible, runPresentation } from '../state.js';
import { useRun } from '../useRun.js';
import { DecisionBrief } from './DecisionBrief.js';
import { ProposalView } from './ProposalView.js';
import { ReviewPanel } from './ReviewPanel.js';
import { DecisionEvolution } from './DecisionEvolution.js';
import { EvidenceInspector } from './EvidenceInspector.js';
import { Timeline } from './Timeline.js';
import { Icon } from './Icons.js';
import { briefPublicationReady, type ReadingView } from '../reading.js';
import './reading.css';

export function RunWorkspace({ runId, initialView = 'overview', catalog, onSeen }: { runId: string; initialView?: ReadingView; catalog: Catalog | null; onSeen: (run: RunRecord) => void }) {
  const { run, artifacts, events, reasonCodes, blockedByService, connection, error, artifactError, reconnect } = useRun(runId);
  const [tab, setTab] = useState<ReadingView>(initialView), [version, setVersion] = useState<number | null>(null), [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false), [cancelError, setCancelError] = useState<ReturnType<typeof errorCopy> | null>(null);
  useEffect(() => { if (run) onSeen(run); }, [run, onSeen]);
  const drafts = useMemo(() => artifacts?.artifacts.filter(a => a.kind === 'proposal_draft').map(a => a.artifact).sort((a, b) => a.version - b.version) ?? [], [artifacts]);
  const reviews = useMemo(() => artifacts?.artifacts.filter(a => a.kind === 'critic_review').map(a => a.artifact).sort((a, b) => a.version - b.version) ?? [], [artifacts]);
  const counters = useMemo(() => artifacts?.artifacts.filter(a => a.kind === 'counter_report').map(a => a.artifact) ?? [], [artifacts]);
  const reasons = reasonCodes.length ? reasonCodes : [...new Set(events.flatMap(e => e.payload.kind === 'run_status' && isTerminal(e.payload.status) ? e.payload.reasonCodes : e.type === 'task.failed' && e.payload.kind === 'task' ? [e.payload.code] : []))];
  const validations = answerDiagnostics(events);
  const draft = drafts.find(d => d.version === version) ?? drafts.at(-1);
  const overviewDraft = drafts.at(-1), overviewReview = reviews.at(-1);
  const company = catalog?.companies.find(c => c.id === run?.input.companyId), challenge = company?.challenges.find(c => c.id === run?.input.challengeId);
  const cancel = async () => {
    if (cancelling) return; setCancelling(true); setCancelError(null);
    try { await api.cancel(runId); reconnect(); } catch (e) { setCancelError(errorCopy(e)); if (errorCopy(e).code === 'RUN_TERMINAL') reconnect(); }
    finally { setCancelling(false); }
  };
  if (!run) return <section className="page-content">{error ? <div className="notice error" role="alert"><h1>Run unavailable</h1><p>{error.message}</p><details className="technical"><summary>Technical details</summary><code>{error.code}</code><p>{runId}</p></details><button className="button secondary" onClick={reconnect}>Reload run</button></div> : <p className="loading-line" role="status">Loading the saved run…</p>}</section>;
  const state = runPresentation(run, blockedByService), terminal = isTerminal(run.status), published = publicationVisible(run, artifacts);
  const placeholder = emptyResult(run, artifacts !== null, artifactError !== null, blockedByService);
  return <div className="run-workspace">
    <header className="run-heading"><div className="run-breadcrumb"><a href="#analyze">Workspace</a><span>/</span><span>{run.input.challengeId}</span></div><div className="section-heading"><h1>{company?.name ?? run.input.companyId}</h1><div className="run-badges">{state.label ? <span className="badge diagnostic">{state.label}</span> : terminal ? <span className="badge neutral">Replay</span> : null}{published ? <span className="badge success">Published</span> : null}</div></div>{challenge ? <details className="challenge-context"><summary>View the original challenge</summary><p>{challenge.text}</p>{challenge.detail ? <p>{challenge.detail}</p> : null}</details> : null}</header>
    <section className={`run-status ${state.tone}`} aria-live="polite"><div><span className={`status-dot ${state.tone}`} /><div><h2>{state.title}</h2><p>{state.description}</p></div></div>{!terminal && !blockedByService ? <button className="button secondary compact" onClick={cancel} disabled={cancelling}><Icon name="stop" size={16} />{cancelling ? 'Cancelling…' : 'Cancel analysis'}</button> : null}</section>
    {state.label === 'Diagnostic / Replay' ? <p className="diagnostic-note">Recorded adversarial test. This result is not a formal research proposal.</p> : state.label === 'Offline fixture' ? <p className="diagnostic-note">Controlled offline test. No real model requests or matching-quality claims.</p> : null}
    {(error || cancelError) ? <div className="notice warning" role="status"><p>{(cancelError ?? error)?.message}</p><details className="technical"><summary>Connection details</summary><code>{(cancelError ?? error)?.code}</code></details>{connection === 'paused' ? <button className="button secondary compact" onClick={reconnect}>Reconnect activity</button> : null}</div> : null}
    <div className="run-summary"><span>{events.length} saved events</span><span>{drafts.length} draft {drafts.length === 1 ? 'version' : 'versions'}</span><span>{reviews.length} {reviews.length === 1 ? 'review' : 'reviews'}</span><span className="connection-indicator">{connection === 'recorded' ? 'Saved replay' : connection === 'connected' ? 'Activity connected' : connection === 'paused' ? 'Connection paused' : 'Checking activity…'}</span></div>
    <details className="technical run-details"><summary>Run details{run.status === 'failed' ? ' and failure reason' : ''}</summary><dl className="metadata"><dt>Run ID</dt><dd>{run.runId}</dd><dt>Authoritative status</dt><dd>{run.status}</dd><dt>Cleanup</dt><dd>{run.cleanupState}</dd><dt>Run mode</dt><dd>{run.input.mode}</dd><dt>Runner</dt><dd>{run.runnerMode}</dd><dt>Recorded reason codes</dt><dd>{reasons.length ? reasons.join(', ') : 'No reason code in the loaded trace.'}</dd></dl>{reasons.includes('INVALID_TASK_ANSWER') && !validations.length ? <p className="small muted">The recorded answer did not pass validation. No further details are available in the loaded trace; the specific cause is unknown.</p> : null}{validations.length ? <details className="technical"><summary>Recorded answer validation</summary>{validations.map((diagnostic, i) => <pre key={i}>{JSON.stringify(diagnostic, null, 2)}</pre>)}</details> : null}</details>
    <nav className="result-tabs" aria-label="Run views">{[['overview', 'Overview'], ['proposal', 'Proposal'], ['review', 'Review'], ['changes', 'Changes'], ['activity', 'Activity']].map(([key, text]) => <button key={key} aria-label={text} aria-current={tab === key ? 'page' : undefined} className={tab === key ? 'selected' : ''} onClick={() => setTab(key as ReadingView)}>{text}{key === 'review' && reviews.length ? <span aria-hidden="true">{reviews.length}</span> : null}</button>)}</nav>
    {artifactError ? <div className="notice warning" role="alert"><p>Saved artifacts could not be loaded.</p><details className="technical"><summary>Technical details</summary><code>{artifactError.code}</code></details><button className="button secondary compact" onClick={reconnect}>Reload saved result</button></div> : null}
    <div className="result-content">
      {tab === 'overview' ? overviewDraft ? <DecisionBrief published={briefPublicationReady(overviewDraft, overviewReview, run, published)} challenge={challenge} terminal={terminal || blockedByService} draft={overviewDraft} review={overviewReview} researcherName={artifacts?.display?.researcherNames[overviewDraft.pair.researcherId]} onEvidence={setEvidenceId} onProposal={() => { setVersion(null); setTab('proposal'); }} onReview={() => setTab('review')} /> : <div className="inline-empty"><h2>{placeholder.title}</h2><p>{placeholder.message}</p><button className="button secondary" onClick={() => setTab('activity')}>View activity</button></div> : null}
      {tab === 'proposal' ? draft ? <>{drafts.length > 1 ? <div className="version-control"><label htmlFor="draft-version">Read draft</label><select id="draft-version" value={draft.version} onChange={e => setVersion(Number(e.target.value))}>{drafts.map(d => <option value={d.version} key={d.version}>Version {d.version}</option>)}</select></div> : null}<ProposalView draft={draft} companyName={artifacts?.display?.companyName ?? company?.name} researcherName={artifacts?.display?.researcherNames[draft.pair.researcherId]} published={published && draft.draftHash === run.publishedDraftHash} onEvidence={setEvidenceId} /></> : <div className="inline-empty"><span className="empty-symbol"><Icon name={terminal ? 'book' : 'activity'} size={30} /></span><h2>{placeholder.title}</h2><p>{placeholder.message}</p><button className="button secondary" onClick={() => setTab('activity')}>View activity</button></div> : null}
      {tab === 'review' ? <ReviewPanel reviews={reviews} counters={counters} onEvidence={setEvidenceId} /> : null}
      {tab === 'changes' ? <DecisionEvolution runId={runId} diff={artifacts?.revisionDiff ?? null} drafts={drafts} reviews={reviews} status={run.status} onEvidence={setEvidenceId} /> : null}
      {tab === 'activity' ? <Timeline events={events} terminal={terminal || blockedByService} /> : null}
    </div>
    {evidenceId ? <EvidenceInspector key={`${runId}:${evidenceId}`} runId={runId} evidenceId={evidenceId} onClose={() => setEvidenceId(null)} /> : null}
  </div>;
}
