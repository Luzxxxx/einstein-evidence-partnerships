import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const allowedRoots = ['integration', 'tooling', 'unit'];

export function discoverTestFiles(projectRoot, filters = []) {
  const root = realpathSync(projectRoot);
  const testsRoot = join(root, 'tests');
  const paths = new Set();
  function inspect(target) {
    const rel = relative(root, target);
    if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Test path escapes project.');
    let cursor = root;
    for (const piece of rel.split(sep)) {
      cursor = join(cursor, piece);
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('Linked test paths are not allowed.');
    }
    const real = realpathSync(target);
    if (real !== testsRoot && !real.startsWith(`${testsRoot}${sep}`)) throw new Error('Test path escapes tests.');
    const info = lstatSync(target);
    if (info.isDirectory()) {
      for (const entry of readdirSync(target).sort()) inspect(join(target, entry));
    } else if (info.isFile() && target.endsWith('.test.mjs')) paths.add(relative(root, target).split(sep).join('/'));
  }
  const selected = filters.length ? filters : allowedRoots.map(name => `tests/${name}`)
    .filter(name => { try { lstatSync(join(root, name)); return true; } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    } });
  for (const filter of selected) {
    if (typeof filter !== 'string' || isAbsolute(filter) || filter.startsWith('-')
      || filter.split(/[\\/]/).includes('..') || !/^tests[\\/](integration|tooling|unit)([\\/]|$)/.test(filter))
      throw new Error('Only tests/unit, tests/integration or tests/tooling filters are allowed.');
    const target = resolve(root, filter);
    const info = lstatSync(target);
    if (info.isFile() && !target.endsWith('.test.mjs')) throw new Error('Only *.test.mjs files are offline tests.');
    inspect(target);
  }
  if (!paths.size) throw new Error('No offline tests selected; refusing an empty pass.');
  return [...paths].sort();
}

async function invokeCommand({ command, args, cwd, shell }) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd, shell, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', code => resolveExit(code ?? 1));
  });
}

export async function executeOfflineTests({ projectRoot, filters = [], invoke = invokeCommand }) {
  const files = discoverTestFiles(projectRoot, filters);
  const build = await invoke({ command: process.execPath,
    args: [join(projectRoot, 'scripts/build-server.mjs')], cwd: projectRoot, shell: false });
  if (build !== 0) return build;
  return invoke({ command: process.execPath, args: ['--test', ...files], cwd: projectRoot, shell: false });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const filters = process.argv.slice(2);
  if (filters[0] === '--') filters.shift();
  try { process.exitCode = await executeOfflineTests({ projectRoot: root, filters }); }
  catch (error) { console.error(`Offline checks failed: ${error.message}`); process.exitCode = 1; }
}
