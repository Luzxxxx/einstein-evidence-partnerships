// Actual loopback HTTP check of the static publication, with no model/backend.
import {readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {resolve, join, sep, extname} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve('.'), output = resolve(process.argv[2] ?? 'var/submission/github-pages-v1');
const prefix = '/einstein-evidence-partnerships/';
const seen = [];
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.ttf':'font/ttf'};
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    seen.push({method:req.method,path});
    if (req.method !== 'GET' || !path.startsWith(prefix)) {res.writeHead(404).end();return;}
    const file = resolve(output, decodeURIComponent(path.slice(prefix.length)) || 'index.html');
    if (!file.startsWith(output + sep) && file !== join(output, 'index.html')) {res.writeHead(404).end();return;}
    const bytes = await readFile(file);
    res.writeHead(200, {'Content-Type':mime[extname(file)] ?? 'text/plain'}).end(bytes);
  } catch {res.writeHead(404).end();}
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const get = async path => {const r=await fetch(origin+path);assert.equal(r.status,200,path);return r;};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const index = await (await get(prefix)).text();
  assert.match(index,/ProofBridge/);
  const assets = [...index.matchAll(/(?:src|href)="([^"]+)"/g)].map(m=>m[1]);
  let fonts=0;
  for (const path of assets) {
    assert.ok(path.startsWith(prefix),path);const response=await get(path);
    if(path.endsWith('.css'))for(const match of (await response.text()).matchAll(/url\(["']?([^)'"\s]+)["']?\)/g)){
      assert.ok(match[1].startsWith(prefix));await get(match[1]);if(match[1].endsWith('.ttf'))fonts++;
    }
  }
  assert.ok(fonts>0,'the supplied handwritten visual reference requires its bundled font');
  await get(prefix+'Kalam-OFL.txt');
  const guide = await (await get(prefix+'guide.html')).text();
  assert.ok(!guide.includes('chatgpt.site'));
  assert.ok(guide.includes('https://github.com/Luzxxxx/einstein-evidence-partnerships/archive/refs/heads/main.zip'));
  const guideLinks = [...guide.matchAll(/(?:src|href)="([^"]+)"/g)].map(m=>m[1]).filter(p=>p.startsWith('/'));
  for (const path of guideLinks) {assert.ok(path.startsWith(prefix),path);await get(path.split('#')[0]);}
  const manifest = await (await get(prefix+'demo-data/manifest.json')).json();
  const routes = Object.values(manifest.routes);
  for (let i=0;i<routes.length;i+=16) await Promise.all(routes.slice(i,i+16).map(async route=>{
    const bytes=Buffer.from(await (await get(prefix+'demo-data/'+route.file)).arrayBuffer());
    assert.equal(bytes.length,route.bytes);assert.equal(sha(bytes),route.sha256);
  }));
  const exported = await (await get(prefix+'export/showcase-manifest.json')).json();
  for (const file of exported.files) {
    const bytes=Buffer.from(await (await get(prefix+'export/'+file.file)).arrayBuffer());
    assert.equal(bytes.length,file.bytes);assert.equal(sha(bytes),file.sha256);
  }
  const native = (input,init) => fetch(new URL(String(input),origin+prefix),init);
  const source = (await readFile(join(root,'web/src/saved-demo.ts'),'utf8'))
    .replaceAll('import.meta.env.VITE_SAVED_DEMO',JSON.stringify('true'))
    .replaceAll('import.meta.env.BASE_URL',JSON.stringify(prefix));
  const code = stripTypeScriptTypes(source).replaceAll('export ','')+'\nexports.installSavedDemo=installSavedDemo;';
  const window={location:{href:origin+prefix,origin},fetch:native};
  const context={window,exports:{},Request,Response,URL};vm.runInNewContext(code,context);context.exports.installSavedDemo();
  const catalog = await (await window.fetch('/api/catalog')).json();assert.equal(catalog.newRunsAvailable,false);
  const showcase = await (await window.fetch('/api/showcase')).json();assert.equal(showcase.length,3);
  const n=seen.length;
  assert.equal((await window.fetch('/api/runs',{method:'POST'})).status,405);
  assert.equal((await window.fetch('/api/runs/missing')).status,404);
  assert.equal(seen.length,n,'blocked API requests must not reach the HTTP host');
  assert.ok(seen.every(r=>r.method==='GET'&&r.path.startsWith(prefix)));
  const result={scope:'loopback_static_http_and_real_saved_adapter',base:prefix,assets:assets.length,guideLinks:guideLinks.length,capturedRoutes:routes.length,exportFiles:exported.files.length,formalPairs:showcase.length,hashFailures:0,newModelRequests:0,apiWritesForwarded:0,browserInteraction:'not performed; independent verification required',requests:seen.length};
  await writeFile(join(root,process.argv[3] ?? 'docs/implementation/github-pages-http-check-20261101.json'),JSON.stringify({...result,fonts},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(result,null,2));
} finally {await new Promise(done=>server.close(done));}
