import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const contract = readFileSync(new URL('../../docs/superpowers/specs/2026-10-30-interface-contracts.md', import.meta.url), 'utf8');
const design = readFileSync(new URL('../../docs/superpowers/specs/2026-10-30-einstein-mvp-design.md', import.meta.url), 'utf8');
const plan = readFileSync(new URL('../../docs/superpowers/plans/2026-10-30-einstein-mvp-implementation.md', import.meta.url), 'utf8');

test('the contract declares the raw source-file hash as mandatory, not just a record hash', () => {
  assert.ok(/\| Evidence \|[^\n]*sourceFileSha256/.test(contract), 'Evidence must list sourceFileSha256');
  assert.ok(/sourceFileSha256[^\n]*必填/.test(contract), 'Raw source-file hash must explicitly be mandatory');
  assert.ok(/sourceFileSha256[^\n]*原始字节/.test(contract), 'Raw byte hashing must be explicit');
  assert.ok(contract.includes('/^[a-f0-9]{64}$/'));
});

test('the design and planned runtime regressions explicitly keep sourceFileSha256', () => {
  assert.ok(/sourceFileSha256[^\n]*必填/.test(design), 'Design must require sourceFileSha256');
  assert.ok(/sourceFileSha256[^\n]*缺失[^\n]*格式[^\n]*不匹配/.test(plan), 'Runtime regression cases must be planned explicitly');
});
