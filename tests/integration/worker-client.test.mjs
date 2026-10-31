import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { WorkerPermitClient } from '../../dist/server/runtime/worker-client.js';
import { WorkerToParentMessageSchema } from '../../dist/server/contracts/ipc.js';

// Isolated IPC doubles only: no child process, model transport, credentials, or dataset.
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; let reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const codeIs = code => error => { assert.equal(error?.code, code); assert.equal(error.message, code); return true; };

function setup(send) {
  const runId = randomUUID(); const controller = new AbortController(); const sent = [];
  const client = new WorkerPermitClient({ runId, signal: controller.signal, send: message => {
    sent.push(WorkerToParentMessageSchema.parse(message)); return send?.(message);
  } });
  const grant = (requestId, permitId = randomUUID(), override = {}) => ({ v: 1, kind: 'permit.granted', runId, requestId, permitId, ...override });
  const denied = (requestId, code = 'RUN_REQUEST_LIMIT', override = {}) => ({ v: 1, kind: 'permit.denied', runId, requestId, code, ...override });
  return { runId, controller, sent, client, grant, denied };
}

test('a request waits for its bound parent grant and sends only strict Run-bound IPC', async () => {
  const x = setup(); const requestId = randomUUID(); let fetched = false;
  const pending = x.client.acquire(requestId, x.controller.signal).then(permit => { fetched = true; return permit; });
  assert.deepEqual(x.sent, [{ v: 1, kind: 'permit.request', runId: x.runId, requestId }]);
  await tick(); assert.equal(fetched, false);
  const grant = x.grant(requestId); x.client.receive(grant);
  assert.deepEqual(await pending, { id: grant.permitId }); assert.equal(fetched, true);
  await x.client.release(grant.permitId);
  assert.deepEqual(x.sent[1], { v: 1, kind: 'permit.release', runId: x.runId, permitId: grant.permitId });
});

test('duplicate acquire, grant, and release reserve and release once without reopening a released request', async () => {
  const releaseSent = deferred(); const x = setup(message => message.kind === 'permit.release' ? releaseSent.promise : undefined);
  const requestId = randomUUID(); const first = x.client.acquire(requestId, x.controller.signal);
  const duplicate = x.client.acquire(requestId, x.controller.signal);
  const grant = x.grant(requestId); x.client.receive(grant); x.client.receive(grant);
  assert.deepEqual(await first, await duplicate); assert.equal(x.sent.filter(m => m.kind === 'permit.request').length, 1);
  assert.deepEqual(await x.client.acquire(requestId, x.controller.signal), { id: grant.permitId });
  const releasing = x.client.release(grant.permitId); const again = x.client.release(grant.permitId);
  releaseSent.resolve(); await Promise.all([releasing, again]); await x.client.release(grant.permitId);
  x.client.receive(grant); await tick();
  assert.equal(x.sent.filter(m => m.kind === 'permit.release').length, 1);
  await assert.rejects(x.client.acquire(requestId, x.controller.signal), codeIs('REQUEST_ALREADY_RELEASED'));
});

test('two requests can be granted in reverse order without exchanging identities', async () => {
  const x = setup(); const a = randomUUID(); const b = randomUUID();
  const pa = x.client.acquire(a, x.controller.signal); const pb = x.client.acquire(b, x.controller.signal);
  const ga = x.grant(a); const gb = x.grant(b); x.client.receive(gb); x.client.receive(ga);
  assert.deepEqual(await pa, { id: ga.permitId }); assert.deepEqual(await pb, { id: gb.permitId });
  await Promise.all([x.client.release(ga.permitId), x.client.release(gb.permitId)]);
});

test('per-request abort prevents continuation and a late grant releases the real permit exactly once', async () => {
  const x = setup(); const request = new AbortController(); const requestId = randomUUID(); let fetches = 0;
  const pending = x.client.acquire(requestId, request.signal).then(permit => { fetches++; return permit; });
  const rejected = assert.rejects(pending, codeIs('PERMIT_ABORTED')); request.abort(new Error('private abort details')); await rejected;
  const grant = x.grant(requestId); x.client.receive(grant); x.client.receive(grant); await tick();
  assert.equal(fetches, 0);
  assert.deepEqual(x.sent.filter(m => m.kind === 'permit.release'), [{ v: 1, kind: 'permit.release', runId: x.runId, permitId: grant.permitId }]);
  await assert.rejects(x.client.acquire(requestId, x.controller.signal), codeIs('PERMIT_ABORTED'));
  const other = randomUUID(); const stillUsable = x.client.acquire(other, x.controller.signal); const otherGrant = x.grant(other); x.client.receive(otherGrant);
  assert.deepEqual(await stillUsable, { id: otherGrant.permitId }); await x.client.release(otherGrant.permitId);
});

test('pre-aborted request signals never send or consume a parent request', async () => {
  const x = setup(); const request = new AbortController(); request.abort();
  await assert.rejects(x.client.acquire(randomUUID(), request.signal), codeIs('PERMIT_ABORTED')); assert.deepEqual(x.sent, []);
});

test('the shared worker signal stops every pending and future request while late grants are returned', async () => {
  const x = setup(); const a = randomUUID(); const b = randomUUID();
  const pa = x.client.acquire(a, new AbortController().signal); const pb = x.client.acquire(b, new AbortController().signal);
  const failures = Promise.all([assert.rejects(pa, codeIs('PERMIT_ABORTED')), assert.rejects(pb, codeIs('PERMIT_ABORTED'))]);
  x.controller.abort(); await failures;
  await assert.rejects(x.client.acquire(randomUUID(), new AbortController().signal), codeIs('PERMIT_ABORTED'));
  const grant = x.grant(a); x.client.receive(grant); await tick();
  assert.equal(x.sent.filter(m => m.kind === 'permit.request').length, 2);
  assert.deepEqual(x.sent.at(-1), { v: 1, kind: 'permit.release', runId: x.runId, permitId: grant.permitId });
});

test('grant races cannot start work before an asynchronous request send is confirmed', async () => {
  const send = deferred(); const x = setup(message => message.kind === 'permit.request' ? send.promise : undefined);
  const requestId = randomUUID(); let fetched = false;
  const pending = x.client.acquire(requestId, x.controller.signal).then(permit => { fetched = true; return permit; });
  const grant = x.grant(requestId); x.client.receive(grant); await tick(); assert.equal(fetched, false);
  send.resolve(); assert.deepEqual(await pending, { id: grant.permitId }); await x.client.release(grant.permitId);
});

test('abort wins over a grant received while request send confirmation is pending', async () => {
  const send = deferred(); const x = setup(message => message.kind === 'permit.request' ? send.promise : undefined);
  const request = new AbortController(); const requestId = randomUUID(); let fetches = 0;
  const pending = x.client.acquire(requestId, request.signal).then(() => { fetches++; });
  const rejection = assert.rejects(pending, codeIs('PERMIT_ABORTED'));
  const grant = x.grant(requestId); x.client.receive(grant); request.abort(); send.resolve(); await rejection; await tick();
  assert.equal(fetches, 0); assert.equal(x.sent.filter(m => m.kind === 'permit.release').length, 1);
});

test('parent denial rejects only its request, preserves the fixed code, and is idempotent', async () => {
  const x = setup(); const a = randomUUID(); const b = randomUUID();
  const pa = x.client.acquire(a, x.controller.signal); const pb = x.client.acquire(b, x.controller.signal);
  const rejection = assert.rejects(pa, codeIs('RUN_REQUEST_LIMIT'));
  const denial = x.denied(a); x.client.receive(denial); x.client.receive(denial); await rejection;
  await assert.rejects(x.client.acquire(a, x.controller.signal), codeIs('RUN_REQUEST_LIMIT'));
  const grant = x.grant(b); x.client.receive(grant); assert.deepEqual(await pb, { id: grant.permitId }); await x.client.release(grant.permitId);
  assert.equal(x.sent.filter(m => m.kind === 'permit.request').length, 2);
});

test('parent cancellation and explicit stop reject pending/future requests with their first safe code', async () => {
  for (const viaMessage of [false, true]) {
    const x = setup(); const requestId = randomUUID(); const pending = x.client.acquire(requestId, x.controller.signal);
    const rejection = assert.rejects(pending, codeIs('RUN_CANCELLED'));
    if (viaMessage) x.client.receive({ v: 1, kind: 'cancel', runId: x.runId, reason: 'RUN_CANCELLED' });
    else x.client.stop('RUN_CANCELLED');
    x.client.stop('SECOND_STOP'); await rejection;
    await assert.rejects(x.client.acquire(randomUUID(), x.controller.signal), codeIs('RUN_CANCELLED'));
    const grant = x.grant(requestId); x.client.receive(grant); await tick();
    assert.equal(x.sent.filter(m => m.kind === 'permit.release').length, 1);
  }
});

test('disconnect rejects all pending/future work and never attempts IPC after disconnection', async () => {
  const x = setup(); const requestId = randomUUID(); const pending = x.client.acquire(requestId, x.controller.signal);
  const rejection = assert.rejects(pending, codeIs('IPC_DISCONNECTED')); x.client.disconnect(); x.client.disconnect(); await rejection;
  await assert.rejects(x.client.acquire(randomUUID(), x.controller.signal), codeIs('IPC_DISCONNECTED'));
  const before = x.sent.length; x.client.receive(x.grant(requestId)); await tick(); assert.equal(x.sent.length, before);
});

test('unknown permit releases never reach the parent or affect a genuine permit', async () => {
  const x = setup(); const requestId = randomUUID(); const pending = x.client.acquire(requestId, x.controller.signal);
  const grant = x.grant(requestId); x.client.receive(grant); await pending;
  await assert.rejects(x.client.release(randomUUID()), codeIs('PERMIT_UNKNOWN'));
  assert.equal(x.sent.filter(m => m.kind === 'permit.release').length, 0);
  await x.client.release(grant.permitId); assert.equal(x.sent.filter(m => m.kind === 'permit.release').length, 1);
});

for (const [label, mutate, code] of [
  ['cross-Run grant', (x, m) => ({ ...m, runId: randomUUID() }), 'IPC_RUN_MISMATCH'],
  ['invalid envelope', (_x, m) => ({ ...m, v: 2 }), 'IPC_INVALID'],
  ['extra data', (_x, m) => ({ ...m, secret: 'private data' }), 'IPC_INVALID'],
  ['unknown request', (_x, m) => ({ ...m, requestId: randomUUID() }), 'PERMIT_REQUEST_UNKNOWN'],
]) test(`${label} cannot grant work and stops pending tasks with sanitized diagnostics`, async () => {
  const x = setup(); const requestId = randomUUID(); const pending = x.client.acquire(requestId, x.controller.signal);
  const rejection = assert.rejects(pending, codeIs(code));
  assert.throws(() => x.client.receive(mutate(x, x.grant(requestId))), codeIs(code)); await rejection;
  await assert.rejects(x.client.acquire(randomUUID(), x.controller.signal), codeIs(code));
  assert.equal(x.sent.filter(m => m.kind === 'permit.release').length, 0);
});

test('a conflicting repeated grant is rejected and cannot replace an already acquired identity', async () => {
  const x = setup(); const requestId = randomUUID(); const pending = x.client.acquire(requestId, x.controller.signal);
  const grant = x.grant(requestId); x.client.receive(grant); assert.deepEqual(await pending, { id: grant.permitId });
  assert.throws(() => x.client.receive(x.grant(requestId)), codeIs('PERMIT_CONFLICT'));
  await assert.rejects(x.client.acquire(randomUUID(), x.controller.signal), codeIs('PERMIT_CONFLICT'));
  await x.client.release(grant.permitId); assert.equal(x.sent.at(-1).permitId, grant.permitId);
});

test('one permit cannot be reused by a second request', async () => {
  const x = setup(); const a = randomUUID(); const b = randomUUID(); const permitId = randomUUID();
  const pa = x.client.acquire(a, x.controller.signal); const pb = x.client.acquire(b, x.controller.signal);
  x.client.receive(x.grant(a, permitId)); await pa; const rejected = assert.rejects(pb, codeIs('PERMIT_CONFLICT'));
  assert.throws(() => x.client.receive(x.grant(b, permitId)), codeIs('PERMIT_CONFLICT')); await rejected;
  await x.client.release(permitId); assert.equal(x.sent.filter(m => m.kind === 'permit.release').length, 1);
});

for (const asynchronous of [false, true]) test(`${asynchronous ? 'asynchronous' : 'synchronous'} request send failure is sanitized and stops the channel`, async () => {
  const secret = 'private transport credential and prompt';
  const x = setup(() => { if (asynchronous) return Promise.reject(new Error(secret)); throw new Error(secret); });
  await assert.rejects(x.client.acquire(randomUUID(), x.controller.signal), codeIs('IPC_SEND_FAILED'));
  await assert.rejects(x.client.acquire(randomUUID(), x.controller.signal), codeIs('IPC_SEND_FAILED')); assert.equal(x.sent.length, 1);
});

test('a grant cannot escape when the corresponding asynchronous request send fails', async () => {
  const send = deferred(); const x = setup(message => message.kind === 'permit.request' ? send.promise : undefined);
  const requestId = randomUUID(); let fetches = 0; const pending = x.client.acquire(requestId, x.controller.signal).then(() => { fetches++; });
  const rejection = assert.rejects(pending, codeIs('IPC_SEND_FAILED')); const grant = x.grant(requestId); x.client.receive(grant);
  send.reject(new Error('private transport failure')); await rejection; await tick();
  assert.equal(fetches, 0); assert.equal(x.sent.filter(m => m.kind === 'permit.release').length, 1);
});

test('release send failure propagates safely without retrying or reopening capacity locally', async () => {
  const x = setup(message => { if (message.kind === 'permit.release') return Promise.reject(new Error('secret release failure')); });
  const requestId = randomUUID(); const pending = x.client.acquire(requestId, x.controller.signal); const grant = x.grant(requestId); x.client.receive(grant); await pending;
  await assert.rejects(x.client.release(grant.permitId), codeIs('IPC_SEND_FAILED'));
  await assert.rejects(x.client.release(grant.permitId), codeIs('IPC_SEND_FAILED'));
  await assert.rejects(x.client.acquire(randomUUID(), x.controller.signal), codeIs('IPC_SEND_FAILED'));
  assert.equal(x.sent.filter(m => m.kind === 'permit.release').length, 1);
});

test('automatic late-grant release failure stops remaining work without an unhandled rejection', async () => {
  const x = setup(message => { if (message.kind === 'permit.release') return Promise.reject(new Error('private late release failure')); });
  const request = new AbortController(); const requestId = randomUUID(); const pending = x.client.acquire(requestId, request.signal);
  const rejection = assert.rejects(pending, codeIs('PERMIT_ABORTED')); request.abort(); await rejection;
  x.client.receive(x.grant(requestId)); await tick();
  await assert.rejects(x.client.acquire(randomUUID(), x.controller.signal), codeIs('IPC_SEND_FAILED'));
});

test('invalid local UUIDs and unsafe stop reasons never enter IPC or diagnostics', async () => {
  assert.throws(() => new WorkerPermitClient({ runId: 'invalid', signal: new AbortController().signal, send: () => {} }), codeIs('IPC_INVALID'));
  const x = setup(); await assert.rejects(x.client.acquire('not-a-request-id', x.controller.signal), codeIs('IPC_INVALID'));
  assert.deepEqual(x.sent, []); x.client.stop('private prompt with spaces');
  await assert.rejects(x.client.acquire(randomUUID(), x.controller.signal), codeIs('WORKER_STOPPED'));
});
