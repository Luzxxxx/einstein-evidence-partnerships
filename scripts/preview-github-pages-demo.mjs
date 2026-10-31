// Standalone read-only static preview; never imports the application server.
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve,sep,extname} from 'node:path';
const root=resolve(process.argv[2] ?? 'var/submission/github-pages-v2');
const prefix='/einstein-evidence-partnerships/';
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.ttf':'font/ttf','.svg':'image/svg+xml','.json':'application/json'};
const server=createServer(async(req,res)=>{try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(req.method!=='GET'||!path.startsWith(prefix)){res.writeHead(404).end();return;}
  const file=resolve(root,decodeURIComponent(path.slice(prefix.length))||'index.html');
  if(!file.startsWith(root+sep)){res.writeHead(404).end();return;}
  const bytes=await readFile(file);
  res.writeHead(200,{'Content-Type':types[extname(file)]??'text/plain','Cache-Control':'no-store'}).end(bytes);
}catch{if(!res.headersSent)res.writeHead(404);res.end();}});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}${prefix}`,readOnly:true,newModelRequests:0})));
