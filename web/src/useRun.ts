import { useCallback, useEffect, useState } from 'react';
import type { RunRecord } from '../../src/contracts/domain.js';
import type { StoredEvent } from '../../src/contracts/events.js';
import type { RunArtifacts, RunDetail } from './types.js';
import { api, errorCopy, parseStoredEvent } from './api.js';
import { acceptRun, isTerminal, mergeEvent } from './state.js';
import { followRun, type Connection } from './transport.js';

export function useRun(runId: string) {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [artifacts, setArtifacts] = useState<RunArtifacts | null>(null);
  const [events, setEvents] = useState<readonly StoredEvent[]>([]);
  const [reasonCodes, setReasonCodes] = useState<string[]>([]);
  const [blockedByService, setBlockedByService] = useState(false);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<ReturnType<typeof errorCopy> | null>(null);
  const [artifactError, setArtifactError] = useState<ReturnType<typeof errorCopy> | null>(null);
  const [revision, setRevision] = useState(0);
  const reconnect = useCallback(() => setRevision(r => r + 1), []);

  useEffect(() => {
    const controller = new AbortController(), { signal } = controller;
    let localRun: RunRecord | null = null, localEvents: readonly StoredEvent[] = [], loadedTerminal = false, loadingArtifacts = false, terminalArtifactPending = false, refreshing = false;
    setRun(null); setArtifacts(null); setEvents([]); setReasonCodes([]); setBlockedByService(false); setError(null); setArtifactError(null); setConnection('connecting');
    const loadArtifacts = async (terminal: boolean) => {
      if (loadingArtifacts) { if (terminal) terminalArtifactPending = true; return; }
      loadingArtifacts = true;
      try { const value = await api.artifacts(runId, signal); if (!signal.aborted) { setArtifacts(value); setArtifactError(null); loadedTerminal = terminal; } }
      catch (e) { if (!signal.aborted) setArtifactError(errorCopy(e)); }
      finally {
        loadingArtifacts = false;
        if (terminalArtifactPending && !loadedTerminal && !signal.aborted) { terminalArtifactPending = false; void loadArtifacts(true); }
      }
    };
    const accept = (detail: RunDetail) => {
      if (signal.aborted) return;
      localRun = acceptRun(localRun, detail.run); setRun(localRun);
      setBlockedByService(detail.progress.blockedByService === true);
      if (localRun === detail.run) setReasonCodes(detail.progress?.reasonCodes ?? []);
      if (isTerminal(localRun.status) && !loadedTerminal) void loadArtifacts(true);
    };
    const refresh = async () => {
      if (refreshing || signal.aborted) return;
      refreshing = true;
      try { accept(await api.run(runId, signal)); } catch (e) { if (!signal.aborted) setError(errorCopy(e)); }
      finally { refreshing = false; }
    };
    void loadArtifacts(false);
    void followRun(runId, {
      signal, loadRun: () => api.run(runId, signal), onRun: accept,
      onConnection: state => { if (!signal.aborted) { setConnection(state); if (state === 'connected' || state === 'recorded') setError(null); } },
      onProblem: code => { if (!signal.aborted) setError({ code, message: code === 'EVENT_REPLAY_INCOMPLETE'
        ? 'Some saved activity could not be loaded. The run status is current; reconnect to reload the trace.'
        : 'Activity was interrupted. Checking the saved run status.' }); },
      onEvent: raw => {
        const event = parseStoredEvent(raw); localEvents = mergeEvent(localEvents, event, runId);
        if (!signal.aborted) setEvents(localEvents);
        if (event.type === 'run.status') void refresh();
      },
    }).catch(e => { if (!signal.aborted) { setError(errorCopy(e)); setConnection('paused'); } });
    return () => controller.abort();
  }, [runId, revision]);
  return { run, artifacts, events, reasonCodes, blockedByService, connection, error, artifactError, reconnect };
}
