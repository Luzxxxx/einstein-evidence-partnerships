import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { ModelMessageItem } from '@mozaik-ai/core';
import { completionNativeRecorder } from '../../dist/server/evaluation/completion-worker.js';
import { createTaskEngine, SINGLE_TOOL_CALL_POLICY, CONTROLLED_PROPOSER_REPRODUCTION_POLICY } from '../../dist/server/runtime/task-context.js';
import { PROPOSER_INSTRUCTION } from '../../dist/server/runtime/agents/proposer.js';

for (const matches of [false, true]) test(`actual SDK prompt freeze matches=${matches} before inference`, async () => {
  const records = []; let calls = 0;
  const actual = createHash('sha256').update(PROPOSER_INSTRUCTION + '\n' + SINGLE_TOOL_CALL_POLICY + '\n' + CONTROLLED_PROPOSER_REPRODUCTION_POLICY).digest('hex');
  const engine = createTaskEngine({ runId: randomUUID(), model: 'offline_fixture', signal: new AbortController().signal,
    tools: [], emit: () => {}, controlledReproduction: true,
    onNative: completionNativeRecorder({ effectiveControlledProposer: matches ? actual : '0'.repeat(64) }, r => records.push(r)),
    runnerFactory: () => ({ async run() { calls++; return { items: [ModelMessageItem.rehydrate({ text: '{"fixture":true}' })], rowResponse: null }; }, async *stream() {} }) });
  try {
    if (matches) assert.deepEqual(await engine.startTask('proposer', { fixture: 'offline_fixture' }), { fixture: true });
    else await assert.rejects(engine.startTask('proposer', { fixture: 'offline_fixture' }), /NATIVE_OBSERVER_FAILED/);
    assert.equal(calls, matches ? 1 : 0);
    assert.equal(records.find(r => r.type === 'inference.started').instructionMatches, matches);
  } finally { engine.dispose(); }
});
