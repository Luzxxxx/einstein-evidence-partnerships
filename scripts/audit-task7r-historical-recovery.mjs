// Read-only OS/file evidence. No RunStore.open, writer lock, termination,
// permit mutation, recovery executor or model/API request exists in this script.
import { readFile,writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolve,dirname,basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from '../dist/server/evidence/hashing.js';

function time(value){return typeof value==='string'&&/^\d{17,20}$/.test(value)&&BigInt(value)>0n?BigInt(value):null;}
export function assessHistoricalScanIssue(issue,current){
  const parent=time(issue.parentCreationFileTime),native=time(current.nativeCreationFileTime),cim=time(current.cimCreationFileTime);
  const nativeKnown=['present','exited'].includes(current.nativeStatus)&&native!==null;
  const cimKnown=current.cimStatus==='present'&&cim!==null;
  const mismatch=nativeKnown&&cimKnown&&(native>cim?native-cim:cim-native)>=10n;
  let currentAssociation='unknown';
  if(parent!==null&&!mismatch){
    if(nativeKnown&&cimKnown&&native+9n<parent&&cim+9n<parent)currentAssociation='excluded_by_consistent_birth';
    else if(nativeKnown&&native+9n<parent&&!cimKnown)currentAssociation='excluded_by_native_birth_current_only';
    else if(!nativeKnown&&cimKnown&&cim+9n<parent)currentAssociation='excluded_by_cim_birth_current_only';
  }
  return {pid:issue.pid,originalCode:issue.code,originalStage:issue.stage,historicalCleanupState:'unconfirmed',
    recordedAtScanCreationFileTime:issue.recordedAtScanCreationFileTime??null,
    originalIdentityMissing:!issue.recordedAtScanCreationFileTime,currentAssociation,nativeIdentityUnknown:!nativeKnown,
    birthConflict:mismatch,automaticRecoveryAllowed:false,
    interpretation:'Current evidence does not rewrite the failed historical native query or establish a historical confirmed cleanup.'};
}

async function verifyHistorical(baseline){
  for(const item of [...baseline.historicalLive,...baseline.historicalStore.files])
    if(sha256Bytes(await readFile(item.file))!==item.sha256)throw Error('HISTORICAL_RECORD_CHANGED');
}
export async function auditHistoricalRecovery(outputName='task-7r-recovery-evidence.json'){
  if(process.platform!=='win32')throw Error('WINDOWS_READ_ONLY_AUDIT_REQUIRED');
  const folder=resolve('docs/implementation'),output=resolve(folder,outputName);
  if(dirname(output)!==folder||!/^task-7r-recovery-[A-Za-z0-9_-]+\.json$/.test(basename(output)))throw Error('APPEND_ONLY_EVIDENCE_FILENAME_REQUIRED');
  const baseline=JSON.parse(await readFile('docs/implementation/task-7r-baseline.json','utf8'));await verifyHistorical(baseline);
  const summary=JSON.parse(await readFile('docs/implementation/task-7-live/summary.json','utf8'));
  const unresolved=[];const targets=new Map();
  for(const row of summary.rows.filter(r=>r.status!=='unexecuted')){
    const resultPath=`docs/implementation/task-7-live/runs/${row.runId}/result.json`;
    const result=JSON.parse(await readFile(resultPath,'utf8'));
    for(const cleanup of result.cleanups){if(cleanup.confirmed)continue;
      const identities=[cleanup.identity,...cleanup.descendants.map(d=>d.identity)].filter(Boolean);
      for(const identity of identities)targets.set(identity.pid,{pid:identity.pid,expectedCreationFileTime:identity.creationFileTime,kind:'registered_identity'});
      for(const diagnostic of cleanup.scanDiagnostics){
        if(!Number.isSafeInteger(diagnostic.pid)||diagnostic.pid<1)throw Error('INVALID_ARCHIVED_PID');
        targets.set(diagnostic.pid,{pid:diagnostic.pid,expectedCreationFileTime:null,kind:'unconfirmed_scan_entry'});
        unresolved.push({runId:row.runId,resultPath,resultSha256:sha256Bytes(await readFile(resultPath)),
          terminalPath:resolve(summary.storeRoot,row.runId,'terminal.json'),terminalSha256:sha256Bytes(await readFile(resolve(summary.storeRoot,row.runId,'terminal.json'))),
          diagnostic,rootIdentity:cleanup.identity,knownDescendants:cleanup.descendants,originalCleanupState:result.record.cleanupState,
          originalExit:cleanup.exit,heldReservations:result.permitSnapshot.runs.find(r=>r.runId===row.runId)?.inFlight??null,
          unmatchedPermits:result.events.filter(e=>e.type==='permit.granted').filter(g=>!result.events.some(e=>e.type==='permit.released'&&e.payload.permitId===g.payload.permitId))
            .map(g=>({requestId:g.payload.requestId,permitId:g.payload.permitId})),
          requestIntervals:result.requests.intervals.map(i=>({requestId:i.requestId,permitId:i.permitId,completion:i.completion,code:i.code,endedAt:i.endedAt})),
        });
      }
    }
  }
  const script=`[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class Task7rReadOnlyProcessHandle {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$payload=[Console]::In.ReadToEnd()|ConvertFrom-Json;$rows=@(foreach($target in $payload){
 $id=[int]$target.pid;$nativeStatus='unknown';$nativeBirth=$null;$nativeError=$null;$exitCode=$null;
 $h=[Task7rReadOnlyProcessHandle]::OpenProcess(0x1000,$false,$id);
 if($h -eq [IntPtr]::Zero){$nativeError=[Runtime.InteropServices.Marshal]::GetLastWin32Error();if($nativeError -eq 87){$nativeStatus='absent'}}
 else{try{[long]$created=0;[long]$exited=0;[long]$kernel=0;[long]$user=0;
  if([Task7rReadOnlyProcessHandle]::GetProcessTimes($h,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user)){
   $nativeBirth=$created.ToString();$nativeStatus='present';[uint32]$code=0;if([Task7rReadOnlyProcessHandle]::GetExitCodeProcess($h,[ref]$code)){$exitCode=$code;if($code -ne 259){$nativeStatus='exited'}}
  }else{$nativeError=[Runtime.InteropServices.Marshal]::GetLastWin32Error()}
 }finally{[void][Task7rReadOnlyProcessHandle]::CloseHandle($h)}}
 $cimStatus='unknown';$cimBirth=$null;$parent=$null;$name=$null;
 try{$row=Get-CimInstance Win32_Process -Filter "ProcessId = $id";if($null -eq $row){$cimStatus='absent'}else{
   $cimStatus='present';$parent=[int]$row.ParentProcessId;$name=[string]$row.Name;if($null -ne $row.CreationDate){$cimBirth=$row.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}
 }}catch{$cimStatus='unknown'}
 [pscustomobject]@{pid=$id;nativeStatus=$nativeStatus;nativeCreationFileTime=$nativeBirth;nativeErrorCode=$nativeError;nativeExitCode=$exitCode;
  cimStatus=$cimStatus;cimCreationFileTime=$cimBirth;parentPid=$parent;name=$name;accessMask='PROCESS_QUERY_LIMITED_INFORMATION_ONLY'}
});@{observations=$rows;readOnly=$true}|ConvertTo-Json -Depth 6 -Compress`;
  const stdout=await new Promise((yes,no)=>{const child=execFile(resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {windowsHide:true,timeout:20000,maxBuffer:1024*1024,encoding:'utf8'},(error,text)=>error?no(Error('READ_ONLY_NATIVE_AUDIT_FAILED')):yes(text));
    child.stdin.end(JSON.stringify([...targets.values()]));});
  const observed=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
  const assessments=unresolved.map(item=>{const current=observed.observations.find(o=>o.pid===item.diagnostic.pid)??{nativeStatus:'unknown',cimStatus:'unknown'};
    return {...item,currentObservation:current,assessment:assessHistoricalScanIssue({...item.diagnostic,
      parentCreationFileTime:item.rootIdentity.creationFileTime},current),
      comparisonBasis:'recorded native root birth is a lower bound for every valid descendant; original failing entry immediate parent/birth were not saved'};});
  await verifyHistorical(baseline);
  const result={scope:'append_only_read_only_historical_recovery_evidence_not_recovery_authorization',observedAt:new Date().toISOString(),baseline:baseline.head,
    historicalFilesUnchanged:baseline.historicalLive.length+baseline.historicalStore.files.length,storeRoot:summary.storeRoot,
    observations:observed.observations,assessments,originalHoldPreserved:true,originalPermitSnapshotPreserved:true,
    recoveryExecuted:false,processesTerminated:0,storesCreated:0,modelRequests:0,limitations:[
      'Current native handles/CIM establish current birth relationships only; no missing historical metadata is invented.',
      'No JobObject or unknown-orphan completeness guarantee is added.',
      'Any future recovery must be separately reviewed, bound to original hashes and recorded append-only in the same store.',
    ]};
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output,issues:assessments.length,observations:observed.observations.map(o=>({pid:o.pid,native:o.nativeStatus,cim:o.cimStatus})),
    classifications:assessments.map(a=>a.assessment.currentAssociation),historicalFilesUnchanged:result.historicalFilesUnchanged,recoveryExecuted:false,modelRequests:0}));
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await auditHistoricalRecovery(process.argv[2]);
