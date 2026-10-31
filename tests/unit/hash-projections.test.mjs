import assert from 'node:assert/strict';
import test from 'node:test';
import * as hashes from '../../dist/server/evidence/hashing.js';
import { canonicalizeArtifact } from '../../dist/server/contracts/canonical.js';
import { input, pool, draft, evidence, ids, h } from '../fixtures/contracts.mjs';

test('input projection excludes only run identity; pool projection excludes its self hash', () => {
  const i = input();
  assert.equal(hashes.hashRunInput(i), hashes.hashRunInput({ ...i, runId: ids.otherRun }));
  assert.notEqual(hashes.hashRunInput(i), hashes.hashRunInput({ ...i, promptVersion: 'prompt-v2' }));
  assert.throws(() => hashes.hashRunInput({ ...i, apiKey: 'forbidden' }));
  const p = pool(), { poolHash, ...content } = p;
  assert.equal(hashes.hashCandidatePool(p), hashes.hashCandidatePool({ ...p, poolHash: h(0) }));
  assert.equal(hashes.hashCandidatePool(p), hashes.hashCandidatePool(content));
  assert.notEqual(hashes.hashCandidatePool(p), hashes.hashCandidatePool({ ...p, query: 'changed' }));
  assert.notEqual(hashes.hashArtifact(draft()), hashes.hashArtifact({ ...draft(), poolHash: h(0) }));
});

test('source record hash binds all fields, including ordinary hash and timestamps', () => {
  const value = { hash: 'source-owned', createdAt: 'source-owned', nested: { b: 2, a: 1 } };
  assert.equal(hashes.hashSourceRecord(value), hashes.sha256Bytes(new TextEncoder().encode(canonicalizeArtifact(value))));
  for (const field of ['hash', 'draftHash', 'createdAt', 'recordedAt', 'committedAt'])
    assert.notEqual(hashes.hashSourceRecord(value), hashes.hashSourceRecord({ ...value, [field]: 'changed' }));
  assert.equal(hashes.hashSourceRecord(value), hashes.hashSourceRecord({ nested: { a: 1, b: 2 }, createdAt: 'source-owned', hash: 'source-owned' }));
});

test('evidence snapshot hash binds complete entries and preserves list order', () => {
  const a = evidence(), b = { ...evidence(), id: 'e-2' };
  assert.equal(hashes.hashEvidenceSnapshot([a, b]), hashes.hashEvidenceSnapshot([a, b]));
  assert.notEqual(hashes.hashEvidenceSnapshot([a, b]), hashes.hashEvidenceSnapshot([b, a]));
  assert.notEqual(hashes.hashEvidenceSnapshot([a]), hashes.hashEvidenceSnapshot([{ ...a, sourceFileSha256: h(0) }]));
  assert.throws(() => hashes.hashEvidenceSnapshot([a, a]));
});
