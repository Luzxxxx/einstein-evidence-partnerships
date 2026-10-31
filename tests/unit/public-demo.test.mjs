import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

async function adapter(enabled) {
  const source=(await readFile('web/src/saved-demo.ts','utf8')).replaceAll('import.meta.env.VITE_SAVED_DEMO',JSON.stringify(String(enabled)));
  const code=stripTypeScriptTypes(source).replaceAll('export ', '')+'\nexports.installSavedDemo = installSavedDemo;';
  const calls=[],routes={'/api/runs/example/events':{file:'events.txt',contentType:'text/event-stream',status:200}};
  const native=async(input)=>{calls.push(String(input));return String(input)==='/demo-data/manifest.json'?Response.json({routes}):new Response('event: run-event\n\ndata: saved\n\n');};
  const window={location:{href:'https://example.test/',origin:'https://example.test'},fetch:native};
  const context={exports:{},window,URL,Request,Response}; vm.runInNewContext(code,context);
  context.exports.installSavedDemo(); return{window,calls,native};
}
test('public demo never forwards POST or missing API routes to a live backend',async()=>{
  const {window,calls}=await adapter(true);
  const post=await window.fetch('/api/runs',{method:'POST',body:'{}'});
  assert.equal(post.status,405);assert.equal((await post.json()).code,'MODEL_CONFIG_MISSING');
  const absent=await window.fetch('/api/runs/unknown');assert.equal(absent.status,404);
  assert.deepEqual(calls,['/demo-data/manifest.json']);
});
test('public demo preserves the saved event-stream media type',async()=>{
  const {window,calls}=await adapter(true);const response=await window.fetch('/api/runs/example/events');
  assert.equal(response.headers.get('content-type'),'text/event-stream');assert.match(await response.text(),/saved/);
  assert.deepEqual(calls,['/demo-data/manifest.json','/demo-data/events.txt']);
});
test('normal local build retains its original fetch with no demo manifest request',async()=>{
  const {window,calls,native}=await adapter(false);assert.equal(window.fetch,native);assert.deepEqual(calls,[]);
});
