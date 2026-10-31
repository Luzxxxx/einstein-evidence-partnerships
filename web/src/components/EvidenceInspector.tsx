import { useEffect, useRef, useState } from 'react';
import type { EvidenceResponse } from '../types.js';
import { api, errorCopy } from '../api.js';
import { sourceHighlight } from '../state.js';
import { Icon } from './Icons.js';

export function EvidenceInspector({ runId, evidenceId, onClose }: { runId: string; evidenceId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [data, setData] = useState<EvidenceResponse | null>(null), [error, setError] = useState<ReturnType<typeof errorCopy> | null>(null);
  useEffect(() => {
    const current = dialog.current; current?.showModal();
    return () => { current?.close(); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(null);
    void api.evidence(runId, evidenceId, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); }).catch(e => { if (!controller.signal.aborted) setError(errorCopy(e)); });
    return () => controller.abort();
  }, [runId, evidenceId]);
  const highlight = data ? sourceHighlight(data.originalField.text, data.evidence) : null;
  return <dialog ref={dialog} className="evidence-drawer" aria-labelledby="evidence-heading" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => {
    if (e.target !== e.currentTarget) return; const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
  }}>
    <header className="drawer-heading"><div><span className="small muted">Source record</span><h2 id="evidence-heading">Evidence inspector</h2></div><button className="icon-button" aria-label="Close evidence" onClick={onClose}><Icon name="close" /></button></header>
    <div className="drawer-body"><p className="id-text evidence-id">{evidenceId}</p>
      {error ? <div className="notice error" role="alert"><p>{error.message}</p><details className="technical"><summary>Technical details</summary><code>{error.code}</code></details></div> : !data ? <p role="status">Loading the original source…</p> : <>
        <div className="source-verdict"><Icon name="check" size={18} /><strong>Source verified</strong></div><p className="small muted">File, record and excerpt match the saved source. This does not establish semantic support.</p>
        <section><h3>Cited excerpt</h3><blockquote className="source-excerpt">{data.evidence.excerpt}</blockquote></section>
        <section><h3>Original field</h3><p className="small muted">{data.evidence.source.fieldPointer || '(root)'} · {data.originalField.valueType}</p><div className="source-full">{highlight?.verified ? <>{highlight.before}<mark>{highlight.selected}</mark>{highlight.after}</> : data.originalField.text}</div>{highlight && !highlight.verified ? <p className="small muted">The excerpt could not be highlighted in this field.</p> : null}</section>
        <section><h3>Identity and source notes</h3>{data.flags.length ? <ul className="source-flags">{data.flags.map((flag, i) => <li key={i}><strong>{flag.code}</strong><pre>{JSON.stringify(flag, null, 2)}</pre></li>)}</ul> : <p className="small muted">No source flags were recorded for this record.</p>}</section>
        <details className="technical" open><summary>Source identity and hashes</summary><dl className="metadata"><dt>File</dt><dd>{data.evidence.source.file}</dd><dt>Record</dt><dd>{data.evidence.source.recordId}</dd><dt>Locator</dt><dd>{data.evidence.source.locator.format === 'json' ? data.evidence.source.locator.jsonPointer : `JSONL line ${data.evidence.source.locator.line1Based}`}</dd><dt>Field</dt><dd>{data.evidence.source.fieldPointer || '(root)'}</dd><dt>Code point range</dt><dd>{data.evidence.source.codePointRange ? `[${data.evidence.source.codePointRange.join(', ')})` : 'Whole field'}</dd><dt>Dataset commit</dt><dd>{data.evidence.datasetCommit}</dd><dt>Source file SHA-256</dt><dd>{data.evidence.sourceFileSha256}</dd><dt>Record SHA-256</dt><dd>{data.evidence.recordSha256}</dd><dt>Excerpt SHA-256</dt><dd>{data.evidence.excerptSha256}</dd></dl></details>
      </>}
    </div>
  </dialog>;
}
