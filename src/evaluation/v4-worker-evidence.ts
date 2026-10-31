/** New V4 evidence only. Importing does not open a Store, start a worker or
 * perform I/O. Own serialized REQUESTS are allowed; headers/provider envelopes
 * and reasoning are never supplied by the V4 projection. */
import {constants,openSync,appendFileSync,fsyncSync,closeSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {performance} from 'node:perf_hooks';
import {AnswerDiagnosticError,type AnswerDiagnostic} from '../runtime/answer-diagnostics.js';

export const V4_EVIDENCE_LIMITS=Object.freeze({rowBytes:262144,totalBytes:4*1024*1024});
export type V4EvidenceWriter={record(value:Record<string,unknown>):void;writeDiagnostic(value:AnswerDiagnostic):Promise<void>};
const failed=()=>new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');
export type V4EvidenceRejectionReason='V4_REQUEST_CREDENTIAL_REFLECTION'|'V4_REQUEST_EXPLICIT_REASONING'|'V4_EVIDENCE_ROW_LIMIT';
export class V4EvidenceRejection extends AnswerDiagnosticError{
 constructor(readonly reason:V4EvidenceRejectionReason){super('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');}
}
export function inspectV4EvidenceText(text:string,credential?:string):V4EvidenceRejectionReason|null{
 const queue:unknown[]=[text];let nodes=0;
 while(queue.length){
  if(++nodes>100000)throw failed();const value=queue.pop();
  if(typeof value==='string'){
   let current=value;
   for(let i=0;i<4;i++){
    if((credential&&current.includes(credential))||/sk-[A-Za-z0-9]{20,}/.test(current))return'V4_REQUEST_CREDENTIAL_REFLECTION';
    if(/<\/?(?:think|thinking|analysis|reasoning)(?:\s[^>]*)?>/i.test(current)||/"(?:reasoning|reasoning_content|analysis)"\s*:/i.test(current))return'V4_REQUEST_EXPLICIT_REASONING';
    let decoded=current.replace(/\\u([0-9a-fA-F]{4})/g,(_all,hex:string)=>String.fromCharCode(Number.parseInt(hex,16)));
    // Decode valid percent runs independently: an unrelated plain "50%" must
    // not hide a credential encoded elsewhere in the same source string.
    decoded=decoded.replace(/(?:%[0-9a-fA-F]{2})+/g,run=>{try{return decodeURIComponent(run);}catch{return run.replace(/%([0-9a-fA-F]{2})/g,(_all,hex:string)=>String.fromCharCode(Number.parseInt(hex,16)));}});
    if(decoded===current)break;current=decoded;
   }
   if((credential&&current.includes(credential))||/sk-[A-Za-z0-9]{20,}/.test(current))return'V4_REQUEST_CREDENTIAL_REFLECTION';
   if(/<\/?(?:think|thinking|analysis|reasoning)(?:\s[^>]*)?>/i.test(current)||/"(?:reasoning|reasoning_content|analysis)"\s*:/i.test(current))return'V4_REQUEST_EXPLICIT_REASONING';
   try{const parsed:unknown=JSON.parse(value);if(parsed!==value)queue.push(parsed);}catch{/* Only structured descendants need another scan. */}
  }else if(value&&typeof value==='object')for(const[k,v]of Object.entries(value)){queue.push(k,v);}
 }
 return null;
}
/** Shared pure safety/byte check. No truncation, raw exception or unsafe prefix
 * is written. Gate independently recomputes request body hashes and lengths. */
export function serializeV4EvidenceRecord(value:Record<string,unknown>,credential:string):string{
 try{
  if(!credential)throw failed();const text=JSON.stringify(value)+'\n';
  if(Buffer.byteLength(text)>V4_EVIDENCE_LIMITS.rowBytes)throw new V4EvidenceRejection('V4_EVIDENCE_ROW_LIMIT');
  const reason=inspectV4EvidenceText(text,credential);if(reason)throw new V4EvidenceRejection(reason);return text;
 }catch(error){if(error instanceof V4EvidenceRejection)throw error;throw failed();}
}
export async function createV4EvidenceWriter(options:{folder:string;credential:string}):Promise<V4EvidenceWriter>{
 if(!isAbsolute(options.folder)||!options.credential)throw failed();
 const native=join(options.folder,'worker-evidence.jsonl'),diagnostics=join(options.folder,'answer-diagnostics.jsonl');
 let used=0,broken=false,tail=Promise.resolve();
 try{for(const file of[native,diagnostics]){const handle=await open(file,'wx');try{await handle.sync();}finally{await handle.close();}}}catch{throw failed();}
 function row(value:Record<string,unknown>){
  if(broken)throw failed();const text=serializeV4EvidenceRecord({at:new Date().toISOString(),monotonicMs:performance.now(),...value},options.credential),size=Buffer.byteLength(text);
  if(used+size>V4_EVIDENCE_LIMITS.totalBytes)throw failed();used+=size;return text;
 }
 return{
  record(value){try{const text=row(value),fd=openSync(native,constants.O_WRONLY|constants.O_APPEND);
   try{appendFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
  }catch{broken=true;throw failed();}},
  writeDiagnostic(value){const operation=tail.then(async()=>{try{
   const text=row(value as unknown as Record<string,unknown>),handle=await open(diagnostics,constants.O_WRONLY|constants.O_APPEND);
   try{await handle.appendFile(text);await handle.sync();}finally{await handle.close();}
  }catch{broken=true;throw failed();}});tail=operation.catch(()=>{broken=true;});return operation;}
 };
}
