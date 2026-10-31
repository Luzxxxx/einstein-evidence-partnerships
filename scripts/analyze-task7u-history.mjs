// New, read-only v3 interpretation of fixed Task7t evidence. No model, spawn,
// RunStore.open, recovery, permit mutation, historical rewrite or Git operation.
// Run only after the owning engineer has compiled the new module.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {analyzeProtocolProbeV3} from '../dist/server/evaluation/protocol-probe-analysis-v3.js';
import {sha256Bytes} from '../dist/server/evidence/hashing.js';

const folder='docs/implementation/task-7t-live';
const read=async file=>({file,bytes:await readFile(file)});
const freezeFile=await read(folder+'/freeze.json'),freeze=JSON.parse(freezeFile.bytes);
if(freeze.scope!=='task7t_layered_protocol_then_single_L05'||freeze.probe.runId!=='908324ce-cfd4-4d40-9da5-455b279f4033')throw Error('HISTORICAL_SCOPE_MISMATCH');
const runFolder=folder+'/runs/'+freeze.probe.runId;
const files=[freezeFile,...await Promise.all([
 folder+'/attempt.json',folder+'/summary.json',folder+'/execution-audit.json',
 runFolder+'/result.json',runFolder+'/worker-evidence.jsonl',runFolder+'/answer-diagnostics.jsonl',
].map(read))];
const json=name=>JSON.parse(files.find(f=>f.file===name).bytes);
const jsonl=name=>files.find(f=>f.file===name).bytes.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const result=json(runFolder+'/result.json');
if(result.record.status!=='failed'||result.analysis.passed!==false)throw Error('HISTORICAL_OUTCOME_CHANGED');
const analysis=analyzeProtocolProbeV3({...result,
 expected:{companyId:freeze.probe.input.companyId,challengeId:freeze.probe.input.challengeId,researcherId:freeze.probe.researcherId},
 records:[...jsonl(runFolder+'/worker-evidence.jsonl'),...jsonl(runFolder+'/answer-diagnostics.jsonl')],
 stopReasonCodes:result.terminalOutcome?.reasonCodes??[],
});
const sources=await Promise.all(files.map(async f=>{
 const after=await readFile(f.file);if(!after.equals(f.bytes))throw Error('HISTORICAL_BYTES_CHANGED_DURING_ANALYSIS');
 return{file:f.file,bytes:f.bytes.length,sha256:sha256Bytes(f.bytes),unchangedDuringAnalysis:true};
}));
const output='docs/implementation/task-7u-history-analysis-v3.json';
if(files.some(f=>resolve(f.file)===resolve(output)))throw Error('OUTPUT_IS_HISTORICAL_SOURCE');
const report={scope:'task7u_offline_readonly_historical_analysis',analysisVersion:'protocol-probe-analysis-v3',observedAt:new Date().toISOString(),
 liveRequests:0,storeOperations:0,historicalReclassification:false,originalRunId:result.runId,originalStatus:result.record.status,
 originalAnalysisPassed:result.analysis.passed,originalAnalysisReasons:result.analysis.reasons,sources,analysis,
 humanLabels:0,qualityMetrics:'NA',holdout:'unopened',Task7Overall:'NOT_PASS',
 notes:[
  'The original Task7t freeze, attempt, result, summary and failure remain byte-identical; this report is an additional interpretation, never a replacement.',
  'Each batch is mapped by complete actor identity, batch and original supplier call IDs to its causal request and cumulative Context/HTTP groups.',
  'Unobserved HTTP or a missing final model answer does not establish receipt or adapter corruption. Actual field contradictions remain separately reported.',
  'No historical unknown Task7s answer or cause is inferred from this newer evidence.',
 ]};
await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,sourceFiles:sources.length,historicalReclassification:false,batches:analysis.batches.map(b=>({role:b.actor.role,calls:b.callCount,native:b.nativeStatus,context:b.contextStatus,http:b.httpStatus})),
 completedCalls:analysis.native.completedCalls,directBindingCorruption:analysis.directBindingCorruption.length,unobserved:analysis.unobserved.length,liveRequests:0,originalStatus:result.record.status,originalPassed:result.analysis.passed}));
