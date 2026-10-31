import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {analyzeL05Chain} from '../../dist/server/evaluation/bounded-validation.js';
import {hashArtifact} from '../../dist/server/evidence/hashing.js';
import {draft,review,target,finding,actor} from '../fixtures/contracts.mjs';

// Clearly synthetic chain fixture: no LLM judgment or human gold is represented.
function chain(){const v1=draft();v1.claims[0].id='C-GUARANTEE';v1.sections.summary[0].claimIds=['C-GUARANTEE'];v1.draftHash=hashArtifact(v1);
 const v2=structuredClone(v1);v2.version=2;v2.claims[0].text='Conditional hypothesis requiring validation.';v2.sections.summary[0].text='Conditional hypothesis requiring validation.';v2.sections.validation=[{text:'Evaluate separately before use.',claimIds:['C-GUARANTEE']}];v2.draftHash=hashArtifact(v2);
 const r1={...review(),verdict:'revise',findings:[{...finding(),claimIds:['C-GUARANTEE'],evidenceIds:['e-1']}],target:{...target(),draftHash:v1.draftHash}};r1.hash=hashArtifact(r1);
 const r2={...review(),version:2,target:{...target(),draftVersion:2,draftHash:v2.draftHash}};r2.hash=hashArtifact(r2);
 const a1=actor(),a2={...a1,taskId:randomUUID(),contextId:randomUUID(),attempt:2};
 return{runId:v1.runId,record:{runId:v1.runId,status:'approved',runnerMode:'live',cleanupState:'confirmed',revisionCount:1},
  caseManifest:{sources:[{alias:'paper-abstract',evidenceId:'e-1'}]},draftVersions:[v1,v2],reviewVersions:[r1,r2],
  loadedReviewSnapshots:[{actor:a1,snapshot:{target:r1.target}},{actor:a2,snapshot:{target:r2.target}}],
  publication:{mode:'adversarial',runnerMode:'live',formalProposal:null,renderedDraft:JSON.stringify(v2)}};
}
test('L05 diagnostic chain requires actual finding, changed content, new Critic Context and exact v2 publication',()=>{
 const result=analyzeL05Chain(chain());assert.equal(result.structuralChainObserved,true);assert.equal(result.semanticQuality,'unadjudicated');
});
for(const [name,edit] of Object.entries({v1_only:r=>{r.draftVersions.pop();r.reviewVersions=[r.reviewVersions[1]];},
 only_version:r=>{r.draftVersions[1]={...structuredClone(r.draftVersions[0]),version:2};r.draftVersions[1].draftHash=hashArtifact(r.draftVersions[1]);},
 no_finding:r=>r.reviewVersions[0].findings=[],wrong_claim:r=>r.reviewVersions[0].findings[0].claimIds=['other'],
 wrong_evidence:r=>r.reviewVersions[0].findings[0].evidenceIds=['other'],old_approval:r=>r.reviewVersions[1].target=r.reviewVersions[0].target,
 reused_context:r=>r.loadedReviewSnapshots[1].actor=r.loadedReviewSnapshots[0].actor,
 wrong_render:r=>r.publication.renderedDraft=JSON.stringify(r.draftVersions[0]),formal:r=>r.publication.formalProposal={id:'not-allowed'}}))
 test(`L05 goal stays unachieved for ${name}`,()=>{const r=chain();edit(r);assert.equal(analyzeL05Chain(r).structuralChainObserved,false);});
