import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

function invokeCommand({ command, args, cwd, shell }) {
  const result = spawnSync(command, args, { cwd, shell, stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(`Web build could not start: ${result.error.message}`);
  return result.status ?? 1;
}

export function buildWeb({ projectRoot, invoke = invokeCommand }) {
  const root = realpathSync(projectRoot);
  const output = resolve(root, 'dist/web');
  if (dirname(root) === root || relative(root, output) !== join('dist', 'web'))
    throw new Error('Unsafe web output.');
  for (const target of [join(root, 'dist'), output]) {
    try { if (lstatSync(target).isSymbolicLink()) throw new Error('Linked web output is not allowed.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const require = createRequire(pathToFileURL(join(root, 'package.json')));
  function bin(name, command) {
    const packagePath = require.resolve(`${name}/package.json`);
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
    const entry = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[command];
    if (typeof entry !== 'string') throw new Error(`Installed ${name} has no ${command} entry.`);
    return resolve(dirname(packagePath), entry);
  }
  const checked = invoke({ command: process.execPath,
    args: [bin('typescript', 'tsc'), '-p', join(root, 'tsconfig.web.json')], cwd: root, shell: false });
  if (checked !== 0) return checked;
  return invoke({ command: process.execPath, args: [bin('vite', 'vite'), 'build'], cwd: root, shell: false });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = buildWeb({ projectRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..') }); }
  catch (error) { console.error(`Web build failed: ${error.message}`); process.exitCode = 1; }
}
