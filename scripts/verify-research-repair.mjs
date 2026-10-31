// One explicit, natural research Run through the production HTTP service.
// No controlled answer, automatic retry, or historical store mutation. Optional
// answer capture uses the same production engine with a passive local observer.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startLocalService, modelConfigurationReady } from '../dist/server/server/service.js';
import { RunStore } from '../dist/server/storage/run-store.js';
import { Scheduler } from '../dist/server/supervisor/scheduler.js';
import { ProcessHost } from '../dist/server/supervisor/process-host.js';
import { loadSnapshot } from '../dist/server/data/snapshot.js';
import { DATASET_COMMIT } from '../dist/server/contracts/primitives.js';

const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const companyId = flag('--company', 'C001'), challengeId = flag('--challenge', 'C001-CH1');
if (!/^C\d{3}$/.test(companyId) || !new RegExp(`^${companyId}-CH[1-9]\\d?$`).test(challengeId)) throw Error('RESEARCH_PAIR_INVALID');
if (!modelConfigurationReady() || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw Error('MODEL_CONFIGURATION_UNAVAILABLE');
const attemptId = randomUUID();
const folder = resolve('docs/implementation/research-repair-live', attemptId);
const storeRoot = resolve('var/research-repair-live', attemptId, 'store');
await mkdir(folder, { recursive: true });
const captureAnswers = process.argv.includes('--capture-answers');
const snapshotPath = resolve('reference/einstein-matchmaker-data');
let captureStore, captureScheduler;
if (captureAnswers) {
  captureStore = await RunStore.open(storeRoot, { publicationSnapshot: () => loadSnapshot(snapshotPath, DATASET_COMMIT) });
  captureScheduler = new Scheduler({ store: captureStore, snapshotPath, runnerMode: 'live',
    createHost: callbacks => new ProcessHost({ ...callbacks, workerPath: resolve('scripts/observe-research-worker.mjs'), workerArgs: ['--capture-folder', folder] }) });
}
const app = await startLocalService({ storeRoot, port: 0, ...(captureAnswers ? { store: captureStore, scheduler: captureScheduler } : {}) });
let runId, result, closeError = null;
try {
  const created = await fetch(app.url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyId, challengeId }) });
  const body = await created.json();
  if (created.status !== 202 || !body.runId) throw Error('RESEARCH_RUN_NOT_ADMITTED');
  runId = body.runId;
  console.log(JSON.stringify({ phase: 'natural_research_started', attemptId, runId, companyId, challengeId, automaticRetries: 0 }));
  await app.scheduler.waitForIdle(210000);
  const detail = await (await fetch(app.url + `/api/runs/${runId}`)).json();
  const artifacts = await (await fetch(app.url + `/api/runs/${runId}/artifacts`)).json();
  const events = app.store.eventsAfter(runId, 0), terminal = app.store.getTerminal(runId);
  const manager = app.scheduler.permits.snapshot();
  const cleanups = app.scheduler.cleanupEvidence.map(({ exit: { stdout, stderr, ...exit }, ...rest }) => ({ ...rest, exit }));
  const usage = events.filter(e => e.type === 'model.usage').map(e => e.payload.usage);
  const grants = events.filter(e => e.type === 'permit.granted').length;
  const totals = Object.fromEntries(['promptTokens', 'completionTokens', 'totalTokens', 'cachedInputTokens'].map(key => {
    const reported = usage.filter(u => Number.isSafeInteger(u[key]));
    const knownSubtotal = reported.length ? reported.reduce((sum, u) => sum + u[key], 0) : null;
    return [key, { reportedRequests: reported.length, grantedAttempts: grants, knownSubtotal, completeTotal: reported.length === grants ? knownSubtotal : null }];
  }));
  result = { attemptId, runId, input: body.input, model: process.env.EINSTEIN_GATEWAY_MODEL, storeRoot,
    controlledSeed: false, runnerMode: 'live', captureAnswers, automaticRetries: 0, detail, artifacts, terminal, events, manager, cleanups,
    safetyHold: app.scheduler.safetyHold, grants, usage: totals,
    failureDetails: events.filter(e => e.type === 'task.failed'),
    completed: ['approved', 'insufficient'].includes(detail.run.status),
    settled: detail.run.cleanupState === 'confirmed' && !app.scheduler.safetyHold && manager.inFlight === 0 && manager.runs.every(r => r.pending === 0),
    humanLabels: 0, qualityMetrics: 'NA', holdout: 'unopened' };
} catch (error) {
  result = { attemptId, runId: runId ?? null, completed: false, settled: false, code: 'RESEARCH_VERIFICATION_FAILED',
    events: runId ? app.store.eventsAfter(runId, 0) : [], manager: app.scheduler.permits.snapshot(), safetyHold: app.scheduler.safetyHold };
} finally {
  try { await app.close(); } catch { closeError = 'SERVICE_CLOSE_UNCONFIRMED'; }
  if (captureStore) { try { await captureStore.close(); } catch { closeError = 'CAPTURE_STORE_CLOSE_UNCONFIRMED'; } }
}
result.closeError = closeError;
if (closeError) result.settled = false;
const text = JSON.stringify(result, null, 2) + '\n';
if (text.includes(process.env.EINSTEIN_GATEWAY_API_KEY)) throw Error('PRIVATE_EVIDENCE_WITHHELD');
const file = join(folder, 'result.json');
await writeFile(file, text, { flag: 'wx' });
console.log(JSON.stringify({ phase: 'natural_research_finished', runId, status: result.detail?.run.status ?? 'failed',
  reasonCodes: result.terminal?.outcome.reasonCodes ?? [result.code], grants: result.grants ?? null,
  failureDetails: result.failureDetails?.map(e => ({ role: e.role, code: e.payload.code, validation: e.payload.validation })),
  settled: result.settled, file }));
if (!result.completed || !result.settled) process.exitCode = 1;
