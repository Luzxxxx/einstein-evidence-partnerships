import type { Evidence, RunRecord, RunStatus } from '../../src/contracts/domain.js';
import type { StoredEvent } from '../../src/contracts/events.js';
import type { RunArtifacts } from './types.js';

export const terminalStatuses = new Set<RunStatus>(['approved', 'failed', 'insufficient', 'cancelled']);
export const isTerminal = (status: string) => terminalStatuses.has(status as RunStatus);
export const roleNames: Record<string, string> = { proposer: 'Proposer', 'counter-evidence': 'Counter-evidence', critic: 'Critic' };
export const sectionNames: Record<string, string> = {
  summary: 'Problem and opportunity', technicalRationale: 'Why this research', cooperationScope: 'Proposed collaboration',
  validation: 'Validation plan', constraints: 'Limits and conditions', unknowns: 'Open questions',
};

/** Display only validation metadata that actually exists in a saved failure event. */
export function answerDiagnostics(events: readonly StoredEvent[]) {
  return events.flatMap(event => event.type === 'task.failed' && event.payload.kind === 'task' && event.payload.validation
    ? [{ role: event.role, taskId: event.taskId, contextId: event.contextId, validation: event.payload.validation }] : []);
}

export function runPresentation(run: RunRecord, blockedByService = false) {
  const states = {
    queued: ['Waiting in queue', 'Your analysis will start when a slot is available.', 'neutral'],
    researching: ['Researching the challenge', 'The analysis agents are checking candidates and counter-evidence.', 'active'],
    reviewing: ['Under independent review', 'The Critic is reviewing the draft and its evidence.', 'active'],
    revising: ['Revising the draft', 'A targeted recheck is addressing the Critic’s findings.', 'active'],
    approved: [run.input.mode === 'adversarial' ? 'Review approved' : 'Analysis approved', 'The reviewed result has been saved.', 'success'],
    insufficient: ['Insufficient evidence', 'This run did not establish enough support for a proposal.', 'warning'],
    failed: ['Analysis failed', 'The run ended before a proposal could be published. See technical details for the recorded reason.', 'error'],
    cancelled: ['Analysis cancelled', 'This run has ended. Its saved activity remains available.', 'neutral'],
  } as const;
  const [title, description, tone] = blockedByService && !isTerminal(run.status)
    ? ['Analysis interrupted', 'The service stopped after a storage or cleanup problem. The last saved state is preserved.', 'error'] as const
    : states[run.status];
  const label = run.runnerMode === 'offline_fixture' ? 'Offline fixture' : run.input.mode === 'adversarial' ? 'Diagnostic / Replay' : null;
  return { title, description, tone, label };
}

export function emptyResult(run: RunRecord, artifactsLoaded: boolean, artifactError: boolean, blockedByService = false) {
  if (artifactError) return { title: 'Saved result unavailable', message: 'The run status is available, but its artifacts could not be read. Reload the saved result.' };
  if (!artifactsLoaded) return { title: 'Loading the saved result', message: 'Waiting for the artifact response. No result has been inferred.' };
  if (blockedByService && !isTerminal(run.status)) return { title: 'Analysis interrupted', message: 'No final result was saved. Open Activity to inspect the recorded work.' };
  if (!isTerminal(run.status)) return { title: 'Waiting for a saved draft', message: 'The agents are working. Complete artifacts may remain empty until the run ends.' };
  if (run.status === 'approved') return { title: 'No draft is available in this archive', message: 'A saved approval exists, but no complete draft was returned. Publication cannot be inferred from this view.' };
  return { title: 'No proposal was published', message: 'Open Activity for the recorded outcome and Review for any saved findings.' };
}

/** Display qualification only. The browser never grants approval. */
export function publicationVisible(run: RunRecord, data: Pick<RunArtifacts, 'publication'> | null) {
  const p = data?.publication;
  return Boolean(run.status === 'approved' && run.cleanupState === 'confirmed' && run.input.mode === 'research'
    && run.runnerMode === 'live' && p?.formalProposal && p.draftHash === run.publishedDraftHash
    && p.reviewHash === run.acceptedReview?.hash);
}

export function acceptRun(previous: RunRecord | null, next: RunRecord): RunRecord {
  if (!previous) return next;
  if (previous.runId !== next.runId) throw Error('RUN_IDENTITY_MISMATCH');
  if (next.lastSeq < previous.lastSeq || (isTerminal(previous.status) && previous.status !== next.status)) return previous;
  return next;
}

export function mergeEvent(events: readonly StoredEvent[], event: StoredEvent, runId: string): readonly StoredEvent[] {
  if (event.runId !== runId) throw Error('EVENT_RUN_MISMATCH');
  const last = events.at(-1)?.seq ?? 0;
  if (event.seq <= last) {
    const previous = events.find(e => e.seq === event.seq);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw Error('EVENT_DUPLICATE_CONFLICT');
    return events;
  }
  if (event.seq !== last + 1) throw Error('EVENT_SEQUENCE_GAP');
  if (events.length >= 10000) throw Error('EVENT_LIMIT_REACHED');
  return [...events, event];
}

const actorKey = (e: StoredEvent) => [e.runId, e.agentId, e.role, e.taskId, e.contextId, e.attempt].join(':');
export function requestSpans(events: readonly StoredEvent[]) {
  return events.filter(e => e.type === 'model.request.started' && e.payload.kind === 'request').map(start => {
    if (start.payload.kind !== 'request') throw Error('REQUEST_SHAPE');
    const request = start.payload;
    const end = events.find(e => (e.type === 'model.request.completed' || e.type === 'model.request.failed')
      && e.payload.kind === 'request' && e.payload.requestId === request.requestId && e.payload.permitId === request.permitId
      && actorKey(e) === actorKey(start) && e.seq > start.seq && e.elapsedMs >= start.elapsedMs);
    return { role: start.role!, contextId: start.contextId!, requestId: request.requestId, startMs: start.elapsedMs,
      endMs: end?.elapsedMs ?? null, durationMs: end ? end.elapsedMs - start.elapsedMs : null, failed: end?.type === 'model.request.failed' };
  });
}

export function sourceHighlight(text: string, evidence: Pick<Evidence, 'excerpt' | 'source'>) {
  const range = evidence.source.codePointRange;
  if (!range) return text === evidence.excerpt
    ? { before: '', selected: text, after: '', verified: true }
    : { before: text, selected: '', after: '', verified: false };
  const chars = Array.from(text), [start, end] = range;
  if (start < 0 || end < start || end > chars.length || chars.slice(start, end).join('') !== evidence.excerpt)
    return { before: text, selected: '', after: '', verified: false };
  return { before: chars.slice(0, start).join(''), selected: chars.slice(start, end).join(''), after: chars.slice(end).join(''), verified: true };
}

export function eventLabel(e: StoredEvent) {
  if (e.payload.kind === 'tool_ref') return `${e.payload.toolName} ${e.type.endsWith('completed') ? 'returned' : 'started'}`;
  if (e.type === 'review.completed' && e.payload.kind === 'review_ref') return `Review: ${e.payload.verdict}`;
  const labels: Record<string, string> = {
    'task.started': 'Task started', 'task.completed': 'Task completed', 'task.failed': 'Task failed',
    'run.status': 'Run status saved', 'worker.spawned': 'Worker started', 'worker.ready': 'Worker ready', 'worker.exited': 'Worker exited',
    'model.request.started': 'Model request started', 'model.request.completed': 'Model request completed', 'model.request.failed': 'Model request failed',
    'model.answer': 'Answer recorded', 'artifact.validated': 'Artifact validated', 'cleanup.completed': 'Cleanup confirmed', 'cleanup.failed': 'Cleanup not confirmed',
    'permit.granted': 'Request permitted', 'permit.released': 'Permit released', 'permit.denied': 'Request denied', 'model.usage': 'Usage reported',
  };
  return labels[e.type] ?? e.type.replaceAll('.', ' ').replaceAll('_', ' ');
}
