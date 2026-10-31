/** Explicitly bounded, first-round live diagnostic. Importing never starts a
 * worker or calls a model. No retry/resume flags or label-dependent gate exist. */
import { readFile, writeFile, mkdir, readdir, mkdtemp } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LIMITS } from '../contracts/config.js';
import { DATASET_COMMIT, TimestampSchema } from '../contracts/primitives.js';
import { canonicalizeArtifact } from '../contracts/canonical.js';
import { hashArtifact, sha256Bytes } from '../evidence/hashing.js';
import { deepFreeze } from '../data/records.js';
import { loadSnapshot } from '../data/snapshot.js';
import { RunStore } from '../storage/run-store.js';
import { Scheduler } from '../supervisor/scheduler.js';
import { ProcessHost } from '../supervisor/process-host.js';
import { createCriticMatrixFreeze, buildCriticCase, summarizeCriticObservations } from './critic-cases.js';
import { PROPOSER_INSTRUCTION } from '../runtime/agents/proposer.js';
import { COUNTER_INSTRUCTION } from '../runtime/agents/counter-evidence.js';
import { CRITIC_INSTRUCTION } from '../runtime/agents/critic.js';
import { runFailStopBatch, assertLiveBatchUnlocked } from './batch-control.js';
import { SINGLE_TOOL_CALL_POLICY, CONTROLLED_PROPOSER_REPRODUCTION_POLICY } from '../runtime/task-context.js';

export type ProductFingerprint = { file: string; sha256: string };
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const digestText = (value: string) => sha256Bytes(Buffer.from(value, 'utf8'));
const safeCode = (error: unknown, fallback: string) => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.message : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : fallback;
};
function ensure(value: unknown, code: string): asserts value { if (!value) throw Error(code); }

export function parseCriticEvalArgs(args: readonly string[]): { suite: 'core'; repeats: 3 } {
  ensure(args.length === 4 && args[0] === '--suite' && args[1] === 'core'
    && args[2] === '--repeats' && args[3] === '3', 'CRITIC_EVAL_SCOPE');
  return { suite: 'core', repeats: 3 };
}

/** Actual source AND executable fingerprints, not just a Git HEAD assertion. */
export async function collectCriticProductFingerprints(root = projectRoot): Promise<ProductFingerprint[]> {
  const paths: string[] = [];
  async function walk(folder: string, suffix: string) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      ensure(!item.isSymbolicLink(), 'CRITIC_PRODUCT_LINK');
      const path = join(folder, item.name);
      if (item.isDirectory()) await walk(path, suffix);
      else if (item.isFile() && item.name.endsWith(suffix)) paths.push(path);
    }
  }
  await walk(resolve(root, 'src'), '.ts'); await walk(resolve(root, 'dist/server'), '.js');
  paths.push(resolve(root, 'package.json'), resolve(root, 'pnpm-lock.yaml'));
  for (const file of ['package.json','dist/index.js','dist/index.mjs','dist/index.d.ts'])
    paths.push(resolve(root,'node_modules/@mozaik-ai/core',file));
  const result: ProductFingerprint[] = [];
  for (const path of paths.sort()) result.push({ file: relative(root, path).replace(/\\/g, '/'), sha256: sha256Bytes(await readFile(path)) });
  return result.sort((a, b) => a.file.localeCompare(b.file, 'en'));
}

export function validateCriticPreLiveGate(value: unknown, fingerprints: readonly ProductFingerprint[]): void {
  ensure(value && typeof value === 'object', 'CRITIC_PRELIVE_GATE');
  const gate = value as Record<string, unknown>;
  ensure(gate.task === 'Task7' && gate.engineeringVerified === true && gate.independentReviewPassed === true
    && canonicalizeArtifact(gate.sourceFingerprints) === canonicalizeArtifact(fingerprints), 'CRITIC_PRELIVE_GATE');
}

export function prepareCriticLivePlan(config: { model: string; gatewayOrigin: string;
  promptHashes: Record<string, string>; executableHashes: Record<string, string>;
  productFingerprints: readonly ProductFingerprint[]; createdAt: string }) {
  TimestampSchema.parse(config.createdAt);
  const { hash: matrixHash, ...matrix } = createCriticMatrixFreeze(config);
  const content = { ...matrix, matrixHash, matrixLimits: matrix.limits, createdAt: config.createdAt,
    limits: { ...DEFAULT_LIMITS }, productFingerprints: structuredClone(config.productFingerprints),
    runs: matrix.runs.map(run => ({ ...run, runId: randomUUID() })), labels: 'draft_not_human_gold',
    retryPolicy: 'none', qualityMetrics: 'NA_unadjudicated', controlledAdversarial: true, showcaseEligible: false,
    modelParameters:{maxOutputTokens:2048,wireMaxTokens:2048,streaming:false,temperature:'not_set',seed:'not_set'} };
  return deepFreeze({ ...content, hash: hashArtifact(content) });
}

type RequestTrace = { type: string; actor?: { role?: string; attempt?: number; [key: string]: unknown };
  requestId?: string; permitId?: string; timestamp?: string; monotonicMs?: number; code?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; [key: string]: unknown } };
export function summarizeCriticRequestIntervals(traces: readonly RequestTrace[]) {
  const starts = traces.filter(t => t.type === 'request.started');
  const intervals = starts.map(start => {
    const ends = traces.filter(t => ['request.completed', 'request.failed'].includes(t.type) && t.requestId === start.requestId
      && t.permitId === start.permitId && canonicalizeArtifact(t.actor ?? {}) === canonicalizeArtifact(start.actor ?? {}));
    const end = ends.length === 1 ? ends[0] : undefined;
    return { requestId: start.requestId ?? null, permitId: start.permitId ?? null, actor: start.actor ?? null,
      startedAt: start.timestamp ?? null, endedAt: end?.timestamp ?? null,
      startMs: start.monotonicMs ?? null, endMs: end?.monotonicMs ?? null,
      durationMs: end?.monotonicMs !== undefined && start.monotonicMs !== undefined ? end.monotonicMs - start.monotonicMs : null,
      completion: end?.type === 'request.completed' ? 'completed' : end ? 'failed' : 'unconfirmed', code: end?.code ?? null };
  });
  const first = (role: string) => intervals.find(i => i.actor?.role === role && (i.actor.attempt === undefined || i.actor.attempt === 1));
  const p = first('proposer'), c = first('counter-evidence');
  const firstAnalysisOverlapMs = p && c && p.startMs !== null && c.startMs !== null && p.endMs !== null && c.endMs !== null
    ? Math.max(0, Math.min(p.endMs, c.endMs) - Math.max(p.startMs, c.startMs)) : null;
  let active = 0, maxObservedInFlight = 0;
  for (const edge of intervals.filter(i => i.startMs !== null && i.endMs !== null)
    .flatMap(i => [{ at: i.startMs!, delta: 1 }, { at: i.endMs!, delta: -1 }]).sort((a,b) => a.at - b.at || a.delta - b.delta)) {
    active += edge.delta; maxObservedInFlight = Math.max(active, maxObservedInFlight);
  }
  const usage = traces.filter(t => t.type === 'usage').map(t => t.usage ?? {});
  const totals = Object.fromEntries(['promptTokens','completionTokens','totalTokens'].map(key => [key,
    usage.length && usage.every(u => typeof u[key] === 'number') ? usage.reduce((sum,u) => sum + (u[key] as number),0) : null]));
  return { intervals, firstAnalysisOverlapMs, maxObservedInFlight, started: starts.length,
    completed: intervals.filter(i=>i.completion==='completed').length, failed: intervals.filter(i=>i.completion==='failed').length,
    incomplete: intervals.filter(i=>i.completion==='unconfirmed').length, usage,
    usageStatus: usage.some(u=>Object.keys(u).some(k=>['promptTokens','completionTokens','totalTokens'].includes(k))) ? 'gateway_reported' : 'unknown',
    reportedTotals: totals, interpretation: 'Actual client fetch/body intervals; no provider internal scheduling, accuracy or price inference.' };
}

export function diffReviewedDrafts(before: unknown, after: unknown, pointer = ''): { pointer: string; before: unknown; after: unknown }[] {
  if (before !== undefined && after !== undefined && canonicalizeArtifact(before) === canonicalizeArtifact(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left),...Object.keys(right)])].sort().flatMap(key =>
      diffReviewedDrafts(left[key], right[key], pointer + '/' + key.replace(/~/g,'~0').replace(/\//g,'~1')));
  }
  return [{ pointer, before: before === undefined ? null : before, after: after === undefined ? null : after }];
}

/** Native invocation/output -> subsequent native Context reinsertion, with exact
 * actor/call/hash matching. This is tool causality, not evidence entailment. */
export function summarizeCriticToolRoundTrips(records: readonly Record<string, unknown>[]) {
  return records.flatMap((entry,index)=>{
    if(entry.kind!=='native'||entry.type!=='function_call.completed')return[];
    const actor=entry.actor as Record<string,unknown>,same=(other:Record<string,unknown>)=>
      canonicalizeArtifact(other.actor??{})===canonicalizeArtifact(actor);
    const started=records.slice(0,index).find(other=>other.kind==='native'&&other.type==='function_call.started'&&other.callId===entry.callId&&same(other));
    const returned=records.slice(index+1).find(other=>other.kind==='native'&&other.type==='inference.started'&&same(other)
      &&Array.isArray(other.toolResults)&&other.toolResults.some((item:{callId?:unknown;outputHash?:unknown})=>item.callId===entry.callId&&item.outputHash===entry.outputHash));
    const output=entry.output as Record<string,unknown>|undefined;
    return[{actor,callId:entry.callId,toolName:started?.toolName??null,outputHash:entry.outputHash,
      receiptId:output?.receiptId??null,success:output?.ok===true,returnedToSameContext:Boolean(returned),
      invokedBeforeCompletion:Boolean(started),returnedContextId:returned?.contextId??null}];
  });
}

function gatewayConfiguration() {
  const baseURL = process.env.EINSTEIN_GATEWAY_BASE_URL ?? '', model = process.env.EINSTEIN_GATEWAY_MODEL ?? '';
  const credential=process.env.EINSTEIN_GATEWAY_API_KEY;
  ensure(baseURL && model && credential, 'CRITIC_MODEL_CONFIGURATION_MISSING');
  ensure(!baseURL.includes(credential)&&!model.includes(credential),'CRITIC_CONFIGURATION_SECRET_IN_PUBLIC_FIELD');
  let parsed: URL; try { parsed = new URL(baseURL); } catch { throw Error('CRITIC_GATEWAY_CONFIGURATION_INVALID'); }
  ensure(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash, 'CRITIC_GATEWAY_CONFIGURATION_INVALID');
  ensure(model.length <= 128 && !/[\r\n]/.test(model), 'CRITIC_MODEL_CONFIGURATION_INVALID');
  return { baseURL, model, gatewayOrigin: parsed.origin };
}

async function readEvidence(path: string): Promise<{ records: Record<string, unknown>[]; diagnostic: string | null }> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return { records: [], diagnostic: 'WORKER_EVIDENCE_MISSING' }; }
  const records: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try { const value:unknown=JSON.parse(line);
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_EVIDENCE_LINE');
      records.push(value as Record<string,unknown>);
    } catch { return { records, diagnostic: 'WORKER_EVIDENCE_INVALID_OR_TRUNCATED' }; }
  }
  return { records, diagnostic: null };
}

export async function runCriticEvaluation(args: readonly string[], root = projectRoot) {
  parseCriticEvalArgs(args);
  assertLiveBatchUnlocked(); // no environment/credential lookup or store/worker creation before this gate
  const configured = gatewayConfiguration(), fingerprints = await collectCriticProductFingerprints(root);
  validateCriticPreLiveGate(JSON.parse(await readFile(resolve(root,'docs/implementation/task-7-pre-live-gate.json'),'utf8')), fingerprints);
  const snapshotPath = resolve(root,'reference/einstein-matchmaker-data'), snapshot = await loadSnapshot(snapshotPath,DATASET_COMMIT);
  const promptHashes = { proposer:digestText(PROPOSER_INSTRUCTION),counter:digestText(COUNTER_INSTRUCTION),critic:digestText(CRITIC_INSTRUCTION),
    singleToolCallPolicy:digestText(SINGLE_TOOL_CALL_POLICY),controlledProposerReproductionPolicy:digestText(CONTROLLED_PROPOSER_REPRODUCTION_POLICY),
    effectiveProposer:digestText(PROPOSER_INSTRUCTION+'\n'+SINGLE_TOOL_CALL_POLICY),
    effectiveControlledProposer:digestText(PROPOSER_INSTRUCTION+'\n'+SINGLE_TOOL_CALL_POLICY+'\n'+CONTROLLED_PROPOSER_REPRODUCTION_POLICY),
    effectiveCounter:digestText(COUNTER_INSTRUCTION+'\n'+SINGLE_TOOL_CALL_POLICY),effectiveCritic:digestText(CRITIC_INSTRUCTION+'\n'+SINGLE_TOOL_CALL_POLICY) };
  const executableHashes = Object.fromEntries(fingerprints.filter(f=>f.file.startsWith('dist/')).map(f=>[f.file,f.sha256]));
  const prepared = prepareCriticLivePlan({ ...configured,promptHashes,executableHashes,productFingerprints:fingerprints,createdAt:new Date().toISOString() });
  const labelsBytes = await readFile(resolve(root,'tests/fixtures/critic/labels.json'));
  const caseFreezes = prepared.runs.map(run=>{ const sample=buildCriticCase(snapshot,run.variantId,run.runId);
    return {runId:run.runId,manifest:sample.manifest,attackDiff:sample.attackDiff,baselineDraft:sample.baselineDraft,
      attackedDraft:sample.draft,input:sample.input,proposerBody:sample.proposerBody,counterBody:sample.counterBody}; });
  const content = { ...prepared,gatewayBaseURL:configured.baseURL,sourceFiles:snapshot.files,
    labelManifestHash:sha256Bytes(labelsBytes),caseFreezes };
  const freeze = deepFreeze({ ...content,hash:hashArtifact(content) });
  const outputRoot = resolve(root,'docs/implementation/task-7-live');
  // Directory and exclusive freeze are the non-resumable first-round marker.
  await mkdir(outputRoot); await mkdir(join(outputRoot,'runs'));
  const freezePath=join(outputRoot,'freeze.json'),freezeBytes=Buffer.from(JSON.stringify(freeze,null,2)+'\n','utf8');
  await writeFile(freezePath,freezeBytes,{flag:'wx'});const freezeFileHash=sha256Bytes(freezeBytes);
  const temporaryRoot=await mkdtemp(join(tmpdir(),'einstein task7 critic ')),storeRoot=join(temporaryRoot,'store'),workerCwd=join(temporaryRoot,'empty worker cwd');
  await mkdir(workerCwd);
  const loadOfficial=()=>loadSnapshot(snapshotPath,DATASET_COMMIT);
  const store=await RunStore.open(storeRoot,{publicationSnapshot:loadOfficial});
  const byRun=new Map<string,(typeof prepared.runs)[number]>(prepared.runs.map(run=>[run.runId,run]));
  const scheduler=new Scheduler({store,runnerMode:'live',limits:DEFAULT_LIMITS,snapshotPath,
    publicationContext:async input=>{const planned=byRun.get(input.runId);ensure(planned,'CRITIC_UNPLANNED_RUN');
      const fresh=await loadOfficial(),sample=buildCriticCase(fresh,planned.variantId,input.runId);
      ensure(canonicalizeArtifact(input)===canonicalizeArtifact(sample.input),'CRITIC_FROZEN_INPUT_MISMATCH');return sample.research;},
    createHost:callbacks=>new ProcessHost({workerPath:resolve(root,'dist/server/evaluation/critic-worker.js'),
      workerArgs:['--critic-freeze',freezePath,'--critic-freeze-hash',freezeFileHash],cwd:workerCwd,...callbacks})});
  const rows: Record<string, unknown>[] = [];
  let stopReason: string | undefined;
  try {
    const batch=await runFailStopBatch(prepared.runs,async planned=>{
      const folder=join(outputRoot,'runs',planned.runId);await mkdir(folder);
      await writeFile(join(folder,'attempt.json'),JSON.stringify({...planned,runnerMode:'live',controlledAdversarial:true,
        freezeHash:freeze.hash,startedAt:new Date().toISOString(),automaticRetry:false},null,2)+'\n',{flag:'wx'});
      let errorCode: string | undefined;
      try {
        ensure(canonicalizeArtifact(await collectCriticProductFingerprints(root))===canonicalizeArtifact(fingerprints),'CRITIC_PRODUCT_CHANGED_AFTER_FREEZE');
        ensure(sha256Bytes(await readFile(freezePath))===freezeFileHash,'CRITIC_FREEZE_CHANGED');
        const sample=buildCriticCase(snapshot,planned.variantId,planned.runId);
        await scheduler.submit(sample.input);await scheduler.waitForIdle(205_000);
      } catch(error) {errorCode=safeCode(error,'CRITIC_RUN_TECHNICAL_FAILURE');}
      const record=store.getRun(planned.runId),events=record?store.eventsAfter(planned.runId,0):[];
      const cleanups=scheduler.cleanupEvidence.filter(c=>c.runId===planned.runId).map(c=>{
        const {stdout,stderr,...exit}=c.exit;return{...c,exit,outputHashes:{stdout:digestText(stdout),stderr:digestText(stderr)},
          outputBytes:{stdout:Buffer.byteLength(stdout),stderr:Buffer.byteLength(stderr)}};});
      const evidence=await readEvidence(join(folder,'worker-evidence.jsonl'));
      const traces=evidence.records.filter(r=>r.kind==='request').map(r=>r.trace as RequestTrace);
      const artifacts=evidence.records.filter(r=>r.kind==='artifact').map(r=>r.artifact as {kind:string;artifact:Record<string,unknown>});
      const drafts=artifacts.filter(a=>a.kind==='proposal_draft').map(a=>a.artifact);
      const reviews=artifacts.filter(a=>a.kind==='critic_review').map(a=>a.artifact);
      const parentReasons=events.filter(event=>event.type==='run.status').flatMap(event=>
        'reasonCodes'in event.payload&&Array.isArray(event.payload.reasonCodes)?event.payload.reasonCodes:[]);
      const reasonCodes=[...new Set([...(errorCode?[errorCode]:[]),...(evidence.diagnostic?[evidence.diagnostic]:[]),...parentReasons])];
      const result={...planned,runnerMode:'live',controlledAdversarial:true,showcaseEligible:false,
        finishedAt:new Date().toISOString(),record:record??null,status:record?.status??'technical_failure',events,cleanups,
        diagnostics:scheduler.diagnostics,permitSnapshot:scheduler.permits.snapshot(),publication:store.getPublication(planned.runId)??null,
        requests:summarizeCriticRequestIntervals(traces),reviewVersions:reviews,loadedReviewSnapshots:evidence.records.filter(r=>r.kind==='review.dispatch'),
        nativeToolRoundTrips:summarizeCriticToolRoundTrips(evidence.records),reasonCodes,
        requestPermitProof:traces.filter(t=>t.type==='request.started').map(trace=>{
          const grant=events.find(event=>event.type==='permit.granted'&&'requestId'in event.payload&&event.payload.requestId===trace.requestId
            &&'permitId'in event.payload&&event.payload.permitId===trace.permitId);
          const begun=events.find(event=>event.type==='model.request.started'&&'requestId'in event.payload&&event.payload.requestId===trace.requestId
            &&'permitId'in event.payload&&event.payload.permitId===trace.permitId);
          return{requestId:trace.requestId,permitId:trace.permitId,grantedSeq:grant?.seq??null,startedSeq:begun?.seq??null,
            valid:Boolean(grant&&begun&&grant.seq<begun.seq)};}),
        versionDifferences:drafts.length>=2?diffReviewedDrafts(drafts[0],drafts[1]):[],
        workerEvidenceDiagnostic:evidence.diagnostic,errorCode:errorCode??null,
        qualityMetrics:'NA_NO_HUMAN_ADJUDICATED_LABELS',retryCount:0,storeRoot};
      await writeFile(join(folder,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
      console.log(JSON.stringify({variantId:planned.variantId,repetition:planned.repetition,runId:planned.runId,
        status:result.status,requests:result.requests.started,errorCode:errorCode??null,safetyHold:scheduler.safetyHold}));
      return{...planned,status:result.status,verdict:reviews.at(-1)?.verdict??null,reasonCodes,errorCode:errorCode??null,
        events,requests:result.requests,safetyHold:scheduler.safetyHold,
        requestCount:result.requests.started,firstAnalysisOverlapMs:result.requests.firstAnalysisOverlapMs,
        publicationQualified:record?.status==='approved',formalProposal:false};
    });
    rows.push(...batch.rows);stopReason=batch.stopReason??undefined;
  } finally {
    try{await scheduler.close();}catch(error){stopReason??=safeCode(error,'CRITIC_SCHEDULER_CLOSE_FAILED');}
    const observations=rows.filter(r=>r.status!=='unexecuted').map(r=>({variantId:r.variantId as string,repetition:r.repetition as number,
      status:r.status as string,...(typeof r.verdict==='string'?{verdict:r.verdict}:{}),reasonCodes:r.reasonCodes as string[]}));
    const summary={schemaVersion:1,runnerMode:'live',controlledAdversarial:true,freezeHash:freeze.hash,plannedRunCount:prepared.runs.length,
      executedRunCount:observations.length,maxGrantedRequests:prepared.maxGrantedRequests,automaticRetries:0,stopReason:stopReason??null,
      rows,observations:summarizeCriticObservations(observations,JSON.parse(labelsBytes.toString('utf8'))),
      finishedAt:new Date().toISOString(),storeRoot,holdoutStatus:'unopened',showcaseEligible:false};
    await writeFile(join(outputRoot,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
    await store.close();
  }
  return {output:relative(root,outputRoot).replace(/\\/g,'/'),rows,stopReason:stopReason??null,
    technicalFailureCount:rows.filter(row=>['failed','cancelled','technical_failure','unexecuted'].includes(row.status as string)).length};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  runCriticEvaluation(process.argv.slice(2)).then(result=>{if(result.stopReason||result.technicalFailureCount)process.exitCode=1;}).catch(()=>{
    console.error('CRITIC_EVALUATION_FAILED_NO_AUTOMATIC_RETRY');process.exitCode=1;
  });
