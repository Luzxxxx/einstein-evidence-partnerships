/** Trusted one-shot protocol worker. No label, expected finding or provider
 * response is supplied here. It reuses actual production Engine/tools/permits. */
import { readFileSync, writeFileSync, appendFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { canonicalizeArtifact } from '../contracts/canonical.js';
import { sha256Bytes, hashArtifact } from '../evidence/hashing.js';
import { loadSnapshot } from '../data/snapshot.js';
import { buildIndex, retrieveWithTrace } from '../retrieval/index.js';
import { startWorker } from '../runtime/worker-entry.js';
import { PROTOCOL_PROBE_POLICY, protocolProbePromptHashes, projectProtocolNative, createProtocolProbeRunner } from './protocol-probe.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
function require(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
function argument(name:string){const index=process.argv.indexOf(name);require(index>=0&&process.argv[index+1],'PROTOCOL_PROBE_WORKER_ARGUMENT');return process.argv[index+1];}

export function startProtocolProbeWorker():void{
  startWorker({configure:async({start,signal,permitClient})=>{
    const freezePath=resolve(argument('--validation-freeze'));
    require(freezePath===resolve(root,'docs/implementation/task-7s-live/freeze.json'),'PROTOCOL_PROBE_FREEZE_PATH');
    const raw=readFileSync(freezePath);require(sha256Bytes(raw)===argument('--validation-freeze-hash'),'PROTOCOL_PROBE_FREEZE_HASH');
    const freeze=JSON.parse(raw.toString('utf8'));
    require(hashArtifact(freeze)===freeze.hash&&freeze.scope==='task7s_bounded_protocol_then_single_L05','PROTOCOL_PROBE_FREEZE_INVALID');
    require(freeze.probe?.runId===start.runId&&canonicalizeArtifact(freeze.probe.input)===canonicalizeArtifact(start.runInput),'PROTOCOL_PROBE_RUN_NOT_FROZEN');
    const promptHashes=protocolProbePromptHashes();
    require(canonicalizeArtifact(freeze.probe.promptHashes)===canonicalizeArtifact(promptHashes),'PROTOCOL_PROBE_PROMPT_FREEZE_MISMATCH');
    require(process.env.EINSTEIN_GATEWAY_BASE_URL===freeze.gatewayBaseURL&&process.env.EINSTEIN_GATEWAY_MODEL===freeze.model,'PROTOCOL_PROBE_GATEWAY_CHANGED');
    const key=process.env.EINSTEIN_GATEWAY_API_KEY;require(key,'PROTOCOL_PROBE_MODEL_CONFIGURATION_MISSING');
    require(start.limits.maxModelRequests===4&&start.limits.maxConcurrentModelRequests<=2
      &&start.limits.requestTimeoutMs===40000&&start.limits.runTimeoutMs===180000,'PROTOCOL_PROBE_LIMITS_CHANGED');
    const snapshot=await loadSnapshot(start.snapshotPath,start.runInput.datasetCommit),research={snapshot,...retrieveWithTrace(start.runInput,buildIndex(snapshot))};
    require(research.pool.candidates.length>0&&research.pool.candidates[0].researcherId===freeze.probe.researcherId,'PROTOCOL_PROBE_FIXED_CANDIDATE_MISMATCH');
    if(freeze.probe.poolHash!==undefined)require(freeze.probe.poolHash===research.pool.poolHash,'PROTOCOL_PROBE_POOL_HASH_MISMATCH');
    const path=join(dirname(freezePath),'runs',start.runId,'worker-evidence.jsonl');let bytes=0;
    function record(value:Record<string,unknown>,first=false){
      const line=JSON.stringify({at:new Date().toISOString(),monotonicMs:performance.now(),...value})+'\n';
      const size=Buffer.byteLength(line);require(size<=262144&&bytes+size<=2*1024*1024,'PROTOCOL_PROBE_EVIDENCE_LIMIT');
      require(!line.includes(key!),'PROTOCOL_PROBE_EVIDENCE_CREDENTIAL_REFLECTION');
      if(first)writeFileSync(path,line,{flag:'wx'});else appendFileSync(path,line);bytes+=size;
      const fd=openSync(path,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
    }
    record({kind:'header',schemaVersion:1,runnerMode:'live',scope:freeze.scope,runId:start.runId,freezeHash:freeze.hash,
      expected:{companyId:start.runInput.companyId,challengeId:start.runInput.challengeId,researcherId:freeze.probe.researcherId},
      input:start.runInput,poolHash:research.pool.poolHash,sourceFiles:snapshot.files,publication:'forbidden'},true);
    signal.addEventListener('abort',()=>record({kind:'worker.abort',runId:start.runId}),{once:true});
    return{runnerMode:'live',adapterProbe:true,adapterProbeInstruction:PROTOCOL_PROBE_POLICY,research,
      gateway:{baseURL:freeze.gatewayBaseURL,model:freeze.model,apiKey:key},
      runnerFactory:hooks=>createProtocolProbeRunner({gateway:{baseURL:freeze.gatewayBaseURL,model:freeze.model,apiKey:key},
        hooks,permitClient,requestTimeoutMs:start.limits.requestTimeoutMs,record,trace:hooks.trace}),
      onToolBatch:manifest=>record({kind:'tool.batch',manifest}),
      onNative:(event,actor)=>{
        const projection=projectProtocolNative(event,actor);record(projection);
        if(event.type==='inference.started')require(projection.actualInstructionHash===(actor.role==='proposer'?promptHashes.effectiveProposer:promptHashes.effectiveCounter),'PROTOCOL_PROBE_EFFECTIVE_PROMPT_MISMATCH');
      },onArtifact:()=>{throw Error('PROTOCOL_PROBE_PUBLICATION_FORBIDDEN');},
    };
  }});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startProtocolProbeWorker();
