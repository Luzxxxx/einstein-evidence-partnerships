import { readFileSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

function compileTypeScript({ projectRoot }) {
  const require = createRequire(pathToFileURL(join(projectRoot, 'package.json')));
  const packagePath = require.resolve('typescript/package.json');
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
  const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.tsc;
  if (typeof bin !== 'string') throw new Error('Installed TypeScript has no tsc entry point.');
  const result = spawnSync(process.execPath, [resolve(dirname(packagePath), bin),
    '-p', resolve(projectRoot, 'tsconfig.server.json')],
  { cwd: projectRoot, stdio: 'inherit', shell: false, windowsHide: true });
  if (result.error) console.error(`Server build could not start: ${result.error.message}`);
  return result.status ?? 1;
}

export function buildServer({ projectRoot, compile = compileTypeScript }) {
  const root = realpathSync(projectRoot);
  if (dirname(root) === root) throw new Error('A filesystem root is not a project.');
  const output = resolve(root, 'dist/server');
  if (relative(root, output) !== join('dist', 'server')) throw new Error('Unsafe server output.');
  for (const target of [join(root, 'dist'), output]) {
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error('Linked build output is not allowed.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Exact absolute output has been checked; never delete the project or web output.
  rmSync(output, { recursive: true, force: true });
  return compile({ projectRoot: root });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = buildServer({ projectRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..') }); }
  catch (error) { console.error(`Server build failed: ${error.message}`); process.exitCode = 1; }
}
