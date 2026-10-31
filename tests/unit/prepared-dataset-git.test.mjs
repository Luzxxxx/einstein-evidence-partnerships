import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve,relative,sep} from 'node:path';import {createHash} from 'node:crypto';
import {verifyPreparedDatasetGit} from '../../dist/server/evaluation/prepared-v4-preflight.js';

// A completely separate git repository, explicitly offline_fixture. No project
// index/commit, original dataset, Store, worker, permit or network is touched.
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function tree(root){const rows=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const file=join(dir,e.name);if(e.isDirectory())await walk(file);else if(e.isFile())rows.push({file:relative(root,file),sha256:sha(await readFile(file))});else throw Error('OFFLINE_FIXTURE_LINK');}}await walk(root);return rows.sort((a,b)=>a.file.localeCompare(b.file,'en'));}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'einstein task7y dataset git 中文 ')),hooks=join(root,'empty-hooks');await mkdir(hooks);
 t.after(async()=>{const path=resolve(root);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&path.includes('einstein task7y dataset git 中文 '));await rm(path,{recursive:true,force:true});});
 const git=args=>execFileSync('git',['-C',root,'-c','core.hooksPath='+hooks,'-c','user.name=Offline Fixture','-c','user.email=offline-fixture@example.invalid','-c','commit.gpgsign=false',...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
 git(['init','--quiet']);git(['config','core.autocrlf','false']);await writeFile(join(root,'source.json'),'[{"id":"official-byte-fixture"}]\n');await writeFile(join(root,'README.fixture.md'),'tracked auxiliary fixture\n');
 git(['add','--','source.json','README.fixture.md']);git(['commit','--quiet','-m','isolated fixture initial']);const expected=git(['rev-parse','HEAD']),raw=await readFile(join(root,'source.json'));
 return{root,git,expected,raw};
}
test('dataset Git readiness verifies the actual expected HEAD and clean complete status without optional-lock writes',async t=>{
 const x=await fixture(t),before=await tree(x.root),result=await verifyPreparedDatasetGit(x.root,x.expected);assert.equal(result.datasetGit,'verified');assert.equal(result.datasetCommit,x.expected);assert.deepEqual(await tree(x.root),before);
});
test('unchanged pinned data bytes cannot conceal dataset HEAD drift',async t=>{
 const x=await fixture(t);x.git(['commit','--quiet','--allow-empty','-m','isolated HEAD-only drift']);assert.deepEqual(await readFile(join(x.root,'source.json')),x.raw);
 const before=await tree(x.root);await assert.rejects(verifyPreparedDatasetGit(x.root,x.expected),error=>error.code==='PREPARED_DATASET_COMMIT_CHANGED');assert.deepEqual(await tree(x.root),before);
});
for(const kind of['other_tracked_dirty','untracked_file'])test(`unchanged pinned bytes cannot conceal ${kind}`,async t=>{
 const x=await fixture(t);await writeFile(join(x.root,kind==='other_tracked_dirty'?'README.fixture.md':'not-ignored.fixture.txt'),'outside pinned source changed\n');assert.deepEqual(await readFile(join(x.root,'source.json')),x.raw);
 const before=await tree(x.root);await assert.rejects(verifyPreparedDatasetGit(x.root,x.expected),error=>error.code==='PREPARED_DATASET_DIRTY');assert.deepEqual(await tree(x.root),before);
});
