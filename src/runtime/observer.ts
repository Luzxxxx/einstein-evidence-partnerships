import { createHuman, SituationSpecification, type SemanticEvent } from '@mozaik-ai/core';
import type { TaskIdentity } from '../model/gateway-runner.js';
import { WorkerEventSchema, type WorkerEvent } from '../contracts/events.js';
import { sha256Bytes } from '../evidence/hashing.js';

class EveryEvent extends SituationSpecification {
  isSatisfiedBy() { return true; }
}
export function createObserver(accept: (event: SemanticEvent) => void, failed: () => void) {
  return createHuman({ name: 'Application observer', capabilities: [], handlers: [{ specification: new EveryEvent(),
    processor: { apply: ({ event }) => { try { accept(event); } catch { failed(); } } } }] });
}
export const textRef = (text: string) => { const hash = sha256Bytes(Buffer.from(text, 'utf8')); return { id: `ref_${hash}`, hash }; };
/** Strict metadata projection only. No raw context, prompt, reasoning or provider response. */
export function projectNative(event: SemanticEvent, actor: TaskIdentity, calls: Map<string, string>): WorkerEvent | undefined {
  const p = event.payload as Record<string, any>;
  let payload: unknown;
  if (['message_received.started', 'message_received.completed', 'inference.started', 'inference.completed'].includes(event.type)) payload = { kind: 'loop' };
  else if (event.type === 'function_call.started') {
    calls.set(p.call.callId, p.call.name);
    payload = { kind: 'tool_ref', callId: p.call.callId, toolName: p.call.name, artifactRef: textRef(p.call.args) };
  } else if (event.type === 'function_call.completed') {
    if (!calls.has(p.callId)) throw Error('UNKNOWN_NATIVE_TOOL_COMPLETION');
    payload = { kind: 'tool_ref', callId: p.callId, toolName: calls.get(p.callId), artifactRef: textRef(p.output.text) };
  } else if (event.type === 'model.answer') payload = { kind: 'answer_ref', artifactRef: textRef(p.answer.content.text) };
  else return undefined;
  return WorkerEventSchema.parse({ ...actor, source: 'mozaik', type: event.type, payload });
}
