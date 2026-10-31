import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { discoverTestFiles, executeOfflineTests } from '../../scripts/test-offline.mjs';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'einstein-task1-runner-'));
  t.after(() => {
    assert.equal(realpathSync(root), realpathSync(resolve(root)));
    assert.ok(basename(root).startsWith('einstein-task1-runner-'));
    assert.equal(resolve(root, '..'), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  for (const name of ['unit', 'integration', 'tooling', 'fixtures', 'online'])
    mkdirSync(join(root, 'tests', name), { recursive: true });
  for (const name of ['unit/a.test.mjs', 'integration/b.test.mjs', 'tooling/c.test.mjs',
    'online/never.test.mjs', 'fixtures/never.test.mjs', 'unit/never.eval.mjs'])
    writeFileSync(join(root, 'tests', name), '// test fixture; no network\n');
  return root;
}

test('default discovery only selects explicit offline test roots', t => {
  const root = project(t);
  assert.deepEqual(discoverTestFiles(root, []).map(p => p.replaceAll('\\', '/')), [
    'tests/integration/b.test.mjs', 'tests/tooling/c.test.mjs', 'tests/unit/a.test.mjs',
  ]);
});

test('filters select a directory or file and deduplicate deterministically', t => {
  const root = project(t);
  assert.deepEqual(discoverTestFiles(root, ['tests/unit', 'tests/unit/a.test.mjs'])
    .map(p => p.replaceAll('\\', '/')), ['tests/unit/a.test.mjs']);
});

test('outside, missing, evaluation and option-like filters fail closed', t => {
  const root = project(t);
  for (const filter of ['../outside', resolve(root, 'tests/unit'), 'tests/../scripts',
    'tests/online', 'tests/fixtures', 'tests/unit/never.eval.mjs', '--import=bad',
    'tests/unit/missing.test.mjs'])
    assert.throws(() => discoverTestFiles(root, [filter]), undefined, filter);
});

test('a junction cannot route the runner outside the allowed test tree', t => {
  const root = project(t);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'bad.test.mjs'), '// must never execute');
  symlinkSync(outside, join(root, 'tests/unit/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => discoverTestFiles(root, ['tests/unit/escape/bad.test.mjs']));
});

test('every run builds before testing; Windows paths are passed as argv without a shell', async t => {
  const root = project(t);
  const calls = [];
  const code = await executeOfflineTests({ projectRoot: root, filters: ['tests/unit'],
    invoke: async args => { calls.push(args); return 0; } });
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].args[0], join(root, 'scripts/build-server.mjs'));
  assert.equal(calls[1].command, process.execPath);
  assert.deepEqual(calls[1].args, ['--test', 'tests/unit/a.test.mjs']);
  assert.ok(calls.every(call => call.cwd === root && call.shell === false));
});

test('a failed build returns its real exit and never executes tests', async t => {
  const root = project(t);
  let calls = 0;
  assert.equal(await executeOfflineTests({ projectRoot: root, filters: ['tests/unit'],
    invoke: async () => { calls++; return 7; } }), 7);
  assert.equal(calls, 1);
});

test('a failing test returns nonzero; invalid filters and empty suites do not pass', async t => {
  const root = project(t);
  let calls = 0;
  assert.equal(await executeOfflineTests({ projectRoot: root, filters: ['tests/unit'],
    invoke: async () => ++calls === 1 ? 0 : 3 }), 3);
  await assert.rejects(executeOfflineTests({ projectRoot: root, filters: ['tests/online'],
    invoke: async () => { throw new Error('Must not execute'); } }));
  rmSync(join(root, 'tests/unit/a.test.mjs'));
  assert.throws(() => discoverTestFiles(root, ['tests/unit']));
});
