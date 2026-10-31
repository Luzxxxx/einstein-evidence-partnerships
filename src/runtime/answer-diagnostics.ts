/** Trusted final-answer diagnostics only. Never consumes a provider envelope,
 * headers, prompts, ReasoningItem or arbitrary exception text. */
import {sha256Bytes} from '../evidence/hashing.js';
import {UuidSchema} from '../contracts/primitives.js';
import type {TaskIdentity} from '../model/gateway-runner.js';

export type AnswerDiagnosticStage='native_identity'|'answer_capture'|'json_parse'|'schema_validation'|'evidence_write'|'native_observer';
export type AnswerDiagnosticCode='ANSWER_CAPTURED'|'ANSWER_CAPTURE_INVALID'|'ANSWER_CAPTURE_LIMIT'
 |'ANSWER_CAPTURE_CREDENTIAL_REFLECTION'|'ANSWER_CAPTURE_REASONING_OMITTED'|'ANSWER_JSON_PARSED'|'ANSWER_JSON_PARSE_FAILED'
 |'ANSWER_SCHEMA_VALIDATED'|'ANSWER_SCHEMA_INVALID'|'ANSWER_EVIDENCE_WRITE_FAILED'
 |'NATIVE_PRODUCER_MISMATCH'|'NATIVE_CONTEXT_MISMATCH'|'NATIVE_LOOP_MISMATCH'|'NATIVE_ANSWER_UNPROVEN'|'NATIVE_OBSERVER_FAILED';
export type AnswerCapture=Readonly<{sha256:string|null;byteLength:number|null;savedByteLength:number;savedSha256:string|null;
 text:string|null;truncated:boolean;omissionReason:'none'|'not_string'|'credential_reflection'|'byte_limit'|'reasoning_content'|'identity_unconfirmed'}>;
export type AnswerRequest=Readonly<{requestId:string;permitId:string}>;
export type AnswerDiagnostic=Readonly<{kind:'answer.diagnostic';stage:AnswerDiagnosticStage;status:'captured'|'passed'|'failed';
 code:AnswerDiagnosticCode;actor:TaskIdentity|null;request:AnswerRequest|null;capture?:AnswerCapture}>;
export type AnswerDiagnosticsOptions={credential:string;maxCaptureBytes?:number;
 write:(diagnostic:AnswerDiagnostic)=>void|Promise<void>;
 validate?:(role:TaskIdentity['role'],parsed:unknown,actor:TaskIdentity)=>unknown};
const allowedCodes=new Set<AnswerDiagnosticCode>(['ANSWER_CAPTURED','ANSWER_CAPTURE_INVALID','ANSWER_CAPTURE_LIMIT',
 'ANSWER_CAPTURE_CREDENTIAL_REFLECTION','ANSWER_CAPTURE_REASONING_OMITTED','ANSWER_JSON_PARSED','ANSWER_JSON_PARSE_FAILED',
 'ANSWER_SCHEMA_VALIDATED','ANSWER_SCHEMA_INVALID','ANSWER_EVIDENCE_WRITE_FAILED','NATIVE_PRODUCER_MISMATCH','NATIVE_CONTEXT_MISMATCH',
 'NATIVE_LOOP_MISMATCH','NATIVE_ANSWER_UNPROVEN','NATIVE_OBSERVER_FAILED']);
export const ANSWER_DIAGNOSTIC_STAGES=Object.freeze(['native_identity','answer_capture','json_parse','schema_validation','evidence_write','native_observer'] as const);
export const ANSWER_DIAGNOSTIC_STAGE_CODES=Object.freeze({
 native_identity:Object.freeze(['NATIVE_PRODUCER_MISMATCH','NATIVE_CONTEXT_MISMATCH','NATIVE_LOOP_MISMATCH','NATIVE_ANSWER_UNPROVEN'] as const),
 answer_capture:Object.freeze(['ANSWER_CAPTURED','ANSWER_CAPTURE_INVALID','ANSWER_CAPTURE_LIMIT','ANSWER_CAPTURE_CREDENTIAL_REFLECTION','ANSWER_CAPTURE_REASONING_OMITTED'] as const),
 json_parse:Object.freeze(['ANSWER_JSON_PARSED','ANSWER_JSON_PARSE_FAILED'] as const),schema_validation:Object.freeze(['ANSWER_SCHEMA_VALIDATED','ANSWER_SCHEMA_INVALID'] as const),
 evidence_write:Object.freeze(['ANSWER_EVIDENCE_WRITE_FAILED'] as const),native_observer:Object.freeze(['NATIVE_OBSERVER_FAILED'] as const),
});
const stages=new Set<AnswerDiagnosticStage>(ANSWER_DIAGNOSTIC_STAGES);
const trustedErrors=new WeakSet<object>();
export class AnswerDiagnosticError extends Error {
 readonly code:AnswerDiagnosticCode;readonly stage:AnswerDiagnosticStage;
 constructor(stage:AnswerDiagnosticStage,code:AnswerDiagnosticCode){
  if(!stages.has(stage)||!allowedCodes.has(code)||!(ANSWER_DIAGNOSTIC_STAGE_CODES[stage] as readonly string[]).includes(code))throw Error('ANSWER_DIAGNOSTICS_CONFIG_INVALID');
  super(code);this.name='AnswerDiagnosticError';this.stage=stage;this.code=code;trustedErrors.add(this);
 }
}
export function isAnswerDiagnosticError(error:unknown):error is AnswerDiagnosticError{
 return Boolean(error&&typeof error==='object'&&trustedErrors.has(error));
}
export function validateAnswerDiagnosticsOptions(value:AnswerDiagnosticsOptions):Readonly<AnswerDiagnosticsOptions>{
 if(!value||typeof value.credential!=='string'||value.credential.length===0||typeof value.write!=='function'
  ||(value.validate!==undefined&&typeof value.validate!=='function')
  ||(value.maxCaptureBytes!==undefined&&(!Number.isSafeInteger(value.maxCaptureBytes)||value.maxCaptureBytes<1||value.maxCaptureBytes>262144)))
  throw Error('ANSWER_DIAGNOSTICS_CONFIG_INVALID');
 return Object.freeze({...value,maxCaptureBytes:value.maxCaptureBytes??262144});
}
export function answerRequest(value:unknown):AnswerRequest|null{
 if(value===null||typeof value!=='object'||Array.isArray(value))return null;
 const row=value as Record<string,unknown>;
 if(!UuidSchema.safeParse(row.requestId).success||!UuidSchema.safeParse(row.permitId).success)return null;
 return Object.freeze({requestId:row.requestId as string,permitId:row.permitId as string});
}
const hash=(text:string)=>sha256Bytes(Buffer.from(text,'utf8'));
function reflectedCredential(text:string,credential:string):boolean{
 const matches=(s:string)=>s.includes(credential)||/sk-[A-Za-z0-9]{20,}/.test(s);
 if(matches(text))return true;
 // Guard representations, not business JSON validation: escaped credentials
 // must be rejected even when another part of the final text is malformed.
 const decoded=text.replace(/\\u([0-9a-fA-F]{4})/g,(_whole,hex:string)=>String.fromCharCode(Number.parseInt(hex,16)));
 if(matches(decoded))return true;
 try{
  const queue:unknown[]=[JSON.parse(text)];
  while(queue.length){const value=queue.pop();if(typeof value==='string'){
    if(matches(value)||matches(value.replace(/\\u([0-9a-fA-F]{4})/g,(_whole,hex:string)=>String.fromCharCode(Number.parseInt(hex,16)))))return true;
   }else if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){
    if(matches(key))return true;queue.push(child);
   }}
 }catch{/* Parsing is repeated and separately diagnosed in the JSON stage. */}
 return false;
}
function capture(text:unknown,credential:string,limit:number):{capture:AnswerCapture;failure?:AnswerDiagnosticCode}{
 const empty={sha256:null,byteLength:null,savedByteLength:0,savedSha256:null,text:null,truncated:false};
 if(typeof text!=='string')return{capture:Object.freeze({...empty,omissionReason:'not_string'}),failure:'ANSWER_CAPTURE_INVALID'};
 const bytes=Buffer.from(text,'utf8'),base={...empty,sha256:hash(text),byteLength:bytes.length};
 // Inspect the COMPLETE original before truncation: a secret crossing the cap
 // must not leak through a seemingly harmless saved prefix.
 if(reflectedCredential(text,credential))
  return{capture:Object.freeze({...base,omissionReason:'credential_reflection'}),failure:'ANSWER_CAPTURE_CREDENTIAL_REFLECTION'};
 // ModelMessageItem is final text, not ReasoningItem. Explicit reasoning tags or
 // fields still cause omission rather than recording them as malformed JSON.
 if(/<\/?(?:think|thinking|analysis|reasoning)(?:\s[^>]*)?>/i.test(text)||/"(?:reasoning|reasoning_content|analysis)"\s*:/i.test(text))
  return{capture:Object.freeze({...base,omissionReason:'reasoning_content'}),failure:'ANSWER_CAPTURE_REASONING_OMITTED'};
 if(bytes.length>limit){let saved:Buffer=bytes.subarray(0,limit),prefix='';
  for(let n=0;n<=3;n++){try{prefix=new TextDecoder('utf-8',{fatal:true}).decode(saved);break;}catch{saved=saved.subarray(0,Math.max(0,saved.length-1));}}
  return{capture:Object.freeze({...base,text:prefix,savedByteLength:Buffer.byteLength(prefix),savedSha256:hash(prefix),truncated:true,omissionReason:'byte_limit'}),failure:'ANSWER_CAPTURE_LIMIT'};
 }
 return{capture:Object.freeze({...base,text,savedByteLength:bytes.length,savedSha256:hash(text),omissionReason:'none'})};
}
// Same pure projection for trusted pre-native contract diagnostics. It never
// reads provider envelopes, headers, ReasoningItem, environment or disk.
export {capture as captureAnswerText};
/** An outstanding sink never owns cancellation. A late acknowledgement has no
 * success authority; errors become a single controlled write failure. */
export async function writeAnswerDiagnostic(options:Readonly<AnswerDiagnosticsOptions>,diagnostic:AnswerDiagnostic,signal:AbortSignal):Promise<void>{
 if(signal.aborted)throw Error('RUN_ABORTED');
 let pending:Promise<void>;
 try{pending=Promise.resolve(options.write(diagnostic));}catch{throw new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED');}
 await new Promise<void>((resolve,reject)=>{
  const abort=()=>reject(Error('RUN_ABORTED'));
  signal.addEventListener('abort',abort,{once:true});
  pending.then(()=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(Error('RUN_ABORTED'));else resolve();},()=>{
   signal.removeEventListener('abort',abort);reject(new AnswerDiagnosticError('evidence_write','ANSWER_EVIDENCE_WRITE_FAILED'));
  });
  if(signal.aborted){signal.removeEventListener('abort',abort);reject(Error('RUN_ABORTED'));}
 });
}
export function identityAnswerDiagnostic(code:AnswerDiagnosticCode,actor:TaskIdentity|null,request:AnswerRequest|null):AnswerDiagnostic{
 return Object.freeze({kind:'answer.diagnostic',stage:'native_identity',status:'failed',code,
  actor:actor?Object.freeze({...actor}):null,request});
}
export async function validateDiagnosedAnswer(input:{text:unknown;actor:TaskIdentity;request:AnswerRequest|null;
 options:Readonly<AnswerDiagnosticsOptions>;signal:AbortSignal;beforeParse?:()=>void;parse?:(parsed:unknown)=>unknown}):Promise<unknown>{
 const {options,actor,request,signal}=input,base={kind:'answer.diagnostic' as const,actor:Object.freeze({...actor}),request};
 const saved=capture(input.text,options.credential,options.maxCaptureBytes??262144);
 await writeAnswerDiagnostic(options,Object.freeze({...base,stage:'answer_capture',status:saved.failure?'failed':'captured',code:saved.failure??'ANSWER_CAPTURED',capture:saved.capture}),signal);
 if(saved.failure)throw new AnswerDiagnosticError('answer_capture',saved.failure);
 let parsed:unknown;
 try{parsed=JSON.parse(input.text as string);}catch{
  await writeAnswerDiagnostic(options,Object.freeze({...base,stage:'json_parse',status:'failed',code:'ANSWER_JSON_PARSE_FAILED'}),signal);
  throw new AnswerDiagnosticError('json_parse','ANSWER_JSON_PARSE_FAILED');
 }
 await writeAnswerDiagnostic(options,Object.freeze({...base,stage:'json_parse',status:'passed',code:'ANSWER_JSON_PARSED'}),signal);
 async function schemaFailure():Promise<never>{
  await writeAnswerDiagnostic(options,Object.freeze({...base,stage:'schema_validation',status:'failed',code:'ANSWER_SCHEMA_INVALID'}),signal);
  throw new AnswerDiagnosticError('schema_validation','ANSWER_SCHEMA_INVALID');
 }
 let value:unknown,validated:unknown;
 try{validated=options.validate?options.validate(actor.role,parsed,actor):parsed;}
 catch(error){if(isAnswerDiagnosticError(error))throw error;return schemaFailure();}
 try{
  // Native answer occurrence precedes application artifact/task side effects.
  // The optional diagnostic schema has passed; original business parsing and
  // source checks still run, and only their success may complete this task.
  input.beforeParse?.();
 }catch(error){
  if(isAnswerDiagnosticError(error))throw error;
  if(signal.aborted)throw Error('RUN_ABORTED');
  await writeAnswerDiagnostic(options,Object.freeze({...base,stage:'native_observer',status:'failed',code:'NATIVE_OBSERVER_FAILED'}),signal);
  throw new AnswerDiagnosticError('native_observer','NATIVE_OBSERVER_FAILED');
 }
 try{value=input.parse?input.parse(validated):validated;}catch(error){
  if(isAnswerDiagnosticError(error))throw error;
  return schemaFailure();
 }
 await writeAnswerDiagnostic(options,Object.freeze({...base,stage:'schema_validation',status:'passed',code:'ANSWER_SCHEMA_VALIDATED'}),signal);
 return value;
}
