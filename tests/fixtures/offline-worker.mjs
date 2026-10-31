// OFFLINE_FIXTURE only: plain process-local state/context, no model, network or Mozaik.
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const mode = process.argv[process.argv.indexOf('--mode') + 1] || 'wait';
const state = { counter: 0 }, context = { id: randomUUID(), messages: [] };
let runId, requestId, finished = false;
const send = value => { if (process.connected) process.send(value); };
if (mode === 'early-ready') send({v:1,kind:'ready',runId:process.argv[process.argv.indexOf('--run-id')+1]});
if (mode === 'boot-exit') setTimeout(()=>process.exit(9),10);
const output = () => console.log(JSON.stringify({ fixture: 'offline_fixture', runId, counter: state.counter, contextId: context.id, messages: context.messages }));
function finish(code = 0) { if (finished) return; finished = true; output(); process.exitCode = code; if (process.connected) process.disconnect(); }
process.on('disconnect', () => { if (!finished) finish(); });
process.on('message', msg => {
  if (msg.kind === 'cancel' && msg.runId === runId) { if (mode !== 'ignore-cancel') finish(); return; }
  if (msg.kind === 'permit.granted' && msg.runId === runId && msg.requestId === requestId) { state.counter++; context.messages.push(requestId); return; }
  if (msg.kind !== 'start' || runId) return;
  runId = msg.runId;
  if (mode === 'crash') throw Error('OFFLINE_FIXTURE_INTENTIONAL_CRASH_BEFORE_READY');
  if (mode === 'never-ready') return;
  if (mode === 'child') {
    const child = fork(fileURLToPath(import.meta.url), ['--mode', 'detached-child'], { detached: true, stdio: 'ignore', windowsHide: true, execArgv: [] });
    child.unref();
  }
  send({ v: 1, runId, kind: 'ready' });
  if (mode === 'ready-crash') setTimeout(() => { throw Error('OFFLINE_FIXTURE_INTENTIONAL_CRASH_AFTER_READY'); }, 20);
  if (mode === 'spoof') send({ v: 1, runId: randomUUID(), kind: 'ready' });
  if (mode === 'permits') { requestId = randomUUID(); send({ v: 1, runId, kind: 'permit.request', requestId }); }
  if (mode === 'finish') { send({ v: 1, runId, kind: 'outcome', typedOutcome: { runId, kind: 'insufficient', reasonCodes: ['OFFLINE_FIXTURE_NO_MODEL'] } }); setTimeout(() => finish(), 80); }
});
// A detached fixture stays alive without an IPC parent, for explicit tree-cleanup tests.
if (mode === 'detached-child') setInterval(() => {}, 1000);
