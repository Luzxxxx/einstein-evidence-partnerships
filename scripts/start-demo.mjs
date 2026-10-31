// Read-only playback of real saved Runs. No model configuration is admitted.
import {readFile, writeFile, mkdir, mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startLocalService} from '../dist/server/server/service.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'artifacts/demo-store-manifest.json'), 'utf8'));
const storeRoot = await mkdtemp(join(tmpdir(), 'einstein saved demo '));
for (const entry of manifest.files) {
  if (!/^[a-f0-9-]{36}\/(record\.json|terminal\.json|events\.jsonl)$/.test(entry.file)) throw Error('DEMO_PATH_INVALID');
  const raw = await readFile(join(root, 'artifacts/demo-store', entry.file));
  if (raw.length !== entry.bytes || createHash('sha256').update(raw).digest('hex') !== entry.sha256) throw Error('DEMO_BYTES_CHANGED');
  await mkdir(join(storeRoot, entry.file.split('/')[0]), {recursive: true});
  await writeFile(join(storeRoot, entry.file), raw, {flag: 'wx'});
}
const app = await startLocalService({storeRoot, historicalRecovery: null, port: process.env.PORT === undefined ? 3000 : Number(process.env.PORT), modelConfigured: () => false});
if (app.scheduler.safetyHold) {await app.close().catch(() => {}); throw Error('DEMO_ARCHIVE_INVALID');}
console.log(`Saved results: ${app.url} (read-only; no model requests)`);
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => void app.close().catch(() => {process.exitCode = 1;}));
