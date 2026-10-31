// Isolated browser rendering of the already-built read-only saved demo.
// No application server, RunStore, model API or user browser profile is used.
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const base=process.argv[2]; assert.ok(['127.0.0.1','luzxxxx.github.io'].includes(new URL(base).hostname));
const localService=process.argv[3]==='--local-service';
const root=resolve('var/submission/final-reading-browser-'+Date.now()); await mkdir(root);
const profile=await mkdtemp(join(tmpdir(),'proofbridge-capture-'));
const requests=[],exceptions=[],captures=[],checks=[];
const original='var/submission/demo-site/dist/demo-data/';
const manifest=JSON.parse(await readFile(original+'manifest.json','utf8'));
const expected=async id=>JSON.parse(await readFile(original+manifest.routes['/api/runs/'+id+'/artifacts'].file,'utf8'));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+20000;while(Date.now()<end){const result=await check();if(result)return result;await wait(80);}throw Error('SCREENSHOT_WAIT_TIMEOUT');}
class Cdp{
  constructor(url){this.socket=new WebSocket(url);this.id=0;this.pending=new Map();this.ready=new Promise((yes,no)=>{this.socket.addEventListener('open',yes,{once:true});this.socket.addEventListener('error',no,{once:true});});this.socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.no(Error(m.error.message)):p.yes(m.result);}else this.event?.(m.method,m.params);});}
  async send(method,params={}){await this.ready;return new Promise((yes,no)=>{const id=++this.id;const timer=setTimeout(()=>{this.pending.delete(id);no(Error('CDP_TIMEOUT:'+method));},15000);this.pending.set(id,{yes,no,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  close(){this.socket.close();}
}
let cdp,closed=false,exitCode=null,failure=null;
const edge=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-features=Translate,MediaRouter','--window-size=1600,1000','about:blank'],{windowsHide:true,stdio:'ignore'});
edge.once('close',code=>{closed=true;exitCode=code;});
async function evaluate(expression){const result=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error('DOM_EVALUATION_FAILED');return result.result.value;}
async function navigate(hash,expected){await cdp.send('Page.navigate',{url:'about:blank'});await until(async()=>await evaluate('location.href')==='about:blank');await cdp.send('Page.navigate',{url:base+hash});await until(async()=>await evaluate('document.readyState')==='complete'&&(await evaluate('document.body.innerText')).includes(expected));await evaluate('document.fonts.ready.then(()=>true)');await evaluate('window.scrollTo(0,0)');await wait(250);}
async function click(selector){const rect=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);assert.ok(rect,'MISSING_CONTROL:'+selector);await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...rect,button:'left',clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...rect,button:'left',clickCount:1});}
async function capture(name){const {data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const bytes=Buffer.from(data,'base64');assert.ok(bytes.length<5*1024*1024);const path=join(root,name);await writeFile(path,bytes,{flag:'wx'});captures.push({name,path,bytes:bytes.length,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),sha256:createHash('sha256').update(bytes).digest('hex'),url:await evaluate('location.href')});console.log(JSON.stringify(captures.at(-1)));}
try{
  const portText=await until(async()=>{try{return await readFile(join(profile,'DevToolsActivePort'),'utf8');}catch{return null;}});
  const port=Number(portText.split('\n')[0]);const target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');cdp=new Cdp(target.webSocketDebuggerUrl);
  cdp.event=(method,p)=>{if(method==='Network.requestWillBeSent'&&p.request.url.startsWith('http'))requests.push({method:p.request.method,url:p.request.url});if(method==='Runtime.exceptionThrown')exceptions.push(p.exceptionDetails.text);};
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});

  if(!localService){
  await navigate('#showcase','Start with a real decision.');
  // The reading guide is static; public proposal data arrives independently.
  // Wait for the real cards rather than treating the initial loading frame as a result.
  await until(async()=>await evaluate("document.querySelectorAll('.proposal-card').length===3"));
  check('homepage has three actual proposals',await evaluate("document.querySelectorAll('.proposal-card').length===3"));
  check('home reading path has three steps',await evaluate("document.querySelectorAll('.reading-steps li').length===3"));
  await capture('01-home.png');await evaluate("document.querySelector('.reading-guide').scrollIntoView({block:'start'})");await capture('02-judge-reading-path.png');
  await click('.reading-steps li:nth-child(3) a');await until(async()=>await evaluate('document.body.innerText').then(t=>t.includes('A decision, challenged.')));
  check('deep link enters actual Changes view',await evaluate("location.hash.endsWith('&view=changes')&&document.querySelector('button[aria-label=Changes]').getAttribute('aria-current')==='page'"));
  check('natural revision keeps insufficient outcome',await evaluate("document.querySelector('.story-status').innerText.includes('Insufficient evidence')"));
  await evaluate("document.querySelector('.story-status').scrollIntoView({block:'start'})");await capture('03-real-critic-story.png');
  await click('.story-complete > summary');check('complete original comparison remains available',await evaluate("document.querySelector('.story-complete').open&&document.querySelectorAll('.claim-comparison').length>0"));
  }
  for(const id of ['d66da659-7683-4511-917f-38a9bbfefca2','4f61dda1-5656-43ec-b84a-26aa80abd541','d80bfe16-3fe3-4cfa-8334-e8b51bf4b425']){
    const data=await expected(id),draft=data.artifacts.filter(a=>a.kind==='proposal_draft').at(-1).artifact;
    await navigate('#run='+id+'&view=overview','A brief for the first conversation.');
    check('parent-bound approval note '+id,await evaluate("!!document.querySelector('.meeting-approved-note')"));
    const actual=await evaluate("[...document.querySelectorAll('.meeting-section .brief-paragraph > p')].map(e=>e.textContent)");
    const originals=['summary','technicalRationale','cooperationScope','validation','constraints','unknowns'].flatMap(k=>(draft.sections[k]??[]).map(p=>p.text));assert.deepEqual(actual,originals);checks.push('all brief paragraphs exact '+id);
  }
  await navigate('#run=4f61dda1-5656-43ec-b84a-26aa80abd541&view=overview','A brief for the first conversation.');
  await evaluate("document.querySelector('.brief-heading').scrollIntoView({block:'start'})");await capture('04-meeting-brief.png');
  await evaluate("document.querySelector('.meeting-nav a[href=\"#meeting-validation\"]').focus()");
  await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  check('keyboard navigation focuses target and preserves Run route',await evaluate("document.activeElement.id==='meeting-validation'&&location.hash.includes('run=4f61dda1')"));await capture('05-validation-plan.png');
  await click('.meeting-section .evidence-link');await until(async()=>await evaluate('document.body.innerText').then(t=>t.includes('Origin checked')));
  check('source integrity is separate from semantic meaning',await evaluate("document.querySelector('dialog').innerText.includes('This does not establish semantic support')"));await capture('06-source-inspector.png');
  await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await navigate('#run=447ecc18-ef58-4fd9-bae3-d36807fdbd3e','Analysis failed');check('failure remains failed',await evaluate("!document.querySelector('.meeting-approved-note')&&document.querySelector('.run-status').innerText.includes('Analysis failed')"));
  await navigate('#run=0fc75288-4d8b-4f0a-bee1-62f19834a8fd&view=changes','A decision, challenged.');check('adversarial replay remains diagnostic',await evaluate("document.body.innerText.includes('Diagnostic / Replay')&&document.body.innerText.includes('not a formal research proposal')&&!document.querySelector('.meeting-approved-note')"));
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  if(!localService){await navigate('#showcase','Start with a real decision.');await evaluate("document.querySelector('.reading-guide').scrollIntoView({block:'start'})");check('mobile landing has no horizontal overflow',await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));await capture('07-mobile-reading-path.png');}
  await navigate('#run=4f61dda1-5656-43ec-b84a-26aa80abd541&view=overview','A brief for the first conversation.');check('mobile brief has no horizontal overflow',await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));await capture('08-mobile-brief.png');
  await navigate('#run=b738ce31-0d8d-4eba-a01e-f4deac26a632&view=changes','A decision, challenged.');check('mobile revision has no horizontal overflow',await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));await capture('09-mobile-review-story.png');
  for(const id of manifest.runIds){const response=JSON.parse(await readFile(original+manifest.routes['/api/runs/'+id].file,'utf8'));const titles={approved:response.run.input.mode==='adversarial'?'Review approved':'Analysis approved',failed:'Analysis failed',insufficient:'Insufficient evidence',cancelled:'Analysis cancelled'};await navigate('#run='+id,titles[response.run.status]);check('saved terminal readable '+id,await evaluate('document.querySelector(".run-status h2").textContent')===titles[response.run.status]);}
  assert.equal(exceptions.length,0);assert.ok(requests.every(r=>r.method==='GET'&&r.url.startsWith(base)));
}catch(error){failure=error.message;console.error(failure);if(cdp){await writeFile(join(root,'failure-visible-text.txt'),await evaluate('document.body.innerText'),{flag:'wx'});await capture('failure-diagnostic.png');}}
finally{if(cdp){try{await cdp.send('Browser.close');}catch{}cdp.close();}try{await until(()=>closed);}catch{}await writeFile(join(root,'capture-audit.json'),JSON.stringify({at:new Date().toISOString(),base,checks,captures,requests,exceptions,newModelRequests:0,userProfileUsed:false,browserPid:edge.pid,browserClosed:closed,browserExitCode:exitCode,failure},null,2),{flag:'wx'});console.log(JSON.stringify({root,checks:checks.length,captures:captures.length,browserClosed:closed,newModelRequests:0,failure}));}
if(failure)process.exitCode=1;
