// Deterministic casebook export only. No model, labels in runtime, or raw-data writes.
import { writeFile,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSnapshot } from '../dist/server/data/snapshot.js';
import { CRITIC_VARIANTS,buildCriticCase } from '../dist/server/evaluation/critic-cases.js';
import { validateClaimSources } from '../dist/server/evidence/validate.js';
import { evaluatePublication } from '../dist/server/publishing/gate.js';
import { hashArtifact,sha256Bytes } from '../dist/server/evidence/hashing.js';
import { DATASET_COMMIT } from '../dist/server/contracts/primitives.js';

const snapshot=await loadSnapshot(resolve('reference/einstein-matchmaker-data'),DATASET_COMMIT);
const rows=[];
for(const [index,variant]of CRITIC_VARIANTS.entries()){
  const runId=`71000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,sample=buildCriticCase(snapshot,variant.variantId,runId);
  const target={inputHash:sample.draft.inputHash,poolVersion:sample.research.pool.poolVersion,poolHash:sample.research.pool.poolHash,
    counterReportHash:sample.counter.hash,draftVersion:sample.draft.version,draftHash:sample.draft.draftHash,evidenceSnapshotHash:sample.draft.evidenceSnapshotHash};
  const actor={role:'critic',agentId:'71000000-0000-4000-8000-999999999991',taskId:'71000000-0000-4000-8000-999999999992',contextId:'71000000-0000-4000-8000-999999999993',attempt:1};
  const review={id:'review_offline_fixture',runId,version:1,verdict:'approve',findings:[],target:structuredClone(target)};review.hash=hashArtifact(review);
  const run={runId,input:sample.input,inputHash:sample.draft.inputHash,runnerMode:'offline_fixture',status:'reviewing',
    createdAt:'2026-10-31T00:00:00.000Z',admittedAt:'2026-10-31T00:00:00.000Z',deadlineAt:'2026-10-31T00:03:00.000Z',revisionCount:0,
    cleanupState:'confirmed',lastSeq:9,reviewExpectation:{actor:structuredClone(actor),reviewVersion:1,target:structuredClone(target)},acceptedReview:review};
  const gateInput={draft:sample.draft,counter:sample.counter,review,run,pool:sample.research.pool,evidence:sample.research.evidence,
    evidenceSnapshotHash:sample.draft.evidenceSnapshotHash,snapshot,actor,now:'2026-10-31T00:01:00.000Z'};
  if(variant.variantId.startsWith('D03-')){
    gateInput.counter=variant.variantId==='D03-missing'?null:variant.variantId==='D03-json'?'{invalid JSON':{...sample.counter};
    if(variant.variantId==='D03-version')delete gateInput.counter.version;
  }else if(variant.variantId.startsWith('D04-')){
    const key=variant.variantId.slice(4);review.target[key]=typeof target[key]==='number'?target[key]+1:'f'.repeat(64);review.hash=hashArtifact(review);
  }else if(variant.variantId==='D05-self')delete run.acceptedReview;
  else if(variant.variantId==='D05-actor')gateInput.actor={...actor,role:'proposer'};
  const sourceIssues=validateClaimSources(sample.draft,snapshot,sample.research.evidence);
  const decision=variant.layer==='D'?evaluatePublication(gateInput):null;
  rows.push({variant,runnerMode:'offline_fixture',manifest:sample.manifest,attackDiff:sample.attackDiff,
    baselineDraft:sample.baselineDraft,attackedDraft:sample.draft,counterFixture:sample.counter,sourceIssues,
    deterministicGate:decision,semanticSupport:'unassessed',labelStatus:'draft_not_human_gold'});
}
const d=rows.filter(r=>r.variant.layer==='D'),lc=rows.filter(r=>r.variant.layer!=='D');
const allDeterministicDenied=d.every(r=>r.deterministicGate.allowed===false);
const allLiveSourcesValid=lc.every(r=>!r.sourceIssues.some(i=>i.severity==='error'));
const result={scope:'isolated_cases_and_deterministic_checks_only_not_model_observations',datasetCommit:DATASET_COMMIT,sourceFiles:snapshot.files,
  logicalCaseCount:15,actualDeterministicVariants:d.length,actualLiveVariants:lc.length,allDeterministicDenied,allLiveSourcesValid,
  labelManifestSha256:sha256Bytes(await readFile('tests/fixtures/critic/labels.json')),humanReviewedCount:0,qualityMetrics:'NA',holdout:'unopened',rows};
await writeFile('docs/implementation/task-7-casebook.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({deterministic:d.length,allDeterministicDenied,liveVariants:lc.length,allLiveSourcesValid,humanReviewedCount:0,quality:'NA'}));
if(!allDeterministicDenied||!allLiveSourcesValid)process.exitCode=1;
