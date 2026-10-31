// An explicit public-release allowlist. Private env, runtime stores and user
// notes are never copied. Run from the original workspace after verification.
import {readFile, writeFile, mkdir, cp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join, dirname, resolve} from 'node:path';
import {createHash} from 'node:crypto';

const root = resolve('.'), release = join(root, 'var/submission/repository');
const tracked = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
const history = [
 'task-6-integrity.json', 'task-7s-authorization.json', 'task-7t-live/freeze.json',
 'task-7t-live/runs/908324ce-cfd4-4d40-9da5-455b279f4033/result.json',
 'task-7t-live/runs/908324ce-cfd4-4d40-9da5-455b279f4033/worker-evidence.jsonl',
 'task-7t-live/runs/908324ce-cfd4-4d40-9da5-455b279f4033/answer-diagnostics.jsonl',
 'task-7v-baseline.json','task-7v-live/freeze.json','task-7x-baseline.json','task-7x-live/freeze.json',
 'task-7y-authorization.json','task-7y-authorization-v2.json','task-7y-baseline.json',
 'task-7x-v4-worker-evidence-forward-1793436712982-3d45253e-4dfd-49fc-9aac-c6fbb350d6e4.json',
 'task-7-live/freeze.json','task-7-live/runs/897203e4-d779-4c3e-8696-52ce718d537e/result.json',
 'task-7r-recovery-evidence-v2.json',
].map(p => 'docs/implementation/' + p);
const specs = ['docs/superpowers/specs/2026-10-30-interface-contracts.md','docs/superpowers/specs/2026-10-30-einstein-mvp-design.md','docs/superpowers/plans/2026-10-30-einstein-mvp-implementation.md'];
const top = ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.contracts.json','tsconfig.server.json','tsconfig.web.json','vite.config.ts','.gitattributes','.gitignore'];
const files = new Set([...tracked.filter(p => /^(src|web|scripts|tests|config)\//.test(p) || p.startsWith('artifacts/demo-store') || p.startsWith('artifacts/showcase/final/')), ...history, ...specs, ...top,
 'web/src/saved-demo.ts','web/saved-demo-assets/guide.html','web/saved-demo-assets/architecture.svg','scripts/build-public-demo.mjs','scripts/prepare-public-release.mjs','tests/unit/public-demo.test.mjs',
 ...['record.json','events.jsonl','terminal.json'].map(n => 'tests/fixtures/historical-recovery/897203e4-d779-4c3e-8696-52ce718d537e/'+n),
 'tests/fixtures/historical-recovery/historical-recovery/897203e4-d779-4c3e-8696-52ce718d537e.resolution.json']);
await mkdir(release, {recursive: true});
const env = await readFile(join(root, '.env.local'), 'utf8');
const secrets = [...env.matchAll(/^(?:.*KEY|.*TOKEN|.*SECRET)\s*=\s*["']?([^\r\n"']+)/gm)].map(m=>m[1].trim()).filter(s=>s.length>12);
const manifest = [];
for (const file of [...files].sort()) {
  let bytes = file === specs.at(-1) ? execFileSync('git', ['show', 'HEAD:' + file]) : await readFile(join(root,file));
  if (secrets.some(secret => bytes.includes(Buffer.from(secret)))) throw Error('SECRET_FOUND_IN_RELEASE:' + file);
  await mkdir(dirname(join(release,file)), {recursive:true}); await writeFile(join(release,file), bytes);
  manifest.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await mkdir(join(release,'docs/images'),{recursive:true});
for (const [source,destination] of [
 ['task-10-final-v2-actual-showcase.png','proposals.png'],
 ['task-10-final-v2-freshpak-overview.png','proposal-overview.png'],
 ['task-10-final-v2-repaired-changes.png','critic-revision.png']]) {
  await cp(join(root,'docs/implementation',source), join(release,'docs/images',destination));
}
await writeFile(join(root,'var/submission/source-copy-manifest.json'),JSON.stringify({sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files:manifest,actualCredentialMatches:0},null,2)+'\n');
console.log(JSON.stringify({release,files:manifest.length,actualCredentialMatches:0}));
