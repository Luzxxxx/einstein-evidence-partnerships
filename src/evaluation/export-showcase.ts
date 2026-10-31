import {lstat,mkdir,readFile,open} from 'node:fs/promises';import {resolve,join,parse,relative,isAbsolute} from 'node:path';
import type {RunStore} from '../storage/run-store.js';import type {DatasetSnapshot} from '../data/snapshot.js';
import {canonicalizeArtifact} from '../contracts/canonical.js';import {sha256Bytes} from '../evidence/hashing.js';
import {readApproved,ShowcaseError} from '../showcase/catalog.js';import {escapeHtml} from '../showcase/presentation.js';
async function directory(path:string){let cursor=parse(path).root;for(const part of relative(cursor,path).split(/[\\/]/).filter(Boolean)){cursor=join(cursor,part);try{const s=await lstat(cursor);if(!s.isDirectory()||s.isSymbolicLink())throw new ShowcaseError('EXPORT_UNSAFE_PATH');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await mkdir(cursor);}}}
async function existing(file:string,raw:Buffer){try{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size!==raw.length||!(await readFile(file)).equals(raw))throw new ShowcaseError('EXPORT_TARGET_CONFLICT');return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
/** One deterministic export path; incomplete collection metadata is never a formal Showcase manifest. */
export async function exportApproved(runIds:readonly string[],target:string,options:{store:RunStore;snapshot:DatasetSnapshot}){
 if(!isAbsolute(target))throw new ShowcaseError('EXPORT_ABSOLUTE_TARGET_REQUIRED');
 if(new Set(runIds).size!==runIds.length)throw new ShowcaseError('DUPLICATE_RUN');
 const archives=runIds.map(id=>readApproved(options.store,id,options.snapshot)).sort((a,b)=>a.proposal.pairKey.localeCompare(b.proposal.pairKey));
 if(new Set(archives.map(a=>a.proposal.pairKey)).size!==archives.length)throw new ShowcaseError('DUPLICATE_PAIR');
 const reasons:string[]=[];if(archives.length<3)reasons.push('THREE_DISTINCT_PAIRS_REQUIRED');if(!archives.some(a=>a.concurrency.overlapMs>0))reasons.push('REAL_CONCURRENT_ANALYSIS_REQUIRED');
 const files=new Map<string,Buffer>(),put=(file:string,text:string)=>files.set(file,Buffer.from(text,'utf8')),json=(file:string,value:unknown)=>put(file,canonicalizeArtifact(value)+'\n');
 const proposals=archives.map(a=>{const folder=a.run.runId,refs={original:`${folder}/original.json`,draft:`${folder}/draft.json`,proposal:`${folder}/proposal.html`,evidence:`${folder}/evidence.json`,review:`${folder}/review.json`,counter:`${folder}/counter.json`,trace:`${folder}/trace.jsonl`,revision:`${folder}/revision-diff.json`,reviewSnapshot:`${folder}/review-snapshot.json`};
  json(refs.original,{run:a.run,terminal:options.store.getTerminal(a.run.runId)});put(refs.draft,canonicalizeArtifact(a.draft)+'\n');put(refs.proposal,a.presentation.html);json(refs.evidence,a.evidence);json(refs.review,a.review);json(refs.counter,a.counter);put(refs.trace,a.events.map(e=>canonicalizeArtifact(e)+'\n').join(''));json(refs.revision,a.revisionDiff);json(refs.reviewSnapshot,options.store.getPublication(a.run.runId)!.proof.reviewSnapshot);
  return{runId:a.run.runId,pairKey:a.proposal.pairKey,draftHash:a.draft.draftHash,reviewHash:a.review.hash,files:refs,concurrency:a.concurrency};});
 put('index.html',`<!doctype html><html lang="en"><meta charset="utf-8"><title>Research proposals</title><body><h1>Research proposals</h1><p>${proposals.length} verified distinct pairs. ${reasons.length?'Incomplete collection: '+reasons.join(', '):'Formal collection requirements satisfied.'}</p><ul>${proposals.map(p=>`<li>${escapeHtml(p.pairKey)} <a href="${p.files.proposal}">Proposal</a> · <a href="${p.files.original}">Original JSON</a> · <a href="${p.files.evidence}">Evidence</a> · <a href="${p.files.review}">Review</a> · <a href="${p.files.trace}">Trace</a></li>`).join('')}</ul><p>Offline read-only export. No model is called by these files.</p></body></html>\n`);
 const manifest={schemaVersion:1,kind:reasons.length?'incomplete_showcase_export':'formal_showcase_export',complete:reasons.length===0,reasons,datasetCommit:options.snapshot.datasetCommit,sourceFiles:options.snapshot.files,proposals,
  files:[...files].map(([file,raw])=>({file,bytes:raw.length,sha256:sha256Bytes(raw)})),humanQuality:{labels:0,metrics:'NA',holdout:'unopened'}};
 json('export-manifest.json',manifest);if(manifest.complete)json('showcase-manifest.json',manifest);
 const root=resolve(target);await directory(root);
 if(!manifest.complete){try{await lstat(join(root,'showcase-manifest.json'));throw new ShowcaseError('EXPORT_TARGET_CONFLICT');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 // Detect conflicts before writing new files; never replace a previous export.
 for(const[file,raw]of files){const path=join(root,file);if(file.includes('/'))await directory(join(root,file.split('/')[0]!));await existing(path,raw);}
 for(const[file,raw]of files){const path=join(root,file);if(await existing(path,raw))continue;let h;try{h=await open(path,'wx');await h.writeFile(raw);await h.sync();}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||!await existing(path,raw))throw e;}finally{await h?.close();}}
 return manifest;
}
