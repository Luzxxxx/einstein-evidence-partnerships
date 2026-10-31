import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { buildWeb } from '../../scripts/build-web.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'einstein-task1-web-'));
  t.after(() => {
    assert.equal(resolve(root, '..'), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('einstein-task1-web-'));
    rmSync(root, { recursive: true, force: true });
  });
  for (const [name, bin] of [['typescript', { tsc: 'bin/tsc' }], ['vite', { vite: 'bin/vite.js' }]]) {
    mkdirSync(join(root, 'node_modules', name), { recursive: true });
    writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '0.0.0', bin }));
  }
  return root;
}

test('web build stops at a failed type check instead of bundling invalid TypeScript', t => {
  const root = fixture(t);
  const calls = [];
  assert.equal(buildWeb({ projectRoot: root, invoke: args => { calls.push(args); return 8; } }), 8);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes(join(root, 'tsconfig.web.json')));
});

test('web build typechecks then bundles and preserves the bundler exit status', t => {
  const root = fixture(t);
  const calls = [];
  assert.equal(buildWeb({ projectRoot: root,
    invoke: args => { calls.push(args); return calls.length === 1 ? 0 : 4; } }), 4);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args[0].endsWith(join('typescript', 'bin', 'tsc')));
  assert.ok(calls[1].args[0].endsWith(join('vite', 'bin', 'vite.js')));
  assert.equal(calls[1].args[1], 'build');
  assert.ok(calls.every(call => call.command === process.execPath && call.shell === false && call.cwd === root));
});
