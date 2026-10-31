// Capture a fixed set of real saved Runs through the read-only API.
import {readFile, writeFile, mkdir, cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {build} from 'vite';
import {EvidenceSchema} from '../dist/server/contracts/domain.js';

const root = resolve('.');
const output = resolve(process.argv[2] ?? 'var/submission/demo-site/dist');
if (!output.startsWith(join(root, 'var', 'submission') + '\\') && !output.startsWith(join(root, 'var', 'submission') + '/')) throw Error('DEMO_OUTPUT_OUTSIDE_SUBMISSION');
const base = process.env.DEMO_CAPTURE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('LOCAL_CAPTURE_ONLY');
const archive = JSON.parse(await readFile(join(root, 'artifacts/demo-store-manifest.json'), 'utf8'));
const ids = [...new Set(archive.files.map(row => row.file.split('/')[0]))];
await build({root: join(root, 'web'), configFile: false, define: {'import.meta.env.VITE_SAVED_DEMO': JSON.stringify('true')}, build: {outDir: output, emptyOutDir: false}});
await mkdir(join(output, 'demo-data'), {recursive: true});
const manifest = {schemaVersion: 1, mode: 'saved_real_results', capturedAt: new Date().toISOString(), runIds: ids, routes: {}};
const capture = async (path, transform) => {
  const response = await fetch(base + path);
  if (!response.ok) throw Error(`CAPTURE_FAILED ${path} ${response.status}`);
  const contentType = response.headers.get('content-type');
  let bytes = Buffer.from(await response.arrayBuffer());
  let parsed;
  if (contentType?.includes('json')) {parsed = JSON.parse(bytes.toString()); if (transform) {parsed = transform(parsed); bytes = Buffer.from(JSON.stringify(parsed));}}
  const file = createHash('sha256').update(path).digest('hex').slice(0, 24) + (contentType?.includes('json') ? '.json' : '.txt');
  await writeFile(join(output, 'demo-data', file), bytes);
  manifest.routes[path] = {file, contentType, status: response.status, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
  return parsed;
};
await capture('/api/catalog', c => ({...c, newRunsAvailable: false}));
const history = await capture('/api/runs', h => ({...h, runs: h.runs.filter(r => ids.includes(r.runId)), total: ids.length}));
if (history.runs.length !== ids.length || history.runs.some(r => !['approved', 'insufficient', 'failed', 'cancelled'].includes(r.status))) throw Error('DEMO_REQUIRES_COMPLETE_ARCHIVE');
const showcase = await capture('/api/showcase', s => s.filter(r => ids.includes(r.runId)));
if (showcase.length !== 3) throw Error('DEMO_REQUIRES_THREE_PROPOSALS');
for (const id of ids) {
  await capture(`/api/runs/${id}`);
  const artifacts = await capture(`/api/runs/${id}/artifacts`);
  await capture(`/api/runs/${id}/events`);
  const evidenceIds = new Set();
  const inspect = value => {if (!value || typeof value !== 'object') return; if (EvidenceSchema.safeParse(value).success) evidenceIds.add(value.id); for (const [key, item] of Object.entries(value)) {if (['evidenceIds', 'restrictionRefs'].includes(key) && Array.isArray(item)) for (const id of item) if (typeof id === 'string') evidenceIds.add(id); if (key === 'evidenceId' && typeof item === 'string') evidenceIds.add(item); inspect(item);}};
  inspect(artifacts);
  for (const evidenceId of evidenceIds) await capture(`/api/runs/${id}/evidence/${evidenceId}`);
}
await writeFile(join(output, 'demo-data/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await cp(join(root, 'web/saved-demo-assets/architecture.svg'), join(output, 'architecture.svg'));
await cp(join(root, 'artifacts/showcase/final'), join(output, 'export'), {recursive: true});
const sourceArchive = process.argv[3];
if (sourceArchive) await cp(resolve(sourceArchive), join(output, 'source.zip'));
const guide = (await readFile(join(root, 'web/saved-demo-assets/guide.html'), 'utf8'))
  .replace('__SOURCE_DOWNLOAD__', sourceArchive ? '<a href="/source.zip">Download the source snapshot</a> · ' : '');
await writeFile(join(output, 'guide.html'), guide);
console.log(JSON.stringify({output, runs: ids.length, proposals: showcase.length, routes: Object.keys(manifest.routes).length}));
