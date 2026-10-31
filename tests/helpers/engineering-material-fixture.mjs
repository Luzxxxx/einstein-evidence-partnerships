// Controlled offline_fixture engineering material. The child test really runs
// node:test; the tiny web-output specimen tests parsing only, not a product build.
// No Store, Git command, live/provider request, or real project build is started.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const engineeringSha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function createEngineeringMaterialFixture(t) {
  const api = await import('../../dist/server/evaluation/engineering-material.js');
  const root = await mkdtemp(join(tmpdir(), 'einstein task7y engineering offline '));
  t.after(async () => {
    const absolute = resolve(root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes('einstein task7y engineering offline ')) throw Error('OFFLINE_FIXTURE_PATH');
    await rm(absolute, { recursive: true, force: true });
  });
  await mkdir(join(root, 'logs'));
  const sourceCommit = 'a'.repeat(40), runnerMode = 'offline_fixture';
  const product = 'fixture-product.mjs', productBytes = Buffer.from('// Controlled engineering fixture, not product source.\n');
  await writeFile(join(root, product), productBytes, { flag: 'wx' });
  const fingerprints = [{ file: product, sha256: engineeringSha(productBytes) }];
  const fingerprintsBefore = [{ file: product, sha256: engineeringSha(await readFile(join(root, product))) }];
  const testFile = join(root, 'controlled.test.mjs');
  await writeFile(testFile, "import test from 'node:test';import assert from 'node:assert/strict';test('explicit offline engineering capture specimen',()=>assert.equal(2+2,4));\n", { flag: 'wx' });
  const offline = await api.captureEngineeringCommand({ root, kind: 'offline', runnerMode,
    command: process.execPath, argv: ['--test', testFile], logFile: 'logs/offline.log', receiptFile: 'logs/offline.receipt.json' });
  const web = await api.captureEngineeringCommand({ root, kind: 'web', runnerMode,
    command: process.execPath, argv: ['-e', "console.log('vite v8.3.5 building client environment for production...');console.log('✓ built in 1ms')"],
    logFile: 'logs/web.log', receiptFile: 'logs/web.receipt.json' });
  const fingerprintsAfter = [{ file: product, sha256: engineeringSha(await readFile(join(root, product))) }];
  const reference = async file => ({ file, sha256: engineeringSha(await readFile(join(root, file))) });
  const certificate = { schemaVersion: 1, kind: 'independent_engineering_review', task: 'Task7y', runnerMode,
    sourceCommit, fingerprints, reviewer: 'offline_fixture_certificate_only_not_human_gold', remainingBlockers: 0, passed: true };
  await writeFile(join(root, 'review.json'), JSON.stringify(certificate) + '\n', { flag: 'wx' });
  const commands = { offline: await reference('logs/offline.receipt.json'), web: await reference('logs/web.receipt.json') };
  // The fixed commit is explicitly an offline fixture identity, not a Git
  // observation. Both source hash snapshots really surround the child commands.
  const capture = { schemaVersion: 1, kind: 'engineering_capture_provenance', runnerMode, sourceCommitBefore: sourceCommit,
    sourceCommitAfter: sourceCommit, fingerprintsBefore, fingerprintsAfter, commands };
  await writeFile(join(root, 'capture.json'), JSON.stringify(capture) + '\n', { flag: 'wx' });
  const options = { task: 'Task7y', runnerMode, sourceCommit, fingerprints, commands,
    independentReview: await reference('review.json'), capture: await reference('capture.json') };
  const material = await api.produceEngineeringMaterial(options, { root });
  return { api, root, sourceCommit, runnerMode, fingerprints, offline, web, options, material, reference,
    verification: { root, currentCommit: sourceCommit, currentFingerprints: fingerprints, runnerMode } };
}
