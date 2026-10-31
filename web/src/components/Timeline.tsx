import { useMemo, useState } from 'react';
import type { StoredEvent } from '../../../src/contracts/events.js';
import { eventLabel, requestSpans, roleNames } from '../state.js';

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
export function Timeline({ events, terminal }: { events: readonly StoredEvent[]; terminal: boolean }) {
  const [role, setRole] = useState('all'), [limit, setLimit] = useState(60);
  const spans = useMemo(() => requestSpans(events), [events]);
  const extent = Math.max(1, ...events.map(e => e.elapsedMs));
  const filtered = role === 'all' ? events : events.filter(e => (e.role ?? 'supervisor') === role);
  const visible = filtered.slice(-limit);
  let overlap = 0;
  for (const a of spans.filter(s => s.role === 'proposer' && s.endMs !== null))
    for (const b of spans.filter(s => s.role === 'counter-evidence' && s.endMs !== null))
      overlap = Math.max(overlap, Math.min(a.endMs!, b.endMs!) - Math.max(a.startMs, b.startMs));
  return <section className="reading-panel"><div className="section-heading"><div><h2>Recorded activity</h2><p className="muted">{events.length} saved events. No simulated progress.</p></div><span className="badge neutral">{terminal ? 'Replay' : 'Live events'}</span></div>
    <div className="agent-lanes">{Object.entries(roleNames).map(([key, name]) => {
      const started = events.filter(e => e.role === key && e.type === 'task.started').at(-1);
      const completed = started && events.some(e => e.contextId === started.contextId && e.taskId === started.taskId && e.seq > started.seq && e.type === 'task.completed');
      const failed = started && events.some(e => e.contextId === started.contextId && e.taskId === started.taskId && e.seq > started.seq && e.type === 'task.failed');
      return <div className={`agent-lane ${key}`} key={key}><div><strong>{name}</strong><span className="small muted">{failed ? 'Task failed' : completed ? 'Task saved' : started ? terminal ? 'No completion recorded' : 'Task started' : 'Not started'}</span></div><div className="request-track" aria-label={`${name} request intervals`}>{spans.filter(s => s.role === key).map(s => <span className={`request-span ${s.endMs === null ? 'open' : ''} ${s.failed ? 'failed' : ''}`} key={s.requestId} style={{ left: `${100 * s.startMs / extent}%`, width: s.endMs === null ? '2px' : `${Math.max(0.3, 100 * (s.endMs - s.startMs) / extent)}%` }} title={`${s.requestId}: ${seconds(s.startMs)}${s.endMs === null ? ', no end recorded' : ` to ${seconds(s.endMs)}`}`} />)}</div></div>;
    })}</div>
    <p className="small muted">{spans.length ? `Observed request overlap: ${seconds(overlap)}. Parent-recorded client intervals; open intervals are shown as ticks.` : 'Request intervals appear when model activity is saved.'}</p>
    <div className="timeline-toolbar"><label htmlFor="activity-role">Show activity</label><select id="activity-role" value={role} onChange={e => { setRole(e.target.value); setLimit(60); }}><option value="all">All participants</option>{Object.entries(roleNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}<option value="supervisor">Supervisor</option></select></div>
    {!events.length ? <div className="inline-empty"><h3>No saved events yet</h3><p>The timeline will show activity after it has been persisted.</p></div> : <ol className="event-list">{visible.map(e => <li key={e.seq}><span className="event-seq">{e.seq}</span><div className="event-content"><div className="event-title"><strong>{eventLabel(e)}</strong><time>{seconds(e.elapsedMs)}</time></div><div className="event-meta"><span>{e.role ? roleNames[e.role] : 'Supervisor'}</span><span>{e.source === 'mozaik' ? 'Mozaik native' : e.source === 'application' ? 'Application' : e.source === 'model' ? 'Model request' : 'Supervisor'}</span></div><details className="technical"><summary>Event details</summary><pre>{JSON.stringify(e, null, 2)}</pre></details></div></li>)}</ol>}
    {filtered.length > limit ? <button className="button secondary" onClick={() => setLimit(n => n + 100)}>Show earlier events ({filtered.length - limit})</button> : null}
  </section>;
}
