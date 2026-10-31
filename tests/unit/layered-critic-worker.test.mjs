import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {resolve} from 'node:path';
import {loadSnapshot} from '../../dist/server/data/snapshot.js';import {DATASET_COMMIT} from '../../dist/server/contracts/primitives.js';import {buildCriticCase} from '../../dist/server/evaluation/critic-cases.js';
import {hashArtifact} from '../../dist/server/evidence/hashing.js';import {validateLayeredCriticSample} from '../../dist/server/evaluation/layered-critic-worker.js';
const snapshot=await loadSnapshot(resolve('reference/einstein-matchmaker-data'),DATASET_COMMIT);
function f(){const id=randomUUID(),sample=buildCriticCase(snapshot,'L05',id),p={scope:'task7t_layered_protocol_then_single_L05',automaticRetry:false,showcaseEligible:false,l05:{runId:id,input:sample.input,variantId:'L05',manifest:sample.manifest}};return{sample,start:{runId:id,runInput:sample.input},freeze:{...p,hash:hashArtifact(p)}};}
test('single L05 accepts only exact new-scope source-built sample',()=>{const x=f();assert.doesNotThrow(()=>validateLayeredCriticSample(x.freeze,x.start,x.sample));});
test('L05 rejects old scope, wrong Run, changed source manifest and product-scope expansion even when rehashed',()=>{
 for(const edit of [p=>p.scope='task7s_bounded_protocol_then_single_L05',p=>p.l05.runId=randomUUID(),p=>p.l05.input.mode='research',p=>p.l05.manifest.sources[0].evidenceId='wrong',p=>p.showcaseEligible=true]){
  const x=f(),p=structuredClone(x.freeze);edit(p);p.hash=hashArtifact(p);assert.throws(()=>validateLayeredCriticSample(p,x.start,x.sample));}
});
