import { RunRecordSchema, EvidenceSchema } from '../../src/contracts/domain.js';
import { TypedArtifactSchema } from '../../src/contracts/ipc.js';
import { StoredEventSchema } from '../../src/contracts/events.js';
import type { Catalog, EvidenceResponse, RunArtifacts, RunDetail, RunHistory, ShowcaseEntry } from './types.js';

export class ApiFailure extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const validRunId = (id: string) => idPattern.test(id);
const runPath = (id: string) => {
  if (!validRunId(id)) throw new ApiFailure('INVALID_RUN_ID', 400);
  return `/api/runs/${id}`;
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function request<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { signal, credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiFailure('SERVICE_UNAVAILABLE', 0);
  }
  let data: unknown;
  try { data = await response.json(); } catch { throw new ApiFailure('INVALID_SERVER_RESPONSE', response.status); }
  if (!response.ok) {
    const code = object(data) && typeof data.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(data.code) ? data.code : 'REQUEST_FAILED';
    throw new ApiFailure(code, response.status);
  }
  return data as T;
}

export const api = {
  async history(signal?: AbortSignal): Promise<RunHistory> {
    const data = await request<RunHistory>('/api/runs', signal);
    if (!data || !Array.isArray(data.runs) || !Number.isSafeInteger(data.total) || data.total < data.runs.length
      || data.limit !== 50 || data.runs.length > data.limit) throw new ApiFailure('RUN_RESPONSE_INVALID', 200);
    const runs = data.runs.map(run => {
      const parsed = RunRecordSchema.safeParse(run);
      if (!parsed.success) throw new ApiFailure('RUN_RESPONSE_INVALID', 200);
      return parsed.data;
    });
    if (new Set(runs.map(run => run.runId)).size !== runs.length) throw new ApiFailure('RUN_RESPONSE_INVALID', 200);
    return { ...data, runs };
  },
  async catalog(signal?: AbortSignal) {
    const data = await request<Catalog>('/api/catalog', signal);
    if (!data || data.synthetic !== true || typeof data.newRunsAvailable !== 'boolean' || !Array.isArray(data.companies)
      || data.companies.some(c => !/^C\d{3}$/.test(c.id) || typeof c.name !== 'string' || !Array.isArray(c.challenges)
        || c.challenges.some(ch => !ch.id.startsWith(c.id + '-CH') || typeof ch.text !== 'string' || (ch.detail != null && typeof ch.detail !== 'string'))))
      throw new ApiFailure('INVALID_SERVER_RESPONSE', 200);
    return data;
  },
  async showcase(signal?: AbortSignal) {
    const data = await request<ShowcaseEntry[]>('/api/showcase', signal);
    if (!Array.isArray(data) || data.some(entry => !validRunId(entry.runId) || typeof entry.pairKey !== 'string')) throw new ApiFailure('INVALID_SERVER_RESPONSE', 200);
    return data;
  },
  async run(id: string, signal?: AbortSignal): Promise<RunDetail> {
    const data = await request<RunDetail>(runPath(id), signal);
    const parsed = RunRecordSchema.safeParse(data?.run);
    if (!parsed.success || parsed.data.runId !== id) throw new ApiFailure('RUN_RESPONSE_INVALID', 200);
    if (data.progress?.reasonCodes !== undefined && (!Array.isArray(data.progress.reasonCodes) || data.progress.reasonCodes.some(code => typeof code !== 'string')))
      throw new ApiFailure('RUN_RESPONSE_INVALID', 200);
    return { ...data, run: parsed.data };
  },
  async create(companyId: string, challengeId: string, signal?: AbortSignal) {
    const data = await request<unknown>('/api/runs', signal, { companyId, challengeId });
    const result = RunRecordSchema.safeParse(data);
    if (!result.success || result.data.input.companyId !== companyId || result.data.input.challengeId !== challengeId) throw new ApiFailure('RUN_RESPONSE_INVALID', 202);
    return result.data;
  },
  async cancel(id: string, signal?: AbortSignal) {
    const data = await request<unknown>(runPath(id) + '/cancel', signal, {});
    const result = RunRecordSchema.safeParse(data);
    if (!result.success || result.data.runId !== id) throw new ApiFailure('RUN_RESPONSE_INVALID', 202);
    return result.data;
  },
  async artifacts(id: string, signal?: AbortSignal) {
    const data = await request<RunArtifacts>(runPath(id) + '/artifacts', signal);
    if (!data || data.runId !== id || !Array.isArray(data.artifacts)) throw new ApiFailure('ARTIFACT_RESPONSE_INVALID', 200);
    for (const artifact of data.artifacts) {
      const parsed = TypedArtifactSchema.safeParse(artifact);
      if (!parsed.success || parsed.data.artifact.runId !== id) throw new ApiFailure('ARTIFACT_RESPONSE_INVALID', 200);
    }
    return data;
  },
  async evidence(id: string, evidenceId: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(evidenceId)) throw new ApiFailure('INVALID_EVIDENCE_ID', 400);
    const data = await request<EvidenceResponse>(runPath(id) + '/evidence/' + encodeURIComponent(evidenceId), signal);
    const parsed = EvidenceSchema.safeParse(data?.evidence);
    if (!parsed.success || parsed.data.id !== evidenceId || data.runId !== id || typeof data.originalField?.text !== 'string'
      || !Array.isArray(data.flags) || data.sourceValidation !== 'verified') throw new ApiFailure('EVIDENCE_RESPONSE_INVALID', 200);
    return { ...data, evidence: parsed.data };
  },
};

export const parseStoredEvent = (value: unknown) => StoredEventSchema.parse(value);
export function errorCopy(error: unknown) {
  const code = error instanceof ApiFailure ? error.code : 'REQUEST_FAILED';
  const messages: Record<string, string> = {
    MODEL_CONFIG_MISSING: 'New analyses are unavailable. Recorded runs are still readable.',
    RUN_QUEUE_FULL: 'The queue is full. Wait for a run to finish before starting another.',
    RUN_SAFETY_HOLD: 'New analyses are paused until process cleanup is resolved.',
    RUN_NOT_FOUND: 'This run is not in the current archive. Check its ID and the service archive.',
    INVALID_RUN_ID: 'Enter a valid Run ID.', RUN_TERMINAL: 'This run has already ended.',
    EVIDENCE_NOT_REGISTERED: 'This evidence is not available in the saved run context.',
    REPLAY_CONTEXT_UNAVAILABLE: 'The saved evidence context cannot be reproduced safely.',
    SERVICE_UNAVAILABLE: 'The local service is unavailable. Check that it is running.',
  };
  return { message: messages[code] ?? 'The request could not be completed.', code };
}
