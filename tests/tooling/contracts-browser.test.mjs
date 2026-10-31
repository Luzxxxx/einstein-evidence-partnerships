import assert from 'node:assert/strict';
import test from 'node:test';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import { input, evidence, record } from '../fixtures/contracts.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
test('shared contracts typecheck with DOM libraries and no Node ambient types', () => {
  const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
  const result = spawnSync(process.execPath, [compiler, '-p', join(root, 'tsconfig.contracts.json')],
    { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('all shared exports bundle for browser and execute without Node globals', async () => {
  const output = await build({ configFile: false, root, logLevel: 'error',
    plugins: [{ name: 'reject-node-contract-imports', enforce: 'pre', resolveId(id) {
      if (id.startsWith('node:') || builtinModules.includes(id)) throw new Error(`Node import in shared contracts: ${id}`);
    } }],
    build: { write: false, minify: false, target: 'es2023',
      lib: { entry: join(root, 'tests/fixtures/browser-contracts.ts'), formats: ['iife'], name: 'SharedContracts' } } });
  const results = Array.isArray(output) ? output : [output];
  assert.equal(results.length, 1);
  const chunks = results[0].output.filter(item => item.type === 'chunk');
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].imports, []);
  const sandbox = {};
  runInNewContext(chunks[0].code, sandbox, { timeout: 5000 });
  assert.equal('process' in sandbox, false); assert.equal('require' in sandbox, false); assert.equal('Buffer' in sandbox, false);
  const shared = sandbox.SharedContracts;
  // JSON is parsed inside the same realm: strict plain-object canonicalization is realm-specific.
  sandbox.inputJson = JSON.stringify(input()); sandbox.evidenceJson = JSON.stringify(evidence());
  sandbox.recordJson = JSON.stringify(record());
  assert.equal(runInNewContext('SharedContracts.domain.RunInputSchema.parse(JSON.parse(inputJson)).companyId', sandbox), 'C001');
  assert.equal(runInNewContext('SharedContracts.domain.EvidenceSchema.parse(JSON.parse(evidenceJson)).sourceFileSha256', sandbox), evidence().sourceFileSha256);
  assert.equal(runInNewContext('SharedContracts.state.transitionRun(JSON.parse(recordJson), {runId:JSON.parse(recordJson).runId,seq:1,action:"start"}).state.status', sandbox), 'researching');
  assert.equal(shared.events.WORKER_EVENT_TYPES.length, 20);
  assert.ok(shared.events.WORKER_EVENT_TYPES.includes('tool.batch.updated'));
  assert.equal(shared.ipc.IPC_VERSION, 1); assert.equal(shared.config.DEFAULT_LIMITS.maxActiveRuns, 1);
});
