import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ModelContext, DeveloperMessageItem, UserMessageItem, ModelMessageItem,
  FunctionCallItem, FunctionCallOutputItem, TokenUsage } from '@mozaik-ai/core';
import { createGatewayRunner, GatewayError } from '../../dist/server/model/gateway-runner.js';

// All transports below are local doubles. No credential, .env, DNS, or live gateway is used.
const key = 'offline-secret-never-log';
const prompt = 'private prompt never appears in diagnostics';
const deferred = () => { let resolve; let reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const answer = (message = { content: 'answer' }, extra = {}) => ({ choices: [{ message: { role: 'assistant', ...message } }], ...extra });
const response = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const call = (id = 'call_1', name = 'read_evidence') => ({ id, type: 'function', function: { name, arguments: '{"id":"E1"}' } });
const tool = { type: 'function', name: 'read_evidence', description: 'Read supplied evidence', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, strict: true, invoke: async () => ({}) };

function setup(options = {}) {
  const controller = new AbortController();
  const context = ModelContext.create().addContextItems([DeveloperMessageItem.create('trusted instruction'), UserMessageItem.create(prompt)]);
  const actor = { runId: randomUUID(), agentId: randomUUID(), role: 'proposer', loopId: randomUUID(), taskId: randomUUID(), contextId: context.id, attempt: 1 };
  const events = []; const steps = []; const releases = []; const requests = [];
  const permitId = randomUUID();
  const permits = options.permits ?? { acquire: async (requestId, signal) => { steps.push('permit'); assert.equal(signal.aborted, false); return { id: permitId }; }, release: id => { releases.push(id); steps.push('release'); } };
  const config = { baseURL: 'https://gateway.example.test/v1', apiKey: key, model: 'fixed-model', signal: controller.signal,
    resolveTask: id => { assert.equal(id, context.id); return actor; }, ...options.config,
    fetchImpl: options.fetchImpl ?? (async (url, init) => { steps.push('fetch'); requests.push({ url, init }); return response(options.body ?? answer()); }) };
  const runner = createGatewayRunner(config, permits, event => { events.push(event); options.trace?.(event); });
  return { runner, config, controller, context, actor, events, steps, releases, requests, permitId,
    input: { model: 'fixed-model', context, tools: [tool] } };
}
const codeIs = expected => error => { assert.ok(error instanceof GatewayError); assert.equal(error.code, expected); assert.equal(error.message, expected); return true; };

test('trusted JSON-object mode reaches HTTP with native tools and reasoning selection intact', async () => {
  const x = setup({ config: { responseFormat: 'json_object' } });
  x.config.responseFormat = undefined; // settings are captured on construction
  await x.runner.run({ ...x.input, reasoningEffort: 'none' });
  const body = JSON.parse(x.requests[0].init.body);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.tools[0].function.name, tool.name);
  assert.equal(body.messages[1].content, prompt);
});

test('a whitespace assistant preface does not invalidate actual native tool calls', async () => {
  const x = setup({ body: answer({ content: ' \n ', tool_calls: [call()] }) });
  const result = await x.runner.run(x.input);
  assert.equal(result.items.find(item => item instanceof FunctionCallItem).callId, 'call_1');
  assert.equal(result.items.find(item => item instanceof ModelMessageItem).content.text, ' \n ');
});

test('a whitespace-only answer without tool calls remains invalid', async () => {
  const x = setup({ body: answer({ content: ' \n ' }) });
  await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_INVALID_RESPONSE'));
});

for (const [label, message] of [
  ['apparently valid JSON', { content: '{"verdict":"approve","findings":[]}' }],
  ['apparently valid native call', { content: null, tool_calls: [call()] }],
]) test(`a length-truncated response cannot become ${label}`, async () => {
  const body = answer(message, { usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } });
  body.choices[0].finish_reason = 'length';
  const x = setup({ body });
  await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_RESPONSE_TRUNCATED'));
  assert.equal(x.events.at(-1).diagnostic.finishReason, 'length');
  assert.equal(x.events.at(-1).type, 'request.failed');
  assert.equal(x.events.filter(e => e.type === 'usage').length, 1);
  assert.equal(x.releases.length, 1);
});

test('maps the real native developer context, pins config, and brackets the complete fetch with a parent permit', async () => {
  const x = setup(); x.config.baseURL = 'https://evil.example.test'; x.config.model = 'switched'; x.config.apiKey = 'changed';
  const output = await x.runner.run({ ...x.input, maxOutputTokens: 123 });
  assert.deepEqual(x.steps, ['permit', 'fetch', 'release']); assert.deepEqual(x.releases, [x.permitId]);
  const { url, init } = x.requests[0]; assert.equal(String(url), 'https://gateway.example.test/v1/chat/completions');
  assert.equal(init.redirect, 'manual'); assert.equal(init.method, 'POST'); assert.ok(init.signal instanceof AbortSignal);
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${key}`);
  const body = JSON.parse(init.body); assert.equal(body.model, 'fixed-model'); assert.equal(body.max_tokens, 123); assert.equal(body.parallel_tool_calls, false); assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: 'system', content: 'trusted instruction' }, { role: 'user', content: prompt }]);
  assert.equal(body.tools[0].function.name, tool.name); assert.equal(body.tools[0].function.strict, true);
  assert.ok(output.items[0] instanceof ModelMessageItem); assert.equal(output.items[0].content.text, 'answer');
  assert.equal(output.tokenUsage, undefined); assert.equal(output.rowResponse.requestId, x.events[0].requestId);
  assert.deepEqual(x.events.map(e => e.type), ['request.started', 'usage', 'request.completed']);
  for (const event of x.events) { assert.deepEqual(event.actor, x.actor); assert.ok(Number.isFinite(event.monotonicMs)); assert.ok(Number.isFinite(Date.parse(event.timestamp))); assert.equal(event.permitId, x.permitId); }
  assert.ok(x.events[1].monotonicMs >= x.events[0].monotonicMs);
  const diagnostic = JSON.stringify({ events: x.events, row: output.rowResponse });
  for (const secret of [key, prompt, 'trusted instruction', 'answer', 'authorization']) assert.equal(diagnostic.includes(secret), false);
});

test('does not release or complete on headers; the response body belongs to the request interval', async () => {
  const body = deferred(); let bodyRequested;
  const bodyRead = new Promise(r => { bodyRequested = r; });
  const x = setup({ fetchImpl: async () => ({ status: 200, ok: true, redirected: false, url: '', text: () => { bodyRequested(); return body.promise; } }) });
  const pending = x.runner.run(x.input); await bodyRead;
  assert.deepEqual(x.events.map(e => e.type), ['request.started']); assert.deepEqual(x.releases, []);
  body.resolve(JSON.stringify(answer())); await pending;
  assert.deepEqual(x.events.map(e => e.type), ['request.started', 'usage', 'request.completed']); assert.equal(x.releases.length, 1);
});

test('preserves native tool items and call IDs through two inference turns', async () => {
  const requests = [];
  const x = setup({ fetchImpl: async (_url, init) => { requests.push(init); return response(requests.length === 1 ? answer({ content: null, tool_calls: [call()] }) : answer()); } });
  const first = await x.runner.run(x.input); assert.equal(first.items.length, 1); assert.ok(first.items[0] instanceof FunctionCallItem);
  assert.equal(first.items[0].callId, 'call_1'); assert.equal(first.items[0].args, '{"id":"E1"}');
  x.context.addContextItems(first.items).addContextItem(FunctionCallOutputItem.create('call_1', '{"excerpt":"evidence"}'));
  await x.runner.run(x.input);
  const messages = JSON.parse(requests[1].body).messages;
  assert.deepEqual(messages.slice(-2), [{ role: 'assistant', content: null, tool_calls: [call()] }, { role: 'tool', tool_call_id: 'call_1', content: '{"excerpt":"evidence"}' }]);
  assert.notEqual(x.events[0].requestId, x.events[3].requestId); assert.equal(x.releases.length, 2);
});

test('rejects multiple returned tool calls instead of silently executing the first one', async () => {
  const x = setup({ body: answer({ content: null, tool_calls: [call('call_1'), call('call_2')] }) });
  await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_MULTIPLE_TOOL_CALLS')); assert.equal(x.requests.length, 1); assert.equal(x.releases.length, 1);
  assert.equal(x.events.at(-1).code, 'GATEWAY_MULTIPLE_TOOL_CALLS');
});

for (const [label, id] of [['missing', undefined], ['empty', ''], ['spaces', 'bad id'], ['too long', 'x'.repeat(129)]]) {
  test(`rejects ${label} returned call ID`, async () => {
    const body = answer({ tool_calls: [call('ok')], content: null }); body.choices[0].message.tool_calls[0].id = id;
    const y = setup({ body }); await assert.rejects(y.runner.run(y.input), codeIs('GATEWAY_INVALID_CALL_ID')); assert.equal(y.releases.length, 1);
  });
}

test('rejects a response call ID already present in the native context', async () => {
  const x = setup({ body: answer({ content: null, tool_calls: [call()] }) });
  x.context.addContextItems([FunctionCallItem.rehydrate({ callId: 'call_1', name: tool.name, args: '{}' }), FunctionCallOutputItem.create('call_1', '{}')]);
  await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_DUPLICATE_CALL_ID')); assert.equal(x.releases.length, 1);
});

for (const [label, items, code] of [
  ['unmatched output', [FunctionCallOutputItem.create('call_1', 'x')], 'GATEWAY_UNMATCHED_TOOL_OUTPUT'],
  ['duplicate call', [FunctionCallItem.rehydrate({ callId: 'call_1', name: tool.name, args: '{}' }), FunctionCallOutputItem.create('call_1', '{}'), FunctionCallItem.rehydrate({ callId: 'call_1', name: tool.name, args: '{}' })], 'GATEWAY_DUPLICATE_CALL_ID'],
  ['missing call ID', [FunctionCallItem.rehydrate({ callId: '', name: tool.name, args: '{}' })], 'GATEWAY_INVALID_CALL_ID'],
  ['parallel calls', [FunctionCallItem.rehydrate({ callId: 'call_1', name: tool.name, args: '{}' }), FunctionCallItem.rehydrate({ callId: 'call_2', name: tool.name, args: '{}' })], 'GATEWAY_MULTIPLE_TOOL_CALLS'],
  ['duplicate output', [FunctionCallItem.rehydrate({ callId: 'call_1', name: tool.name, args: '{}' }), FunctionCallOutputItem.create('call_1', '{}'), FunctionCallOutputItem.create('call_1', '{}')], 'GATEWAY_UNMATCHED_TOOL_OUTPUT'],
]) test(`rejects native context ${label} before acquiring a permit`, async () => {
  const x = setup(); x.context.addContextItems(items); await assert.rejects(x.runner.run(x.input), codeIs(code)); assert.equal(x.requests.length, 0); assert.equal(x.releases.length, 0);
});

test('partial usage retains unknown fields and raw response never escapes', async () => {
  const privateMetadata = 'unrelated-private-provider-metadata';
  const x = setup({ body: answer({ content: 'private model output' }, { usage: { prompt_tokens: 17 }, secret: privateMetadata }) });
  const output = await x.runner.run(x.input); assert.equal(output.tokenUsage, undefined);
  const usage = x.events.find(e => e.type === 'usage').usage;
  assert.deepEqual(usage, { source: 'gateway_reported', requestId: x.events[0].requestId, promptTokens: 17 });
  assert.equal('completionTokens' in usage, false); assert.equal('cachedInputTokens' in usage, false); assert.equal('cost' in usage, false);
  assert.equal(JSON.stringify(output.rowResponse).includes(key), false); assert.equal(JSON.stringify(output.rowResponse).includes('private model output'), false);
  assert.equal(JSON.stringify(output.rowResponse).includes(privateMetadata), false);
});

test('complete native TokenUsage is built only from reported values', async () => {
  const x = setup({ body: answer(undefined, { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } } }) });
  const output = await x.runner.run(x.input); assert.ok(output.tokenUsage instanceof TokenUsage); assert.equal(output.tokenUsage.inputTokens, 10); assert.equal(output.tokenUsage.outputTokens, 3);
  assert.equal(output.tokenUsage.inputTokenDetails.cached_tokens, 2); assert.equal(output.tokenUsage.outputTokenDetails.reasoning_tokens, 1);
});

test('top-level token counts do not invent missing cached/reasoning details', async () => {
  const x = setup({ body: answer(undefined, { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) });
  const output = await x.runner.run(x.input); assert.equal(output.tokenUsage, undefined);
  assert.deepEqual(x.events.find(e => e.type === 'usage').usage, { source: 'gateway_reported', requestId: x.events[0].requestId, promptTokens: 10, completionTokens: 3, totalTokens: 13 });
});

for (const [label, change, code] of [
  ['unknown tool', c => { c.function.name = 'unregistered_tool'; }, 'GATEWAY_UNKNOWN_TOOL'],
  ['invalid arguments JSON', c => { c.function.arguments = '{secret'; }, 'GATEWAY_INVALID_TOOL_ARGUMENTS'],
  ['array arguments', c => { c.function.arguments = '[]'; }, 'GATEWAY_INVALID_TOOL_ARGUMENTS'],
  ['null arguments', c => { c.function.arguments = 'null'; }, 'GATEWAY_INVALID_TOOL_ARGUMENTS'],
]) test(`rejects returned ${label} before the native tool runner`, async () => {
  const c = call(); change(c); const x = setup({ body: answer({ content: null, tool_calls: [c] }) });
  await assert.rejects(x.runner.run(x.input), codeIs(code)); assert.equal(x.releases.length, 1);
});

for (const content of [null, '', 42, []]) test(`rejects an unusable assistant answer (${JSON.stringify(content)})`, async () => {
  const x = setup({ body: answer({ content }) }); await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_INVALID_RESPONSE'));
});

for (const url of ['http://gateway.example.test/v1', 'https://name:password@gateway.example.test/v1', 'https://gateway.example.test/v1?key=secret', 'https://gateway.example.test/v1#secret', 'invalid']) {
  test(`rejects unsafe base URL without a request: ${url.replace('password', 'redacted')}`, () => { assert.throws(() => setup({ config: { baseURL: url } }), codeIs('GATEWAY_CONFIG_INVALID')); });
}

test('rejects a model change and streaming without acquiring a permit', async () => {
  const x = setup(); await assert.rejects(x.runner.run({ ...x.input, model: 'another-model' }), codeIs('GATEWAY_MODEL_MISMATCH'));
  await assert.rejects(x.runner.run({ ...x.input, streaming: true }), codeIs('GATEWAY_STREAMING_UNSUPPORTED'));
  await assert.rejects(x.runner.stream(x.input).next(), codeIs('GATEWAY_STREAMING_UNSUPPORTED')); assert.equal(x.steps.length, 0);
});

for (const [label, fetchImpl, code] of [
  ['redirect', async () => new Response('secret body', { status: 307, headers: { location: 'https://evil.example.test' } }), 'GATEWAY_REDIRECT_REJECTED'],
  ['HTTP failure', async () => new Response(`secret ${key}`, { status: 429 }), 'GATEWAY_HTTP_ERROR'],
  ['network failure', async () => { throw Error(`${key} ${prompt}`); }, 'GATEWAY_FETCH_FAILED'],
  ['invalid JSON', async () => new Response(`invalid ${key}`), 'GATEWAY_INVALID_RESPONSE'],
  ['missing answer', async () => response({ secret: 'unrelated-private-provider-metadata' }), 'GATEWAY_INVALID_RESPONSE'],
]) test(`${label} is sanitized, releases once, and never retries`, async () => {
  let count = 0; const x = setup({ fetchImpl: async (...args) => { count++; return fetchImpl(...args); } });
  await assert.rejects(x.runner.run(x.input), codeIs(code)); assert.equal(count, 1); assert.deepEqual(x.releases, [x.permitId]);
  assert.deepEqual(x.events.map(e => e.type), ['request.started', 'request.failed']); assert.equal(x.events.at(-1).code, code);
  assert.equal(JSON.stringify(x.events).includes(key), false); assert.equal(JSON.stringify(x.events).includes(prompt), false);
});

test('abort while waiting for a permit prevents fetch and reclaims a late grant', async () => {
  const grant = deferred(); const releases = []; let signal; let fetches = 0;
  const x = setup({ permits: { acquire: async (_id, s) => { signal = s; return grant.promise; }, release: id => { releases.push(id); } }, fetchImpl: async () => { fetches++; return response(answer()); } });
  const pending = x.runner.run(x.input); x.controller.abort(); await assert.rejects(pending, codeIs('GATEWAY_ABORTED'));
  assert.equal(signal.aborted, true); assert.equal(fetches, 0); assert.equal(x.events.some(e => e.type === 'request.started'), false);
  const permitId = randomUUID(); grant.resolve({ id: permitId }); await new Promise(r => setImmediate(r)); assert.deepEqual(releases, [permitId]);
});

for (const phase of ['fetch', 'body']) test(`abort during ${phase} releases the parent permit and has no completion`, async () => {
  const entered = deferred();
  const x = setup({ fetchImpl: async (_url, init) => { if (phase === 'fetch') { entered.resolve(); return new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(Error(key)), { once: true })); }
    return { status: 200, ok: true, url: '', redirected: false, text: () => { entered.resolve(); return new Promise(() => {}); } }; } });
  const pending = x.runner.run(x.input); await entered.promise; x.controller.abort(); await assert.rejects(pending, codeIs('GATEWAY_ABORTED'));
  assert.equal(x.releases.length, 1); assert.deepEqual(x.events.map(e => e.type), ['request.started', 'request.failed']);
});

test('request deadline starts at fetch and aborts a stalled body', async () => {
  const x = setup({ config: { requestTimeoutMs: 15 }, fetchImpl: async () => ({ status: 200, ok: true, url: '', redirected: false, text: () => new Promise(() => {}) }) });
  await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_REQUEST_TIMEOUT')); assert.equal(x.releases.length, 1); assert.equal(x.events.at(-1).code, 'GATEWAY_REQUEST_TIMEOUT');
});

test('a configured request timeout cannot exceed the fixed 40 second cap', async t => {
  const original = globalThis.setTimeout; const durations = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => { durations.push(ms); return original(fn, 1, ...args); });
  const x = setup({ config: { requestTimeoutMs: 90000 }, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_REQUEST_TIMEOUT')); assert.deepEqual(durations, [40000]); assert.equal(x.releases.length, 1);
});

// The provider already receives the credential in a request header. Its response
// must never turn that credential into native Context items, metadata or artifacts.
const unicodeEscaped = value => Array.from(value, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
for (const [label, body] of [
  ['assistant content', () => answer({ content: `reflected ${key}` })],
  ['tool call ID', () => { const c = call(); c.id = key; return answer({ content: null, tool_calls: [c] }); }],
  ['tool argument', () => { const c = call(); c.function.arguments = JSON.stringify({ id: key }); return answer({ content: null, tool_calls: [c] }); }],
  ['unknown response value', () => answer(undefined, { providerDebug: { authorization: `Bearer ${key}` } })],
  ['unknown response property name', () => answer(undefined, { [key]: 'provider metadata' })],
  ['assistant JSON escaped value', () => answer({ content: `{"sections":{"summary":[{"text":"${unicodeEscaped(key)}"}]}}` })],
  ['assistant JSON escaped property name', () => answer({ content: `{"${unicodeEscaped(key)}":"provider metadata"}` })],
  ['tool arguments escaped value', () => { const c = call(); c.function.arguments = `{"id":"${unicodeEscaped(key)}"}`; return answer({ content: null, tool_calls: [c] }); }],
  ['tool arguments escaped property name', () => { const c = call(); c.function.arguments = `{"${unicodeEscaped(key)}":"E1"}`; return answer({ content: null, tool_calls: [c] }); }],
]) test(`rejects a provider-reflected configured credential in ${label} before native items escape`, async () => {
  const x = setup({ body: body() });
  await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_SECRET_REFLECTED'));
  assert.deepEqual(x.events.map(event => event.type), ['request.started', 'request.failed']);
  assert.equal(x.events[1].code, 'GATEWAY_SECRET_REFLECTED'); assert.deepEqual(x.releases, [x.permitId]);
  assert.equal(JSON.stringify(x.events).includes(key), false); assert.equal(x.requests.length, 1);
});

test('decodes JSON unicode escapes in response metadata before credential checks', async () => {
  const raw = JSON.stringify(answer(undefined, { providerDebug: key })).replace(key, unicodeEscaped(key));
  const x = setup({ fetchImpl: async () => new Response(raw, { status: 200 }) });
  await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_SECRET_REFLECTED')); assert.equal(x.releases.length, 1);
});

const responseCap = 1024 * 1024;
const encode = value => new TextEncoder().encode(value);

test('native response stream remains inside its request interval until the body arrives', async () => {
  const entered = deferred(); let controller;
  const stream = new ReadableStream({ start(value) { controller = value; }, pull() { entered.resolve(); } });
  const x = setup({ fetchImpl: async () => new Response(stream) });
  const pending = x.runner.run(x.input); await entered.promise; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(x.events.map(event => event.type), ['request.started']); assert.equal(x.releases.length, 0);
  controller.enqueue(encode(JSON.stringify(answer()))); controller.close(); await pending;
  assert.deepEqual(x.events.map(event => event.type), ['request.started', 'usage', 'request.completed']); assert.equal(x.releases.length, 1);
});

test('over-limit native response stream is immediately cancelled and aborted without waiting for EOF', async () => {
  let cancelled = 0; let requestSignal;
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(responseCap).fill(0x20)); controller.enqueue(encode('x'));
    // No close: the cumulative byte cap, rather than EOF or timeout, must stop this request.
  }, cancel() { cancelled++; } });
  const x = setup({ config: { requestTimeoutMs: 100 }, fetchImpl: async (_url, init) => { requestSignal = init.signal; return new Response(stream); } });
  await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, 1); assert.equal(requestSignal.aborted, true); assert.deepEqual(x.releases, [x.permitId]);
  assert.deepEqual(x.events.map(event => event.type), ['request.started', 'request.failed']);
});

test('response cap counts UTF-8 bytes even when Content-Length understates the actual body', async () => {
  const raw = JSON.stringify(answer({ content: '界'.repeat(400_000) }));
  assert.ok(raw.length < responseCap); assert.ok(Buffer.byteLength(raw) > responseCap);
  const x = setup({ fetchImpl: async () => new Response(raw, { headers: { 'content-length': '12' } }) });
  await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_RESPONSE_TOO_LARGE')); assert.equal(x.releases.length, 1);
});

test('declared Content-Length above the cap is rejected before an otherwise valid response is accepted', async () => {
  const x = setup({ fetchImpl: async () => new Response(JSON.stringify(answer()), { headers: { 'content-length': String(responseCap + 1) } }) });
  await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_RESPONSE_TOO_LARGE')); assert.equal(x.releases.length, 1);
});

test('a native response of exactly one MiB is allowed', async () => {
  const json = JSON.stringify(answer()); const raw = json + ' '.repeat(responseCap - Buffer.byteLength(json));
  const x = setup({ fetchImpl: async () => new Response(raw) });
  const output = await x.runner.run(x.input); assert.equal(output.items[0].content.text, 'answer'); assert.equal(x.releases.length, 1);
});

test('controlled text-only transport doubles also reject oversized decoded text after reading', async () => {
  const x = setup({ fetchImpl: async () => ({ status: 200, ok: true, redirected: false, url: '', text: async () => JSON.stringify(answer({ content: 'x'.repeat(responseCap) })) }) });
  await assert.rejects(x.runner.run(x.input), codeIs('GATEWAY_RESPONSE_TOO_LARGE')); assert.equal(x.releases.length, 1);
});

test('abort while reading a real response stream cancels the reader and releases once', async () => {
  const entered = deferred(); let cancelled = 0;
  const stream = new ReadableStream({ pull() { entered.resolve(); }, cancel() { cancelled++; } });
  const x = setup({ fetchImpl: async () => new Response(stream) });
  const pending = x.runner.run(x.input); await entered.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(stream.locked, true); assert.deepEqual(x.events.map(event => event.type), ['request.started']);
  const rejection = assert.rejects(pending, codeIs('GATEWAY_ABORTED')); x.controller.abort(); await rejection;
  assert.equal(cancelled, 1); assert.deepEqual(x.releases, [x.permitId]);
});

// Synthetic offline fault bodies below exercise structures absent from the old
// live archive. They are NOT reconstructions of missing historical responses.
test('protocol failure records bounded structural diagnostics and valid usage without completing the request', async () => {
  const privateName='provider-private-tool-name', privateArguments='provider-private-arguments';
  const body=answer({content:null,tool_calls:[call('call_1'),{...call('call_2',privateName),function:{name:privateName,arguments:JSON.stringify({id:privateArguments})}}]},
    {usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}});
  body.choices[0].finish_reason='tool_calls';
  const x=setup({body});let failure;
  await assert.rejects(x.runner.run(x.input),error=>{failure=error;return codeIs('GATEWAY_MULTIPLE_TOOL_CALLS')(error);});
  assert.deepEqual(x.events.map(e=>e.type),['request.started','usage','request.failed']);
  const usage=x.events.find(e=>e.type==='usage').usage;
  assert.deepEqual(usage,{source:'gateway_reported',requestId:x.events[0].requestId,promptTokens:10,completionTokens:3,totalTokens:13});
  assert.deepEqual(failure.diagnostic,{stage:'protocol',httpStatus:200,choiceCount:1,toolCallCount:2,
    allowedToolNames:['read_evidence'],returnedAllowedToolNames:['read_evidence'],unknownToolNameCount:1,
    finishReason:'tool_calls',finishReasonPresent:true,usageStatus:'reported'});
  assert.deepEqual(x.events.at(-1).diagnostic,failure.diagnostic);
  assert.ok(Object.isFrozen(failure.diagnostic)&&Object.isFrozen(failure.diagnostic.allowedToolNames));
  assert.equal(x.releases.length,1);assert.equal(x.events.some(e=>e.type==='request.completed'),false);
  const logged=JSON.stringify({events:x.events,diagnostic:failure.diagnostic});
  for(const text of [key,prompt,privateName,privateArguments,'call_1','call_2'])assert.equal(logged.includes(text),false);
});

test('missing protocol-failure usage remains unknown rather than zero or fabricated', async () => {
  const x=setup({body:answer({content:null,tool_calls:[call('one'),call('two')]})});let failure;
  await assert.rejects(x.runner.run(x.input),error=>{failure=error;return codeIs('GATEWAY_MULTIPLE_TOOL_CALLS')(error);});
  assert.equal(failure.diagnostic.usageStatus,'missing');assert.equal(failure.diagnostic.finishReason,null);
  assert.equal(failure.diagnostic.finishReasonPresent,false);assert.equal(x.events.some(e=>e.type==='usage'),false);
  assert.equal(x.events.some(e=>e.type==='request.completed'),false);
});

test('safe JSON HTTP failure can retain valid reported usage while remaining failed', async () => {
  const body=answer(undefined,{usage:{prompt_tokens:17}});body.choices[0].finish_reason='stop';
  const x=setup({fetchImpl:async()=>new Response(JSON.stringify(body),{status:429})});let failure;
  await assert.rejects(x.runner.run(x.input),error=>{failure=error;return codeIs('GATEWAY_HTTP_ERROR')(error);});
  assert.equal(failure.diagnostic.stage,'http');assert.equal(failure.diagnostic.httpStatus,429);
  assert.equal(failure.diagnostic.usageStatus,'reported');
  assert.deepEqual(x.events.map(e=>e.type),['request.started','usage','request.failed']);
  assert.deepEqual(x.events.find(e=>e.type==='usage').usage,{source:'gateway_reported',requestId:x.events[0].requestId,promptTokens:17});
});

for(const [label,usage]of [['non-number',{prompt_tokens:'10'}],['negative',{completion_tokens:-1}],['inconsistent',{prompt_tokens:10,completion_tokens:3,total_tokens:99}],['non-object',[]]])
test(`invalid ${label} usage is diagnosed as unknown and does not change a valid business answer`,async()=>{
  const x=setup({body:answer(undefined,{usage})}),output=await x.runner.run(x.input);
  assert.equal(output.items[0].content.text,'answer');assert.equal(output.tokenUsage,undefined);
  const completed=x.events.find(e=>e.type==='request.completed');assert.equal(completed.diagnostic.usageStatus,'invalid');
  assert.equal(x.events.some(e=>e.type==='usage'),false);assert.equal(x.events.some(e=>e.type==='request.failed'),false);
  assert.deepEqual(output.rowResponse.usage,{source:'gateway_reported',requestId:x.events[0].requestId});
});

test('unrecognized finish reason is an enum projection and never provider-controlled text',async()=>{
  const privateReason='private-provider-finish-reason';const body=answer();body.choices[0].finish_reason=privateReason;
  const x=setup({body});await x.runner.run(x.input);const diagnostic=x.events.find(e=>e.type==='request.completed').diagnostic;
  assert.equal(diagnostic.finishReason,'other');assert.equal(diagnostic.finishReasonPresent,true);
  assert.equal(JSON.stringify(x.events).includes(privateReason),false);
});

test('credential reflection blocks every provider structure projection and usage before native items escape',async()=>{
  const body=answer({content:key},{usage:{prompt_tokens:10}});body.choices[0].finish_reason='stop';
  const x=setup({body});let failure;
  await assert.rejects(x.runner.run(x.input),error=>{failure=error;return codeIs('GATEWAY_SECRET_REFLECTED')(error);});
  assert.equal(failure.diagnostic.stage,'credential');assert.equal(failure.diagnostic.choiceCount,null);
  assert.equal(failure.diagnostic.toolCallCount,null);assert.equal(failure.diagnostic.usageStatus,'not_available');
  assert.equal(x.events.some(e=>e.type==='usage'),false);assert.equal(JSON.stringify(x.events).includes(key),false);
});

test('body limit rejection retains body-stage diagnostics and no partial response or usage',async()=>{
  const x=setup({fetchImpl:async()=>new Response('x'.repeat(responseCap+1))});let failure;
  await assert.rejects(x.runner.run(x.input),error=>{failure=error;return codeIs('GATEWAY_RESPONSE_TOO_LARGE')(error);});
  assert.equal(failure.diagnostic.stage,'body');assert.equal(failure.diagnostic.httpStatus,200);
  assert.equal(failure.diagnostic.toolCallCount,null);assert.equal(failure.diagnostic.usageStatus,'not_available');
  assert.equal(x.events.some(e=>e.type==='usage'),false);assert.equal(x.releases.length,1);
});

test('permit-release failure cannot record a request as completed or return a business answer',async()=>{
  const x=setup({permits:{acquire:async()=>({id:randomUUID()}),release:async()=>{throw Error(`private release error ${key}`);}}});let failure;
  await assert.rejects(x.runner.run(x.input),error=>{failure=error;return codeIs('GATEWAY_PERMIT_RELEASE_FAILED')(error);});
  assert.equal(x.events.some(e=>e.type==='request.completed'),false);assert.equal(failure.diagnostic.stage,'release');
  assert.equal(x.events.at(-1).type,'request.failed');assert.equal(JSON.stringify(x.events).includes(key),false);
});

test('confirmed release does not move the actual successful fetch/body end timestamp',async()=>{
  const release=deferred(),entered=deferred();
  const x=setup({permits:{acquire:async()=>({id:randomUUID()}),release:async()=>{entered.resolve();await release.promise;}}});
  const pending=x.runner.run(x.input);await entered.promise;const releaseEnteredAt=performance.now();
  assert.equal(x.events.some(e=>e.type==='request.completed'),false,'success is unconfirmed while release acknowledgement is pending');
  await new Promise(r=>setImmediate(r));release.resolve();await pending;
  const completed=x.events.find(e=>e.type==='request.completed');assert.ok(completed.monotonicMs<=releaseEnteredAt);
  assert.ok(completed.monotonicMs>=x.events.find(e=>e.type==='request.started').monotonicMs);
});

test('Run cancellation while permit release acknowledgement waits cannot return a late business response',async()=>{
  const release=deferred(),entered=deferred();
  const x=setup({permits:{acquire:async()=>({id:randomUUID()}),release:async()=>{entered.resolve();await release.promise;}}});
  const pending=x.runner.run(x.input);await entered.promise;
  x.controller.abort();release.resolve();
  await assert.rejects(pending,codeIs('GATEWAY_ABORTED'));
  assert.equal(x.events.some(e=>e.type==='request.completed'),false);assert.equal(x.events.at(-1).diagnostic.stage,'release');
});

test('usage sink failure cannot expose completion or an answer and records a safe trace-stage failure',async()=>{
  const sink=[],privateObserverText=`private usage sink failure ${key} ${prompt}`;
  const x=setup({body:answer(undefined,{usage:{prompt_tokens:17}}),trace:event=>{
    if(event.type==='usage')throw Error(privateObserverText);
    sink.push(event);
  }});let failure;
  await assert.rejects(x.runner.run(x.input),error=>{failure=error;return codeIs('GATEWAY_TRACE_FAILED')(error);});
  assert.equal(sink.some(e=>e.type==='request.completed'),false);
  assert.equal(sink.at(-1).type,'request.failed');assert.equal(sink.at(-1).code,'GATEWAY_TRACE_FAILED');
  assert.equal(sink.at(-1).diagnostic.stage,'trace');assert.equal(failure.diagnostic.stage,'trace');
  assert.equal(JSON.stringify({sink,error:failure}).includes(privateObserverText),false);
  assert.equal(JSON.stringify({sink,error:failure}).includes(key),false);assert.equal(x.releases.length,1);
});

for(const [label,calls,expected]of [
  ['unknown later tool',[call('first'),call('second','unregistered_later_tool')],'GATEWAY_UNKNOWN_TOOL'],
  ['duplicate later ID',[call('first'),call('first')],'GATEWAY_DUPLICATE_CALL_ID'],
  ['malformed later arguments',[call('first'),{...call('second'),function:{name:'read_evidence',arguments:'[]'}}],'GATEWAY_INVALID_TOOL_ARGUMENTS'],
  ['above eight calls',Array.from({length:9},(_,n)=>call(`call_${n}`)),'GATEWAY_TOOL_BATCH_LIMIT'],
])test(`enabled native bridge validates entire raw batch (${label}) before staging any call`,async()=>{
  const {createToolBatchBridge}=await import('../../dist/server/model/tool-batch.js');
  const controller=new AbortController();let x;
  const bridge=createToolBatchBridge({signal:controller.signal,resolveTask:()=>x.actor,onFailure:()=>{}});
  try{
    x=setup({config:{signal:controller.signal,toolBatchBridge:bridge},body:answer({content:null,tool_calls:calls},{usage:{prompt_tokens:17}})});
    await assert.rejects(x.runner.run(x.input),codeIs(expected));
    assert.equal(bridge.getBatchForCall(x.context,calls[0].id),undefined,'rejected batch must never become an executable native queue');
    assert.equal(x.events.some(e=>e.type==='request.completed'),false);
    assert.equal(x.events.find(e=>e.type==='usage').usage.promptTokens,17);
    assert.equal(x.requests.length,1);assert.equal(x.releases.length,1);
  }finally{bridge.dispose();}
});
