/** Read-only file safety for readiness evidence and four already-pinned SDK aliases. */
import {lstat,readFile,realpath} from 'node:fs/promises';import {resolve,relative,parse,join,isAbsolute} from 'node:path';
export class EngineeringFileError extends Error{constructor(readonly code:string){super(code);}}
function need(value:unknown,code:string):asserts value{if(!value)throw new EngineeringFileError(code);}
async function ordinary(target:string,kind:'file'|'directory'){
 const volume=parse(target).root;let cursor=volume;
 for(const segment of relative(volume,target).split(/[\\/]/).filter(Boolean)){
  cursor=join(cursor,segment);const item=await lstat(cursor);
  need(!item.isSymbolicLink()&&(cursor===target&&kind==='file'?item.isFile():item.isDirectory()),'ENGINEERING_FILE_UNSAFE');
 }
}
export async function readEngineeringFile(projectRoot:string,absoluteFile:string,maxBytes:number):Promise<Buffer>{
 need(isAbsolute(projectRoot)&&isAbsolute(absoluteFile)&&Number.isSafeInteger(maxBytes)&&maxBytes>0,'ENGINEERING_FILE_ARGUMENT');
 const project=resolve(projectRoot),target=resolve(absoluteFile),alias=relative(project,target).replaceAll('\\','/');
 const sdk=/^node_modules\/@mozaik-ai\/core\/(package\.json|dist\/index\.(?:js|mjs|d\.ts))$/.exec(alias);
 let physical=target;
 if(sdk){
  const pnpm=resolve(project,'node_modules/.pnpm');await ordinary(pnpm,'directory');
  const packageRoot=await realpath(resolve(project,'node_modules/@mozaik-ai/core'));
  const pinned=relative(pnpm,packageRoot).replaceAll('\\','/');
  need(/^@mozaik-ai\+core@4\.2\.0(?:_[A-Za-z0-9_.@+()=-]+)?\/node_modules\/@mozaik-ai\/core$/.test(pinned),'ENGINEERING_SDK_IDENTITY');
  await ordinary(packageRoot,'directory');
  const metadataSize=await lstat(join(packageRoot,'package.json'));need(metadataSize.isFile()&&!metadataSize.isSymbolicLink()&&metadataSize.size<=maxBytes,'ENGINEERING_FILE_LIMIT');
  const metadata=JSON.parse((await readFile(join(packageRoot,'package.json'))).toString('utf8')) as Record<string,unknown>;
  need(metadata.name==='@mozaik-ai/core'&&metadata.version==='4.2.0','ENGINEERING_SDK_IDENTITY');
  physical=resolve(packageRoot,sdk[1]!);need(await realpath(target)===physical,'ENGINEERING_SDK_IDENTITY');
 }
 await ordinary(physical,'file');need((await lstat(physical)).size<=maxBytes,'ENGINEERING_FILE_LIMIT');
 const bytes=await readFile(physical);need(bytes.length<=maxBytes,'ENGINEERING_FILE_LIMIT');return bytes;
}
