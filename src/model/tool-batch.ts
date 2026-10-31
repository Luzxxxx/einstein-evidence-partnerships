import { FunctionCallItem, FunctionCallOutputItem, ModelMessageItem, ModelContext,
  type ContextItem, type InferenceInput, type InferenceOutput, type InterceptionHandler,
  type ExecutableTransition, type SemanticEvent, type Tool } from '@mozaik-ai/core';
import { canonicalizeArtifact } from '../contracts/canonical.js';
import type { TaskIdentity } from './gateway-runner.js';
import { randomUUID } from 'node:crypto';
import { sha256Bytes } from '../evidence/hashing.js';

/** An application adapter around the installed SDK's public interception hook.
 * core4.2 itself selects only the first FunctionCallItem from an inference. This
 * queue schedules every remaining ORIGINAL call through its actual native tool
 * state before allowing another inference. It never invokes tools or invents outputs. */
export type NativeToolBatch = Readonly<{
  calls: readonly FunctionCallItem[];
  assistantText: string | null;
  assistantMessage?: ModelMessageItem;
  outputs: readonly FunctionCallOutputItem[];
  complete: boolean;
}>;
export type ToolBatchManifest = Readonly<{
  actor: TaskIdentity; batchId: string; phase: 'staged' | 'progress' | 'completed' | 'cancelled' | 'failed';
  calls: readonly Readonly<{ callId: string; toolName: string; argumentsSha256: string;
    started: boolean; returned: boolean; outputSha256?: string }>[];
}>;
export type ToolBatchBridge = Readonly<{
  maxCalls: 8;
  stage(input: InferenceInput, output: InferenceOutput): InferenceOutput;
  observeNative(event: SemanticEvent, actor: TaskIdentity): boolean;
  getBatchForCall(context: ModelContext, callId: string): NativeToolBatch | undefined;
  interceptionHandler: InterceptionHandler;
  dispose(): void;
}>;
/** Trusted synchronous execution control, separate from trace callbacks. */
export type InferenceContractGuard = Readonly<{
  inspect(input: InferenceInput, fullOutput: InferenceOutput, actor: Readonly<TaskIdentity>): void;
}>;
type Options = { resolveTask(contextId: string): TaskIdentity; signal: AbortSignal;
  onFailure(code: string): void; maxCalls?: 8; onBatch?(manifest: ToolBatchManifest): void;
  inferenceGuard?: InferenceContractGuard };
type CallSnapshot = Readonly<{ callId: string; name: string; args: string }>;
type ToolSnapshot = Readonly<{ tool: Tool; invoke: Tool['invoke']; name: string; shape: string }>;
type Completion = { content: FunctionCallOutputItem['output']; text: string };
type Batch = {
  batchId: string; terminalPhase?: ToolBatchManifest['phase'];
  context: ModelContext; actor: TaskIdentity; calls: FunctionCallItem[]; callValues: CallSnapshot[];
  assistantMessage?: ModelMessageItem; assistantText: string | null; tools: ToolSnapshot[];
  prefix: ContextItem[]; prefixValues: string[]; outputs: FunctionCallOutputItem[]; outputValues: string[];
  started: boolean; completion?: Completion; complete: boolean;
};
type Owner = { context: ModelContext; actor: TaskIdentity; knownCalls: Set<string>; batches: Batch[]; pending?: Batch };
const capabilities = new WeakSet<object>();
const name = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export class ToolBatchError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ToolBatchError'; }
}
function deny(code: string): never { throw new ToolBatchError(code); }
function require(condition: unknown, code: string): asserts condition { if (!condition) deny(code); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const sameActor = (a: TaskIdentity, b: TaskIdentity) => canonicalizeArtifact(a) === canonicalizeArtifact(b);
function callValue(call: FunctionCallItem): CallSnapshot { return { callId: call.callId, name: call.name, args: call.args }; }
function itemValue(item: ContextItem): string {
  if (item instanceof FunctionCallItem) return canonicalizeArtifact({ type: item.type, ...callValue(item) });
  if (item instanceof FunctionCallOutputItem) return canonicalizeArtifact({ type: item.type, callId: item.callId, text: item.output.text });
  const value = item as unknown as { type: string; role?: string; content?: { text?: string } };
  // Only private in-memory fingerprints; source/prompt text is never emitted here.
  return canonicalizeArtifact({ type: value.type, role: value.role ?? null, text: value.content?.text ?? null });
}
function toolValue(tool: Tool): string {
  return canonicalizeArtifact({ type: tool.type, name: tool.name, description: tool.description,
    parameters: tool.parameters, strict: tool.strict ?? null });
}
export function isToolBatchBridge(value: unknown): value is ToolBatchBridge {
  return Boolean(value && typeof value === 'object' && capabilities.has(value));
}

export function createToolBatchBridge(options: Options): ToolBatchBridge {
  require(options.signal instanceof AbortSignal && typeof options.resolveTask === 'function' && typeof options.onFailure === 'function'
    && (options.maxCalls === undefined || options.maxCalls === 8)
    && (options.onBatch === undefined || typeof options.onBatch === 'function')
    && (options.inferenceGuard === undefined || typeof options.inferenceGuard.inspect === 'function'), 'TOOL_BATCH_CONFIG_INVALID');
  const owners = new WeakMap<ModelContext, Owner>(), byId = new Map<string, ModelContext>();
  const staged = new WeakMap<InferenceOutput, { context: ModelContext; actor: TaskIdentity }>();
  let closed = false, stopped: string | undefined;
  const hashText=(text:string)=>sha256Bytes(Buffer.from(text,'utf8'));
  function notify(batch: Batch, phase: ToolBatchManifest['phase']): void {
    if (batch.terminalPhase) return;
    if (['completed','cancelled','failed'].includes(phase)) batch.terminalPhase = phase;
    const index=batch.outputs.length;
    const calls=batch.callValues.map((call,i)=>{
      const returned=i<index||(i===index&&Boolean(batch.completion));
      const text=i<index?batch.outputValues[i]:i===index?batch.completion?.text:undefined;
      return Object.freeze({callId:call.callId,toolName:call.name,argumentsSha256:hashText(call.args),
        started:i<index||(i===index&&batch.started),returned,
        ...(returned&&text!==undefined?{outputSha256:hashText(text)}:{})});
    });
    const manifest=Object.freeze({actor:batch.actor,batchId:batch.batchId,phase,calls:Object.freeze(calls)});
    try { options.onBatch?.(manifest); } catch { deny('TOOL_BATCH_TRACE_FAILED'); }
  }
  const fail = (error: unknown): false => {
    const code = error instanceof ToolBatchError ? error.code : options.signal.aborted ? 'RUN_ABORTED' : 'TOOL_BATCH_INVALID_STATE';
    stopped ??= code;
    for(const context of byId.values()){
      const batch=owners.get(context)?.pending;
      if(batch)try{notify(batch,stopped==='RUN_ABORTED'?'cancelled':'failed');}catch{/* Original failure stays authoritative. */}
    }
    try { options.onFailure(stopped); } catch { /* Never reject the SDK's discarded native-loop Promise. */ }
    return false;
  };
  const active = () => { if (options.signal.aborted) deny('RUN_ABORTED'); if (closed || stopped) deny(stopped ?? 'TOOL_BATCH_CLOSED'); };
  function actorFor(context: ModelContext): TaskIdentity {
    require(context instanceof ModelContext, 'TOOL_BATCH_CONTEXT_MISMATCH');
    let actor: TaskIdentity;
    try { actor = options.resolveTask(context.id); } catch { return deny('TOOL_BATCH_IDENTITY_MISMATCH'); }
    require(actor && actor.contextId === context.id && ['runId','agentId','role','loopId','taskId','contextId'].every(k =>
      typeof actor[k as keyof TaskIdentity] === 'string') && ['proposer','counter-evidence','critic'].includes(actor.role)
      && (actor.attempt === 1 || actor.attempt === 2), 'TOOL_BATCH_IDENTITY_MISMATCH');
    return Object.freeze({ runId: actor.runId, agentId: actor.agentId, role: actor.role, loopId: actor.loopId,
      taskId: actor.taskId, contextId: actor.contextId, attempt: actor.attempt });
  }
  function ownerFor(context: ModelContext): Owner {
    const actor = actorFor(context), priorObject = byId.get(context.id);
    require(!priorObject || priorObject === context, 'TOOL_BATCH_CONTEXT_MISMATCH');
    let owner = owners.get(context);
    if (owner) require(sameActor(owner.actor, actor), 'TOOL_BATCH_IDENTITY_MISMATCH');
    else { owner = { context, actor, knownCalls: new Set(), batches: [] }; owners.set(context, owner); byId.set(context.id, context); }
    return owner;
  }
  function validateTools(batch: Batch, input: InferenceInput): void {
    const tools=input.tools;
    require(input.context === batch.context && tools && tools.length === batch.tools.length, 'TOOL_BATCH_CONTEXT_MISMATCH');
    for (let i = 0; i < batch.tools.length; i++) {
      const expected = batch.tools[i], actual = tools[i];
      require(actual === expected.tool && actual.invoke === expected.invoke && toolValue(actual) === expected.shape, 'TOOL_BATCH_TOOLSET_CHANGED');
    }
  }
  function validateBlock(batch: Batch, pairs: number, exactLength: boolean): void {
    const items = batch.context.getItems();
    require(exactLength ? items.length === batch.prefix.length + pairs * 2 : items.length >= batch.prefix.length + pairs * 2,
      'TOOL_BATCH_CONTEXT_MISMATCH');
    for (let i = 0; i < batch.prefix.length; i++) require(items[i] === batch.prefix[i]
      && itemValue(items[i]) === batch.prefixValues[i], 'TOOL_BATCH_CONTEXT_MISMATCH');
    for (let i = 0; i < pairs; i++) {
      const call = items[batch.prefix.length + i * 2], output = items[batch.prefix.length + i * 2 + 1];
      require(call === batch.calls[i] && canonicalizeArtifact(callValue(batch.calls[i])) === canonicalizeArtifact(batch.callValues[i]), 'TOOL_BATCH_CALL_MISMATCH');
      require(output === batch.outputs[i] && output instanceof FunctionCallOutputItem && output.callId === batch.callValues[i].callId
        && output.output.text === batch.outputValues[i], 'TOOL_BATCH_OUTPUT_MISMATCH');
    }
  }
  function validateOwner(owner: Owner): void { require(sameActor(actorFor(owner.context), owner.actor), 'TOOL_BATCH_IDENTITY_MISMATCH'); }
  function beforeInvoke(owner: Owner, batch: Batch, transition: Extract<ExecutableTransition,{nextStateId:'function_call'}>): void {
    active(); validateOwner(owner); validateTools(batch, transition.input.inferenceInput); validateBlock(batch, batch.outputs.length, true);
    require(!batch.complete && !batch.started && transition.input.call === batch.calls[batch.outputs.length]
      && canonicalizeArtifact(callValue(transition.input.call)) === canonicalizeArtifact(batch.callValues[batch.outputs.length]), 'TOOL_BATCH_CALL_MISMATCH');
  }
  const interceptionHandler: InterceptionHandler = {
    isSatisfiedBy(transition) {
      if (transition.nextStateId === 'function_call') return true;
      return transition.nextStateId === 'inference' && Boolean(owners.get(transition.input.context)?.pending);
    },
    async handle(transition) {
      try {
        active();
        if (transition.nextStateId === 'function_call') {
          const owner = ownerFor(transition.input.inferenceInput.context), batch = owner.pending;
          require(batch, 'TOOL_BATCH_UNREGISTERED_CALL'); beforeInvoke(owner, batch, transition); return transition;
        }
        require(transition.nextStateId === 'inference', 'TOOL_BATCH_INVALID_TRANSITION');
        const owner = ownerFor(transition.input.context), batch = owner.pending;
        require(batch && batch.started && batch.completion, 'TOOL_BATCH_MISSING_COMPLETION'); validateTools(batch, transition.input);
        // The SDK's completion event spreads the item; its `output` content object
        // is the exact reference subsequently appended inside FunctionCallOutputItem.
        const index = batch.outputs.length, items = batch.context.getItems();
        require(items.length === batch.prefix.length + (index + 1) * 2, 'TOOL_BATCH_CONTEXT_MISMATCH');
        const output = items[items.length - 1], originalCall = items[items.length - 2];
        require(originalCall === batch.calls[index] && output instanceof FunctionCallOutputItem
          && output.callId === batch.callValues[index].callId && output.output === batch.completion.content
          && output.output.text === batch.completion.text, 'TOOL_BATCH_OUTPUT_MISMATCH');
        batch.outputs.push(output); batch.outputValues.push(batch.completion.text); batch.started = false; delete batch.completion;
        validateBlock(batch, batch.outputs.length, true);
        if (batch.outputs.length === batch.calls.length) { batch.complete = true; notify(batch,'completed'); delete owner.pending; return transition; }
        const next: Extract<ExecutableTransition,{nextStateId:'function_call'}> = { nextStateId:'function_call', input:{
          call:batch.calls[batch.outputs.length], inferenceInput:transition.input } };
        beforeInvoke(owner,batch,next); return next;
      } catch(error) {
        fail(error);
        // core4.2 does not await runLoop's Promise at the application boundary.
        // Park its failed loop after rejecting the application task, never return
        // a fabricated answer/output or let a rejected loop escape unhandled.
        return await new Promise<ExecutableTransition>(()=>{});
      }
    },
  };
  const bridge: ToolBatchBridge = Object.freeze({
    maxCalls: 8 as const,
    stage(input: InferenceInput, output: InferenceOutput): InferenceOutput {
      active(); const owner = ownerFor(input.context), old = staged.get(output);
      if (old) { require(old.context === input.context, 'TOOL_BATCH_CONTEXT_MISMATCH');
        require(sameActor(old.actor, owner.actor), 'TOOL_BATCH_IDENTITY_MISMATCH'); return output; }
      require(!owner.pending, 'TOOL_BATCH_REENTRY');
      require(output && Array.isArray(output.items), 'TOOL_BATCH_INVALID_OUTPUT');
      const calls = output.items.filter(item=>item instanceof FunctionCallItem);
      require(!output.items.some(item=>item.type==='function_call'&&!(item instanceof FunctionCallItem)), 'TOOL_BATCH_INVALID_CALL');
      require(calls.length <= 8, 'TOOL_BATCH_LIMIT');
      const messages = output.items.filter(item=>item instanceof ModelMessageItem);
      require(messages.length <= 1, 'TOOL_BATCH_MULTIPLE_MESSAGES');
      // Full original output, before queue mutation, notification or Tool.invoke.
      // Gateway + Engine double-stage is idempotent via the cache above.
      if (options.inferenceGuard) {
        try {
          const result: unknown = options.inferenceGuard.inspect(input, output, owner.actor);
          // A void callback can accidentally be async in TypeScript. Observe a
          // rejected Promise without awaiting it or admitting any native call.
          if(result!==undefined)void Promise.resolve(result).catch(()=>{});
          require(result === undefined, 'TOOL_BATCH_ASYNC_GUARD_FORBIDDEN');
        } catch (error) {
          fail(error);
          throw error instanceof ToolBatchError ? error : new ToolBatchError(stopped ?? 'TOOL_BATCH_INVALID_STATE');
        }
      }
      if (!calls.length) { staged.set(output,{context:input.context,actor:owner.actor}); return output; }
      const toolByName = new Map<string,Tool>();
      for(const tool of input.tools??[]) {
        require(tool.type==='function' && typeof tool.name==='string' && name.test(tool.name) && !toolByName.has(tool.name)
          && typeof tool.invoke==='function', 'TOOL_BATCH_INVALID_TOOLS'); toolByName.set(tool.name,tool);
      }
      const ids=new Set<string>();
      for(const call of calls) {
        require(typeof call.callId==='string'&&name.test(call.callId)&&!ids.has(call.callId)&&!owner.knownCalls.has(call.callId), 'TOOL_BATCH_DUPLICATE_CALL_ID');
        require(toolByName.has(call.name),'TOOL_BATCH_UNKNOWN_TOOL');
        require(typeof call.args==='string','TOOL_BATCH_INVALID_ARGUMENTS');
        let args:unknown;try{args=JSON.parse(call.args);}catch{return deny('TOOL_BATCH_INVALID_ARGUMENTS');}
        require(record(args),'TOOL_BATCH_INVALID_ARGUMENTS'); ids.add(call.callId);
      }
      const prefix=[...input.context.getItems()];
      const batch:Batch={batchId:randomUUID(),context:input.context,actor:owner.actor,calls:[...calls],callValues:calls.map(callValue),
        assistantMessage:messages[0],assistantText:messages[0]?.content.text??null,
        tools:(input.tools??[]).map(tool=>({tool,invoke:tool.invoke,name:tool.name,shape:toolValue(tool)})),
        prefix,prefixValues:prefix.map(itemValue),outputs:[],outputValues:[],started:false,complete:false};
      owner.batches.push(batch); owner.pending=batch;for(const id of ids)owner.knownCalls.add(id);
      notify(batch,'staged');
      // Native 4.2 only sees the first original call. The other calls remain in
      // the bound queue and are ALL dispatched by its public interception hook.
      const result={...output,items:output.items.filter(item=>!(item instanceof FunctionCallItem)||item===calls[0])};
      staged.set(result,{context:input.context,actor:owner.actor});return result;
    },
    observeNative(event: SemanticEvent, actor: TaskIdentity): boolean {
      if(event.type!=='function_call.started'&&event.type!=='function_call.completed')return true;
      try {
        active();const context=byId.get(actor.contextId);require(context,'TOOL_BATCH_CONTEXT_MISMATCH');
        const owner=owners.get(context);require(owner&&sameActor(owner.actor,actor),'TOOL_BATCH_IDENTITY_MISMATCH');
        require(event.producerId===actor.agentId&&record(event.payload)&&event.payload.loopId===actor.loopId,'TOOL_BATCH_IDENTITY_MISMATCH');
        const batch=owner.pending;require(batch&&!batch.complete,'TOOL_BATCH_UNREGISTERED_CALL');const index=batch.outputs.length;
        const p=event.payload;
        if(event.type==='function_call.started') {
          require(record(p.inferenceInput)&&p.inferenceInput.context===context&&p.call===batch.calls[index], 'TOOL_BATCH_CONTEXT_MISMATCH');
          require(!batch.started&&!batch.completion,'TOOL_BATCH_DUPLICATE_START');
          validateTools(batch,p.inferenceInput as InferenceInput);validateBlock(batch,index,true);batch.started=true;notify(batch,'progress');
        }else{
          require(batch.started&&!batch.completion&&p.callId===batch.callValues[index].callId&&record(p.output)
            &&p.output.type==='input_text'&&typeof p.output.text==='string','TOOL_BATCH_COMPLETION_MISMATCH');
          batch.completion={content:p.output as unknown as FunctionCallOutputItem['output'],text:p.output.text};
          notify(batch,'progress');
        }
        return true;
      }catch(error){return fail(error);}
    },
    getBatchForCall(context:ModelContext,callId:string):NativeToolBatch|undefined {
      const owner=owners.get(context),batch=owner?.batches.find(b=>b.callValues.some(c=>c.callId===callId));if(!batch)return undefined;
      try{active();require(owner,'TOOL_BATCH_CONTEXT_MISMATCH');validateOwner(owner);validateBlock(batch,batch.outputs.length,false);}catch(error){fail(error);throw error;}
      return Object.freeze({calls:Object.freeze([...batch.calls]),assistantText:batch.assistantText,
        ...(batch.assistantMessage?{assistantMessage:batch.assistantMessage}:{}),outputs:Object.freeze([...batch.outputs]),complete:batch.complete});
    },
    interceptionHandler,
    dispose(){
      for(const context of byId.values()){const batch=owners.get(context)?.pending;if(batch)try{notify(batch,'cancelled');}catch{/* No new work during disposal. */}}
      closed=true;options.signal.removeEventListener('abort',onAbort);byId.clear();
    },
  });
  const onAbort=()=>{fail(new ToolBatchError('RUN_ABORTED'));};options.signal.addEventListener('abort',onAbort,{once:true});
  capabilities.add(bridge);return bridge;
}
