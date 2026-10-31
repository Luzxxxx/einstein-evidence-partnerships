// Real Vite dev server -> unchanged Task8 loopback service. No Run/model calls.
import { createServer } from 'vite';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startLocalService } from '../dist/server/server/service.js';

const suffix = process.argv[2];
if (!/^[a-z0-9-]+$/.test(suffix ?? '')) throw Error('TASK9_PROXY_ARGUMENT');
const root = await mkdtemp(join(tmpdir(), 'einstein task9 dev proxy offline_fixture '));
let api, vite, result;
try {
  api = await startLocalService({ port: 3000, storeRoot: join(root, 'store'), modelConfigured: () => false });
  vite = await createServer({ server: { port: 5173, strictPort: true } }); await vite.listen();
  const page = await fetch('http://127.0.0.1:5173/');
  const catalog = await fetch('http://127.0.0.1:5173/api/catalog');
  const value = await catalog.json();
  result = { task: 'Task9', kind: 'actual_vite_loopback_proxy_with_isolated_store', pageStatus: page.status,
    catalogStatus: catalog.status, companyCount: value.companies?.length ?? null, errorCode: value.code ?? null,
    managerRuns: api.scheduler.permits.snapshot().runs.length, modelRequests: 0,
    passed: page.status === 200 && catalog.status === 200 && value.companies?.length > 0 };
} catch (e) { result = { task: 'Task9', passed: false, error: String(e.code ?? e.message).slice(0, 200), modelRequests: 0 }; }
finally { await vite?.close(); await api?.close(); }
await writeFile(resolve(`docs/implementation/task-9-dev-proxy-${suffix}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result)); if (!result.passed) process.exitCode = 1;
