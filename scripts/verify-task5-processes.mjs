// Read-only Windows audit of archived offline_fixture identities; never terminates a PID.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = resolve(root, 'docs/implementation');
const names = (await readdir(folder)).filter(n => /^(task-5-(process-evidence(?:-.*)?|scheduler-evidence-.*|process-first-recovery))\.json$/.test(n)).sort();
const known = new Map();
const systemConhost = resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/conhost.exe').toLowerCase();
const normalized = s => s.replaceAll('\\', '/').toLowerCase();
const fixtureDir = normalized(resolve(root, 'tests/fixtures'));
function collect(value, source) {
  if (!value || typeof value !== 'object') return;
  if (Number.isSafeInteger(value.pid) && value.pid > 0 && /^\d{17,20}$/.test(value.creationFileTime ?? '')
    && typeof value.executablePath === 'string' && win32.isAbsolute(value.executablePath) && typeof value.commandLine === 'string') {
    const cmd = normalized(value.commandLine), exe = resolve(value.executablePath).toLowerCase();
    if ((cmd.includes(fixtureDir) && /offline-(worker|parent)\.mjs/.test(cmd)) || exe === systemConhost) {
      const key = value.pid + ':' + value.creationFileTime;
      const item = known.get(key) ?? { pid: value.pid, creationFileTime: value.creationFileTime, sources: [] };
      if (!item.sources.includes(source)) item.sources.push(source); known.set(key, item);
    }
  }
  for (const child of Object.values(value)) collect(child, source);
}
for (const name of names) collect(JSON.parse(await readFile(resolve(folder, name), 'utf8')), name);
if (!known.size || process.platform !== 'win32') throw Error('Expected archived actual Windows fixture identities.');
const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';
$payload=[Console]::In.ReadToEnd()|ConvertFrom-Json;$targets=@($payload.targets);$fixture=[string]$payload.fixture;
$all=@(Get-CimInstance Win32_Process);$rows=@(foreach($target in $targets){
 $row=$all|Where-Object ProcessId -eq $target.pid;
 if($null -eq $row){[pscustomobject]@{pid=$target.pid;creationFileTime=$target.creationFileTime;status='absent'}}
 else{try{$p=[Diagnostics.Process]::GetProcessById([int]$target.pid);$actual=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();
 [pscustomobject]@{pid=$target.pid;creationFileTime=$target.creationFileTime;actualFileTime=$actual;status=$(if($actual -eq $target.creationFileTime){'same_identity_present'}else{'identity_replaced'})}}
 catch [ArgumentException]{[pscustomobject]@{pid=$target.pid;creationFileTime=$target.creationFileTime;status='absent'}}
 catch{$cimBirth=$null;if($null -ne $row.CreationDate){$cimBirth=$row.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()};
  if($null -ne $cimBirth -and [Math]::Abs([decimal]$cimBirth-[decimal]$target.creationFileTime) -gt 10000000){
   [pscustomobject]@{pid=$target.pid;creationFileTime=$target.creationFileTime;actualCimFileTime=$cimBirth;status='identity_replaced_cim_creation'}}
  else{[pscustomobject]@{pid=$target.pid;creationFileTime=$target.creationFileTime;status='unknown'}}}}
});
$live=@($all|Where-Object { $line=([string]$_.CommandLine).Replace('\\','/').ToLowerInvariant(); $line.Contains($fixture) -and ($line.Contains('offline-worker.mjs') -or $line.Contains('offline-parent.mjs')) }|ForEach-Object{[pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;commandLine=$_.CommandLine}});
@{rows=@($rows);liveFixtureNodes=@($live);fixturePathUsedByAudit=$fixture}|ConvertTo-Json -Depth 8 -Compress`;
const ps = resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const stdout = await new Promise((yes, no) => {
  const child = execFile(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, output) => error ? no(error) : yes(output));
  child.stdin.end(JSON.stringify({ fixture: fixtureDir, targets: [...known.values()].map(({pid, creationFileTime}) => ({pid, creationFileTime})) }));
});
const observed = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
if (observed.fixturePathUsedByAudit !== fixtureDir) throw Error('OS audit input encoding mismatch; refusing a zero-process claim.');
const failures = observed.rows.filter(r => !['absent', 'identity_replaced', 'identity_replaced_cim_creation'].includes(r.status));
const result = { runnerMode: 'offline_fixture', auditedAt: new Date().toISOString(), scope: 'archived actual fixture identities and exact project fixture path; no JobObject or unknown-orphan guarantee',
  cimFallback: 'Read-only CreationDate differs by over one second from the archived native birth; never used to terminate or clear a running Scheduler hold.',
  evidenceFiles: names, registeredIdentityCount: known.size, known: [...known.values()], ...observed,
  allRegisteredOriginalsGone: !failures.length, liveFixtureCount: observed.liveFixtureNodes.length };
const output = resolve(folder, process.argv[2] ?? 'task-5-process-final-audit.json');
if (dirname(output) !== folder || !/^task-5-process-[A-Za-z0-9_-]+\.json$/.test(win32.basename(output))) throw Error('Use one new task-5-process-*.json filename in docs/implementation.');
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, registeredIdentityCount: known.size, allRegisteredOriginalsGone: result.allRegisteredOriginalsGone, liveFixtureCount: result.liveFixtureCount }));
if (failures.length || result.liveFixtureCount) process.exitCode = 1;
