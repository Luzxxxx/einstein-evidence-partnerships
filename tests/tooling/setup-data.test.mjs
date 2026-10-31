import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, cp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  setupData,
  resolveDataDirectory,
  OFFICIAL_REPOSITORY,
  PINNED_COMMIT,
  DEFAULT_DATA_DIRECTORY,
} from '../../scripts/setup-data.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../../scripts/setup-data.mjs', import.meta.url));
const tempPrefix = 'JigJoy 数据 setup-';

async function git(directory, ...args) {
  const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-C', directory, ...args], {
    encoding: 'utf8', windowsHide: true,
  });
  return stdout.trim();
}

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), tempPrefix));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()), 'cleanup stays directly inside the OS temp directory');
    assert.ok(basename(target).startsWith(tempPrefix), 'cleanup only owns this task-created temporary root');
    await rm(target, { recursive: true, force: true });
  });
  return directory;
}

async function repository(t) {
  const root = await sandbox(t);
  const source = join(root, '本地 source with spaces');
  await mkdir(source);
  await git(source, 'init', '--initial-branch=main');
  // Keep fixture bytes deterministic under the user's Windows autocrlf config.
  // This fixture opts out of text conversion; byte-profile coverage is below.
  await writeFile(join(source, '.gitattributes'), '* -text\n', 'utf8');
  await writeFile(join(source, 'data.txt'), 'first snapshot 数据\n', 'utf8');
  await git(source, 'add', '--', '.gitattributes', 'data.txt');
  await git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'first');
  return { root, source, commit: await git(source, 'rev-parse', 'HEAD') };
}

function options(fixture, dataDirectory = fixture.source) {
  return { dataDirectory, localTestSource: { directory: fixture.source, commit: fixture.commit } };
}

async function state(directory) {
  return {
    head: await git(directory, 'rev-parse', 'HEAD'),
    status: await git(directory, 'status', '--porcelain=v1', '--untracked-files=all'),
    contents: await readFile(join(directory, 'data.txt'), 'utf8'),
    config: await readFile(join(directory, '.git', 'config'), 'utf8'),
    index: await readFile(join(directory, '.git', 'index')),
  };
}

test('a linked existing dataset path is refused without modifying its repository target', async t => {
  const fixture = await repository(t);
  const before = await state(fixture.source);
  const link = join(fixture.root, '链接 data');
  await symlink(fixture.source, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(setupData(options(fixture, link)), { code: 'NOT_DIRECTORY' });
  assert.deepEqual(await state(fixture.source), before);
});

test('production repository and commit are fixed; default path comes from the module, not cwd', () => {
  assert.equal(OFFICIAL_REPOSITORY, 'https://github.com/jigjoy-ai/einstein-matchmaker-data.git');
  assert.equal(PINNED_COMMIT, '4fb99b3749adf0d10b5977089ff4c73f4f522240');
  assert.equal(DEFAULT_DATA_DIRECTORY, resolve(dirname(scriptPath), '..', 'reference', 'einstein-matchmaker-data'));
  assert.equal(resolveDataDirectory(), DEFAULT_DATA_DIRECTORY);
});

test('explicit target paths must be absolute', () => {
  assert.throws(() => resolveDataDirectory('relative data'), { code: 'INVALID_OPTIONS' });
});

test('existing clean pinned repository is verified without rewriting files or index', async (t) => {
  const fixture = await repository(t);
  const before = await state(fixture.source);
  const result = await setupData(options(fixture));
  assert.equal(result.status, 'verified');
  assert.equal(result.directory, fixture.source);
  assert.equal(result.commit, fixture.commit);
  assert.deepEqual(await state(fixture.source), before);
});

test('existing correct data does not access an unavailable source or pull', async (t) => {
  const fixture = await repository(t);
  await git(fixture.source, 'remote', 'add', 'origin', join(fixture.root, 'unavailable origin'));
  const before = await state(fixture.source);
  const result = await setupData({
    dataDirectory: fixture.source,
    localTestSource: { directory: join(fixture.root, 'source does not exist'), commit: fixture.commit },
  });
  assert.equal(result.status, 'verified');
  assert.deepEqual(await state(fixture.source), before);
});

test('tracked modifications are rejected and preserved', async (t) => {
  const fixture = await repository(t);
  await writeFile(join(fixture.source, 'data.txt'), 'user edits 用户改动\n', 'utf8');
  const before = await state(fixture.source);
  await assert.rejects(setupData(options(fixture)), { code: 'DIRTY_DATA' });
  assert.deepEqual(await state(fixture.source), before);
});

test('untracked files are rejected and preserved', async (t) => {
  const fixture = await repository(t);
  const file = join(fixture.source, '未跟踪 数据.txt');
  await writeFile(file, 'preserve me', 'utf8');
  await assert.rejects(setupData(options(fixture)), { code: 'DIRTY_DATA' });
  assert.equal(await readFile(file, 'utf8'), 'preserve me');
});

test('wrong clean commit is rejected without checkout, reset, or deletion', async (t) => {
  const fixture = await repository(t);
  await writeFile(join(fixture.source, 'data.txt'), 'second snapshot\n', 'utf8');
  await git(fixture.source, 'add', '--', 'data.txt');
  await git(fixture.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'second');
  const before = await state(fixture.source);
  await assert.rejects(setupData(options(fixture)), { code: 'WRONG_COMMIT' });
  assert.deepEqual(await state(fixture.source), before);
});

test('existing empty directory is not treated as missing data', async (t) => {
  const fixture = await repository(t);
  const target = join(fixture.root, 'existing empty 数据');
  await mkdir(target);
  await assert.rejects(setupData(options(fixture, target)), { code: 'NOT_DATA_REPOSITORY' });
  assert.deepEqual(await readdir(target), []);
});

test('existing non-Git directory and sentinel stay untouched', async (t) => {
  const fixture = await repository(t);
  const target = join(fixture.root, 'existing folder');
  await mkdir(target);
  await writeFile(join(target, 'sentinel.txt'), 'owned by user', 'utf8');
  await assert.rejects(setupData(options(fixture, target)), { code: 'NOT_DATA_REPOSITORY' });
  assert.deepEqual(await readdir(target), ['sentinel.txt']);
  assert.equal(await readFile(join(target, 'sentinel.txt'), 'utf8'), 'owned by user');
});

test('directory inside another Git repository is not mistaken for a dataset root', async (t) => {
  const fixture = await repository(t);
  const target = join(fixture.source, 'nested empty');
  await mkdir(target);
  await assert.rejects(setupData(options(fixture, target)), { code: 'NOT_DATA_REPOSITORY' });
  assert.deepEqual(await readdir(target), []);
});

test('existing ordinary file is rejected without replacement', async (t) => {
  const fixture = await repository(t);
  const target = join(fixture.root, 'data is a file.txt');
  await writeFile(target, 'keep this file', 'utf8');
  await assert.rejects(setupData(options(fixture, target)), { code: 'NOT_DIRECTORY' });
  assert.equal(await readFile(target, 'utf8'), 'keep this file');
});

test('missing target clones a local fixture and checks out the requested older commit', async (t) => {
  const fixture = await repository(t);
  await writeFile(join(fixture.source, 'data.txt'), 'newer than pinned\n', 'utf8');
  await writeFile(join(fixture.source, 'later-only.txt'), 'later', 'utf8');
  await git(fixture.source, 'add', '--', 'data.txt', 'later-only.txt');
  await git(fixture.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'newer');
  const beforeSource = await state(fixture.source);
  const target = join(fixture.root, 'fresh workspace 中文', 'reference', 'einstein-matchmaker-data');
  const result = await setupData(options(fixture, target));
  assert.equal(result.status, 'cloned');
  assert.equal(await git(target, 'rev-parse', 'HEAD'), fixture.commit);
  assert.equal(await readFile(join(target, 'data.txt'), 'utf8'), 'first snapshot 数据\n');
  assert.equal(await git(target, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  assert.ok(!(await readdir(target)).includes('later-only.txt'));
  assert.deepEqual(await state(fixture.source), beforeSource);
  assert.equal((await setupData(options(fixture, target))).status, 'verified');
});

test('failed clone preserves newly created target for inspection and never deletes sibling data', async (t) => {
  const root = await sandbox(t);
  const sibling = join(root, 'user-owned.txt');
  await writeFile(sibling, 'keep sibling', 'utf8');
  const target = join(root, 'new data');
  await assert.rejects(setupData({
    dataDirectory: target,
    localTestSource: { directory: join(root, 'missing local source'), commit: '1'.repeat(40) },
  }), { code: 'CLONE_FAILED' });
  assert.deepEqual(await readdir(target), []);
  assert.equal(await readFile(sibling, 'utf8'), 'keep sibling');
  await assert.rejects(setupData({
    dataDirectory: target,
    localTestSource: { directory: join(root, 'missing local source'), commit: '1'.repeat(40) },
  }), { code: 'NOT_DATA_REPOSITORY' });
});

test('new checkouts reproduce the recorded CRLF byte profile regardless of inherited autocrlf', async t => {
  const fixture = await repository(t);
  await writeFile(join(fixture.source, '.gitattributes'), '', 'utf8');
  await writeFile(join(fixture.source, 'data.txt'), 'one\ntwo\n', 'utf8');
  const mixed = Buffer.from('one\r\ntwo\n');
  const binary = Buffer.from([0, 13, 10, 255, 10]);
  await writeFile(join(fixture.source, 'mixed.csv'), mixed);
  await writeFile(join(fixture.source, 'binary.dat'), binary);
  await git(fixture.source, '-c', 'core.autocrlf=false', 'add', '--', '.gitattributes', 'data.txt', 'mixed.csv', 'binary.dat');
  await git(fixture.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'byte profile');
  fixture.commit = await git(fixture.source, 'rev-parse', 'HEAD');
  const before = await state(fixture.source);
  for (const inherited of ['false', 'input']) {
    const config = join(fixture.root, `global-${inherited}.gitconfig`);
    const contents = `[core]\n  autocrlf = ${inherited}\n`;
    await writeFile(config, contents);
    const target = join(fixture.root, `checkout-${inherited}`);
    const script = `import {setupData} from ${JSON.stringify(pathToFileURL(scriptPath).href)}; await setupData(JSON.parse(process.argv[1]));`;
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(options(fixture, target))], {
      encoding: 'utf8', windowsHide: true,
      env: {...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1'},
    });
    assert.equal(await readFile(join(target, 'data.txt'), 'utf8'), 'one\r\ntwo\r\n');
    assert.deepEqual(await readFile(join(target, 'mixed.csv')), mixed);
    assert.deepEqual(await readFile(join(target, 'binary.dat')), binary);
    assert.equal(await git(target, 'config', '--local', 'core.autocrlf'), 'true');
    assert.equal(await git(target, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    assert.equal(await readFile(config, 'utf8'), contents);
    const beforeExisting = await state(target);
    assert.equal((await setupData(options(fixture, target))).status, 'verified');
    assert.deepEqual(await state(target), beforeExisting);
  }
  assert.deepEqual(await state(fixture.source), before);
});

test('failed pinned checkout keeps the clone and does not mutate the original fixture', async (t) => {
  const fixture = await repository(t);
  const before = await state(fixture.source);
  const target = join(fixture.root, 'bad commit clone');
  await assert.rejects(setupData({
    dataDirectory: target,
    localTestSource: { directory: fixture.source, commit: 'f'.repeat(40) },
  }), { code: 'CHECKOUT_FAILED' });
  assert.ok((await readdir(target)).includes('.git'));
  assert.deepEqual(await state(fixture.source), before);
});

test('local test source rejects URLs and non-hex commits before creating target', async (t) => {
  const root = await sandbox(t);
  const target = join(root, 'must stay absent');
  for (const source of [
    { directory: 'https://example.invalid/repo.git', commit: '1'.repeat(40) },
    { directory: root, commit: '--detach' },
  ]) {
    await assert.rejects(setupData({ dataDirectory: target, localTestSource: source }), { code: 'INVALID_OPTIONS' });
  }
  assert.ok(!(await readdir(root)).includes('must stay absent'));
});

test('import has no setup side effects and copied module keeps its own default root', async (t) => {
  const root = await sandbox(t);
  const scripts = join(root, 'scripts');
  await mkdir(scripts);
  const copied = join(scripts, 'setup-data.mjs');
  await cp(scriptPath, copied);
  const module = await import(pathToFileURL(copied).href);
  assert.equal(module.DEFAULT_DATA_DIRECTORY, join(root, 'reference', 'einstein-matchmaker-data'));
  assert.deepEqual(await readdir(root), ['scripts']);
});

test('CLI rejects arbitrary source/options, even from an unrelated cwd', async (t) => {
  const root = await sandbox(t);
  await assert.rejects(execFileAsync(process.execPath, [scriptPath, '--source', 'https://example.invalid/repo.git'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /does not accept arguments|INVALID_ARGUMENTS/i);
    return true;
  });
  assert.deepEqual(await readdir(root), []);
});
