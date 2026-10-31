/** Versioned engineering evidence, never model/publication or human-gold authority.
 * Receipts are persisted by the reviewed capture helper from actual child close
 * events. Re-reading hashes is traceability, not a cryptographic defence against
 * a local administrator rewriting the helper, all receipts and all logs. */
import { spawn } from 'node:child_process';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { canonicalizeArtifact } from '../contracts/canonical.js';
import { HashSchema, TimestampSchema } from '../contracts/primitives.js';
import { deepFreeze } from '../data/records.js';
import { hashArtifact, sha256Bytes } from '../evidence/hashing.js';
import { readEngineeringFile, EngineeringFileError } from './engineering-files.js';

const VERSION = 'task7y-engineering-material-v1' as const;
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CAP_BYTES = 16 * 1024 * 1024;
const Mode = z.enum(['live', 'offline_fixture']);
const Kind = z.enum(['offline', 'web']);
const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const File = z.string().min(1).max(1024).refine(value => !value.includes('\\') && !value.includes(':')
  && !value.includes('\0') && !isAbsolute(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const Fingerprint = z.strictObject({ file: File, sha256: HashSchema });
const Fingerprints = z.array(Fingerprint).min(1).refine(rows => new Set(rows.map(row => row.file)).size === rows.length);
const Reference = z.strictObject({ file: File, sha256: HashSchema });
const commandText = z.string().min(1).max(32768).refine(value => !value.includes('\0'));

export class EngineeringMaterialError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'EngineeringMaterialError'; }
}
const fail = (code: string): never => { throw new EngineeringMaterialError(code); };
function need(value: unknown, code: string): asserts value { if (!value) fail(code); }
const same = (a: unknown, b: unknown) => canonicalizeArtifact(a) === canonicalizeArtifact(b);
const sha = (bytes: Uint8Array) => sha256Bytes(bytes);
function checked<S extends z.ZodType>(schema: S, value: unknown, code: string): z.infer<S> {
  const parsed = schema.safeParse(value); if (!parsed.success) return fail(code); return parsed.data;
}

export const EngineeringCommandReceiptSchema = z.strictObject({ schemaVersion: z.literal(1), kind: Kind, runnerMode: Mode,
  command: commandText, argv: z.array(commandText).min(1).max(256), exitCode: z.int(),
  log: z.strictObject({ file: File, sha256: HashSchema, bytes: z.int().positive().max(CAP_BYTES) }),
  startedAt: TimestampSchema, endedAt: TimestampSchema,
}).refine(value => Date.parse(value.endedAt) >= Date.parse(value.startedAt));
export type EngineeringCommandReceipt = z.infer<typeof EngineeringCommandReceiptSchema>;
export const EngineeringReviewCertificateSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('independent_engineering_review'),
  task: z.literal('Task7y'), runnerMode: Mode, sourceCommit: Commit, fingerprints: Fingerprints,
  reviewer: z.string().min(1).max(256), remainingBlockers: z.literal(0), passed: z.literal(true) });
export type EngineeringReviewCertificate = z.infer<typeof EngineeringReviewCertificateSchema>;
export const EngineeringCaptureProvenanceSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('engineering_capture_provenance'),
  runnerMode: Mode, sourceCommitBefore: Commit, sourceCommitAfter: Commit, fingerprintsBefore: Fingerprints, fingerprintsAfter: Fingerprints,
  commands: z.strictObject({ offline: Reference, web: Reference }),
}).refine(value => value.sourceCommitBefore === value.sourceCommitAfter && same(value.fingerprintsBefore, value.fingerprintsAfter));
export type EngineeringCaptureProvenance = z.infer<typeof EngineeringCaptureProvenanceSchema>;
const offlineSummary = z.strictObject({ tests: z.int().positive(), pass: z.int().positive(), fail: z.literal(0), cancelled: z.literal(0), skipped: z.literal(0),
  durationMs: z.number().finite().nonnegative() }).refine(value => value.tests === value.pass);
const webSummary = z.strictObject({ typecheck: z.literal(true), build: z.literal(true), buildMs: z.number().finite().nonnegative(),
  typecheckEvidence: z.literal('fixed_build_script_control_flow') });
const commandEvidence = { receiptFile: File, receiptSha256: HashSchema, receipt: EngineeringCommandReceiptSchema };
export const EngineeringMaterialSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('engineering_material'), version: z.literal(VERSION),
  task: z.literal('Task7y'), runnerMode: Mode, createdAt: TimestampSchema, sourceCommit: Commit, fingerprints: Fingerprints,
  commands: z.strictObject({ offline: z.strictObject({ ...commandEvidence, summary: offlineSummary }), web: z.strictObject({ ...commandEvidence, summary: webSummary }) }),
  independentReview: Reference, capture: Reference, hash: HashSchema,
}).refine(value => value.commands.offline.receipt.kind === 'offline' && value.commands.web.receipt.kind === 'web'
  && [value.commands.offline.receipt, value.commands.web.receipt].every(receipt => receipt.runnerMode === value.runnerMode && receipt.exitCode === 0)
  && value.commands.offline.receiptFile !== value.commands.web.receiptFile
  && value.commands.offline.receipt.log.file !== value.commands.web.receipt.log.file);
export type EngineeringMaterial = z.infer<typeof EngineeringMaterialSchema>;
export type ProduceEngineeringMaterialOptions = {
  task: 'Task7y'; runnerMode: 'live' | 'offline_fixture'; sourceCommit: string;
  fingerprints: readonly { file: string; sha256: string }[];
  commands: { offline: { file: string; sha256: string }; web: { file: string; sha256: string } };
  independentReview: { file: string; sha256: string };
  capture: { file: string; sha256: string };
};
type IO = { root: string; readFile?: (path: string) => Promise<Uint8Array> };
type VerifyOptions = IO & { currentCommit: string; currentFingerprints: readonly { file: string; sha256: string }[]; runnerMode: 'live' | 'offline_fixture' };
type CaptureOptions = { root: string; kind: 'offline' | 'web'; runnerMode: 'live' | 'offline_fixture';
  logFile: string; receiptFile: string; command?: string; argv?: readonly string[] };

function project(io: IO, mode: 'live' | 'offline_fixture') {
  need(isAbsolute(io.root), 'ENGINEERING_ROOT_INVALID'); const root = resolve(io.root);
  if (mode === 'live') {
    need(root === resolve(PROJECT_ROOT), 'ENGINEERING_LIVE_ROOT_INVALID');
    need(io.readFile === undefined, 'ENGINEERING_LIVE_IO_OVERRIDE');
  }
  return root;
}
function target(root: string, file: string) {
  checked(File, file, 'ENGINEERING_FILE_INVALID'); const path = resolve(root, file);
  need(path.startsWith(root + sep), 'ENGINEERING_FILE_INVALID'); return path;
}
async function ordinary(path: string, final: 'file' | 'directory') {
  const volume = parse(path).root; let cursor = volume;
  for (const component of relative(volume, path).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, component); const info = await lstat(cursor);
    need(!info.isSymbolicLink() && (cursor === path && final === 'file' ? info.isFile() && info.size <= CAP_BYTES : info.isDirectory()), 'ENGINEERING_FILE_UNSAFE');
  }
}
async function read(io: IO, mode: 'live' | 'offline_fixture', file: string): Promise<Buffer> {
  const root = project(io, mode), path = target(root, file);
  try {
    let bytes: Buffer;
    if (io.readFile) { await ordinary(path, 'file'); bytes = Buffer.from(await io.readFile(path)); }
    else bytes = await readEngineeringFile(root, path, CAP_BYTES);
    need(bytes.length <= CAP_BYTES, 'ENGINEERING_FILE_LIMIT'); return bytes;
  } catch (error) {
    if (error instanceof EngineeringMaterialError) throw error;
    if (error instanceof EngineeringFileError && ['ENGINEERING_FILE_ARGUMENT', 'ENGINEERING_FILE_UNSAFE', 'ENGINEERING_SDK_IDENTITY', 'ENGINEERING_FILE_LIMIT'].includes(error.code)) return fail(error.code);
    return fail('ENGINEERING_FILE_READ');
  }
}
function json(bytes: Uint8Array): unknown { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('ENGINEERING_JSON_INVALID'); } }
function fixedCommand(root: string, kind: 'offline' | 'web') { return resolve(root, 'scripts', kind === 'offline' ? 'test-offline.mjs' : 'build-web.mjs'); }
function commandBinding(root: string, receipt: Pick<EngineeringCommandReceipt, 'kind' | 'runnerMode' | 'command' | 'argv'>) {
  need(resolve(receipt.command) === resolve(process.execPath), 'ENGINEERING_CAPTURE_COMMAND');
  if (receipt.runnerMode === 'live') need(receipt.argv.length === 1 && resolve(root, receipt.argv[0]!) === fixedCommand(root, receipt.kind), 'ENGINEERING_CAPTURE_COMMAND');
}
async function sourceBinding(io: IO, mode: 'live' | 'offline_fixture', fingerprints: readonly { file: string; sha256: string }[]) {
  if (mode === 'live') for (const file of ['scripts/test-offline.mjs', 'scripts/build-server.mjs', 'scripts/build-web.mjs'])
    need(fingerprints.some(row => row.file === file), 'ENGINEERING_FIXED_SCRIPT_FINGERPRINT');
  for (const row of fingerprints) need(sha(await read(io, mode, row.file)) === row.sha256, 'ENGINEERING_SOURCE_BINDING');
}
function parseLog(bytes: Uint8Array, receipt: EngineeringCommandReceipt) {
  need(receipt.exitCode === 0, 'ENGINEERING_COMMAND_EXIT');
  need(bytes.length === receipt.log.bytes && sha(bytes) === receipt.log.sha256, 'ENGINEERING_LOG_BINDING');
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('ENGINEERING_LOG_UTF8'); }
  // Derived parsing only: original bytes, BOM/newlines and hash remain intact.
  const plain = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const markers = plain.split(/\r?\n/).filter(line => line.startsWith('CHECK_EXIT='));
  need(markers.length === 1 && markers[0] === 'CHECK_EXIT=0' && /(?:^|\n)CHECK_EXIT=0\r?\n?$/.test(plain), 'ENGINEERING_LOG_EXIT');
  return plain;
}
function parseOffline(text: string) {
  const field = (name: string) => { const rows = [...text.matchAll(new RegExp(`^(?:ℹ|#)\\s+${name}\\s+([0-9]+(?:\\.[0-9]+)?)\\s*$`, 'gm'))];
    need(rows.length === 1, 'ENGINEERING_TEST_SUMMARY'); return Number(rows[0]![1]); };
  return checked(offlineSummary, { tests: field('tests'), pass: field('pass'), fail: field('fail'), cancelled: field('cancelled'), skipped: field('skipped'), durationMs: field('duration_ms') }, 'ENGINEERING_TEST_SUMMARY');
}
function parseWeb(text: string) {
  need(/vite\s+v?\d[^\r\n]*building (?:client environment for production|for production)/i.test(text), 'ENGINEERING_WEB_SUMMARY');
  const matches = [...text.matchAll(/^(?:✓\s*)?built in ([0-9]+(?:\.[0-9]+)?)(ms|s)\s*$/gm)];
  need(matches.length === 1, 'ENGINEERING_WEB_SUMMARY');
  return checked(webSummary, { typecheck: true, build: true, buildMs: Number(matches[0]![1]) * (matches[0]![2] === 's' ? 1000 : 1), typecheckEvidence: 'fixed_build_script_control_flow' }, 'ENGINEERING_WEB_SUMMARY');
}
async function commandEvidenceFrom(ref: { file: string; sha256: string }, kind: 'offline' | 'web', mode: 'live' | 'offline_fixture', io: IO) {
  const raw = await read(io, mode, ref.file); need(sha(raw) === ref.sha256, 'ENGINEERING_RECEIPT_BINDING');
  const receipt = checked(EngineeringCommandReceiptSchema, json(raw), 'ENGINEERING_RECEIPT_INVALID');
  need(receipt.kind === kind && receipt.runnerMode === mode, 'ENGINEERING_RECEIPT_BINDING'); commandBinding(project(io, mode), receipt);
  const text = parseLog(await read(io, mode, receipt.log.file), receipt);
  return { receiptFile: ref.file, receiptSha256: ref.sha256, receipt, summary: kind === 'offline' ? parseOffline(text) : parseWeb(text) };
}
async function reviewBinding(options: Pick<ProduceEngineeringMaterialOptions, 'runnerMode' | 'sourceCommit' | 'fingerprints' | 'independentReview'>, io: IO) {
  const raw = await read(io, options.runnerMode, options.independentReview.file);
  need(sha(raw) === options.independentReview.sha256, 'ENGINEERING_REVIEW_BINDING');
  const certificate = checked(EngineeringReviewCertificateSchema, json(raw), 'ENGINEERING_REVIEW_INVALID');
  need(certificate.runnerMode === options.runnerMode && certificate.sourceCommit === options.sourceCommit && same(certificate.fingerprints, options.fingerprints), 'ENGINEERING_REVIEW_BINDING');
}
async function captureBinding(options: Pick<ProduceEngineeringMaterialOptions, 'runnerMode' | 'sourceCommit' | 'fingerprints' | 'capture' | 'commands'>, io: IO) {
  const raw = await read(io, options.runnerMode, options.capture.file);
  need(sha(raw) === options.capture.sha256, 'ENGINEERING_CAPTURE_PROVENANCE_BINDING');
  const manifest = checked(EngineeringCaptureProvenanceSchema, json(raw), 'ENGINEERING_CAPTURE_PROVENANCE_INVALID');
  need(manifest.runnerMode === options.runnerMode && manifest.sourceCommitBefore === options.sourceCommit && manifest.sourceCommitAfter === options.sourceCommit
    && same(manifest.fingerprintsBefore, options.fingerprints) && same(manifest.fingerprintsAfter, options.fingerprints)
    && same(manifest.commands, options.commands), 'ENGINEERING_CAPTURE_PROVENANCE_BINDING');
}

/** Read persisted actual receipts; no command, Store, worker or model is run. */
export async function produceEngineeringMaterial(options: ProduceEngineeringMaterialOptions, io: IO): Promise<EngineeringMaterial> {
  checked(z.strictObject({ task: z.literal('Task7y'), runnerMode: Mode, sourceCommit: Commit, fingerprints: Fingerprints,
    commands: z.strictObject({ offline: Reference, web: Reference }), independentReview: Reference, capture: Reference }), options, 'ENGINEERING_PRODUCER_INVALID');
  project(io, options.runnerMode); await sourceBinding(io, options.runnerMode, options.fingerprints); await reviewBinding(options, io); await captureBinding(options, io);
  const offline = await commandEvidenceFrom(options.commands.offline, 'offline', options.runnerMode, io), web = await commandEvidenceFrom(options.commands.web, 'web', options.runnerMode, io);
  const body = { schemaVersion: 1, kind: 'engineering_material', version: VERSION, task: options.task, runnerMode: options.runnerMode,
    createdAt: new Date().toISOString(), sourceCommit: options.sourceCommit, fingerprints: options.fingerprints, commands: { offline, web }, independentReview: options.independentReview, capture: options.capture };
  return deepFreeze(checked(EngineeringMaterialSchema, { ...body, hash: hashArtifact(body) }, 'ENGINEERING_MATERIAL_INVALID'));
}
/** Same contract for producer, preparation and preflight. Nothing is repaired. */
export async function verifyEngineeringMaterial(value: unknown, options: VerifyOptions): Promise<EngineeringMaterial> {
  const material = checked(EngineeringMaterialSchema, value, 'ENGINEERING_MATERIAL_INVALID');
  need(hashArtifact(material) === material.hash, 'ENGINEERING_MATERIAL_HASH');
  need(material.sourceCommit === options.currentCommit && material.runnerMode === options.runnerMode && same(material.fingerprints, options.currentFingerprints), 'ENGINEERING_CURRENT_BINDING');
  project(options, options.runnerMode); await sourceBinding(options, material.runnerMode, material.fingerprints); await reviewBinding(material, options);
  await captureBinding({ ...material, commands: {
    offline: { file: material.commands.offline.receiptFile, sha256: material.commands.offline.receiptSha256 },
    web: { file: material.commands.web.receiptFile, sha256: material.commands.web.receiptSha256 },
  } }, options);
  for (const kind of ['offline', 'web'] as const) {
    const stored = material.commands[kind], actual = await commandEvidenceFrom({ file: stored.receiptFile, sha256: stored.receiptSha256 }, kind, material.runnerMode, options);
    need(same(stored, actual), 'ENGINEERING_RECEIPT_BINDING');
  }
  return deepFreeze(material);
}

/** Capture only, not success: a nonzero actual close code is still persisted.
 * stdout/stderr chunks are retained in arrival order, never rewritten as a
 * successful build. Existing paths are reserved with wx before any spawn. */
export async function captureEngineeringCommand(options: CaptureOptions): Promise<EngineeringCommandReceipt> {
  const mode = checked(Mode, options.runnerMode, 'ENGINEERING_CAPTURE_INVALID'), kind = checked(Kind, options.kind, 'ENGINEERING_CAPTURE_INVALID');
  const root = project({ root: options.root }, mode), command = options.command ?? process.execPath, argv = [...(options.argv ?? [fixedCommand(root, kind)])];
  checked(commandText, command, 'ENGINEERING_CAPTURE_COMMAND'); checked(z.array(commandText).min(1).max(256), argv, 'ENGINEERING_CAPTURE_COMMAND');
  commandBinding(root, { command, argv, kind, runnerMode: mode });
  const logFile = checked(File, options.logFile, 'ENGINEERING_CAPTURE_INVALID'), receiptFile = checked(File, options.receiptFile, 'ENGINEERING_CAPTURE_INVALID');
  need(logFile !== receiptFile, 'ENGINEERING_CAPTURE_INVALID');
  const logPath = target(root, logFile), receiptPath = target(root, receiptFile);
  let logHandle: Awaited<ReturnType<typeof open>> | undefined, receiptHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await ordinary(root, 'directory'); await mkdir(dirname(logPath), { recursive: true }); await mkdir(dirname(receiptPath), { recursive: true });
    await ordinary(dirname(logPath), 'directory'); await ordinary(dirname(receiptPath), 'directory');
    logHandle = await open(logPath, 'wx'); receiptHandle = await open(receiptPath, 'wx');
    const startedAt = new Date().toISOString(), chunks: Buffer[] = []; let count = 0, overflow = false;
    const actual = await new Promise<{ exitCode: number | null; signal: string | null; spawnError: boolean }>(resolveClose => {
      // The capture is an independent command, not a nested node:test worker.
      // Preserve the parent's environment and every unrelated variable.
      const childEnvironment = { ...process.env }; delete childEnvironment.NODE_TEST_CONTEXT;
      const child = spawn(command, argv, { cwd: root, env: childEnvironment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnError = false;
      const capture = (chunk: Uint8Array) => { count += chunk.length; if (count <= CAP_BYTES - 128) chunks.push(Buffer.from(chunk)); else overflow = true; };
      child.stdout.on('data', capture); child.stderr.on('data', capture); child.on('error', () => { spawnError = true; });
      child.once('close', (exitCode, signal) => resolveClose({ exitCode, signal, spawnError }));
    });
    const endedAt = new Date().toISOString();
    if (actual.spawnError || actual.signal !== null || !Number.isInteger(actual.exitCode) || overflow) {
      const code = overflow ? 'ENGINEERING_CAPTURE_OUTPUT_LIMIT' : 'ENGINEERING_CAPTURE_FAILED';
      await logHandle.writeFile(Buffer.concat([...chunks, Buffer.from(`\nCAPTURE_ERROR=${code}\n`)])); await logHandle.sync(); fail(code);
    }
    const exitCode = actual.exitCode!, raw = Buffer.concat([...chunks, Buffer.from(`\nCHECK_EXIT=${exitCode}\n`)]);
    const receipt = checked(EngineeringCommandReceiptSchema, { schemaVersion: 1, kind, runnerMode: mode, command, argv, exitCode,
      log: { file: logFile, sha256: sha(raw), bytes: raw.length }, startedAt, endedAt }, 'ENGINEERING_RECEIPT_INVALID');
    await logHandle.writeFile(raw); await logHandle.sync(); await receiptHandle.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await receiptHandle.sync();
    return deepFreeze(receipt);
  } catch (error) { if (error instanceof EngineeringMaterialError) throw error; return fail('ENGINEERING_CAPTURE_WRITE_OR_SPAWN'); }
  finally {
    const closed = await Promise.allSettled([logHandle?.close(), receiptHandle?.close()]);
    if (closed.some(result => result.status === 'rejected')) return fail('ENGINEERING_CAPTURE_CLOSE');
  }
}
