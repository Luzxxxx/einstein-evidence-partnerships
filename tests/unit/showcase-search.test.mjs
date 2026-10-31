import test from 'node:test';
import assert from 'node:assert/strict';
import {filterShowcaseEntries} from '../../web/src/showcase-search.ts';

const entries=Object.freeze([
  Object.freeze({companyId:'C036',researcherId:'R0976',challengeId:'C036-CH1',companyName:'FreshPak Solutions',researcherName:'Jelena Marković'}),
  Object.freeze({companyId:'C025',researcherId:'R0637',challengeId:'C025-CH1',companyName:'Nexara Embedded',researcherName:'Dijana Radulović'}),
]);
const catalog={companies:[{id:'C036',name:'FreshPak Solutions',challenges:[{id:'C036-CH1',text:'Raspberry packaging and shelf life.'}]}]};

test('saved collection search finds actual company, researcher, ID and original challenge text',()=>{
  for(const query of ['freshpak','MARKOVIC','R0976','raspberry packaging','Jelena Markovic'])assert.equal(filterShowcaseEntries(entries,catalog,query)[0],entries[0]);
  assert.equal(filterShowcaseEntries(entries,null,'nexara')[0],entries[1]);
});
test('saved collection search preserves order and empty states without inventing matches',()=>{
  assert.deepEqual(filterShowcaseEntries(entries,catalog,'   '),entries);
  assert.deepEqual(filterShowcaseEntries(entries,catalog,'unrelated quantum sensor'),[]);
  assert.deepEqual(filterShowcaseEntries([],catalog,''),[]);
  assert.equal(entries[0].researcherName,'Jelena Marković');
});
