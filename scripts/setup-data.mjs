import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const OFFICIAL_REPOSITORY = 'https://github.com/jigjoy-ai/einstein-matchmaker-data.git';
export const PINNED_COMMIT = '4fb99b3749adf0d10b5977089ff4c73f4f522240';
export const DEFAULT_DATA_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)), '..', 'reference', 'einstein-matchmaker-data',
);

const execFileAsync = promisify(execFile);

export class DataSetupError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DataSetupError';
    this.code = code;
  }
}

/** Pure path resolution: explicit paths must be absolute; never uses cwd. */
export function resolveDataDirectory(path = DEFAULT_DATA_DIRECTORY) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new DataSetupError('INVALID_OPTIONS', 'dataDirectory must be an absolute filesystem path.');
  }
  return resolve(path);
}

function policy(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['dataDirectory', 'localTestSource'].includes(key))) {
    throw new DataSetupError('INVALID_OPTIONS', 'Only dataDirectory and module-only localTestSource are supported.');
  }
  const directory = resolveDataDirectory(options.dataDirectory);
  if (options.localTestSource === undefined) {
    return { directory, repository: OFFICIAL_REPOSITORY, commit: PINNED_COMMIT, sourcePolicy: 'official' };
  }
  // This injection exists only on the imported API for temporary local Git
  // fixtures. CLI never accepts it, and no environment variable selects it.
  const source = options.localTestSource;
  if (!source || typeof source !== 'object' || Array.isArray(source)
      || Object.keys(source).some(key => !['directory', 'commit'].includes(key))
      || typeof source.directory !== 'string' || !isAbsolute(source.directory)
      || typeof source.commit !== 'string' || !/^[a-f0-9]{40}$/.test(source.commit)) {
    throw new DataSetupError('INVALID_OPTIONS', 'localTestSource requires an absolute local directory and a 40-character lowercase hex commit.');
  }
  return { directory, repository: resolve(source.directory), commit: source.commit, sourcePolicy: 'local-test' };
}

async function git(...args) {
  const { stdout } = await execFileAsync('git', [
    '--no-optional-locks', '-c', 'core.quotepath=false', ...args,
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function verifyExisting(configuration) {
  const { directory, commit } = configuration;
  let top;
  try {
    top = await git('-C', directory, 'rev-parse', '--show-toplevel');
    if (!samePath(await realpath(top), await realpath(directory))) {
      throw new Error('Directory is nested inside a different repository.');
    }
  } catch (cause) {
    throw new DataSetupError('NOT_DATA_REPOSITORY', `Existing directory is not a Git repository root: ${directory}. It was left unchanged.`, cause);
  }
  const dirty = await git('-C', directory, 'status', '--porcelain=v1', '--untracked-files=all');
  if (dirty) {
    throw new DataSetupError('DIRTY_DATA', `Data repository has modified or untracked files: ${directory}. No repair or pull was attempted.`);
  }
  const actualCommit = await git('-C', directory, 'rev-parse', '--verify', 'HEAD');
  if (actualCommit !== commit) {
    throw new DataSetupError('WRONG_COMMIT', `Data commit is ${actualCommit}; expected ${commit}. No checkout, reset or pull was attempted.`);
  }
}

/**
 * Verify existing data or acquire missing data. Does nothing until called.
 *
 * Existing directories (including empty/non-Git ones) are never repaired.
 * For an absent target, mkdir claims it exclusively before clone; on failure
 * this new directory is retained. No deletion, overwrite or automatic retry
 * occurs, and existing repositories never contact the configured source.
 */
export async function setupData(options = {}) {
  const configuration = policy(options);
  const { directory, repository, commit, sourcePolicy } = configuration;
  let existing;
  try {
    existing = await lstat(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new DataSetupError('NOT_DIRECTORY', `Existing data path must be a real directory, not a file or link: ${directory}. It was left unchanged.`);
    }
    await verifyExisting(configuration);
    return { status: 'verified', directory, repository, commit, sourcePolicy };
  }

  await mkdir(dirname(directory), { recursive: true });
  try {
    // Exclusive creation is important: rename could replace an empty target
    // created by another process on POSIX. Never treat EEXIST as our folder.
    await mkdir(directory);
  } catch (cause) {
    throw new DataSetupError('DESTINATION_UNAVAILABLE', `Could not exclusively create data directory: ${directory}. Nothing was overwritten.`, cause);
  }
  try {
    // Full history allows the fixed commit to differ from the latest branch.
    // Argument arrays protect Chinese/spaced paths; no shell is involved.
    // Recorded Evidence hashes use the original Windows checkout bytes. Pin
    // conversion locally for new clones, independent of the caller's Git
    // defaults. Git preserves mixed/binary files; existing data is untouched.
    await git('clone', '--no-checkout', '--no-hardlinks', '--config', 'core.autocrlf=true', '--', repository, directory);
  } catch (cause) {
    throw new DataSetupError('CLONE_FAILED', `Git clone failed. The newly created directory was preserved for inspection: ${directory}.`, cause);
  }
  try {
    await git('-C', directory, 'checkout', '--detach', commit);
  } catch (cause) {
    throw new DataSetupError('CHECKOUT_FAILED', `Git checkout of ${commit} failed. The clone was preserved for inspection: ${directory}.`, cause);
  }
  await verifyExisting(configuration);
  return { status: 'cloned', directory, repository, commit, sourcePolicy };
}

async function cli() {
  try {
    if (process.argv.length > 2) {
      throw new DataSetupError('INVALID_ARGUMENTS', 'This CLI does not accept arguments. Its official repository, commit and workspace-relative data path are fixed.');
    }
    process.stdout.write(`${JSON.stringify(await setupData())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.code ?? 'DATA_SETUP_FAILED', message: error.message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await cli();
}
