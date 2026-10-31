import test from 'node:test';
import assert from 'node:assert/strict';
import {matchingReview, meetingSections, reviewStory, readRouteHash, laterReviewForComparison, briefPublicationReady} from '../../web/src/reading.ts';
const draft=()=>({runId:'run-a',inputHash:'input',poolVersion:1,poolHash:'pool',version:2,draftHash:'draft',evidenceSnapshotHash:'evidence',sections:{summary:[{text:'Exact original summary.',claimIds:['C1']}],validation:[{text:'Measure the original target.',claimIds:['C2']}]}});
const review=()=>({runId:'run-a',hash:'review',verdict:'approve',target:{inputHash:'input',poolVersion:1,poolHash:'pool',counterReportHash:'counter',draftVersion:2,draftHash:'draft',evidenceSnapshotHash:'evidence'}});
test('reading review requires exact Run and every available draft binding',()=>{
 const d=draft(),r=review();assert.equal(matchingReview(d,r),r);assert.equal(matchingReview(d,undefined),undefined);
 for(const key of ['inputHash','poolVersion','poolHash','draftVersion','draftHash','evidenceSnapshotHash'])assert.equal(matchingReview(d,{...r,target:{...r.target,[key]:'different'}}),undefined,key);
 assert.equal(matchingReview(d,{...r,runId:'other'}),undefined);
});
test('meeting brief retains all exact original paragraphs, sources and missing sections without mutation',()=>{
 const d=draft(),before=JSON.stringify(d);const sections=meetingSections(d);assert.equal(sections.length,6);assert.equal(sections.find(s=>s.key==='summary').paragraphs,d.sections.summary);assert.equal(sections.find(s=>s.key==='validation').paragraphs,d.sections.validation);assert.deepEqual(sections.find(s=>s.key==='cooperationScope').paragraphs,[]);assert.equal(JSON.stringify(d),before);
 assert.ok(!JSON.stringify(sections).includes('approved'));
});
test('review story associates exact Claim IDs and retains limitation-only changes',()=>{
 const finding={id:'F1',claimIds:['C1','C10'],severity:'blocking',explanation:'Original finding',reviewHash:'r1',laterReviewHash:'r2',resolution:'later_review_recorded'};
 const diff={available:true,from:{version:1,hash:'a'},to:{version:2,hash:'b'},findings:[finding],claims:[{id:'C1',change:'changed',before:{text:'Same text',limitations:['old']},after:{text:'Same text',limitations:['new']}},{id:'C10',change:'unchanged',before:{text:'No change'},after:{text:'No change'}},{id:'C100',change:'changed',before:{text:'Unrelated'},after:{text:'Unrelated edit'}}]};
 const before=JSON.stringify(diff),story=reviewStory(diff);assert.equal(story.length,1);assert.equal(story[0].finding,finding);assert.deepEqual(story[0].changes.map(x=>x.id),['C1']);assert.deepEqual(story[0].unchangedClaimIds,['C10']);assert.equal(JSON.stringify(diff),before);assert.ok(!Object.hasOwn(story[0],'resolved'));
});
test('missing comparisons and run-level findings do not invent a changed claim or resolution',()=>{
 assert.deepEqual(reviewStory(null),[]);assert.deepEqual(reviewStory({available:false}),[]);
 const finding={id:'F',claimIds:[],severity:'blocking'};const result=reviewStory({available:true,findings:[finding],claims:[]});assert.deepEqual(result[0].changes,[]);assert.equal(result[0].finding,finding);
});
test('reading deep links select only known views and never specify an action or execution mode',()=>{
 assert.deepEqual(readRouteHash('#run=abc&view=changes',true),{page:'run',id:'abc',view:'changes'});assert.equal(readRouteHash('#run=abc&view=approve&mode=live',true).view,'overview');
 assert.deepEqual(readRouteHash('#run=abc',false),{page:'run',id:'abc',view:'overview'});assert.equal(readRouteHash('#showcase',true).page,'showcase');assert.equal(readRouteHash('#replay',true).page,'replay');assert.equal(readRouteHash('',true).page,'showcase');assert.equal(readRouteHash('',false).page,'analyze');assert.equal(readRouteHash('#run=&view=changes',true).page,'showcase');
});
test('later review display requires current Run and exact v2 draft bindings for all verdicts',()=>{
 const d=draft(),r=review(),diff={available:true,from:{version:1,hash:'old'},to:{version:2,hash:'draft'}};
 for(const verdict of ['approve','insufficient','revise']){const end={...r,verdict};assert.equal(laterReviewForComparison(diff,[d],[end],'run-a'),end);}
 assert.equal(laterReviewForComparison(diff,[d],[r],'other'),undefined);
 assert.equal(laterReviewForComparison(diff,[d],[{...r,runId:'other'}],'run-a'),undefined);
 assert.equal(laterReviewForComparison(diff,[d],[{...r,target:{...r.target,poolHash:'wrong'}}],'run-a'),undefined);
 assert.equal(laterReviewForComparison({...diff,to:{version:2,hash:'wrong'}},[d],[r],'run-a'),undefined);
 assert.equal(laterReviewForComparison(diff,[],[r],'run-a'),undefined);
});
test('approved meeting brief binds the actual overview draft, accepted review and parent publication',()=>{
 const d=draft(),r=review(),run={runId:'run-a',publishedDraftHash:'draft',acceptedReview:{hash:'review'}};
 assert.equal(briefPublicationReady(d,r,run,true),true);
 assert.equal(briefPublicationReady({...d,draftHash:'new-unreviewed'},r,run,true),false);
 assert.equal(briefPublicationReady(d,{...r,hash:'old-review'},run,true),false);
 assert.equal(briefPublicationReady(d,{...r,verdict:'insufficient'},run,true),false);
 assert.equal(briefPublicationReady(d,r,{...run,runId:'other'},true),false);
 assert.equal(briefPublicationReady(d,r,run,false),false);
 assert.equal(briefPublicationReady(d,undefined,run,true),false);
});
