// Actual built React + local HTTP + temporary headless Edge. No user browser profile.
// Original archive is read-only at the application level; new runs use a separate
// offline_fixture Scheduler/worker with an HTTPS Response factory, never a model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { startLocalService } from '../dist/server/server/service.js';
import { Scheduler } from '../dist/server/supervisor/scheduler.js';
import { RunStore } from '../dist/server/storage/run-store.js';
import { queryWindowsIdentity } from '../dist/server/supervisor/process-host.js';

const suffix = process.argv[2] ?? 'first';
const repairedReplay = process.argv[3] === '--repaired-replay';
const readOnly = process.argv[3] === '--read-only' || repairedReplay;
if (!/^[a-z0-9-]+$/.test(suffix) || process.argv.length > 4 || (process.argv[3] !== undefined && !readOnly)) throw Error('TASK9_BROWSER_ARGUMENT');
const output = resolve(`docs/implementation/task-9-browser-${suffix}.json`);
try { await readFile(output); throw Error('TASK9_OUTPUT_EXISTS'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const root = await mkdtemp(join(tmpdir(), 'einstein task9 browser offline_fixture '));
const baseline = JSON.parse(await readFile('docs/implementation/task-9-baseline.json', 'utf8'));
const historicalId = '0fc75288-4d8b-4f0a-bee1-62f19834a8fd';
const failedId = '523f5ab4-66b7-4e86-8c4a-7ffff900c934';
// Actual existing Run supplied by the user's other assistant; read-only, no rerun.
const repairedId = 'b738ce31-0d8d-4eba-a01e-f4deac26a632';
const selectedStore = repairedReplay ? resolve('var/research-repair-live/959de8d0-74c5-4404-a055-d6c111e49d16/store') : baseline.historicalStore.root;
const steps = [], requests = [], exceptions = [], screenshots = [], closed = [];
let original, isolated, store, scheduler, edge, cdp, edgeIdentity, browserExited = false;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (true) { const value = await check(); if (value) return value; if (Date.now() >= end) throw Error('TASK9_BROWSER_WAIT_TIMEOUT'); await wait(80); }
}
class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url); this.pending = new Map(); this.id = 0;
    this.ready = new Promise((yes, no) => { this.socket.addEventListener('open', yes, { once: true }); this.socket.addEventListener('error', no, { once: true }); });
    this.socket.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.no(Error(`CDP_${m.error.code}`)) : p.yes(m.result); }
      else this.event?.(m.method, m.params);
    });
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    return new Promise((yes, no) => { const timer = setTimeout(() => { this.pending.delete(id); no(Error('CDP_COMMAND_TIMEOUT:' + method)); }, 15000); this.pending.set(id, { yes, no, timer }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  close() { this.socket.close(); for (const p of this.pending.values()) { clearTimeout(p.timer); p.no(Error('CDP_CLOSED')); } this.pending.clear(); }
}
const evaluate = async code => {
  const result = await cdp.send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error('BROWSER_EVALUATE_FAILED');
  return result.result.value;
};
const text = () => evaluate('document.body.innerText');
async function click(selector) {
  const rect = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  assert.ok(rect, 'MISSING_CONTROL:' + selector);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}
async function button(label) {
  const selector = await evaluate(`(()=>{const all=[...document.querySelectorAll('button')];const i=all.findIndex(e=>(e.getAttribute('aria-label')??e.textContent.trim())===${JSON.stringify(label)});return i<0?null:'button[data-task9-target="'+i+'"]';})()`);
  assert.ok(selector, 'BUTTON_NOT_FOUND:' + label);
  await evaluate(`(()=>{[...document.querySelectorAll('button')].forEach((e,i)=>e.setAttribute('data-task9-target',i));})()`);
  await click(selector);
}
async function fill(selector, value) {
  await click(selector);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
  await cdp.send('Input.insertText', { text: value });
}
async function screenshot(name) {
  const file = resolve(`docs/implementation/task-9-${suffix}-${name}.png`);
  const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(file, Buffer.from(image.data, 'base64'), { flag: 'wx' }); screenshots.push(file); return file;
}
async function navigate(url) {
  await cdp.send('Page.navigate', { url });
  await until(async () => await evaluate('document.readyState') === 'complete');
}
async function key(key, code = key) {
  const virtual = { Escape: 27, Tab: 9, Enter: 13 }[key];
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
}
let error = null;
try {
  original = await startLocalService({ storeRoot: selectedStore, ...(repairedReplay ? {} : { historicalRecovery: JSON.parse(await readFile(baseline.existingAuthorization.file, 'utf8')) }), port: 0, modelConfigured: () => false });
  if (!readOnly) {
    store = await RunStore.open(join(root, 'store'), { publicationSnapshot: async () => original.snapshot });
    scheduler = new Scheduler({ store, snapshotPath: resolve('reference/einstein-matchmaker-data'), runnerMode: 'offline_fixture', workerPath: resolve('tests/fixtures/mozaik-worker.mjs'), workerArgs: ['--mode', 'fetch-wait', '--barrier-path', join(root, 'barrier.json')] });
    isolated = await startLocalService({ store, scheduler, snapshot: original.snapshot, port: 0, modelConfigured: () => true });
  }
  const profile = join(root, 'edge-profile'); await mkdir(profile);
  edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-features=Translate,MediaRouter', '--window-size=1440,1000', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  edge.once('close', code => { browserExited = true; closed.push({ kind: 'temporary_headless_edge', exitCode: code }); });
  edgeIdentity = await queryWindowsIdentity(edge.pid);
  const portText = await until(async () => { try { return await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return null; } });
  const port = Number(portText.split('\n')[0]);
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  assert.ok(target?.webSocketDebuggerUrl, 'BROWSER_TARGET_MISSING');
  cdp = new Cdp(target.webSocketDebuggerUrl);
  cdp.event = (method, params) => {
    if (method === 'Network.requestWillBeSent') { const url = new URL(params.request.url); if (url.protocol === 'http:') requests.push({ requestId: params.requestId, method: params.request.method, origin: url.origin, path: url.pathname, at: params.timestamp }); }
    if (method === 'Runtime.exceptionThrown') exceptions.push({ kind: 'runtime_exception', text: params.exceptionDetails.text });
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') exceptions.push({ kind: 'console_error', descriptions: params.args.map(a => String(a.value ?? a.description ?? '').slice(0, 500)) });
  };
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  if (repairedReplay) {
    await navigate(`${original.url}/#run=${repairedId}`);
    await until(async () => (await text()).includes('Insufficient evidence') && (await text()).includes('Draft v2'));
    assert.ok(!(await text()).includes('Analysis failed')); assert.ok(!(await text()).includes('Published proposal'));
    const saved = await (await fetch(`${original.url}/api/runs/${repairedId}`)).json();
    assert.equal(saved.run.status, 'insufficient'); assert.equal(saved.run.input.mode, 'research');
    await button('Review'); await until(async () => (await text()).includes('Review v2'));
    assert.ok((await text()).includes('Insufficient'));
    await screenshot('repaired-insufficient-review');
    await click('.evidence-link'); await until(async () => (await text()).includes('Source verified'));
    await key('Escape'); await until(async () => !await evaluate('Boolean(document.querySelector("dialog[open]"))'));
    await button('Changes'); await until(async () => (await text()).includes('How the draft changed'));
    assert.ok((await text()).includes('No bound later approval'));
    await screenshot('repaired-changes');
    assert.equal(requests.filter(r => r.method === 'POST').length, 0);
    steps.push({ step: 'existing_repaired_research_reads_v1_v2_review_sources_and_normal_insufficient', runId:repairedId, passed:true });
  } else {
  await navigate(original.url);
  await until(async () => (await text()).includes('ArmaturaSec d.o.o.'));
  assert.equal(await evaluate("document.documentElement.lang"), 'en');
  assert.equal(await evaluate("document.querySelector('.start-button').disabled"), true);
  await screenshot('workspace'); steps.push({ step: 'real_catalog_and_keyless_controls', passed: true });
  const initialShowcaseReads = requests.filter(r => r.path === '/api/showcase').length;
  await click('a[href="#showcase"]'); await until(async () => (await text()).includes('No proposals yet'));
  assert.ok(requests.filter(r => r.path === '/api/showcase').length > initialShowcaseReads, 'SHOWCASE_MUST_REFRESH_ON_ENTRY');
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(e=>e.textContent.includes('Export'))"), false);
  await screenshot('empty-showcase'); steps.push({ step: 'empty_formal_showcase_no_export_control', passed: true });
  const beforeReplayPosts = requests.filter(r => r.method === 'POST').length;
  await fill('#sidebar-run-id', 'not-a-run'); await click('.compact-replay button');
  await until(async () => (await text()).includes('Enter a valid Run ID.'));
  await fill('#sidebar-run-id', historicalId); await click('.compact-replay button');
  await until(async () => (await text()).includes('Diagnostic / Replay') && (await text()).includes('Draft v2'));
  await until(async () => (await text()).includes('Saved replay'));
  assert.ok((await text()).includes('Review approved')); assert.ok(!(await text()).includes('Published proposal'));
  await screenshot('diagnostic-draft');
  await button('Changes'); await until(async () => (await text()).includes('How the draft changed'));
  assert.ok((await text()).includes('Later review bound to v2')); await screenshot('diagnostic-changes');
  await button('Review'); await until(async () => (await text()).includes('Independent review'));
  await click('.evidence-link'); await until(async () => (await text()).includes('Source verified'));
  assert.ok((await text()).includes('Source file SHA-256'));
  assert.equal(await evaluate('document.querySelector("dialog").open'), true);
  await screenshot('evidence'); await key('Escape'); await until(async () => !await evaluate('Boolean(document.querySelector("dialog[open]"))'));
  const focused = await evaluate('document.activeElement.className'); assert.ok(focused.includes('evidence-link'), 'EVIDENCE_FOCUS_NOT_RESTORED');
  await button('Proposal'); await until(async () => await evaluate('Boolean(document.querySelector("#draft-version"))'));
  await evaluate("(()=>{const e=document.querySelector('#draft-version');e.value='1';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await until(async () => (await text()).includes('Draft v1'));
  await button('Activity'); await until(async () => (await text()).includes('Recorded activity'));
  assert.ok((await text()).includes('97 saved events'));
  const settledSseCount = requests.filter(r => r.path.endsWith(`/${historicalId}/events`)).length;
  await wait(1400); assert.equal(requests.filter(r => r.path.endsWith(`/${historicalId}/events`)).length, settledSseCount);
  assert.equal(requests.filter(r => r.method === 'POST').length, beforeReplayPosts);
  steps.push({ step: 'real_diagnostic_versions_reviews_evidence_trace_no_posts_terminal_no_reconnect', events: 97, passed: true });
  await fill('#sidebar-run-id', failedId); await click('.compact-replay button');
  await until(async () => (await text()).includes('Analysis failed') && (await text()).includes('No proposal was published'));
  await click('.run-details summary'); await until(async () => (await text()).includes('INVALID_TASK_ANSWER'));
  assert.ok((await text()).includes('specific cause is unknown'));
  assert.ok(!(await text()).includes('Insufficient evidence'));
  await screenshot('actual-failed-answer'); steps.push({ step: 'actual_research_failure_remains_failed_unknown_subcause', passed: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.sidebar')).display"), 'none');
  await evaluate('window.scrollTo(0,0)');
  assert.ok(await evaluate("document.querySelector('.run-status').getBoundingClientRect().bottom < innerHeight"), 'MOBILE_RESULT_HIDDEN_BY_CONTROLS');
  await button('Show analysis controls'); assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.sidebar')).display"), 'none');
  await button('Hide analysis controls'); assert.equal(await evaluate("getComputedStyle(document.querySelector('.sidebar')).display"), 'none');
  await screenshot('mobile-failure'); await key('Tab');
  assert.notEqual(await evaluate('document.activeElement.tagName'), 'BODY');
  steps.push({ step: 'narrow_screen_no_horizontal_overflow_and_keyboard_focus', passed: true });
  if (!readOnly) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate(isolated.url);
  await until(async () => (await text()).includes('ArmaturaSec d.o.o.'));
  await evaluate("(()=>{const e=document.querySelector('#company-select');e.value='C009';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await until(async () => await evaluate("document.querySelector('input[name=challenge]:checked').value.startsWith('C009-')"));
  await evaluate("(()=>{const e=document.querySelector('#company-select');e.value='C001';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await click('.start-button'); await until(async () => (await text()).includes('Offline fixture'));
  const firstRunId = await evaluate('location.hash.slice(5)');
  await until(async () => (await text()).includes('Waiting for a saved draft'));
  assert.ok(!(await text()).includes('Draft v1'));
  await button('Activity'); await until(async () => (await text()).includes('Model request started'));
  const startedRun = store.getRun(firstRunId); assert.equal(startedRun.runnerMode, 'offline_fixture');
  await screenshot('offline-active');
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await wait(150); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  // Explicit navigation creates a fresh reader; isolated pure-transport tests cover exact resume headers.
  await click('a[href="#analyze"]'); await until(async () => (await text()).includes('Research worth a closer look.'));
  for (let n = 0; n < 3; n++) {
    const count = store.listRuns().length; await click('.start-button'); await until(() => store.listRuns().length === count + 1);
    await until(async () => (await text()).includes('Waiting in queue')); if (n === 2) await screenshot('offline-queued');
  }
  assert.equal(store.listRuns().length, 4);
  await click('.start-button'); await until(async () => (await text()).includes('The queue is full.'));
  assert.equal(store.listRuns().length, 4);
  await button('Cancel analysis'); await until(async () => (await text()).includes('Analysis cancelled'));
  assert.equal(store.listRuns().filter(r => r.status === 'cancelled').length, 1);
  // Cancel the remaining waiting runs using the same UI, leaving the active worker last.
  for (const run of store.listRuns().filter(r => r.status === 'queued')) {
    await fill('#sidebar-run-id', run.runId); await click('.compact-replay button');
    await until(async () => (await text()).includes('Waiting in queue')); await button('Cancel analysis'); await until(async () => (await text()).includes('Analysis cancelled'));
  }
  await fill('#sidebar-run-id', firstRunId); await click('.compact-replay button');
  await until(async () => (await text()).includes('Researching the challenge'));
  await button('Cancel analysis'); await until(async () => (await text()).includes('Analysis cancelled'), 20000);
  await until(() => scheduler.cleanupEvidence.length > 0, 20000);
  assert.ok(scheduler.cleanupEvidence.every(c => c.confirmed && c.exit.exitObserved && c.exit.closeObserved && c.scanDiagnostics.length === 0));
  assert.equal(scheduler.safetyHold, false); assert.equal(scheduler.permits.snapshot().inFlight, 0);
  assert.ok(scheduler.permits.snapshot().runs.every(r => r.pending === 0));
  steps.push({ step: 'offline_fixture_company_relationship_create_empty_artifacts_real_sdk_worker_queue_full_queued_active_cancel', runs: 4, cleanupConfirmed: true, passed: true });
  }
  }
  assert.deepEqual(exceptions, []);
} catch (e) { error = { name: e.name, message: String(e.message).slice(0, 1500) }; if (cdp) { try { await screenshot('failure'); } catch {} } }
finally {
  if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.close(); }
  if (edge) { try { await until(() => browserExited, 15000); } catch { error ??= { message: 'HEADLESS_BROWSER_EXIT_UNCONFIRMED' }; } }
  if (isolated) { try { await isolated.close(); } catch (e) { error ??= { message: 'ISOLATED_SERVICE_CLOSE_FAILED' }; } }
  if (store) await store.close();
  if (original) { try { await original.close(); } catch { error ??= { message: 'ORIGINAL_READ_SERVICE_CLOSE_FAILED' }; } }
}
const browserCurrent = edgeIdentity?.status === 'present' ? await queryWindowsIdentity(edgeIdentity.identity.pid) : null;
const result = {
  task: 'Task9', kind: repairedReplay ? 'actual_edge_browser_readonly_repaired_research' : readOnly ? 'actual_edge_browser_readonly_original_replay_and_mobile' : 'actual_edge_browser_with_original_http_replay_and_separate_offline_fixture_creation',
  at: new Date().toISOString(), fallbackReason: 'Built-in Browser tool failed twice before code execution: kernel assets host path missing.',
  passed: !error, error, steps, screenshots, requests, exceptions,
  original: { root: selectedStore, historicalId:repairedReplay ? repairedId : historicalId, failedId:repairedReplay ? null : failedId, modelConfiguredForNewRuns: false, managerRuns: original?.scheduler.permits.snapshot().runs.length ?? null },
  fixture: { runnerMode: 'offline_fixture', root, modelRequests: 0, managerCreated: Boolean(scheduler), runs: store?.listRuns() ?? null, manager: scheduler?.permits.snapshot() ?? null, safetyHold: scheduler?.safetyHold ?? null, cleanups: scheduler?.cleanupEvidence ?? null },
  temporaryBrowser: { identity: edgeIdentity, current: browserCurrent, exitObserved: browserExited, profileIsNewTemporaryDirectory: true, userProfileRead: false, closed },
  actualModelRequests: 0, originalStoreNewRuns: 0, recoveryApplyCalls: 0, Task10Started: false,
};
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, passed: !error, error, steps: steps.length, screenshots: screenshots.length, actualModelRequests: 0, fixtureRuns: result.fixture.runs?.length ?? 0, cleanupConfirmed: result.fixture.cleanups?.every(c => c.confirmed), browserExited }));
if (error) process.exitCode = 1;
