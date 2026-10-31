// Read-only actual Windows identity audit. Never terminates PIDs or clears a safety hold.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),folder=resolve(root,'docs/implementation');
const names=(await readdir(folder)).filter(n=>/^task-6-runtime-worker-.*\.json$/.test(n)||n==='task-6-live-result.json').sort();
const known=new Map();
function collect(value,source){
  if(!value||typeof value!=='object')return;
  if(Number.isSafeInteger(value.pid)&&value.pid>0&&/^\d{17,20}$/.test(value.creationFileTime??'')&&win32.isAbsolute(value.executablePath??'')){
    const key=value.pid+':'+value.creationFileTime,item=known.get(key)??{pid:value.pid,creationFileTime:value.creationFileTime,sources:[]};
    if(!item.sources.includes(source))item.sources.push(source);known.set(key,item);
  }
  for(const child of Object.values(value))collect(child,source);
}
for(const name of names)collect(JSON.parse(await readFile(resolve(folder,name),'utf8')),name);
if(process.platform!=='win32'||!known.size)throw Error('ACTUAL_WINDOWS_IDENTITIES_REQUIRED');
const targets=[...known.values()].map(({pid,creationFileTime})=>({pid,creationFileTime}));
const paths=[resolve(root,'tests/fixtures/mozaik-worker.mjs'),resolve(root,'dist/server/runtime/worker-entry.js')].map(p=>p.replaceAll('\\','/').toLowerCase());
const script=`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';
$payload=[Console]::In.ReadToEnd()|ConvertFrom-Json;$all=@(Get-CimInstance Win32_Process);
$rows=@(foreach($target in $payload.targets){$row=$all|Where-Object ProcessId -eq $target.pid;
 if($null -eq $row){[pscustomobject]@{pid=$target.pid;creationFileTime=$target.creationFileTime;status='absent'}}
 else{try{$actual=[Diagnostics.Process]::GetProcessById([int]$target.pid).StartTime.ToUniversalTime().ToFileTimeUtc().ToString();
 [pscustomobject]@{pid=$target.pid;creationFileTime=$target.creationFileTime;actualFileTime=$actual;status=$(if($actual -eq $target.creationFileTime){'same_identity_present'}else{'identity_replaced'})}}
 catch [ArgumentException]{[pscustomobject]@{pid=$target.pid;creationFileTime=$target.creationFileTime;status='absent'}}
 catch{$birth=$null;if($null -ne $row.CreationDate){$birth=$row.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()};
 [pscustomobject]@{pid=$target.pid;creationFileTime=$target.creationFileTime;actualCimFileTime=$birth;status=$(if($birth -and [Math]::Abs([decimal]$birth-[decimal]$target.creationFileTime) -gt 10000000){'identity_replaced_cim_creation'}else{'unknown'})}}}
});
$live=@($all|Where-Object{$line=([string]$_.CommandLine).Replace('\\','/').ToLowerInvariant();$match=$false;foreach($path in $payload.paths){if($line.Contains([string]$path)){$match=$true}};$match}|ForEach-Object{[pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;commandLine=$_.CommandLine}});
@{rows=@($rows);liveProcesses=@($live);pathsUsed=@($payload.paths)}|ConvertTo-Json -Depth 8 -Compress`;
const output=resolve(folder,process.argv[2]??'task-6-process-final-audit.json');
if(dirname(output)!==folder||!/^task-6-process-[A-Za-z0-9_-]+\.json$/.test(win32.basename(output)))throw Error('NEW_AUDIT_FILENAME_REQUIRED');
const stdout=await new Promise((yes,no)=>{const p=execFile(resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
 ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
 {windowsHide:true,timeout:20000,maxBuffer:4*1024*1024,encoding:'utf8'},(error,text)=>error?no(error):yes(text));p.stdin.end(JSON.stringify({targets,paths}));});
const observed=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
if(JSON.stringify(observed.pathsUsed)!==JSON.stringify(paths))throw Error('AUDIT_INPUT_ENCODING_MISMATCH');
const failures=observed.rows.filter(row=>!['absent','identity_replaced','identity_replaced_cim_creation'].includes(row.status));
const result={scope:'Task6 archived actual registered identities and exact worker paths; no JobObject or unknown-orphan guarantee',auditedAt:new Date().toISOString(),
 evidenceFiles:names,registeredIdentityCount:known.size,known:[...known.values()],...observed,allRegisteredOriginalsGone:!failures.length,liveCount:observed.liveProcesses.length,
 cimFallback:'Read-only birth difference >1s; never used for termination or clearing a running safety hold'};
await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,registeredIdentityCount:known.size,allRegisteredOriginalsGone:result.allRegisteredOriginalsGone,liveCount:result.liveCount}));
if(failures.length||result.liveCount)process.exitCode=1;
