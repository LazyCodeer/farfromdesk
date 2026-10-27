import {createServer,type IncomingMessage} from 'node:http';
import {OwnerViewSession,type OwnerAction} from './session.js';
import {explainWithMeta} from './meta.js';

async function body(req:IncomingMessage){
  if(req.headers['content-type']!=='application/json')throw Error('JSON_REQUIRED');
  let data='';for await(const chunk of req){data+=chunk;if(data.length>8000)throw Error('BODY_TOO_LARGE');}return JSON.parse(data);
}
export function ownerViewServer(session:OwnerViewSession,meta?:{endpoint:string;model:string;key:string}){
  let origin='';const modelAbort=new AbortController();
  const server=createServer(async(req,res)=>{
    const send=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try{
      if(req.headers.host!==new URL(origin).host||![undefined,origin].includes(req.headers.origin))return send(403,{error:'ORIGIN_REFUSED'});
      if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(html);return;}
      if(req.method==='GET'&&req.url==='/view.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(js);return;}
      if(req.method==='GET'&&req.url==='/view.css'){res.writeHead(200,{'content-type':'text/css'});res.end(css);return;}
      if(req.method!=='POST'||req.headers.origin!==origin)return send(403,{error:'OWNER_BROWSER_REQUIRED'});
      const d=await body(req);
      if(req.url==='/claim'){
        const token=session.claim(typeof d.code==='string'?d.code:'');
        res.setHeader('Set-Cookie',`ffd_owner=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`);
        return send(200,{expiresAt:session.expiresAt,metaAvailable:!!meta});
      }
      const token=req.headers.cookie?.match(/(?:^|;\s*)ffd_owner=([A-Za-z0-9_-]+)/)?.[1]??'';
      session.authenticate(token);
      if(req.url==='/stop'){session.stop();modelAbort.abort();return send(200,{stopped:true});}
      if(req.url==='/frame')return send(200,await session.observe(token));
      if(req.url==='/action')return send(200,await session.act(token,d as OwnerAction));
      if(req.url==='/explain'){
        if(!meta||d.consent!==true)return send(409,{error:'META_ACCESS_AND_EXPLICIT_CONTEXT_SHARING_REQUIRED'});
        const context=session.context(token,d.frameId);
        const explanation=await explainWithMeta(context,meta,modelAbort.signal);
        session.authenticate(token);return send(200,{explanation,executed:false});
      }
      send(404,{error:'NOT_FOUND'});
    }catch(e){
      // Never return native errors, input, credentials, model responses or command strings.
      const message=(e as Error).message;
      send(409,{error:/^[A-Z_]+$/.test(message)?message:'OPERATION_FAILED_NO_AUTOMATIC_RETRY'});
    }
  });
  server.requestTimeout=10000;server.headersTimeout=5000;server.maxConnections=8;
  const expiry=setTimeout(()=>{session.stop();modelAbort.abort();server.close();},Math.max(1,session.expiresAt-Date.now()));expiry.unref();
  server.on('close',()=>{clearTimeout(expiry);session.stop();modelAbort.abort();});
  return {server,listen:()=>new Promise<string>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const a=server.address();if(!a||typeof a==='string')return reject(Error('LISTEN_FAILED'));origin=`http://127.0.0.1:${a.port}`;resolve(origin);});})};
}
/** Disconnected preview of the real viewer assets. No pairing, driver, or messaging client. */
export function ownerViewSetupServer(){
  let host='';
  const page=html.replace('Your Mac, your actions','Owner View Test · Setup only')
    .replace('Local preview • One selected window • Unlocked Mac only','Disconnected prototype. This is not the production FarFromDesk app.')
    .replace('Paste the one-time code shown on your Mac. Never enter your Mac password.','No live session is running. Use the separate FarFromDesk Owner View Test app to check native permissions. This preview has no control connection. Do not change production FarFromDesk permissions.')
    .replace('<section id="session" hidden>','<section id="session">')
    .replaceAll('<button ','<button disabled ').replaceAll('<input ','<input disabled ')
    .replace('<script src="/view.js"></script>','');
  const server=createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if(req.method!=='GET'||req.headers.host!==host||![undefined,'http://'+host].includes(req.headers.origin)){res.writeHead(403);res.end('Preview only');return;}
    if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end(page);}
    else if(req.url==='/view.css'){res.writeHead(200,{'Content-Type':'text/css'});res.end(css);}
    else{res.writeHead(404);res.end();}
  });
  return {server,listen:()=>new Promise<string>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const a=server.address();if(!a||typeof a==='string')return reject(Error('LISTEN_FAILED'));host=`127.0.0.1:${a.port}`;resolve('http://'+host);});})};
}
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FarFromDesk • Owner view</title><link rel="stylesheet" href="/view.css"><main><header><h1>Your Mac, your actions</h1><button id="stop">Stop session</button></header><p>Local preview • One selected window • Unlocked Mac only</p><label>Pairing code <input id="code" type="password" autocomplete="off"></label><button id="pair">Connect</button><p id="status" role="status">Paste the one-time code shown on your Mac. Never enter your Mac password.</p><section id="session" hidden><button id="refresh">Refresh picture</button><label><input type="checkbox" id="armed"> Enable my clicks on the picture</label><p>Refresh before each action. Only you operate these controls. Security prompts and login screens are excluded.</p><img id="screen" alt="Selected Mac window"><label>Text field <select id="field"></select></label><label>Text to insert <input id="text" maxlength="2000" autocomplete="off"></label><button id="type">Type once</button><label><input type="checkbox" id="share"> Share visible control labels with the configured Meta model for an explanation</label><button id="explain">Explain this window</button><pre id="advice"></pre></section></main><script src="/view.js"></script></html>`;
const css=`body{margin:0;background:#f5f4f0;color:#202b2b;font:16px system-ui}main{max-width:960px;margin:auto;padding:24px}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h1{font-size:26px}button,input{font:inherit;padding:10px;border:1px solid #798b89;border-radius:7px}button{cursor:pointer;background:white}#stop{background:#9b2828;color:white}label{display:block;margin:16px 0}#screen{display:block;max-width:100%;max-height:65vh;object-fit:contain;border:1px solid #aeb7b4}#status{padding:14px;background:#e1ebe5}pre{white-space:pre-wrap}button:disabled{opacity:.5}`;
const js=`const $=id=>document.getElementById(id);let frame=null,busy=false,ended=false;
const status=t=>$('status').textContent=t;
async function api(path,data={}){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
async function run(fn){if(busy||ended)return;busy=true;try{await fn();}catch(e){status(e.message+' • No action will be retried automatically.');frame=null;$('armed').checked=false;$('screen').removeAttribute('src');}finally{busy=false;}}
$('pair').onclick=()=>run(async()=>{const d=await api('/claim',{code:$('code').value});$('code').value='';$('session').hidden=false;$('pair').disabled=true;$('explain').disabled=!d.metaAvailable;status('Connected. Refresh the picture to begin.');setTimeout(()=>{ended=true;frame=null;$('screen').removeAttribute('src');status('Session expired. Reconnect from your Mac.');},Math.max(0,d.expiresAt-Date.now()));});
$('refresh').onclick=()=>run(async()=>{frame=await api('/frame');$('field').replaceChildren(...(frame.fields||[]).map(f=>{const o=document.createElement('option');o.value=f.id;o.textContent=f.label;return o;}));$('screen').src='data:image/png;base64,'+frame.png;status('Fresh picture. Actions expire in five seconds.');});
async function act(data){if(!frame)throw Error('REFRESH_PICTURE_FIRST');const id=crypto.randomUUID(),frameId=frame.frameId;frame=null;$('armed').checked=false;await api('/action',{id,frameId,...data});status('Action dispatched. Refresh and check the result before doing anything else.');}
$('screen').onclick=e=>{if(!$('armed').checked)return;const r=e.target.getBoundingClientRect();run(()=>act({kind:'click',x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}));};
$('type').onclick=()=>run(async()=>{const text=$('text').value;$('text').value='';await act({kind:'type',text,fieldId:$('field').value});});
$('explain').onclick=()=>run(async()=>{if(!frame||!$('share').checked)throw Error('REFRESH_AND_CONSENT_FIRST');const d=await api('/explain',{frameId:frame.frameId,consent:true});$('advice').textContent=d.explanation;status('Suggestion only. No action was performed.');});
$('stop').onclick=async()=>{ended=true;frame=null;$('screen').removeAttribute('src');status('Stopping. Already sent input may have taken effect.');try{await api('/stop');status('Session stopped.');}catch{status('Stop could not be confirmed. Use Stop on the Mac.');}};
document.addEventListener('visibilitychange',()=>{if(document.hidden){frame=null;$('screen').removeAttribute('src');$('armed').checked=false;}});`;
