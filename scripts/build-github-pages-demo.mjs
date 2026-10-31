// Reuse immutable saved GET responses. This entry never starts a Run or model.
import {readFile, writeFile, mkdir, cp, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, join} from 'node:path';
import {build} from 'vite';

const root = resolve('.');
const source = join(root, 'var/submission/demo-site/dist');
const output = resolve(process.argv[2] ?? 'var/submission/github-pages-v1');
const base = '/einstein-evidence-partnerships/';
if (!output.startsWith(join(root, 'var/submission') + '/') && !output.startsWith(join(root, 'var/submission') + '\\')) throw Error('OUTPUT_OUTSIDE_SUBMISSION');
const manifest = JSON.parse(await readFile(join(source, 'demo-data/manifest.json'), 'utf8'));
let verifiedRoutes = 0;
for (const [path, route] of Object.entries(manifest.routes)) {
  if (!path.startsWith('/api/') || !/^[a-f0-9]{24}\.(json|txt)$/.test(route.file)) throw Error('INVALID_SAVED_ROUTE');
  const bytes = await readFile(join(source, 'demo-data', route.file));
  if (bytes.length !== route.bytes || createHash('sha256').update(bytes).digest('hex') !== route.sha256) throw Error('CAPTURE_HASH_MISMATCH');
  verifiedRoutes++;
}
await mkdir(output, {recursive: false});
await cp(join(source, 'demo-data'), join(output, 'demo-data'), {recursive: true});
await cp(join(source, 'export'), join(output, 'export'), {recursive: true});
await cp(join(source, 'architecture.svg'), join(output, 'architecture.svg'));
await build({root: join(root, 'web'), configFile: false, base, define: {'import.meta.env.VITE_SAVED_DEMO': JSON.stringify('true')}, build: {outDir: output, emptyOutDir: false}});
const markerFont = (await readdir(join(output,'assets'))).find(name => /^Kalam-Bold-[\w-]+\.ttf$/.test(name));
if (!markerFont) throw Error('BUNDLED_FONT_MISSING');
await cp(join(root,'web/src/assets/OFL.txt'),join(output,'Kalam-OFL.txt'));
const guide = (await readFile(join(source, 'guide.html'), 'utf8'))
  .replace('How it works | EINSTEIN', 'How it works | ProofBridge')
  .replace('<strong>EINSTEIN</strong>', '<strong>ProofBridge</strong>')
  .replace('<h1>A research partner.<br>The evidence to decide.</h1>', '<h1>Good partnerships.<br>Better questions.</h1>')
  .replaceAll('href="/#run=b738ce31-0d8d-4eba-a01e-f4deac26a632"', 'href="/#run=b738ce31-0d8d-4eba-a01e-f4deac26a632&amp;view=changes"')
  .replace('href="/#run=d66da659-7683-4511-917f-38a9bbfefca2"', 'href="/#run=d66da659-7683-4511-917f-38a9bbfefca2&amp;view=review"')
  .replace('<img class="diagram"', '<section><h2>Your first three clicks.</h2><ol><li>Open a proposal. Overview brings together the company challenge, proposed work, validation plan and conditions to confirm.</li><li>Open an Evidence citation. Compare the excerpt with the original field; origin verification is separate from semantic support.</li><li>Open the real revision story. Read the Critic finding next to its linked before-and-after claims and check the final Run outcome.</li></ol><p>System approval records a reviewed proposal. Participation, commercial terms and real-world trial outcomes still need confirmation.</p></section><img class="diagram"')
  .replace('href="/source.zip"', 'href="https://github.com/Luzxxxx/einstein-evidence-partnerships/archive/refs/heads/main.zip"')
  .replace(/\b(href|src)="\/(?!\/)([^"]*)"/g, (_match, attribute, suffix) => `${attribute}="${base}${suffix}"`)
  .replace('</head>', `<style>@font-face{font-family:ProofMarker;src:url("${base}assets/${markerFont}") format("truetype");font-display:swap}body{background:#fff;color:#171717}header strong{font-family:ProofMarker,cursive;font-size:25px;letter-spacing:0}h1{font-family:ProofMarker,cursive;font-size:clamp(42px,6vw,68px);line-height:1.17;font-weight:700;letter-spacing:-.025em}h2,h3{color:#171717}.button{background:#171717;border-radius:40px;padding:13px 23px}.button.secondary{border-color:#ddd;color:#333;border-radius:40px}.diagram{background:#e2f2ff;border-radius:30px}.rows{border:0;padding:0}.row{border:0;border-radius:25px;margin:18px 0;padding:27px 30px}.row:nth-child(4n+1){background:#e2f2ff}.row:nth-child(4n+2){background:#def1e4}.row:nth-child(4n+3){background:#fae9d8}.row:nth-child(4n){background:#efe7fc}footer{color:#777}</style></head>`);
await writeFile(join(output, 'guide.html'), guide, {flag: 'wx'});
await writeFile(join(output, '.nojekyll'), '', {flag: 'wx'});
await writeFile(join(output, 'deployment-verification.json'), JSON.stringify({mode: 'saved_real_results', base, verifiedRoutes, runIds: manifest.runIds, newModelRequests: 0, sourceDownload: 'public GitHub main archive', previousSiteUnmodified: true}, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({output, base, verifiedRoutes, runs: manifest.runIds.length, newModelRequests: 0}));
