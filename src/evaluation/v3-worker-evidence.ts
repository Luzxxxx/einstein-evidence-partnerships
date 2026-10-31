/** New-scope worker evidence only. No store, recovery, model or import effect. */
import {constants,openSync,writeFileSync,appendFileSync,fsyncSync,closeSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {performance} from 'node:perf_hooks';
import {AnswerDiagnosticError,type AnswerDiagnostic} from '../runtime/answer-diagnostics.js';

export type V3EvidenceWriter={record(value:Record<string,unknown>):void;writeDiagnostic(value:AnswerDiagnostic):Promise<void>};
type Options={folder:string;credential:string;nativeLineBytes?:number;nativeTotalBytes?:number;diagnosticLineBytes?:number;diagnosticTotalBytes?:number};
const failed=()=>new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');
export async function createV3EvidenceWriter(options:Options):Promise<V3EvidenceWriter>{
  if(!isAbsolute(options.folder)||!options.credential)throw failed();
  const nativeLine=options.nativeLineBytes??262144,nativeCap=options.nativeTotalBytes??8*1024*1024,
    diagnosticLine=options.diagnosticLineBytes??300000,diagnosticCap=options.diagnosticTotalBytes??2*1024*1024;
  if(![nativeLine,nativeCap,diagnosticLine,diagnosticCap].every(v=>Number.isSafeInteger(v)&&v>0))throw failed();
  const evidence=join(options.folder,'worker-evidence.jsonl'),answers=join(options.folder,'answer-diagnostics.jsonl');
  let nativeTotal=0,diagnosticTotal=0,broken=false,tail=Promise.resolve();
  try{for(const file of [evidence,answers]){const handle=await open(file,'wx');try{await handle.sync();}finally{await handle.close();}}}catch{throw failed();}
  function serialize(value:object,limit:number){
    const text=JSON.stringify({at:new Date().toISOString(),monotonicMs:performance.now(),...value})+'\n';
    const decoded=text.replace(/\\u([0-9a-fA-F]{4})/g,(_all,hex:string)=>String.fromCharCode(parseInt(hex,16)));
    if(text.includes(options.credential)||decoded.includes(options.credential)||Buffer.byteLength(text)>limit)throw failed();
    return text;
  }
  return{
    record(value){
      try{if(broken)throw failed();const text=serialize(value,nativeLine),size=Buffer.byteLength(text);
        if(nativeTotal+size>nativeCap)throw failed();
        // No O_CREAT: a missing/renamed stream is lost evidence, never a new log.
        const fd=openSync(evidence,constants.O_WRONLY|constants.O_APPEND);
        try{appendFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}nativeTotal+=size;
      }catch{broken=true;throw failed();}
    },
    writeDiagnostic(value){
      const operation=tail.then(async()=>{
        try{if(broken)throw failed();const text=serialize(value,diagnosticLine),size=Buffer.byteLength(text);
          if(diagnosticTotal+size>diagnosticCap)throw failed();
          const handle=await open(answers,constants.O_WRONLY|constants.O_APPEND);
          try{await handle.appendFile(text);await handle.sync();}finally{await handle.close();}diagnosticTotal+=size;
        }catch{broken=true;throw failed();}
      });
      // Observe the chain while returning the actual rejection to Engine ACK.
      tail=operation.catch(()=>{broken=true;});return operation;
    }
  };
}
