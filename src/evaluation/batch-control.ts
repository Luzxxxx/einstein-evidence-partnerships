import { deepFreeze } from '../data/records.js';

type Observation = Record<string, unknown> & { runId: string; status: string; reasonCodes?: readonly string[] };
function object(value: unknown): value is Record<string, unknown> { return value!==null&&typeof value==='object'&&!Array.isArray(value); }
function safeCode(value: unknown): value is string { return typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(value); }
/** Read only stable codes; provider/body/exception text cannot become a stop reason. */
export function batchStopReason(row: unknown): string | null {
  if(!object(row))return 'BATCH_RESULT_INVALID';
  if(row.safetyHold===true)return 'BATCH_SAFETY_HOLD';
  const codes: string[]=[];
  if(Array.isArray(row.reasonCodes))codes.push(...row.reasonCodes.filter(safeCode));
  if(safeCode(row.errorCode))codes.push(row.errorCode);
  if(object(row.requests)&&Array.isArray(row.requests.intervals))for(const value of row.requests.intervals)
    if(object(value)&&safeCode(value.code))codes.push(value.code);
  if(Array.isArray(row.events))for(const value of row.events)
    if(object(value)&&object(value.payload)&&safeCode(value.payload.code))codes.push(value.payload.code);
  const critical=codes.find(code=>code.startsWith('GATEWAY_')||code.startsWith('TOOL_BATCH_')||code.includes('CONTEXT')||code.includes('IDENTITY')
    ||code.includes('PRODUCER')||code.startsWith('RECEIPT_')||['INVALID_RUNTIME_RECEIPT','INVALID_NATIVE_INFERENCE_OUTPUT','REVIEW_DISPATCH_REJECTED'].includes(code));
  if(critical)return `BATCH_CRITICAL_${critical}`;
  if(['failed','cancelled','technical_failure'].includes(String(row.status)))return 'BATCH_TECHNICAL_FAILURE';
  return null;
}

/** Sequential execution of the frozen plan. No replacement IDs, retries or
 * speculative callback for a future Run. Technical failures conservatively stop;
 * a valid semantic insufficient is an observation, not a transport failure. */
export async function runFailStopBatch<T extends {runId:string}>(planned: readonly T[],execute:(item:T)=>Promise<Observation>) {
  const ids=new Set<string>();for(const item of planned){if(!item||typeof item.runId!=='string'||!item.runId)throw Error('BATCH_PLAN_INVALID');
    if(ids.has(item.runId))throw Error('BATCH_PLAN_DUPLICATE_RUN');ids.add(item.runId);}
  const rows: Observation[]=[];let stopReason:string|null=null;
  for(const item of planned){
    if(stopReason){rows.push({...structuredClone(item),status:'unexecuted',reasonCodes:[stopReason]});continue;}
    let row:Observation;
    try{
      const result=await execute(item);
      if(!object(result)||result.runId!==item.runId)row={...structuredClone(item),status:'failed',reasonCodes:['BATCH_RESULT_RUN_IDENTITY_MISMATCH']};
      else if(!['approved','insufficient','failed','cancelled','technical_failure'].includes(result.status))row={...structuredClone(item),status:'failed',reasonCodes:['BATCH_RESULT_INVALID']};
      else row=structuredClone(result);
    }catch{row={...structuredClone(item),status:'failed',reasonCodes:['BATCH_EXECUTION_FAILED']};}
    rows.push(row);stopReason=batchStopReason(row);
  }
  return deepFreeze({rows,stopReason});
}

/** Intentionally locked this repair round. Unlocking requires a later explicit
 * user authorization plus accepted bounded-protocol and single-L05 evidence.
 * Offline fixtures/tests never constitute that authorization. */
export function assertLiveBatchUnlocked(): void {
  throw Error('BATCH_LOCKED_PENDING_PROTOCOL_AND_L05_ACCEPTANCE');
}
