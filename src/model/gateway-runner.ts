import { randomUUID } from 'node:crypto';
import { DeveloperMessageItem, SystemMessageItem, UserMessageItem, ModelMessageItem,
  FunctionCallItem, FunctionCallOutputItem, ReasoningItem, ModelContext,
  TokenUsage, InputTokenDetails, OutputTokenDetails } from '@mozaik-ai/core';
import type { InferenceInput, InferenceOutput, InferenceRunner, SemanticEvent } from '@mozaik-ai/core';
import { RawUsageSchema } from '../contracts/domain.js';
import type { RawUsage } from '../contracts/domain.js';
import type { GatewayDiagnostic } from '../contracts/events.js';
import { isToolBatchBridge, ToolBatchError, type ToolBatchBridge } from './tool-batch.js';

export type TaskIdentity = {
  runId: string; agentId: string; role: 'proposer' | 'counter-evidence' | 'critic';
  loopId: string; taskId: string; contextId: string; attempt: 1 | 2;
};
export type PermitClient = {
  acquire(requestId: string, signal: AbortSignal): Promise<{ id: string }>;
  release(permitId: string): void | Promise<void>;
};
export type GatewayConfig = {
  baseURL: string; apiKey: string; model: string; signal: AbortSignal;
  resolveTask: (contextId: string) => TaskIdentity;
  requestTimeoutMs?: number; fetchImpl?: typeof fetch;
  /** Trusted provider-supported JSON syntax mode; domain validation still applies. */
  responseFormat?: 'json_object';
  /** Trusted capability bound to the native task engine's interception hook. */
  toolBatchBridge?: ToolBatchBridge;
};
export type GatewayTrace = {
  type: 'request.started' | 'request.completed' | 'request.failed' | 'usage';
  actor: TaskIdentity; requestId: string; permitId?: string;
  timestamp: string; monotonicMs: number; code?: string; usage?: RawUsage;
  diagnostic?: GatewayDiagnostic;
};

/** Error messages and codes never incorporate provider bodies, prompts, headers, or causes. */
export class GatewayError extends Error {
  readonly code: string;
  readonly diagnostic?: GatewayDiagnostic;
  constructor(code: string, diagnostic?: GatewayDiagnostic) {
    super(code); this.name = 'GatewayError'; this.code = code;
    if (diagnostic) this.diagnostic = diagnostic;
  }
}

const REQUEST_CAP_MS = 40_000;
const RESPONSE_CAP_BYTES = 1024 * 1024;
const metadataName = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(code: string): never { throw new GatewayError(code); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validName(value: unknown): value is string { return typeof value === 'string' && metadataName.test(value); }
function callId(value: unknown): asserts value is string {
  if (!validName(value)) fail('GATEWAY_INVALID_CALL_ID');
}
function argumentsObject(value: unknown): asserts value is string {
  if (typeof value !== 'string') fail('GATEWAY_INVALID_TOOL_ARGUMENTS');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail('GATEWAY_INVALID_TOOL_ARGUMENTS'); }
  if (!record(parsed)) fail('GATEWAY_INVALID_TOOL_ARGUMENTS');
}
function taskIdentity(value: TaskIdentity, contextId: string): TaskIdentity {
  if (!value || !['runId', 'agentId', 'loopId', 'taskId', 'contextId'].every(key => {
    const id = value[key as keyof TaskIdentity]; return typeof id === 'string' && uuid.test(id);
  }) || !['proposer', 'counter-evidence', 'critic'].includes(value.role)
      || (value.attempt !== 1 && value.attempt !== 2) || value.contextId !== contextId) fail('GATEWAY_TASK_IDENTITY_INVALID');
  return Object.freeze({ runId: value.runId, agentId: value.agentId, role: value.role,
    loopId: value.loopId, taskId: value.taskId, contextId: value.contextId, attempt: value.attempt });
}

type WireMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string };
function toRequest(input: InferenceInput, model: string, bridge?: ToolBatchBridge, responseFormat?: 'json_object'): { body: string; callIds: Set<string>; toolNames: Set<string> } {
  if (input.model !== model) fail('GATEWAY_MODEL_MISMATCH');
  if (input.streaming) fail('GATEWAY_STREAMING_UNSUPPORTED');
  if (!(input.context instanceof ModelContext)) fail('GATEWAY_INVALID_CONTEXT');
  if (input.tools && input.tools.length > 128) fail('GATEWAY_INVALID_REQUEST');
  const toolNames = new Set<string>();
  const tools = input.tools?.map(tool => {
    if (tool.type !== 'function' || !validName(tool.name) || toolNames.has(tool.name)
        || typeof tool.description !== 'string' || !record(tool.parameters)) fail('GATEWAY_INVALID_REQUEST');
    toolNames.add(tool.name);
    return { type: 'function', function: { name: tool.name, description: tool.description,
      parameters: tool.parameters, strict: tool.strict } };
  });
  const messages: WireMessage[] = [];
  const callIds = new Set<string>();
  let pendingCall: string | undefined;
  const contextItems = input.context.getItems();
  for (let itemIndex = 0; itemIndex < contextItems.length; itemIndex++) {
    const item = contextItems[itemIndex];
    if (item instanceof FunctionCallItem) {
      if (bridge) {
        const batch = bridge.getBatchForCall(input.context, item.callId);
        if (!batch || !batch.complete || batch.calls[0] !== item || batch.calls.length < 1
          || batch.calls.length > bridge.maxCalls || batch.outputs.length !== batch.calls.length) fail('GATEWAY_TOOL_BATCH_CONTEXT');
        const calls: NonNullable<WireMessage['tool_calls']> = [];
        const outputs: WireMessage[] = [];
        for (let index = 0; index < batch.calls.length; index++) {
          const call = batch.calls[index], output = batch.outputs[index];
          if (contextItems[itemIndex + index * 2] !== call || contextItems[itemIndex + index * 2 + 1] !== output
            || !(output instanceof FunctionCallOutputItem) || output.callId !== call.callId) fail('GATEWAY_TOOL_BATCH_CONTEXT');
          callId(call.callId); argumentsObject(call.args);
          if (callIds.has(call.callId)) fail('GATEWAY_DUPLICATE_CALL_ID');
          if (!toolNames.has(call.name)) fail('GATEWAY_UNKNOWN_TOOL');
          callIds.add(call.callId);
          calls.push({ id: call.callId, type: 'function', function: { name: call.name, arguments: call.args } });
          outputs.push({ role: 'tool', tool_call_id: call.callId, content: output.output.text });
        }
        // The SDK appends native call/output pairs. Its function-call priority
        // omits the assistant message from Context, so reconstruct the ORIGINAL
        // group from the capability registry without merging unrelated turns.
        messages.push({ role: 'assistant', content: batch.assistantText, tool_calls: calls }, ...outputs);
        itemIndex += batch.calls.length * 2 - 1;
        continue;
      }
      callId(item.callId);
      if (callIds.has(item.callId)) fail('GATEWAY_DUPLICATE_CALL_ID');
      if (pendingCall) fail('GATEWAY_MULTIPLE_TOOL_CALLS');
      if (!toolNames.has(item.name)) fail('GATEWAY_UNKNOWN_TOOL');
      argumentsObject(item.args);
      callIds.add(item.callId); pendingCall = item.callId;
      const wireCall = { id: item.callId, type: 'function' as const, function: { name: item.name, arguments: item.args } };
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') previous.tool_calls = [wireCall];
      else messages.push({ role: 'assistant', content: null, tool_calls: [wireCall] });
      continue;
    }
    if (item instanceof FunctionCallOutputItem) {
      callId(item.callId);
      if (pendingCall !== item.callId || typeof item.output?.text !== 'string') fail('GATEWAY_UNMATCHED_TOOL_OUTPUT');
      messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output.text });
      pendingCall = undefined; continue;
    }
    // The installed native Chat Completions mapper also omits provider reasoning from subsequent messages.
    if (item instanceof ReasoningItem) continue;
    if (pendingCall) fail('GATEWAY_UNMATCHED_TOOL_OUTPUT');
    if (item instanceof DeveloperMessageItem || item instanceof SystemMessageItem) {
      messages.push({ role: 'system', content: item.content.text });
    } else if (item instanceof UserMessageItem) {
      messages.push({ role: 'user', content: item.content.text });
    } else if (item instanceof ModelMessageItem) {
      messages.push({ role: 'assistant', content: item.content.text });
    } else fail('GATEWAY_INVALID_CONTEXT');
  }
  if (pendingCall) fail('GATEWAY_UNMATCHED_TOOL_OUTPUT');
  const wire: Record<string, unknown> = { model, messages, stream: false, parallel_tool_calls: false };
  if (tools?.length) wire.tools = tools;
  if (input.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) fail('GATEWAY_INVALID_REQUEST');
    wire.max_tokens = input.maxOutputTokens;
  }
  if (input.reasoningEffort !== undefined) wire.reasoning_effort = input.reasoningEffort;
  if (responseFormat && input.structuredOutput) fail('GATEWAY_INVALID_REQUEST');
  if (responseFormat) wire.response_format = { type: responseFormat };
  if (input.structuredOutput) wire.response_format = { type: 'json_schema', json_schema: {
    name: input.structuredOutput.name ?? 'response', schema: input.structuredOutput.schema, strict: input.structuredOutput.strict ?? true,
  } };
  try { return { body: JSON.stringify(wire), callIds, toolNames }; } catch { return fail('GATEWAY_INVALID_REQUEST'); }
}

function reportedCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail('GATEWAY_INVALID_RESPONSE');
  return value;
}

/** Reject exact credential reflection before any provider-controlled native item exists.
 * Content and tool arguments are JSON strings that the application parses once more;
 * inspect that decoded layer too, including object keys and Unicode escapes.
 */
function rejectReflectedSecret(raw: unknown, apiKey: string): void {
  const inspect = (value: unknown): void => {
    const pending: unknown[] = [value];
    while (pending.length) {
      const current = pending.pop();
      if (typeof current === 'string') {
        if (current.includes(apiKey)) fail('GATEWAY_SECRET_REFLECTED');
      } else if (Array.isArray(current)) {
        for (const item of current) pending.push(item);
      } else if (record(current)) {
        for (const [key, item] of Object.entries(current)) {
          if (key.includes(apiKey)) fail('GATEWAY_SECRET_REFLECTED');
          pending.push(item);
        }
      }
    }
  };
  const inspectJsonText = (text: unknown): void => {
    if (typeof text !== 'string') return;
    let decoded: unknown;
    try { decoded = JSON.parse(text); } catch { return; }
    inspect(decoded);
  };
  inspect(raw);
  if (!record(raw) || !Array.isArray(raw.choices)) return;
  for (const choice of raw.choices) {
    if (!record(choice) || !record(choice.message)) continue;
    inspectJsonText(choice.message.content);
    if (!Array.isArray(choice.message.tool_calls)) continue;
    for (const call of choice.message.tool_calls)
      if (record(call) && record(call.function)) inspectJsonText(call.function.arguments);
  }
}

type ReportedUsage = { usage: RawUsage; tokenUsage: TokenUsage | undefined;
  status: GatewayDiagnostic['usageStatus'] };

/** Usage is provider-reported metadata, independent of whether a tool/answer is
 * acceptable. Invalid counts remain unknown rather than coercing or estimating. */
function extractReportedUsage(raw: unknown, requestId: string): ReportedUsage {
  const empty = Object.freeze({ source: 'gateway_reported' as const, requestId });
  if (!record(raw) || raw.usage === undefined || raw.usage === null)
    return { usage: empty, tokenUsage: undefined, status: 'missing' };
  if (!record(raw.usage)) return { usage: empty, tokenUsage: undefined, status: 'invalid' };
  try {
    const reported = raw.usage;
    const promptTokens = reportedCount(reported.prompt_tokens);
    const completionTokens = reportedCount(reported.completion_tokens);
    const totalTokens = reportedCount(reported.total_tokens);
    const cachedInputTokens = reportedCount(record(reported.prompt_tokens_details) ? reported.prompt_tokens_details.cached_tokens : undefined);
    const candidate: RawUsage = { source: 'gateway_reported', requestId,
      ...(promptTokens !== undefined ? { promptTokens } : {}), ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}), ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}) };
    const validated = RawUsageSchema.safeParse(candidate);
    if (!validated.success) return { usage: empty, tokenUsage: undefined, status: 'invalid' };
    const usage = Object.freeze(validated.data);
    // This SDK-only detail is not required to retain otherwise valid public
    // top-level usage. An invalid detail cannot be coerced into a native count.
    let reasoningTokens: number | undefined;
    try { reasoningTokens = reportedCount(record(reported.completion_tokens_details) ? reported.completion_tokens_details.reasoning_tokens : undefined); }
    catch { reasoningTokens = undefined; }
    const tokenUsage = promptTokens !== undefined && completionTokens !== undefined && totalTokens !== undefined
      && cachedInputTokens !== undefined && reasoningTokens !== undefined && reasoningTokens <= completionTokens
      ? new TokenUsage(promptTokens, completionTokens, totalTokens, new InputTokenDetails(cachedInputTokens), new OutputTokenDetails(reasoningTokens))
      : undefined;
    return { usage, tokenUsage, status: Object.keys(usage).length > 2 ? 'reported' : 'missing' };
  } catch { return { usage: empty, tokenUsage: undefined, status: 'invalid' }; }
}

type ResponseStructure = Pick<GatewayDiagnostic, 'choiceCount' | 'toolCallCount' | 'returnedAllowedToolNames'
  | 'unknownToolNameCount' | 'finishReason' | 'finishReasonPresent'>;
function projectResponseStructure(raw: unknown, allowedNames: Set<string>): ResponseStructure {
  const empty: ResponseStructure = { choiceCount: null, toolCallCount: null, returnedAllowedToolNames: [],
    unknownToolNameCount: null, finishReason: null, finishReasonPresent: false };
  if (!record(raw) || !Array.isArray(raw.choices)) return empty;
  empty.choiceCount = raw.choices.length;
  if (raw.choices.length !== 1 || !record(raw.choices[0])) return empty;
  const choice = raw.choices[0];
  empty.finishReasonPresent = Object.hasOwn(choice, 'finish_reason');
  if (typeof choice.finish_reason === 'string') empty.finishReason =
    ['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(choice.finish_reason)
      ? choice.finish_reason as NonNullable<GatewayDiagnostic['finishReason']> : 'other';
  else if (choice.finish_reason !== undefined && choice.finish_reason !== null) empty.finishReason = 'other';
  if (!record(choice.message)) return empty;
  const calls = choice.message.tool_calls;
  if (calls !== undefined && !Array.isArray(calls)) return empty;
  empty.toolCallCount = Array.isArray(calls) ? calls.length : 0;
  empty.unknownToolNameCount = 0;
  for (const call of Array.isArray(calls) ? calls : []) {
    const name = record(call) && record(call.function) ? call.function.name : undefined;
    if (typeof name === 'string' && allowedNames.has(name)) {
      if (!empty.returnedAllowedToolNames.includes(name)) empty.returnedAllowedToolNames.push(name);
    } else empty.unknownToolNameCount++;
  }
  return empty;
}

function toResponse(raw: unknown, requestId: string, permitId: string, previousCalls: Set<string>, toolNames: Set<string>, reported: ReportedUsage,
  input: InferenceInput, bridge?: ToolBatchBridge): InferenceOutput {
  if (!record(raw) || !Array.isArray(raw.choices) || raw.choices.length !== 1 || !record(raw.choices[0])
      || !record(raw.choices[0].message)) fail('GATEWAY_INVALID_RESPONSE');
  // Even syntactically valid JSON/tool arguments may omit material findings when
  // the provider reports truncation. Reject before native Context or Tool.invoke.
  if (raw.choices[0].finish_reason === 'length') fail('GATEWAY_RESPONSE_TRUNCATED');
  const message = raw.choices[0].message;
  if (message.role !== 'assistant') fail('GATEWAY_INVALID_RESPONSE');
  const items: InferenceOutput['items'] = [];
  if (typeof message.content === 'string') {
    if (message.content.length > 0) items.push(ModelMessageItem.rehydrate({ text: message.content }));
  } else if (message.content !== null && message.content !== undefined && message.content !== '') fail('GATEWAY_INVALID_RESPONSE');
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) fail('GATEWAY_INVALID_RESPONSE');
  const calls = message.tool_calls as unknown[] | undefined;
  if (calls && calls.length > 1 && !bridge) fail('GATEWAY_MULTIPLE_TOOL_CALLS');
  if (bridge && calls && calls.length > bridge.maxCalls) fail('GATEWAY_TOOL_BATCH_LIMIT');
  const responseCallIds = new Set<string>();
  for (const call of calls ?? []) {
    if (!record(call)) fail('GATEWAY_INVALID_RESPONSE');
    callId(call.id);
    if (previousCalls.has(call.id) || responseCallIds.has(call.id)) fail('GATEWAY_DUPLICATE_CALL_ID');
    if (call.type !== 'function' || !record(call.function)) fail('GATEWAY_INVALID_RESPONSE');
    if (typeof call.function.name !== 'string' || !toolNames.has(call.function.name)) fail('GATEWAY_UNKNOWN_TOOL');
    argumentsObject(call.function.arguments);
    responseCallIds.add(call.id);
    items.push(FunctionCallItem.rehydrate({ callId: call.id, name: call.function.name, args: call.function.arguments }));
  }
  if (items.length === 0 || (!(calls?.length) && !(typeof message.content === 'string' && message.content.trim()))) fail('GATEWAY_INVALID_RESPONSE');
  // Native field spelling is rowResponse. It contains only our IDs and projected reported usage.
  const output = { items, tokenUsage: reported.tokenUsage, rowResponse: Object.freeze({ requestId, permitId, usage: reported.usage }) };
  // All original calls have passed validation before the bridge can stage any
  // native transition. The strict standalone runner never gains this capability.
  return bridge ? bridge.stage(input, output) : output;
}

/** Race each async boundary so cancellation also works with slow body readers and permit transports. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal, abortError: () => GatewayError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { signal.removeEventListener('abort', onAbort); reject(abortError()); };
    if (signal.aborted) { promise.catch(() => {}); reject(abortError()); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => {
      signal.removeEventListener('abort', onAbort); reject(error);
    });
  });
}

/** The production fetch Response is read incrementally; retained chunks never exceed
 * the fixed cap. Content-Length is only an early rejection, never a trusted limit.
 * Text-only transport doubles receive a post-read byte check, not a memory guarantee.
 */
async function readResponseBody(response: Response, controller: AbortController,
  abortError: () => GatewayError): Promise<string> {
  const declared = response.headers?.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > RESPONSE_CAP_BYTES) {
    try { void response.body?.cancel().catch(() => {}); } catch { /* Failure remains the fixed cap code. */ }
    controller.abort(); fail('GATEWAY_RESPONSE_TOO_LARGE');
  }
  if (!response.body) {
    const text = await abortable(Promise.resolve(response.text()), controller.signal, abortError);
    if (typeof text !== 'string') fail('GATEWAY_INVALID_RESPONSE');
    if (Buffer.byteLength(text, 'utf8') > RESPONSE_CAP_BYTES) {
      controller.abort(); fail('GATEWAY_RESPONSE_TOO_LARGE');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, completed = false, cancelled = false;
  const cancel = (): void => {
    if (cancelled) return; cancelled = true;
    // Do not await a possibly stalled source cancel; abort and permit release must continue.
    try { void reader.cancel().catch(() => {}); } catch { /* Never replace the original failure. */ }
  };
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), controller.signal, abortError);
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('GATEWAY_INVALID_RESPONSE');
      size += value.byteLength;
      if (size > RESPONSE_CAP_BYTES) {
        cancel(); controller.abort(); fail('GATEWAY_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
    completed = true;
    return new TextDecoder().decode(Buffer.concat(chunks, size));
  } finally {
    if (!completed) cancel();
    try { reader.releaseLock(); } catch { /* A pending native read was already observed by abortable. */ }
  }
}

function acquirePermit(client: PermitClient, requestId: string, signal: AbortSignal,
  abortError: () => GatewayError): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', onAbort); reject(abortError());
    };
    if (signal.aborted) { reject(abortError()); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    let grant: Promise<{ id: string }>;
    try { grant = client.acquire(requestId, signal); }
    catch (error) { settled = true; signal.removeEventListener('abort', onAbort); reject(error); return; }
    grant.then(value => {
      if (settled || signal.aborted) {
        // Late grants cannot start work; the parent still owns final Run-level reclamation.
        Promise.resolve().then(() => client.release(value.id)).catch(() => {});
        onAbort(); return;
      }
      // Resolve this promise directly. Aborting after resolution is handled by the caller's finally.
      settled = true; signal.removeEventListener('abort', onAbort); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', onAbort); reject(error);
    });
  });
}

/** Fixed HTTPS Chat Completions transport. No SDK client, retry, fallback, redirect, or provider telemetry. */
export function createGatewayRunner(config: GatewayConfig, permitClient: PermitClient,
  trace: (event: GatewayTrace) => void): InferenceRunner {
  let endpoint: string;
  try {
    const parsed = new URL(config.baseURL);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) fail('GATEWAY_CONFIG_INVALID');
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/chat/completions`;
    endpoint = parsed.href;
  } catch { return fail('GATEWAY_CONFIG_INVALID'); }
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey)
      || typeof config.model !== 'string' || !config.model.trim() || !(config.signal instanceof AbortSignal)
      || typeof config.resolveTask !== 'function' || (config.requestTimeoutMs !== undefined
        && (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs < 1))
      || (config.responseFormat !== undefined && config.responseFormat !== 'json_object')
      || (config.toolBatchBridge !== undefined && !isToolBatchBridge(config.toolBatchBridge))) fail('GATEWAY_CONFIG_INVALID');
  // Capture once so later mutations of the caller's config cannot redirect credentials or switch models.
  const { apiKey, model, signal: runSignal, resolveTask, toolBatchBridge, responseFormat } = config;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = Math.min(REQUEST_CAP_MS, config.requestTimeoutMs ?? REQUEST_CAP_MS);
  if (typeof fetchImpl !== 'function') fail('GATEWAY_CONFIG_INVALID');

  return {
    async run(input: InferenceInput): Promise<InferenceOutput> {
      const requestId = randomUUID();
      const controller = new AbortController();
      const onRunAbort = (): void => controller.abort();
      runSignal.addEventListener('abort', onRunAbort, { once: true });
      if (runSignal.aborted) controller.abort();
      let actor: TaskIdentity | undefined;
      let permitId: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let failure: GatewayError | undefined;
      let output: InferenceOutput | undefined;
      let stage: GatewayDiagnostic['stage'] = 'request';
      let httpStatus: number | null = null;
      let allowedToolNames: string[] = [];
      let structure: ResponseStructure = { choiceCount: null, toolCallCount: null, returnedAllowedToolNames: [],
        unknownToolNameCount: null, finishReason: null, finishReasonPresent: false };
      let reported: ReportedUsage | undefined;
      let usageEmitted = false;
      let completionTiming: { timestamp: string; monotonicMs: number } | undefined;
      const diagnostic = (atStage: GatewayDiagnostic['stage'] = stage): GatewayDiagnostic => {
        const value: GatewayDiagnostic = { stage: atStage, httpStatus, ...structure,
          allowedToolNames: [...allowedToolNames], returnedAllowedToolNames: [...structure.returnedAllowedToolNames],
          usageStatus: reported?.status ?? 'not_available' };
        Object.freeze(value.allowedToolNames); Object.freeze(value.returnedAllowedToolNames);
        return Object.freeze(value);
      };
      const abortError = (): GatewayError => new GatewayError(timedOut ? 'GATEWAY_REQUEST_TIMEOUT' : 'GATEWAY_ABORTED');
      const checkAbort = (): void => { if (controller.signal.aborted) throw abortError(); };
      const emit = (type: GatewayTrace['type'], extra: { code?: string; usage?: RawUsage; diagnostic?: GatewayDiagnostic } = {},
        timing?: { timestamp: string; monotonicMs: number }): void => {
        if (!actor) return;
        try { trace(Object.freeze({ type, actor, requestId, ...(permitId ? { permitId } : {}),
          timestamp: timing?.timestamp ?? new Date().toISOString(), monotonicMs: timing?.monotonicMs ?? performance.now(), ...extra })); }
        catch { throw new GatewayError('GATEWAY_TRACE_FAILED'); }
      };
      const emitUsage = (): void => {
        if (!reported || usageEmitted || reported.status === 'invalid') return;
        usageEmitted = true; emit('usage', { usage: reported.usage });
      };
      const failed = (error: GatewayError): void => {
        // A protocol/HTTP failure is not a successful request. Independently
        // validated reported counts still survive; missing counts stay unknown.
        if (reported?.status === 'reported') try { emitUsage(); } catch { /* No observer-controlled error escapes. */ }
        try { emit('request.failed', { code: error.code, diagnostic: error.diagnostic ?? diagnostic() }); }
        catch { /* Never leak observer errors. */ }
      };
      try {
        if (!(input.context instanceof ModelContext)) fail('GATEWAY_INVALID_CONTEXT');
        try { actor = taskIdentity(resolveTask(input.context.id), input.context.id); }
        catch { fail('GATEWAY_TASK_IDENTITY_INVALID'); }
        checkAbort();
        const mapped = toRequest(input, model, toolBatchBridge, responseFormat);
        allowedToolNames = [...mapped.toolNames].filter(name => !name.includes(apiKey));
        stage = 'permit';
        const permit = await acquirePermit(permitClient, requestId, controller.signal, abortError);
        if (typeof permit?.id !== 'string' || !uuid.test(permit.id)) fail('GATEWAY_PERMIT_INVALID');
        permitId = permit.id;
        checkAbort();
        stage = 'fetch';
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
        emit('request.started');
        const response = await abortable(Promise.resolve(fetchImpl(endpoint, { method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: mapped.body, redirect: 'manual', signal: controller.signal })), controller.signal, abortError);
        httpStatus = Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
        stage = 'body';
        const text = await readResponseBody(response, controller, abortError);
        checkAbort();
        stage = 'http';
        if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
            || (response.url && response.url !== endpoint)) fail('GATEWAY_REDIRECT_REJECTED');
        let raw: unknown;
        stage = 'json';
        try { raw = JSON.parse(text); } catch { if (!response.ok) { stage = 'http'; fail('GATEWAY_HTTP_ERROR'); } fail('GATEWAY_INVALID_RESPONSE'); }
        checkAbort();
        stage = 'credential';
        rejectReflectedSecret(raw, apiKey);
        // Safe structural projection follows credential rejection and never
        // retains raw unknown tool names, arguments, call IDs or provider text.
        structure = projectResponseStructure(raw, new Set(allowedToolNames));
        stage = 'usage'; reported = extractReportedUsage(raw, requestId);
        stage = 'http'; if (!response.ok) fail('GATEWAY_HTTP_ERROR');
        stage = 'protocol';
        output = toResponse(raw, requestId, permitId, mapped.callIds, mapped.toolNames, reported, input, toolBatchBridge);
        // Confirm success only once release succeeds, while preserving the
        // actual fetch/body finish instant rather than including IPC delay.
        completionTiming = { timestamp: new Date().toISOString(), monotonicMs: performance.now() };
      } catch (error) {
        const code = error instanceof GatewayError || error instanceof ToolBatchError ? error.code : controller.signal.aborted ? abortError().code
          : stage === 'permit' ? 'GATEWAY_PERMIT_DENIED' : stage === 'fetch' ? 'GATEWAY_FETCH_FAILED'
            : stage === 'request' ? 'GATEWAY_INVALID_REQUEST' : 'GATEWAY_INVALID_RESPONSE';
        failure = new GatewayError(code, diagnostic());
        controller.abort(); failed(failure);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        runSignal.removeEventListener('abort', onRunAbort);
        if (permitId) {
          try { await permitClient.release(permitId); }
          catch { if (!failure) { failure = new GatewayError('GATEWAY_PERMIT_RELEASE_FAILED', diagnostic('release')); failed(failure); } }
        }
      }
      // The HTTP body may already be complete while the trusted permit transport
      // confirms release. Run cancellation still revokes the late business result.
      if (!failure && runSignal.aborted) {
        controller.abort(); failure = new GatewayError('GATEWAY_ABORTED', diagnostic('release')); failed(failure);
      }
      if (failure) throw failure;
      try {
        // A failed usage sink must not leave an acknowledged successful request
        // or return its business output. Provider counts are independent metadata;
        // completion is the last acknowledgement, with the captured network end.
        emitUsage(); emit('request.completed', { diagnostic: diagnostic('complete') }, completionTiming);
      } catch {
        failure = new GatewayError('GATEWAY_TRACE_FAILED', diagnostic('trace')); failed(failure); throw failure;
      }
      return output!;
    },
    async *stream(_input: InferenceInput): AsyncGenerator<SemanticEvent> {
      throw new GatewayError('GATEWAY_STREAMING_UNSUPPORTED');
    },
  };
}
