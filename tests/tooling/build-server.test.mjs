import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { buildServer } from '../../scripts/build-server.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'einstein-task1-build-'));
  t.after(() => {
    assert.ok(basename(root).startsWith('einstein-task1-build-'));
    assert.equal(resolve(root, '..'), resolve(tmpdir()));
    assert.equal(realpathSync(root), realpathSync(resolve(root)));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'dist/server'), { recursive: true });
  mkdirSync(join(root, 'dist/web'), { recursive: true });
  writeFileSync(join(root, 'dist/server/removed-source.js'), 'stale');
  writeFileSync(join(root, 'dist/web/keep.txt'), 'web');
  return root;
}

test('a server build removes stale server output before compilation and preserves web output', t => {
  const root = fixture(t);
  const exit = buildServer({ projectRoot: root, compile: ({ projectRoot }) => {
    assert.equal(projectRoot, root);
    assert.equal(existsSync(join(root, 'dist/server/removed-source.js')), false);
    return 0;
  } });
  assert.equal(exit, 0);
  assert.equal(readFileSync(join(root, 'dist/web/keep.txt'), 'utf8'), 'web');
});

test('a failed compiler cannot leave an old module to make a test pass', t => {
  const root = fixture(t);
  assert.equal(buildServer({ projectRoot: root, compile: () => 12 }), 12);
  assert.equal(existsSync(join(root, 'dist/server/removed-source.js')), false);
});

test('a junction at the dist boundary is rejected without deleting its target', t => {
  const root = mkdtempSync(join(tmpdir(), 'einstein-task1-build-'));
  t.after(() => {
    assert.ok(basename(root).startsWith('einstein-task1-build-'));
    assert.equal(resolve(root, '..'), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const outside = join(root, 'outside');
  mkdirSync(join(outside, 'server'), { recursive: true });
  writeFileSync(join(outside, 'server/sentinel.txt'), 'do not delete');
  symlinkSync(outside, join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildServer({ projectRoot: root,
    compile: () => { throw new Error('Must not compile'); } }));
  assert.equal(readFileSync(join(outside, 'server/sentinel.txt'), 'utf8'), 'do not delete');
});

test('a junction at dist/server itself is also rejected without deleting its target', t => {
  const root = fixture(t);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel.txt'), 'keep');
  const obsoleteServer = resolve(root, 'dist/server');
  assert.equal(resolve(obsoleteServer, '../..'), resolve(root));
  rmSync(obsoleteServer, { recursive: true, force: true });
  symlinkSync(outside, join(root, 'dist/server'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildServer({ projectRoot: root, compile: () => 0 }));
  assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'keep');
});
