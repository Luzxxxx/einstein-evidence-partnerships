import {lstat,readFile} from 'node:fs/promises';import {resolve,join,parse,relative} from 'node:path';import {ApiError} from './errors.js';
const mime:Record<string,string>={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml',png:'image/png',ico:'image/x-icon',woff2:'font/woff2'};
/** Only ordinary files below the trusted Web output root, with no hidden paths or junctions. */
export async function staticFile(root:string,path:string){
 const parts=(path==='/'?'/index.html':path).split('/').filter(Boolean);if(!parts.length||parts.some(p=>p.startsWith('.')||!/^[-A-Za-z0-9_.]+$/.test(p)))throw new ApiError(404,'NOT_FOUND','Resource not found.');
 const type=mime[parts[parts.length-1]!.split('.').pop()!];if(!type)throw new ApiError(404,'NOT_FOUND','Resource not found.');
 const file=join(resolve(root),...parts);let cursor=parse(file).root;
 try{const segments=relative(cursor,file).split(/[\\/]/);for(let i=0;i<segments.length;i++){cursor=join(cursor,segments[i]!);const s=await lstat(cursor);if(s.isSymbolicLink()||(i<segments.length-1?!s.isDirectory():!s.isFile()))throw new ApiError(403,'UNSAFE_PATH','Resource is not an ordinary Web file.');if(i===segments.length-1&&s.size>8*1024*1024)throw new ApiError(413,'STATIC_FILE_TOO_LARGE','Resource exceeds the serving limit.');}const raw=await readFile(file);if(raw.length>8*1024*1024)throw new ApiError(413,'STATIC_FILE_TOO_LARGE','Resource exceeds the serving limit.');return{raw,type};}
 catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new ApiError(404,'NOT_FOUND','Resource not found.');throw e;}
}
