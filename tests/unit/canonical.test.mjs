import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeArtifact, sliceCodePoints } from '../../dist/server/contracts/canonical.js';
import { hashArtifact, sha256Bytes } from '../../dist/server/evidence/hashing.js';

test('canonical JSON sorts keys recursively and preserves arrays and every field', () => {
  const value = { z: [{ b: 2, a: 1 }, 0], a: { hash: 'bound', createdAt: 'bound-time' } };
  const before = structuredClone(value);
  assert.equal(canonicalizeArtifact(value),
    '{"a":{"createdAt":"bound-time","hash":"bound"},"z":[{"a":1,"b":2},0]}');
  assert.deepEqual(value, before);
  assert.equal(canonicalizeArtifact({ 2: 'two', 10: 'ten', a: 'a' }),
    '{"10":"ten","2":"two","a":"a"}');
  assert.notEqual(canonicalizeArtifact([1, 2]), canonicalizeArtifact([2, 1]));
});

test('canonical JSON accepts finite JSON values, null-prototype records and shared references', () => {
  const shared = Object.freeze({ answer: 42 });
  const record = Object.assign(Object.create(null), { b: shared, a: shared });
  assert.equal(canonicalizeArtifact(record), '{"a":{"answer":42},"b":{"answer":42}}');
  for (const value of [null, true, false, 0, -0, 1.25, '', 'quote"\\\n', [], {}])
    assert.equal(JSON.stringify(JSON.parse(canonicalizeArtifact(value))), JSON.stringify(value));
});

test('canonical JSON rejects non-JSON values and non-finite numbers at any depth', () => {
  const invalid = [undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol('x'),
    new Date('2026-10-30T00:00:00.000Z'), new Map(), new Set(), new Uint8Array([1]),
    new Number(2), new (class Record { value = 1; })()];
  for (const value of invalid) {
    assert.throws(() => canonicalizeArtifact(value), TypeError);
    assert.throws(() => canonicalizeArtifact({ nested: value }), TypeError);
    assert.throws(() => canonicalizeArtifact([value]), TypeError);
  }
});

test('canonical JSON rejects cycles but not repeated non-cyclic references', () => {
  const object = {}; object.self = object;
  const array = []; array.push(array);
  assert.throws(() => canonicalizeArtifact(object), TypeError);
  assert.throws(() => canonicalizeArtifact(array), TypeError);
  const shared = { x: 1 };
  assert.equal(canonicalizeArtifact([shared, shared]), '[{"x":1},{"x":1}]');
});

test('canonical JSON rejects sparse arrays and extra array properties instead of dropping content', () => {
  const sparse = [1, , 3];
  const extra = [1]; extra.note = 'must not disappear';
  const hidden = [1]; Object.defineProperty(hidden, 'hidden', { value: 2 });
  for (const value of [sparse, new Array(1), extra, hidden])
    assert.throws(() => canonicalizeArtifact(value), TypeError);
});

test('canonical JSON rejects accessors without invoking them, including array accessors', () => {
  let called = 0;
  const object = Object.defineProperty({}, 'x', { enumerable: true, get() { called++; return 1; } });
  const array = Object.defineProperty([], '0', { enumerable: true, get() { called++; return 1; } });
  assert.throws(() => canonicalizeArtifact(object), TypeError);
  assert.throws(() => canonicalizeArtifact(array), TypeError);
  assert.equal(called, 0);
  const toJSON = { toJSON() { called++; return {}; } };
  assert.throws(() => canonicalizeArtifact(toJSON), TypeError);
  assert.equal(called, 0);
});

test('canonical JSON rejects symbol keys and hidden object properties instead of ignoring them', () => {
  const symbol = { x: 1, [Symbol('secret')]: 2 };
  const array = [1]; array[Symbol('secret')] = 2;
  const hidden = Object.defineProperty({ x: 1 }, 'hidden', { value: 2 });
  for (const value of [symbol, array, hidden])
    assert.throws(() => canonicalizeArtifact(value), TypeError);
});

test('canonical JSON rejects unpaired UTF-16 surrogates in values and keys', () => {
  for (const text of ['\ud800', '\udfff', 'x\ud800y', '\ud800\ud800', '\udc00\ud800']) {
    assert.throws(() => canonicalizeArtifact(text), TypeError);
    assert.throws(() => canonicalizeArtifact({ [text]: 1 }), TypeError);
  }
  assert.equal(canonicalizeArtifact('😀\ufffd'), '"😀�"');
});

test('canonical JSON preserves Unicode normalization, text newlines and BOM characters', () => {
  const composed = '\u00e9';
  const decomposed = 'e\u0301';
  assert.notEqual(canonicalizeArtifact(composed), canonicalizeArtifact(decomposed));
  assert.notEqual(hashArtifact({ text: composed }), hashArtifact({ text: decomposed }));
  assert.notEqual(hashArtifact({ text: 'a\n' }), hashArtifact({ text: 'a\r\n' }));
  assert.notEqual(hashArtifact({ text: 'a' }), hashArtifact({ text: '\ufeffa' }));
});

test('artifact hashes are deterministic SHA-256 of the canonical root projection', () => {
  assert.equal(sha256Bytes(new Uint8Array()),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Bytes(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hashArtifact({ b: [2], a: 1 }), hashArtifact({ a: 1, b: [2] }));
  assert.equal(hashArtifact({ a: 1 }), sha256Bytes(new TextEncoder().encode('{"a":1}')));
  assert.match(hashArtifact({ a: 1 }), /^[a-f0-9]{64}$/);
});

test('artifact hashes exclude exactly root self hashes and declared recording timestamps', () => {
  const base = { id: 'draft', payload: { text: 'bound' } };
  assert.equal(hashArtifact({ ...base, hash: 'old', draftHash: 'old',
    createdAt: 'first', recordedAt: 'first', committedAt: 'first' }), hashArtifact(base));
  assert.equal(hashArtifact({ ...base, hash: 'new', draftHash: 'new',
    createdAt: 'second', recordedAt: 'second', committedAt: 'second' }), hashArtifact(base));
  for (const field of ['id', 'runId', 'version', 'inputHash', 'poolHash', 'counterReportHash',
    'sourceFileSha256', 'recordSha256', 'excerptSha256', 'evidenceSnapshotHash',
    'admittedAt', 'deadlineAt', 'updatedAt']) {
    assert.notEqual(hashArtifact({ ...base, [field]: 'first' }), hashArtifact({ ...base, [field]: 'second' }), field);
  }
});

test('artifact hashes bind every nested hash and timestamp, including Critic target and Evidence', () => {
  for (const field of ['hash', 'draftHash', 'inputHash', 'poolHash', 'counterReportHash',
    'evidenceSnapshotHash', 'sourceFileSha256', 'recordSha256', 'excerptSha256',
    'createdAt', 'recordedAt', 'committedAt']) {
    assert.notEqual(hashArtifact({ target: { [field]: 'first' } }),
      hashArtifact({ target: { [field]: 'second' } }), field);
    assert.notEqual(hashArtifact({ evidence: [{ [field]: 'first' }] }),
      hashArtifact({ evidence: [{ [field]: 'second' }] }), field);
  }
  assert.notEqual(hashArtifact({ target: { draftHash: 'approved-v1' } }),
    hashArtifact({ target: { draftHash: 'changed-v2' } }));
});

test('hash projection validates excluded fields too and never silently erases invalid input', () => {
  for (const root of [null, true, 1, 'artifact', [], new Date()])
    assert.throws(() => hashArtifact(root), TypeError);
  for (const field of ['hash', 'draftHash', 'createdAt', 'recordedAt', 'committedAt']) {
    assert.throws(() => hashArtifact({ [field]: undefined }), TypeError);
    assert.throws(() => hashArtifact({ [field]: '\ud800' }), TypeError);
  }
  let called = 0;
  const input = Object.defineProperty({}, 'hash', { enumerable: true, get() { called++; return 'x'; } });
  assert.throws(() => hashArtifact(input), TypeError);
  assert.equal(called, 0);
});

test('raw byte hashing respects views and distinguishes BOM/newline and whole-file bytes from a record', () => {
  const bytes = new TextEncoder().encode('xabcx');
  assert.equal(sha256Bytes(bytes.subarray(1, 4)),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const plain = new TextEncoder().encode('{"a":1}\n');
  const crlf = new TextEncoder().encode('{"a":1}\r\n');
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...plain]);
  assert.notEqual(sha256Bytes(plain), sha256Bytes(crlf));
  assert.notEqual(sha256Bytes(plain), sha256Bytes(bom));
  assert.notEqual(sha256Bytes(plain), hashArtifact({ a: 1 }));
  assert.notEqual(sha256Bytes(new Uint8Array([0xff])), sha256Bytes(new TextEncoder().encode('\ufffd')));
  for (const invalid of ['abc', [97, 98, 99], new ArrayBuffer(3), new DataView(new ArrayBuffer(3)), null])
    assert.throws(() => sha256Bytes(invalid), TypeError);
});

test('code-point slicing uses zero-based half-open scalar positions without normalization', () => {
  const text = 'A😀e\u0301中';
  assert.equal(sliceCodePoints(text, 1, 2), '😀');
  assert.equal(sliceCodePoints(text, 2, 4), 'e\u0301');
  assert.equal(sliceCodePoints(text, 0, 5), text);
  assert.equal(sliceCodePoints(text, 5, 5), '');
  assert.equal(sliceCodePoints('', 0, 0), '');
  assert.notEqual(sliceCodePoints(text, 1, 2), text.slice(1, 2));
});

test('code-point slicing rejects malformed strings and invalid ranges rather than clipping', () => {
  for (const [start, end] of [[-1, 1], [1, 0], [0, 3], [0.5, 1], [0, NaN],
    [0, Infinity], [0, Number.MAX_SAFE_INTEGER + 1], ['0', 1], [0, undefined]])
    assert.throws(() => sliceCodePoints('😀x', start, end), RangeError);
  assert.throws(() => sliceCodePoints('\ud800', 0, 1), TypeError);
  assert.throws(() => sliceCodePoints(null, 0, 0), TypeError);
});
