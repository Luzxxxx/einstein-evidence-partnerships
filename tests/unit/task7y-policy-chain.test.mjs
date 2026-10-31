// Explicit temporary policy copies. Default/live means immutable policy checking,
// not permission to execute a Run: this file opens no Store/worker/model or Git.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import * as policy from '../../dist/server/evaluation/prepared-v4-policy.js';

const oneFile = 'docs/implementation/task-7y-authorization.json';
const twoFile = 'docs/implementation/task-7y-authorization-v2.json';
const marker = 'docs/implementation/task-7y-live/attempt.json';
const sha = raw => createHash('sha256').update(raw).digest('hex');
beforeEach(() => assert.equal(typeof policy.verifyTask7yAuthorizationFile, 'function', 'a missing verifier is not a policy refusal'));
async function specimen(t, version) {
  const root = await mkdtemp(join(tmpdir(), 'einstein task7y strict policy chain '));
  t.after(async () => {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('einstein task7y strict policy chain '));
    await rm(absolute, { recursive: true, force: true });
  });
  const one = await readFile(oneFile), two = await readFile(twoFile), v1 = JSON.parse(one), v2 = JSON.parse(two);
  const evidence = await readFile(v2.scopeExtension.evidence.file);
  for (const [file, raw] of [[oneFile, one], [twoFile, two], [v2.scopeExtension.evidence.file, evidence]]) {
    await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), raw, { flag: 'wx' });
  }
  const file = version === 1 ? oneFile : twoFile, value = version === 1 ? v1 : v2;
  const meta = { authorizationFile: file, authorizationFileSha256: sha(version === 1 ? one : two), authorizationId: value.authorizationId,
    baselineFile: value.baselineFile, baselineSha256: value.baselineSha256, globalAttemptFile: value.globalAttemptFile };
  assert.deepEqual(await policy.verifyTask7yAuthorizationFile(root, meta), value, 'unmodified exact raw policy is a positive control');
  return { root, file, one, two, v1, v2, meta };
}
async function noAdmission(s) { await assert.rejects(access(join(s.root, marker)), { code: 'ENOENT' }); }
async function rewriteCopy(s, raw) { await writeFile(join(s.root, s.file), raw); s.meta.authorizationFileSha256 = sha(raw); }

test('default policy verifier pins direct v1 raw bytes despite coherently refreshed metadata digests', async t => {
  const results = [];
  for (const change of ['raw_whitespace', 'original_before_sha']) {
    const s = await specimen(t, 1), value = structuredClone(s.v1);
    if (change === 'original_before_sha') value.approvedRuntimeChanges[0].beforeSha256 = '0'.repeat(64);
    const raw = change === 'raw_whitespace' ? Buffer.concat([s.one, Buffer.from(' ')]) : Buffer.from(JSON.stringify(value) + '\n');
    await rewriteCopy(s, raw);
    let rejected = false; try { await policy.verifyTask7yAuthorizationFile(s.root, s.meta); } catch { rejected = true; }
    results.push({ change, rejected }); await noAdmission(s);
  }
  assert.deepEqual(results, [{ change: 'raw_whitespace', rejected: true }, { change: 'original_before_sha', rejected: true }]);
});

test('v2 cannot rewrite any original-six before hash as a Gate-only extension, even in an explicit fixture', async t => {
  const s = await specimen(t, 2), value = structuredClone(s.v2);
  value.approvedRuntimeChanges[0].beforeSha256 = '0'.repeat(64);
  await rewriteCopy(s, Buffer.from(JSON.stringify(value) + '\n'));
  await assert.rejects(policy.verifyTask7yAuthorizationFile(s.root, s.meta, { runnerMode: 'offline_fixture' }));
  await noAdmission(s);
});

test('v2 cannot alter the original protocol-contract digest while retaining the same identity and budget', async t => {
  const s = await specimen(t, 2), value = structuredClone(s.v2);
  value.protocolContractSha256 = '0'.repeat(64);
  await rewriteCopy(s, Buffer.from(JSON.stringify(value) + '\n'));
  await assert.rejects(policy.verifyTask7yAuthorizationFile(s.root, s.meta, { runnerMode: 'offline_fixture' }));
  await noAdmission(s);
});
