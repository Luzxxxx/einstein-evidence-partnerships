// Controlled offline_fixture diagnostic, not a model request or product test pass.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {join,resolve,sep} from 'node:path';import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {captureEngineeringCommand} from '../../dist/server/evaluation/engineering-material.js';
test('capture actual nested Node test output for parser root-cause analysis',async t=>{
 const root=await mkdtemp(join(tmpdir(),'einstein task7y log diagnostic '));
 t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&root.includes('einstein task7y log diagnostic '));await rm(root,{recursive:true,force:true});});
 const child=join(root,'child.test.mjs');await writeFile(child,"import test from 'node:test';test('actual controlled child test',()=>{});\n",{flag:'wx'});
 const receipt=await captureEngineeringCommand({root,kind:'offline',runnerMode:'offline_fixture',command:process.execPath,argv:['--test',child],logFile:'child.log',receiptFile:'child-receipt.json'});
 const log=await readFile(join(root,'child.log'));
 const evidence='docs/implementation/task-7y-capture-context-'+randomUUID()+'.json';
 await writeFile(evidence,JSON.stringify({runnerMode:'offline_fixture',scope:'new controlled diagnostic, not reconstructed historical child output',
  nodeTestContext:process.env.NODE_TEST_CONTEXT??null,nodeVersion:process.version,receipt,rawLogBase64:log.toString('base64'),logText:log.toString('utf8'),modelRequests:0},null,2)+'\n',{flag:'wx'});
 t.diagnostic('Immutable offline capture-context evidence: '+evidence);
 assert.match(log.toString('utf8'),/^(?:ℹ|#)\s+tests\s+1\s*$/m);
});
