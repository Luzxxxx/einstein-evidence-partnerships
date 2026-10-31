import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashArtifact } from '../../dist/server/evidence/hashing.js';
import { createEngineeringMaterialFixture, engineeringSha } from '../helpers/engineering-material-fixture.mjs';

const rehash = value => ({ ...value, hash: hashArtifact(value) });
async function alignFixtureCaptureReferences(x, options = x.options) {
  // Deliberate temporary-copy fault injection: keep provenance references
  // coherent so it cannot mask the specific receipt/log defect under test.
  const path = join(x.root, options.capture.file), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.commands = structuredClone(options.commands); await writeFile(path, JSON.stringify(manifest) + '\n');
  options.capture.sha256 = engineeringSha(await readFile(path));
}
async function changeReceipt(x, kind, change) {
  const ref = x.options.commands[kind], path = join(x.root, ref.file), receipt = JSON.parse(await readFile(path, 'utf8'));
  change(receipt); await writeFile(path, JSON.stringify(receipt) + '\n');
  ref.sha256 = engineeringSha(await readFile(path)); await alignFixtureCaptureReferences(x); return receipt;
}
async function changeReview(x, change) {
  const path = join(x.root, 'review.json'), certificate = JSON.parse(await readFile(path, 'utf8'));
  change(certificate); await writeFile(path, JSON.stringify(certificate) + '\n');
  x.options.independentReview.sha256 = engineeringSha(await readFile(path));
}

test('programmatic capture records actual child exit, original log identity and a strict persistable engineering material', async t => {
  const parentTestContext = process.env.NODE_TEST_CONTEXT;
  const x = await createEngineeringMaterialFixture(t), raw = await readFile(join(x.root, 'logs/offline.log'));
  assert.equal(process.env.NODE_TEST_CONTEXT, parentTestContext, 'child isolation must not mutate the parent environment');
  assert.equal(x.offline.exitCode, 0); assert.equal(x.offline.kind, 'offline'); assert.equal(x.offline.runnerMode, 'offline_fixture');
  assert.equal(x.offline.command, process.execPath); assert.deepEqual(x.offline.argv.slice(0, 1), ['--test']);
  assert.equal(x.offline.log.sha256, engineeringSha(raw)); assert.equal(x.offline.log.bytes, raw.length);
  assert.match(raw.toString('utf8'), /CHECK_EXIT=0\s*$/); assert.ok(Date.parse(x.offline.endedAt) >= Date.parse(x.offline.startedAt));
  assert.equal(x.api.EngineeringCommandReceiptSchema.safeParse(x.offline).success, true);
  assert.equal(x.api.EngineeringMaterialSchema.safeParse(x.material).success, true);
  assert.equal(x.material.version, 'task7y-engineering-material-v1'); assert.equal(x.material.kind, 'engineering_material');
  assert.equal(x.material.commands.offline.summary.tests, 1); assert.equal(x.material.commands.offline.summary.pass, 1);
  assert.equal(x.material.commands.web.receipt.exitCode, 0); assert.equal(x.material.commands.web.summary.buildMs, 1);
  assert.equal(x.material.commands.web.summary.typecheckEvidence, 'fixed_build_script_control_flow');
  assert.equal(x.material.hash, hashArtifact(x.material));
  const serialized = JSON.parse(JSON.stringify(x.material));
  assert.deepEqual(await x.api.verifyEngineeringMaterial(serialized, x.verification), x.material);
  assert.equal(Object.isFrozen(x.material), true); assert.equal(Object.isFrozen(x.material.commands.web.receipt), true);
});

test('actual nonzero child exit survives receipt capture and cannot be replaced by a successful-looking log', async t => {
  const x = await createEngineeringMaterialFixture(t), receipt = await x.api.captureEngineeringCommand({ root: x.root, kind: 'offline', runnerMode: x.runnerMode,
    command: process.execPath, argv: ['-e', "console.log('# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# duration_ms 1');process.exitCode=7"],
    logFile: 'logs/failure.log', receiptFile: 'logs/failure.receipt.json' });
  assert.equal(receipt.exitCode, 7); assert.match(await readFile(join(x.root, 'logs/failure.log'), 'utf8'), /CHECK_EXIT=7\s*$/);
  const options = structuredClone(x.options); options.commands.offline = await x.reference('logs/failure.receipt.json');
  await alignFixtureCaptureReferences(x, options);
  await assert.rejects(x.api.produceEngineeringMaterial(options, { root: x.root }));
});

test('capture reserves exclusive paths before launching and never overwrites an existing receipt', async t => {
  const x = await createEngineeringMaterialFixture(t), original = await readFile(join(x.root, 'logs/offline.receipt.json'));
  const counter = join(x.root, 'should-not-execute.txt');
  await assert.rejects(x.api.captureEngineeringCommand({ root: x.root, kind: 'offline', runnerMode: x.runnerMode,
    command: process.execPath, argv: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(counter)},'executed')`],
    logFile: 'logs/exclusive.log', receiptFile: 'logs/offline.receipt.json' }));
  assert.deepEqual(await readFile(join(x.root, 'logs/offline.receipt.json')), original);
  await assert.rejects(readFile(counter), error => error.code === 'ENOENT');
});

for (const fault of ['missing_exit', 'string_exit', 'wrong_kind', 'wrong_mode', 'reversed_time', 'unknown_field']) {
  test(`producer rejects strict receipt defect ${fault} despite refreshed receipt-file hash`, async t => {
    const x = await createEngineeringMaterialFixture(t);
    await changeReceipt(x, 'web', receipt => {
      if (fault === 'missing_exit') delete receipt.exitCode;
      if (fault === 'string_exit') receipt.exitCode = '0';
      if (fault === 'wrong_kind') receipt.kind = 'offline';
      if (fault === 'wrong_mode') receipt.runnerMode = 'live';
      if (fault === 'reversed_time') receipt.endedAt = '2000-01-01T00:00:00.000Z';
      if (fault === 'unknown_field') receipt.build = true;
    });
    await assert.rejects(x.api.produceEngineeringMaterial(x.options, { root: x.root }));
  });
}

for (const fault of ['hash', 'bytes', 'missing_marker', 'wrong_marker', 'duplicate_marker', 'empty_tests', 'skipped_tests', 'missing_web_build']) {
  test(`producer rejects traceable log defect ${fault}`, async t => {
    const x = await createEngineeringMaterialFixture(t), kind = fault === 'missing_web_build' ? 'web' : 'offline';
    await changeReceipt(x, kind, receipt => {
      if (fault === 'hash') { receipt.log.sha256 = '0'.repeat(64); return; }
      if (fault === 'bytes') { receipt.log.bytes++; return; }
      let text = 'CHECK_EXIT=0\n';
      if (fault === 'missing_marker') text = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# duration_ms 1\n';
      if (fault === 'wrong_marker') text = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# duration_ms 1\nCHECK_EXIT=7\n';
      if (fault === 'duplicate_marker') text = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# duration_ms 1\nCHECK_EXIT=0\nCHECK_EXIT=0\n';
      if (fault === 'empty_tests') text = '# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# duration_ms 1\nCHECK_EXIT=0\n';
      if (fault === 'skipped_tests') text = '# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 1\n# duration_ms 1\nCHECK_EXIT=0\n';
      // Only an explicit temporary fixture log is modified. These variants test
      // parsing/tamper rejection; they are never labeled an actual build/gold.
      const raw = Buffer.from(text); receipt.log.sha256 = engineeringSha(raw); receipt.log.bytes = raw.length;
      receipt.__temporaryFixtureReplacement = raw;
    });
    const ref = x.options.commands[kind], path = join(x.root, ref.file), receipt = JSON.parse(await readFile(path, 'utf8'));
    if (receipt.__temporaryFixtureReplacement) {
      const raw = Buffer.from(receipt.__temporaryFixtureReplacement.data); delete receipt.__temporaryFixtureReplacement;
      await writeFile(join(x.root, receipt.log.file), raw); await writeFile(path, JSON.stringify(receipt) + '\n');
      ref.sha256 = engineeringSha(await readFile(path));
      await alignFixtureCaptureReferences(x);
    }
    await assert.rejects(x.api.produceEngineeringMaterial(x.options, { root: x.root }));
  });
}

for (const fault of ['review_hash', 'review_commit', 'review_fingerprint', 'review_mode', 'review_blocker']) {
  test(`producer rejects independent review binding defect ${fault}`, async t => {
    const x = await createEngineeringMaterialFixture(t);
    if (fault === 'review_hash') x.options.independentReview.sha256 = '0'.repeat(64);
    else await changeReview(x, certificate => {
      if (fault === 'review_commit') certificate.sourceCommit = 'b'.repeat(40);
      if (fault === 'review_fingerprint') certificate.fingerprints[0].sha256 = '0'.repeat(64);
      if (fault === 'review_mode') certificate.runnerMode = 'live';
      if (fault === 'review_blocker') certificate.remainingBlockers = 1;
    });
    await assert.rejects(x.api.produceEngineeringMaterial(x.options, { root: x.root }));
  });
}

test('verification rejects changed source, HEAD, mode, raw log and embedded receipts independently', async t => {
  const x = await createEngineeringMaterialFixture(t);
  await assert.rejects(x.api.verifyEngineeringMaterial(x.material, { ...x.verification, currentCommit: 'b'.repeat(40) }));
  await assert.rejects(x.api.verifyEngineeringMaterial(x.material, { ...x.verification, runnerMode: 'live' }));
  await assert.rejects(x.api.verifyEngineeringMaterial(x.material, { ...x.verification, currentFingerprints: [{ file: 'fixture-product.mjs', sha256: '0'.repeat(64) }] }));
  const changed = structuredClone(x.material); changed.commands.web.receipt.argv.push('unrecorded');
  await assert.rejects(x.api.verifyEngineeringMaterial(rehash(changed), x.verification));
  const originalWeb = await readFile(join(x.root, 'logs/web.log'));
  await writeFile(join(x.root, 'logs/web.log'), 'tampered\n');
  await assert.rejects(x.api.verifyEngineeringMaterial(x.material, x.verification));
  await writeFile(join(x.root, 'logs/web.log'), originalWeb);
  await writeFile(join(x.root, 'fixture-product.mjs'), '// modified after capture\n');
  await assert.rejects(x.api.verifyEngineeringMaterial(x.material, x.verification));
});

test('live capture rejects controlled child commands and arbitrary source scripts before spawning', async t => {
  const x = await createEngineeringMaterialFixture(t);
  await assert.rejects(x.api.captureEngineeringCommand({ root: x.root, kind: 'web', runnerMode: 'live', command: process.execPath,
    argv: ['-e', "console.log('fake success')"], logFile: 'logs/rejected-live.log', receiptFile: 'logs/rejected-live.receipt.json' }));
});

test('material schema rejects legacy success flags and missing web exitCode rather than accepting Task7x metadata', async t => {
  const x = await createEngineeringMaterialFixture(t), value = structuredClone(x.material);
  delete value.commands.web.receipt.exitCode; value.web = { typecheck: true, build: true, buildMs: 1 }; value.hash = hashArtifact(value);
  assert.equal(x.api.EngineeringMaterialSchema.safeParse(value).success, false);
  await assert.rejects(x.api.verifyEngineeringMaterial(value, x.verification));
});

async function provenanceFor(x, edit = () => {}) {
  const manifest = { schemaVersion: 1, kind: 'engineering_capture_provenance', runnerMode: x.runnerMode,
    sourceCommitBefore: x.sourceCommit, sourceCommitAfter: x.sourceCommit,
    fingerprintsBefore: structuredClone(x.fingerprints), fingerprintsAfter: structuredClone(x.fingerprints), commands: structuredClone(x.options.commands) };
  edit(manifest); const file = 'manifest-case.json';
  await writeFile(join(x.root, file), JSON.stringify(manifest) + '\n', { flag: 'wx' });
  return { ...x.options, capture: await x.reference(file) };
}

test('producer requires a persisted capture provenance manifest instead of assuming current source was tested', async t => {
  const x = await createEngineeringMaterialFixture(t), options = structuredClone(x.options); delete options.capture;
  await assert.rejects(x.api.produceEngineeringMaterial(options, { root: x.root }));
});
test('matching original before/after capture manifest is accepted and retained in the material', async t => {
  const x = await createEngineeringMaterialFixture(t), options = await provenanceFor(x);
  const material = await x.api.produceEngineeringMaterial(options, { root: x.root });
  assert.deepEqual(material.capture, options.capture); assert.equal(x.api.EngineeringCaptureProvenanceSchema.safeParse(JSON.parse(await readFile(join(x.root, options.capture.file), 'utf8'))).success, true);
  assert.deepEqual(await x.api.verifyEngineeringMaterial(material, x.verification), material);
});
for (const fault of ['before_commit', 'after_commit', 'before_fingerprint', 'after_fingerprint', 'command_reference', 'capture_mode']) {
  test(`capture provenance rejects ${fault} even when its file hash is refreshed`, async t => {
    const x = await createEngineeringMaterialFixture(t), options = await provenanceFor(x, manifest => {
      if (fault === 'before_commit') manifest.sourceCommitBefore = 'b'.repeat(40);
      if (fault === 'after_commit') manifest.sourceCommitAfter = 'b'.repeat(40);
      if (fault === 'before_fingerprint') manifest.fingerprintsBefore[0].sha256 = '0'.repeat(64);
      if (fault === 'after_fingerprint') manifest.fingerprintsAfter[0].sha256 = '0'.repeat(64);
      if (fault === 'command_reference') manifest.commands.web.sha256 = '0'.repeat(64);
      if (fault === 'capture_mode') manifest.runnerMode = 'live';
    });
    await assert.rejects(x.api.produceEngineeringMaterial(options, { root: x.root }));
  });
}
