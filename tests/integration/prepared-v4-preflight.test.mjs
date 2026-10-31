import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,rename,symlink} from 'node:fs/promises';import {join,relative,resolve} from 'node:path';
import {checkPreparedV4,assertPreparedV4} from '../../dist/server/evaluation/prepared-v4-preflight.js';
import {createPreparedV4Fixture} from '../helpers/prepared-v4-fixture.mjs';
import {engineeringSha} from '../helpers/engineering-material-fixture.mjs';

// Complete readiness with REAL programmatic command capture -> strict producer
// -> candidate engineering material -> freeze/readback. Everything is a labeled
// isolated offline_fixture; no model, real Store, Git mutation or product build.
const originalFetch=globalThis.fetch;let fetchCalls=0;
test.before(()=>{globalThis.fetch=async()=>{fetchCalls++;throw Error('OFFLINE_FIXTURE_NETWORK_FORBIDDEN');};});
test.after(()=>{globalThis.fetch=originalFetch;assert.equal(fetchCalls,0);});
const byName=(result,name)=>result.checks.find(c=>c.name===name);
async function checked(x,p=x.p,options=x.options){
 const before=await x.tree(),result=await checkPreparedV4(p,options),after=await x.tree();assert.deepEqual(after,before,'complete preflight performs zero filesystem mutation');
 assert.equal(result.readOnly,true);assert.equal(result.executionAuthority,false);assert.equal(result.liveEligible,false);
 assert.deepEqual(result.effects,{attemptWrites:0,storeOpens:0,workerSpawns:0,permitAcquires:0,fetchCalls:0,recoveryApplies:0});
 assert.equal(JSON.stringify(result).includes('fixture_key_not_for_network'),false);assert.ok(result.checks.every(c=>['passed','failed','not_checked'].includes(c.status)));return result;
}
test('same COMPLETE readonly prepared preflight accepts actual captured material and frozen readback, never admitting an offline fixture',async t=>{
 const x=await createPreparedV4Fixture(t),result=await checked(x);assert.equal(result.passed,true,JSON.stringify(result));assert.ok(result.checks.every(c=>c.status==='passed'));
 const before=await x.tree();assert.equal((await assertPreparedV4(x.p,x.options)).passed,true);assert.deepEqual(await x.tree(),before);
 assert.equal(x.material.commands.offline.summary.tests,1);assert.equal(x.material.commands.offline.summary.pass,1);assert.equal(x.material.commands.web.receipt.exitCode,0);
 assert.equal(x.material.runnerMode,'offline_fixture');assert.equal(x.material.commands.web.summary.typecheckEvidence,'fixed_build_script_control_flow');
});

test('candidate/frozen/execute phases use the same complete checks; only candidate permits a not-yet-created freeze',async t=>{
 const x=await createPreparedV4Fixture(t);await x.edit(x.candidateFreeze,()=>null);
 try{const candidate=await checked(x,x.p,{...x.options,phase:'candidate'});assert.equal(candidate.passed,true,JSON.stringify(candidate));
  for(const phase of['frozen','execute']){const result=await checked(x,x.p,{...x.options,phase});assert.equal(result.passed,false);assert.equal(byName(result,'candidate_readback').status,'failed');assert.equal(byName(result,'configuration').status,'passed');}
 }finally{await x.reset();}
});
test('SDK junction outside the pinned pnpm package subtree is rejected even with identical frozen bytes',async t=>{
 const x=await createPreparedV4Fixture(t),logical=join(x.root,'node_modules/@mozaik-ai/core'),backup=logical+'-original',wrong=join(x.root,'outside-pnpm-fixture/core');
 for(const file of['package.json','dist/index.d.ts','dist/index.js','dist/index.mjs'])await x.write(join(wrong,file),await readFile(join(logical,file)));
 await rename(logical,backup);await symlink(wrong,logical,'junction');
 try{const result=await checked(x);assert.equal(result.passed,false);assert.equal(byName(result,'fingerprints').status,'failed');}
 finally{await rename(logical,logical+'-rejected-copy');await rename(backup,logical);}
});
test('legitimate relative outside-project store references resolve only into the exact authorized store, never arbitrary files',async t=>{
 const x=await createPreparedV4Fixture(t);
 for(const outside of[false,true])await t.test(outside?'outside-store reference rejected before any read':'relative authorized store reference accepted',async()=>{
  const p=structuredClone(x.p),b=structuredClone(x.baseline),a=structuredClone(x.authorization),target=outside?resolve(x.rootStore,'..','must-not-read-'+x.candidateId+'.json'):b.historicalStore.files[0].file;
  b.historicalStore.files[0].file=relative(x.root,target).replaceAll('\\','/');
  const baselineBytes=Buffer.from(JSON.stringify(b)+'\n');a.baselineSha256=engineeringSha(baselineBytes);const authBytes=Buffer.from(JSON.stringify(a)+'\n');
  p.preparation.baselineSha256=a.baselineSha256;p.preparation.authorizationFileSha256=engineeringSha(authBytes);
  try{await x.edit(p.preparation.baselineFile,()=>baselineBytes);await x.edit(p.preparation.authorizationFile,()=>authBytes);await x.savePlan(p);const result=await checked(x,p);
   assert.equal(byName(result,'store_file_set').status,outside?'failed':'passed',JSON.stringify(result));
   assert.equal(byName(result,'protected_history').status,outside?'failed':'passed',JSON.stringify(result));
   if(outside)assert.equal(byName(result,'store_file_set').code,'PREPARED_UNSAFE_STORE_REFERENCE');else assert.equal(result.passed,true,JSON.stringify(result));
  }finally{await x.reset();}
 });
});

test('independent safe checks continue across real material/file faults; no attempt or execution side effect is created',async t=>{
 const x=await createPreparedV4Fixture(t);
 const cases=[
  ['zero_tests','engineering_material',async(p,m)=>{m.commands.offline.summary.tests=0;m.commands.offline.summary.pass=0;return m;}],
  ['missing_web_exit','engineering_material',async(p,m)=>{delete m.commands.web.receipt.exitCode;return m;}],
  ['string_web_exit','engineering_material',async(p,m)=>{m.commands.web.receipt.exitCode='0';return m;}],
  ['nonzero_web_exit','engineering_material',async(p,m)=>{m.commands.web.receipt.exitCode=9;return m;}],
  ['receipt_log_changed','engineering_material',async()=>{await x.edit('logs/prepared-offline.log',b=>Buffer.concat([b,Buffer.from('tampered fixture tail\n')]));}],
  ['review_certificate_changed','engineering_material',async()=>{await x.edit('prepared-review.json',b=>{const c=JSON.parse(b);c.remainingBlockers=1;return JSON.stringify(c)+'\n';});}],
  ['current_fingerprint_changed','fingerprints',async()=>{await x.edit('src/unchanged-fixture.ts',()=>Buffer.from('// unauthorized fixture drift\n'));}],
  ['decision_object_and_sha_changed','existing_decisions',async p=>{await x.edit(x.legacyAuthFile,b=>{const a=JSON.parse(b);a.authorizedAt='2026-10-30T00:00:00.000Z';return JSON.stringify(a)+'\n';});p.authorizationFileSha256=engineeringSha(await readFile(join(x.root,x.legacyAuthFile)));}],
  ['decision_resolution_changed','existing_decisions',async p=>{await x.edit(x.resolutionFile,b=>{const r=JSON.parse(b);r.historicalCleanupConfirmed=true;return JSON.stringify(r)+'\n';});p.resolutionFileSha256=engineeringSha(await readFile(x.resolutionFile));}],
  ['unexpected_store_file','store_file_set',async()=>{await x.edit(join(x.rootStore,'unexpected-fixture.json'),()=>Buffer.from('{}\n'));}],
  ['preserved_history_changed','protected_history',async()=>{await x.edit('docs/offline-history/prior-preserved.txt',()=>Buffer.from('fixture changed prior bytes\n'));}],
  ['source_file_changed','official_sources',async()=>{const f=x.p.sourceIntegrity[0].file;await x.edit('reference/einstein-matchmaker-data/'+f,b=>Buffer.concat([b,Buffer.from('\n')]));}],
  ['existing_global_attempt','admission_unused',async()=>{await x.edit(x.p.preparation.globalAttemptFile,()=>Buffer.from('{"offline_fixture_existing_attempt":true}\n'));}],
 ];
 for(const[name,check,attack]of cases)await t.test(name,async()=>{
  // Every case re-runs the REAL producer over its captured receipts/review;
  // mutations below are explicit attacks AFTER valid generation, not gold.
  const fresh=await x.materialApi.produceEngineeringMaterial(x.producerOptions,{root:x.root});assert.equal(fresh.commands.offline.summary.tests,1);
  const p=structuredClone(x.p),m=structuredClone(fresh);
  try{const changed=await attack(p,m);if(changed){const material=x.rehash(changed),bytes=Buffer.from(JSON.stringify(material)+'\n');await x.edit(x.engineeringFile,()=>bytes);p.engineeringGate.sha256=engineeringSha(bytes);}
   await x.savePlan(p);const result=await checked(x,p);assert.equal(result.passed,false);assert.equal(byName(result,check).status,'failed',JSON.stringify(result));assert.equal(byName(result,'configuration').status,'passed');
   await assert.rejects(assertPreparedV4(p,x.options),error=>error.code==='PREPARED_V4_NOT_READY'&&error.report?.passed===false);
  }finally{await x.reset();}
 });
 for(const[name,patch,check]of[
  ['current_commit_drift',{currentCommit:'b'.repeat(40)},'source_commit'],
  ['missing_secret',{env:{...x.options.env,EINSTEIN_GATEWAY_API_KEY:''}},'configuration'],
  ['wrong_model',{env:{...x.options.env,EINSTEIN_GATEWAY_MODEL:'fixture-other-model'}},'configuration'],
  ['wrong_gateway',{env:{...x.options.env,EINSTEIN_GATEWAY_BASE_URL:'https://different.invalid/v1'}},'configuration'],
 ])await t.test(name,async()=>{await x.materialApi.produceEngineeringMaterial(x.producerOptions,{root:x.root});const result=await checked(x,x.p,{...x.options,...patch});assert.equal(result.passed,false);assert.equal(byName(result,check).status,'failed');assert.equal(byName(result,'store_file_set').status,'passed');});
});

test('candidate readback mismatch and unsafe paths cannot pass or be followed; offline overrides cannot become live readiness',async t=>{
 const x=await createPreparedV4Fixture(t);
 try{await x.edit(x.candidateFreeze,b=>Buffer.concat([b,Buffer.from('{broken tail')]));const result=await checked(x);assert.equal(result.passed,false);assert.equal(byName(result,'candidate_readback').status,'failed');}finally{await x.reset();}
 try{const priorSha=engineeringSha(await readFile(join(x.root,x.candidateFreeze)));await x.edit(x.candidateFreeze,()=>JSON.stringify(x.p,null,2)+'\n');const result=await checked(x,x.p,{...x.options,phase:'execute',expectedRawFreezeFileSha256:priorSha});assert.equal(result.passed,false);assert.equal(byName(result,'candidate_readback').status,'failed');}finally{await x.reset();}
 const p=structuredClone(x.p);p.preparation.candidateFolder='../outside-the-offline-fixture';p.hash=x.rehash(p).hash;
 const invalid=await checked(x,p);assert.equal(invalid.passed,false);assert.ok(invalid.checks.some(c=>c.status==='not_checked'));
 const before=await x.tree(),upgraded=await checkPreparedV4(x.p,{...x.options,runnerMode:'live'});assert.equal(upgraded.passed,false);assert.equal(upgraded.executionAuthority,false);assert.deepEqual(await x.tree(),before);
 const source=await readFile('src/evaluation/prepared-v4-preflight.ts','utf8');assert.doesNotMatch(source,/from\s+['"][^'"]*(?:run-store|supervisor\/scheduler|process-host|worker-entry|v4-bounded-validation)['"]/);
});
