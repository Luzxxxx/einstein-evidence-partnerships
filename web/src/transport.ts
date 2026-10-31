import type { StoredEvent } from '../../src/contracts/events.js';
import type { RunDetail } from './types.js';
import { isTerminal } from './state.ts';

export type Connection = 'connecting' | 'connected' | 'reconnecting' | 'recorded' | 'paused';
const abortablePause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
});

export async function consumeEventStream(response: Response, runId: string, cursor: number,
  onEvent: (event: StoredEvent) => void, signal: AbortSignal): Promise<number> {
  if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw Error('EVENT_STREAM_UNAVAILABLE');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', last = cursor;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length > 2 * 1024 * 1024) throw Error('EVENT_TOO_LARGE');
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending)) !== null && !signal.aborted) {
        const packet = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
        if (new TextEncoder().encode(packet).length > 1024 * 1024) throw Error('EVENT_TOO_LARGE');
        const lines = packet.split(/\r?\n/), data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        const id = lines.find(l => l.startsWith('id:'))?.slice(3).trim();
        const kind = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
        const event = JSON.parse(data) as StoredEvent;
        if (kind !== 'run-event' || event.runId !== runId || id !== `${runId}:${event.seq}`) throw Error('EVENT_RUN_MISMATCH');
        if (event.schemaVersion !== 1 || !Number.isSafeInteger(event.seq) || event.seq < 1 || !Number.isFinite(event.elapsedMs)
          || event.elapsedMs < 0 || typeof event.type !== 'string' || !event.payload || typeof event.payload !== 'object') throw Error('EVENT_SCHEMA_INVALID');
        if (event.seq <= last) continue;
        if (event.seq !== last + 1) throw Error('EVENT_SEQUENCE_GAP');
        onEvent(event); last = event.seq;
      }
      if (done) { if (pending.trim()) throw Error('EVENT_TRUNCATED'); break; }
      if (new TextEncoder().encode(pending).length > 1024 * 1024) throw Error('EVENT_TOO_LARGE');
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
  return last;
}

export async function followRun(runId: string, options: {
  signal: AbortSignal; loadRun: () => Promise<RunDetail>; fetcher?: typeof fetch;
  onRun: (detail: RunDetail) => void; onEvent: (event: StoredEvent) => void;
  onConnection: (state: Connection) => void; onProblem: (code: string) => void;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const { signal } = options, fetcher = options.fetcher ?? fetch, pause = options.pause ?? abortablePause;
  let cursor = 0, reconnects = 0;
  const refresh = async () => {
    const detail = await options.loadRun();
    if (detail.run.runId !== runId) throw Error('RUN_IDENTITY_MISMATCH');
    if (!signal.aborted) options.onRun(detail);
    return detail;
  };
  try { await refresh(); } catch (error) { if (!signal.aborted) throw error; return; }
  while (!signal.aborted) {
    options.onConnection(reconnects ? 'reconnecting' : 'connecting');
    let interrupted = false;
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (cursor) headers['Last-Event-ID'] = `${runId}:${cursor}`;
      const response = await fetcher(`/api/runs/${encodeURIComponent(runId)}/events`, { signal, headers, credentials: 'omit', redirect: 'error' });
      if (signal.aborted) { await response.body?.cancel(); return; }
      options.onConnection('connected');
      cursor = await consumeEventStream(response, runId, cursor, e => { options.onEvent(e); cursor = e.seq; }, signal);
    } catch (error) {
      if (signal.aborted) return;
      interrupted = true;
      const code = error instanceof Error && /^EVENT_[A-Z_]+$/.test(error.message) ? error.message : 'EVENT_CONNECTION_INTERRUPTED';
      options.onProblem(code);
    }
    if (signal.aborted) return;
    // EOF, cleanup and model verdicts are never a publication decision.
    try {
      const detail = await refresh();
      if (detail.progress.blockedByService) {
        // Cleanup can set the hold just before the final disk commit. Briefly
        // settle via read-only GETs; never reconnect a stopped event stream.
        let settled = detail;
        for (let check = 0; check < 4 && !signal.aborted; check++) {
          await pause(500, signal);
          try { settled = await refresh(); }
          catch { if (!signal.aborted) options.onProblem('RUN_REFRESH_UNAVAILABLE'); break; }
          if (isTerminal(settled.run.status)) break;
        }
        if (interrupted || cursor < settled.run.lastSeq) options.onProblem('EVENT_REPLAY_INCOMPLETE');
        if (!signal.aborted) options.onConnection('paused'); return;
      }
      if (isTerminal(detail.run.status)) {
        if (interrupted || cursor < detail.run.lastSeq) { options.onProblem('EVENT_REPLAY_INCOMPLETE'); options.onConnection('paused'); }
        else options.onConnection('recorded');
        return;
      }
    } catch { if (signal.aborted) return; options.onProblem('RUN_REFRESH_UNAVAILABLE'); }
    if (++reconnects > 5) { options.onConnection('paused'); return; }
    await pause(Math.min(500 * 2 ** (reconnects - 1), 5000), signal);
  }
}
