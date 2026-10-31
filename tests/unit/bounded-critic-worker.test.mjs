import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {loadSnapshot} from '../../dist/server/data/snapshot.js';
import {DATASET_COMMIT} from '../../dist/server/contracts/primitives.js';
import {buildCriticCase} from '../../dist/server/evaluation/critic-cases.js';
import {hashArtifact} from '../../dist/server/evidence/hashing.js';
import {validateBoundedCriticSample} from '../../dist/server/evaluation/bounded-critic-worker.js';

// Real fixed sources, no model; labels and expected findings never enter worker.
const snapshot=await loadSnapshot(resolve('reference/einstein-matchmaker-data'),DATASET_COMMIT);
function fixture(){const runId=randomUUID(),sample=buildCriticCase(snapshot,'L05',runId);const p={scope:'task7s_bounded_protocol_then_single_L05',
 l05:{variantId:'L05',runId,input:sample.input,manifest:sample.manifest},showcaseEligible:false,automaticRetry:false};
 return{sample,start:{runId,runInput:sample.input},freeze:{...p,hash:hashArtifact(p)}};}
test('bounded L05 worker accepts the one frozen controlled sample with exact input and original source manifest',()=>{
 const f=fixture();assert.doesNotThrow(()=>validateBoundedCriticSample(f.freeze,f.start,f.sample));
 assert.equal(f.sample.input.mode,'adversarial');assert.equal(f.sample.manifest.showcaseEligible,false);
});
test('bounded L05 worker rejects unplanned Run, variant, input, source manifest and false freeze',()=>{
 for(const edit of [x=>x.freeze.l05.runId=randomUUID(),x=>x.freeze.l05.variantId='L06-system',
  x=>x.freeze.l05.input.mode='research',x=>x.freeze.l05.manifest.sources[0].excerptSha256='f'.repeat(64),
  x=>x.freeze.hash='f'.repeat(64),x=>x.freeze.showcaseEligible=true,x=>x.freeze.automaticRetry=true]){
  const f=fixture(),copy={freeze:structuredClone(f.freeze),start:structuredClone(f.start),sample:f.sample};edit(copy);
  if(copy.freeze.hash!=='f'.repeat(64))copy.freeze.hash=hashArtifact(copy.freeze);
  assert.throws(()=>validateBoundedCriticSample(copy.freeze,copy.start,copy.sample));
 }
});
