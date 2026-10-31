import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, isAbsolute, basename } from 'node:path';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { RunInputSchema, type RunInput } from '../contracts/domain.js';
import { LimitsSchema, type Limits } from '../contracts/config.js';
import { ParentToWorkerMessageSchema, WorkerToParentMessageSchema, type ParentToWorkerMessage, type WorkerToParentMessage } from '../contracts/ipc.js';

const execute = promisify(execFile);
export type ProcessIdentity = Readonly<{ pid: number; creationFileTime: string; executablePath: string; commandLine: string; parentPid: number }>;
export type IdentityProbe = { status: 'present'; identity: ProcessIdentity } | { status: 'absent' | 'unknown'; reason?: string };
export type TerminationEvidence = Readonly<{ status: 'terminated' | 'already_exited' | 'absent' | 'identity_mismatch' | 'unknown'; terminated: boolean; osWaitConfirmed?: boolean }>;
export type ExitEvidence = Readonly<{ runId: string; pid: number | null; exitCode: number | null; signal: string | null;
  exitObserved: boolean; closeObserved: boolean; spawnError: boolean; stdout: string; stderr: string; outputTruncated: boolean }>;
export type ScanDiagnostic = Readonly<{ pid: number; stage: string; code: string;
  parentPid?: number; cimCreationFileTime?: string; parentCreationFileTime?: string; nativeCreationFileTime?: string }>;
export type CleanupResult = Readonly<{ runId: string; confirmed: boolean; scope: 'registered_identities_only_no_job_object';
  identity: ProcessIdentity | null; rootVerification: string; termination: TerminationEvidence | null; exit: ExitEvidence;
  scanDiagnostics: readonly ScanDiagnostic[];
  descendants: readonly { identity: ProcessIdentity; termination: TerminationEvidence | null; verification: string }[];
  unobservedDescendantsNotGuaranteed: true }>;
export type WorkerHandle = Readonly<{ runId: string; pid: number | undefined; ready: Promise<void>; identity: Promise<ProcessIdentity | null>;
  closed: Promise<ExitEvidence>; send(message: ParentToWorkerMessage): boolean; terminate(reason: string): Promise<CleanupResult>;
  inspectDescendants(): Promise<readonly ProcessIdentity[]> }>;

function pidValue(pid: number) { if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('INVALID_PROCESS_ID'); return pid; }
function freezeIdentity(value: ProcessIdentity): ProcessIdentity {
  pidValue(value.pid);
  if (!/^\d+$/.test(value.creationFileTime) || !Number.isSafeInteger(value.parentPid) || value.parentPid < 0
    || typeof value.executablePath !== 'string' || typeof value.commandLine !== 'string') throw new Error('INVALID_PROCESS_IDENTITY');
  return Object.freeze({ ...value });
}
async function powershell(script: string): Promise<unknown> {
  if (process.platform !== 'win32') throw new Error('WINDOWS_PROCESS_HOST_REQUIRED');
  const path = resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const encoded = Buffer.from('[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);' + script, 'utf16le').toString('base64');
  const result = await execute(path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}
/** Read only one owned PID. Command lines are data and never interpolated as shell code. */
export async function queryWindowsIdentity(pid: number): Promise<IdentityProbe> {
  pidValue(pid);
  try {
    const value = await powershell(`$ErrorActionPreference='Stop';try {
      $p=[System.Diagnostics.Process]::GetProcessById(${pid});$birth=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();
      $c=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';
      if($null -eq $c){@{status='absent'}|ConvertTo-Json -Compress}else{
      @{status='present';identity=@{pid=${pid};creationFileTime=$birth;executablePath=[string]$c.ExecutablePath;commandLine=[string]$c.CommandLine;parentPid=[int]$c.ParentProcessId}}|ConvertTo-Json -Compress}
    }catch [System.ArgumentException]{@{status='absent'}|ConvertTo-Json -Compress}`) as IdentityProbe;
    return value.status === 'present' ? { status: 'present', identity: freezeIdentity(value.identity) } : value;
  } catch { return { status: 'unknown', reason: 'OS_IDENTITY_QUERY_FAILED' }; }
}

/** Compare creation time and terminate through THE SAME Windows process handle.
 * Unlike a probe followed by taskkill(pid), PID reuse between check and action cannot select a new process.
 * This does not create a JobObject or make unobserved detached descendants discoverable.
 */
export async function terminateWindowsIdentity(target: ProcessIdentity): Promise<TerminationEvidence> {
  const identity = freezeIdentity(target);
  try {
    return await powershell(`$ErrorActionPreference='Stop';Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class Task5ProcessHandle {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint a,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr h,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr h,out uint code);
 [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
$h=[Task5ProcessHandle]::OpenProcess(0x101001,$false,${identity.pid});
if($h -eq [IntPtr]::Zero){$e=[Runtime.InteropServices.Marshal]::GetLastWin32Error();if($e -eq 87){@{status='absent';terminated=$false}|ConvertTo-Json -Compress}else{@{status='unknown';terminated=$false}|ConvertTo-Json -Compress};exit}
try{[long]$c=0;[long]$e=0;[long]$k=0;[long]$u=0;
 if(-not [Task5ProcessHandle]::GetProcessTimes($h,[ref]$c,[ref]$e,[ref]$k,[ref]$u)){@{status='unknown';terminated=$false}|ConvertTo-Json -Compress;exit}
 if($c.ToString() -ne '${identity.creationFileTime}'){@{status='identity_mismatch';terminated=$false}|ConvertTo-Json -Compress;exit}
 [uint32]$exitCode=0;if([Task5ProcessHandle]::GetExitCodeProcess($h,[ref]$exitCode) -and $exitCode -ne 259){@{status='already_exited';terminated=$false;osWaitConfirmed=$true}|ConvertTo-Json -Compress;exit}
 if(-not [Task5ProcessHandle]::TerminateProcess($h,1)){@{status='unknown';terminated=$false}|ConvertTo-Json -Compress;exit}
 $wait=[Task5ProcessHandle]::WaitForSingleObject($h,5000);@{status='terminated';terminated=$true;osWaitConfirmed=($wait -eq 0)}|ConvertTo-Json -Compress
}finally{[void][Task5ProcessHandle]::CloseHandle($h)}`) as TerminationEvidence;
  } catch { return { status: 'unknown', terminated: false }; }
}
/** Deterministic ancestry selection, also exposed for synthetic PID-reuse regressions. No OS action. */
export function selectOwnedDescendants(root: ProcessIdentity, candidates: readonly ProcessIdentity[]) {
  const parents = new Map([[root.pid, freezeIdentity(root)]]), identities: ProcessIdentity[] = [];
  const rows = new Map<number, ProcessIdentity>(), conflicting = new Set<number>();
  let ambiguous = false;
  for (const raw of candidates) {
    const row = freezeIdentity(raw), existing = rows.get(row.pid);
    if (row.pid === root.pid || (existing && (existing.creationFileTime !== row.creationFileTime || existing.parentPid !== row.parentPid))) {
      ambiguous = true; conflicting.add(row.pid); continue;
    }
    rows.set(row.pid, row);
  }
  let changed: boolean;
  do {
    changed = false;
    for (const row of rows.values()) if (!parents.has(row.pid) && !conflicting.has(row.pid)) {
      const parent = parents.get(row.parentPid); if (!parent) continue;
      // ParentProcessId is a historical number. A surviving process can point to a reused
      // immediate-parent PID, so comparison with only the original root birth is unsafe.
      if (BigInt(row.creationFileTime) < BigInt(parent.creationFileTime)) { ambiguous = true; continue; }
      parents.set(row.pid, row); identities.push(row); changed = true;
    }
  } while (changed);
  return { identities, ambiguous };
}
async function descendantsOf(root: ProcessIdentity): Promise<{ known: boolean; identities: ProcessIdentity[]; diagnostics: readonly ScanDiagnostic[] }> {
  try {
    // A historical ParentProcessId is disproved by a reliable earlier birth,
    // before querying an unrelated/inaccessible current PID. Respect the existing
    // <10-tick CIM/native precision window; close or missing metadata still needs
    // a native identity. Only verified parents enter the traversal map.
    const result = await powershell(`$ErrorActionPreference='Stop';$issues=New-Object System.Collections.ArrayList;$stage='root_identity';try{$p=[Diagnostics.Process]::GetProcessById(${root.pid});if($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne '${root.creationFileTime}'){throw 'root changed'};
    $stage='enumeration';$all=@(Get-CimInstance Win32_Process);$ids=New-Object 'System.Collections.Generic.HashSet[int]';[void]$ids.Add(${root.pid});$parents=New-Object 'System.Collections.Generic.Dictionary[int,string]';$parents.Add(${root.pid},'${root.creationFileTime}');$rows=New-Object System.Collections.ArrayList;$uncertain=$false;
    do{$added=$false;foreach($c in $all){if($ids.Contains([int]$c.ParentProcessId) -and -not $ids.Contains([int]$c.ProcessId)){
      $entryStage='cim_creation_date';try{if($null -eq $c.CreationDate){throw 'missing CIM birth'};$cimBirth=$c.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString();if([decimal]$cimBirth -le 0){throw 'invalid CIM birth'};$parentBirth=$parents[[int]$c.ParentProcessId];
      $entryStage='chronology';if(([decimal]$cimBirth+9) -lt [decimal]$parentBirth){[void]$issues.Add(@{pid=[int]$c.ProcessId;parentPid=[int]$c.ParentProcessId;stage='chronology_exclusion';code='CIM_PRECEDES_VERIFIED_PARENT';cimCreationFileTime=$cimBirth;parentCreationFileTime=$parentBirth});continue};
      $entryStage='native_identity';$q=[Diagnostics.Process]::GetProcessById([int]$c.ProcessId);$birth=$q.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();$entryStage='birth_comparison';if([Math]::Abs([decimal]$birth-[decimal]$cimBirth) -ge 10){$uncertain=$true;[void]$issues.Add(@{pid=[int]$c.ProcessId;stage=$entryStage;code='BIRTH_METADATA_MISMATCH'});continue};
      if([decimal]$birth -lt [decimal]$parentBirth){[void]$issues.Add(@{pid=[int]$c.ProcessId;parentPid=[int]$c.ParentProcessId;stage='chronology_exclusion';code='NATIVE_PRECEDES_VERIFIED_PARENT';cimCreationFileTime=$cimBirth;nativeCreationFileTime=$birth;parentCreationFileTime=$parentBirth});continue};
      [void]$ids.Add([int]$c.ProcessId);$parents.Add([int]$c.ProcessId,$birth);[void]$rows.Add(@{pid=[int]$c.ProcessId;creationFileTime=$birth;executablePath=[string]$c.ExecutablePath;commandLine=[string]$c.CommandLine;parentPid=[int]$c.ParentProcessId});$added=$true}catch{$uncertain=$true;[void]$issues.Add(@{pid=[int]$c.ProcessId;stage=$entryStage;code='DESCENDANT_IDENTITY_UNCONFIRMED'})}}
    }}while($added);$stage='root_recheck';if([Diagnostics.Process]::GetProcessById(${root.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne '${root.creationFileTime}'){throw 'root changed'};
    @{known=(-not $uncertain);identities=@($rows.ToArray());diagnostics=@($issues.ToArray())}|ConvertTo-Json -Depth 5 -Compress
    }catch{[void]$issues.Add(@{pid=${root.pid};stage=$stage;code='DESCENDANT_SCAN_FAILED'});@{known=$false;identities=@();diagnostics=@($issues.ToArray())}|ConvertTo-Json -Depth 5 -Compress}`) as { known: boolean; identities: ProcessIdentity[]; diagnostics: ScanDiagnostic[] };
    const selected = selectOwnedDescendants(root, result.identities.map(freezeIdentity));
    return { known: result.known && !selected.ambiguous, identities: selected.identities,
      diagnostics: [...result.diagnostics, ...(selected.ambiguous ? [{ pid: root.pid, stage: 'ancestry', code: 'DESCENDANT_ANCESTRY_AMBIGUOUS' }] : [])].map(d => Object.freeze({ ...d })) };
  } catch { return { known: false, identities: [], diagnostics: [Object.freeze({ pid: root.pid, stage: 'scan_transport', code: 'DESCENDANT_SCAN_FAILED' })] }; }
}
function delay(ms: number) { return new Promise<void>(resolveDelay => setTimeout(resolveDelay, ms)); }
function deferred<T>() { let resolvePromise!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolvePromise = r; reject = j; }); promise.catch(() => {});
  return { promise, resolve: resolvePromise, reject }; }
type Options = { workerPath: string; workerArgs?: string[]; cwd?: string; env?: NodeJS.ProcessEnv;
  onMessage?: (runId: string, message: WorkerToParentMessage) => void;
  onExit?: (runId: string, evidence: ExitEvidence) => void; onFault?: (runId: string, code: string) => void;
  /** Explicit trusted test-only hooks; never supplied by RunInput or worker IPC. */
  testIdentityProbe?: (pid: number) => Promise<IdentityProbe>; testIdentityTerminator?: (identity: ProcessIdentity) => Promise<TerminationEvidence> };

export class ProcessHost {
  private options: Options;
  private handles = new Map<string, WorkerHandle>();
  constructor(options: Options) {
    if (!isAbsolute(options.workerPath) || !existsSync(options.workerPath) || lstatSync(options.workerPath).isSymbolicLink()
      || realpathSync(options.workerPath).toLowerCase() !== resolve(options.workerPath).toLowerCase()) throw new Error('INVALID_WORKER_PATH');
    if (options.cwd && !isAbsolute(options.cwd)) throw new Error('INVALID_WORKER_CWD');
    this.options = { ...options, workerPath: resolve(options.workerPath), workerArgs: [...(options.workerArgs ?? [])] };
  }
  get(runId: string) { return this.handles.get(runId); }
  list(): readonly WorkerHandle[] { return Object.freeze([...this.handles.values()]); }
  start(raw: RunInput, snapshotPath: string, rawLimits: Limits): WorkerHandle {
    const input = RunInputSchema.parse(raw), limits = LimitsSchema.parse(rawLimits);
    if (this.handles.has(input.runId)) throw new Error('WORKER_ALREADY_REGISTERED');
    if (!isAbsolute(snapshotPath)) throw new Error('INVALID_SNAPSHOT_PATH');
    const opts = this.options, ready = deferred<void>(), closed = deferred<ExitEvidence>();
    const child = fork(opts.workerPath, [...(opts.workerArgs ?? []), '--supervisor-run-id', input.runId], { cwd: opts.cwd, env: opts.env ?? process.env, silent: true,
      windowsHide: true, execArgv: [] });
    // Child handle/PID registration is synchronous, before any ready callback or OS query.
    let identity: ProcessIdentity | null = null, stopped = false, readySeen = false, startSent = false, closeSeen = false, exitSeen = false,
      spawnError = false, code: number | null = null, signal: string | null = null, stdout = '', stderr = '', truncated = false, scanUnconfirmed = false;
    const descendants = new Map<string, ProcessIdentity>();
    const scanDiagnostics = new Map<string, ScanDiagnostic>();
    const fault = (reason: string) => { try { opts.onFault?.(input.runId, reason); } catch { /* observer cannot break cleanup */ } };
    const probe = opts.testIdentityProbe ?? queryWindowsIdentity, terminateIdentity = opts.testIdentityTerminator ?? terminateWindowsIdentity;
    const output = (name: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = (name === 'stdout' ? stdout : stderr) + chunk.toString('utf8');
      if (text.length > 16_384) truncated = true;
      if (name === 'stdout') stdout = text.slice(-16_384); else stderr = text.slice(-16_384);
    };
    child.stdout?.on('data', (chunk: Buffer) => output('stdout', chunk)); child.stderr?.on('data', (chunk: Buffer) => output('stderr', chunk));
    const evidence = (): ExitEvidence => Object.freeze({ runId: input.runId, pid: child.pid ?? null, exitCode: code, signal,
      exitObserved: exitSeen, closeObserved: closeSeen, spawnError, stdout, stderr, outputTruncated: truncated });
    const sendBound = (rawMessage: ParentToWorkerMessage, internalStart = false) => {
      const parsed = ParentToWorkerMessageSchema.safeParse(rawMessage);
      if (!parsed.success || parsed.data.runId !== input.runId || !child.connected || closeSeen) return false;
      if (parsed.data.kind === 'start') {
        if (!internalStart || startSent || !identity || exitSeen) return false;
        startSent = true;
      }
      try { child.send(parsed.data, error => { if (error && !stopped) fault('IPC_SEND_FAILED'); }); return true; } catch { return false; }
    };
    const send = (message: ParentToWorkerMessage) => sendBound(message);
    child.on('error', () => { spawnError = true; ready.reject(new Error('WORKER_SPAWN_ERROR')); fault('WORKER_SPAWN_ERROR'); });
    child.once('exit', (exitCode, exitSignal) => { exitSeen = true; code = exitCode; signal = exitSignal; });
    child.once('close', (exitCode, exitSignal) => {
      closeSeen = true; code = exitCode; signal = exitSignal;
      if (!readySeen) ready.reject(new Error('WORKER_CLOSED_BEFORE_READY'));
      const exit = evidence(); closed.resolve(exit); try { opts.onExit?.(input.runId, exit); } catch { fault('EXIT_OBSERVER_FAILED'); }
    });
    child.on('message', message => {
      if (stopped || closeSeen || exitSeen) return;
      let bytes: number; try { bytes = Buffer.byteLength(JSON.stringify(message)); } catch { fault('INVALID_WORKER_MESSAGE'); return; }
      if (bytes > 1_048_576) { fault('WORKER_MESSAGE_TOO_LARGE'); return; }
      const parsed = WorkerToParentMessageSchema.safeParse(message);
      if (!parsed.success || parsed.data.runId !== input.runId) { fault('INVALID_WORKER_MESSAGE'); return; }
      if (!identity || !startSent) { fault('WORKER_MESSAGE_BEFORE_BOUND_START'); return; }
      if (parsed.data.kind === 'ready') {
        if (readySeen) { fault('DUPLICATE_READY'); return; }
        readySeen = true; ready.resolve();
      } else if (!readySeen) { fault('WORKER_MESSAGE_BEFORE_READY'); return; }
      try { opts.onMessage?.(input.runId, parsed.data); } catch { fault('MESSAGE_OBSERVER_FAILED'); }
    });
    const identityPromise = (async () => {
      if (!child.pid) return null;
      const result = await probe(child.pid);
      if (exitSeen || closeSeen) return null; // Never adopt a reused PID after the original handle exited.
      if (result.status !== 'present') {
        if (!closeSeen) fault('WORKER_IDENTITY_UNCONFIRMED'); return null;
      }
      identity = freezeIdentity(result.identity);
      const marker = new RegExp('(?:^|\\s)--supervisor-run-id\\s+"?' + input.runId + '"?(?:\\s|$)');
      if (identity.pid !== child.pid || identity.parentPid !== process.pid || basename(identity.executablePath).toLowerCase() !== basename(process.execPath).toLowerCase()
        || !identity.commandLine.toLowerCase().includes(opts.workerPath.toLowerCase()) || !marker.test(identity.commandLine)) {
        fault('WORKER_IDENTITY_MISMATCH'); identity = null; return null;
      }
      if (!stopped && !closeSeen && !exitSeen) sendBound({ v: 1, kind: 'start', runId: input.runId, runInput: input, snapshotPath, limits }, true);
      return identity;
    })();
    let cleanupPromise: Promise<CleanupResult> | undefined;
    let scanTail: Promise<readonly ProcessIdentity[]> = Promise.resolve(Object.freeze([]));
    const scanDescendants = () => {
      const pending = scanTail.then(async () => {
      const root = await identityPromise;
      if (root && !closeSeen) {
        const result = await descendantsOf(root);
        for (const d of result.diagnostics) scanDiagnostics.set(`${d.pid}:${d.stage}:${d.code}:${d.cimCreationFileTime ?? ''}:${d.parentCreationFileTime ?? ''}:${d.nativeCreationFileTime ?? ''}`, d);
        if (!result.known) { scanUnconfirmed = true; fault('DESCENDANT_SCAN_UNCONFIRMED'); }
        for (const row of result.identities) descendants.set(`${row.pid}:${row.creationFileTime}`, row);
        const nativeConsole = resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/conhost.exe').toLowerCase();
        // Windows may create this exact OS console helper even when the worker never forks.
        // It remains registered/cleaned; an arbitrary same basename is never exempted.
        if (result.identities.some(row => resolve(row.executablePath).toLowerCase() !== nativeConsole)) fault('UNEXPECTED_DESCENDANT');
      }
      return Object.freeze([...descendants.values()]);
      });
      scanTail = pending;
      return pending;
    };
    // Cleanup queues its final scan behind every previously requested scan. Once
    // stopping, public inspections observe that barrier instead of starting later
    // OS queries whose uncertainty could arrive after a cleanup certificate.
    const inspectDescendants = () => stopped ? scanTail : scanDescendants();
    const verify = async (target: ProcessIdentity) => {
      const result = await probe(target.pid);
      if (result.status === 'present') return result.identity.creationFileTime === target.creationFileTime ? 'still_present' : 'identity_replaced';
      return result.status;
    };
    const handle: WorkerHandle = Object.freeze({ runId: input.runId, pid: child.pid, ready: ready.promise, identity: identityPromise,
      closed: closed.promise, send, inspectDescendants,
      terminate: (reason: string) => {
        if (cleanupPromise) return cleanupPromise;
        stopped = true; if (!readySeen) ready.reject(new Error('WORKER_STOPPED_BEFORE_READY'));
        cleanupPromise = (async () => {
          await identityPromise; await scanDescendants();
          if (!closeSeen) send({ v: 1, runId: input.runId, kind: 'cancel', reason: /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(reason) ? reason : 'PARENT_CANCELLED' });
          await Promise.race([closed.promise, delay(150)]);
          let termination: TerminationEvidence | null = null;
          if (!closeSeen && !exitSeen && identity) termination = await terminateIdentity(identity);
          if (!termination || termination.status !== 'identity_mismatch') await Promise.race([closed.promise, delay(5000)]);
          const childResults = [];
          for (const row of [...descendants.values()].reverse()) {
            const before = await verify(row);
            const action = before === 'still_present' ? await terminateIdentity(row) : null;
            childResults.push(Object.freeze({ identity: row, termination: action, verification: await verify(row) }));
          }
          if (exitSeen || termination?.terminated) await Promise.race([closed.promise, delay(5000)]);
          const rootVerification = identity ? await verify(identity) : child.pid ? (await probe(child.pid)).status : 'not_spawned';
          const gone = (value: string) => ['absent', 'identity_replaced', 'not_spawned'].includes(value);
          return Object.freeze({ runId: input.runId, confirmed: closeSeen && !scanUnconfirmed && gone(rootVerification) && childResults.every(row => gone(row.verification)),
            scope: 'registered_identities_only_no_job_object' as const, identity, rootVerification, termination, exit: evidence(), descendants: Object.freeze(childResults),
            scanDiagnostics: Object.freeze([...scanDiagnostics.values()]),
            unobservedDescendantsNotGuaranteed: true as const });
        })();
        return cleanupPromise;
      } });
    this.handles.set(input.runId, handle); return handle;
  }
}
