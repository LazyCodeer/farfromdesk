import {createServer, type ServerOptions} from 'node:https';
import type {IncomingMessage} from 'node:http';
import type {OwnerBackend, OwnerAction} from '../owner-view/session.js';
import {OwnerViewSession} from '../owner-view/session.js';
import {RemotePasswordAccess} from './access.js';
import {phoneHtml,phoneCss,phoneJs} from './phone-view.js';

async function body(req:IncomingMessage){
 if(req.headers['content-type']!=='application/json')throw Error('JSON_REQUIRED');
 let length=0;const chunks:Buffer[]=[];
 for await(const part of req){const chunk=Buffer.from(part);length+=chunk.length;if(length>12000)throw Error('REQUEST_TOO_LARGE');chunks.push(chunk);}
 const d=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!d||typeof d!=='object'||Array.isArray(d))throw Error('INVALID_REQUEST');return d;
}
/** A separate TLS listener exposes only a single chosen window, never bridge routes.
 * One authenticated phone, no bearer links, no passwords or screenshots in logs.
 */
export function phoneServer(options:{tls:ServerOptions;address:string;access:RemotePasswordAccess;backend:()=>OwnerBackend;onStop:()=>void}){
 let origin='',closed=false,generation=0,busyLogin=false;
 let connection:{phone:string;owner:string;session:OwnerViewSession;backend:OwnerBackend;lastSeen:number}|undefined;
 let checking=false;
 const drop=()=>{const c=connection;connection=undefined;if(c){options.access.disconnect(c.phone);c.session.stop();}};
 const revoke=()=>{closed=true;generation++;drop();options.access.setReady(false);clearInterval(watch);};
 const server=createServer(options.tls,(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  const send=(status:number,value:unknown)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}};
  void(async()=>{
   try{
    if(closed)throw Error('ACCESS_ENDED');
    if(req.headers.host!==new URL(origin).host||![undefined,origin].includes(req.headers.origin)){send(403,{error:'ORIGIN_REFUSED'});return;}
    if(req.method==='GET'){
     const assets:Record<string,[string,string]>={'/':['text/html',phoneHtml],'/view.js':['text/javascript',phoneJs],'/view.css':['text/css',phoneCss]};
     const asset=assets[req.url??''];if(asset){res.writeHead(200,{'Content-Type':asset[0]});res.end(asset[1]);return;}
     send(404,{error:'NOT_FOUND'});return;
    }
    if(req.method!=='POST'||req.headers.origin!==origin){send(403,{error:'OWNER_BROWSER_REQUIRED'});return;}
    const d=await body(req);
    if(req.url==='/login'){
     if(busyLogin)throw Error('WAIT_BEFORE_RETRY');busyLogin=true;const current=generation;
     let candidate:OwnerBackend|undefined,phone:string|undefined;
     try{
      phone=await options.access.authenticate(d.password);
      if(closed||current!==generation)throw Error('ACCESS_ENDED');
      drop();candidate=options.backend();if(!await candidate.ready())throw Error('MAC_UNAVAILABLE');
      if(closed||current!==generation)throw Error('ACCESS_ENDED');
      const session=new OwnerViewSession(candidate,Date.now,Infinity),owner=session.claim(session.pairingCode);
      connection={phone,owner,session,backend:candidate,lastSeen:Date.now()};candidate=undefined;
      res.setHeader('Set-Cookie',`ffd_phone=${phone}; Secure; HttpOnly; SameSite=Strict; Path=/`);
      send(200,{connected:true,mode:'selected-window',network:'same-wifi'});
     }catch(e){candidate?.stop();if(phone)options.access.disconnect(phone);throw e;}finally{busyLogin=false;}
     return;
    }
    const token=req.headers.cookie?.match(/(?:^|;\s*)ffd_phone=([A-Za-z0-9_-]+)/)?.[1]??'';
    options.access.authorize(token);const c=connection;
    if(!c||c.phone!==token)throw Error('ACCESS_ENDED');c.lastSeen=Date.now();
    if(req.url==='/stop'){send(200,{stopped:true});revoke();options.onStop();return;}
    if(req.url==='/heartbeat'){send(200,{connected:true});return;}
    if(req.url==='/frame'){const frame=await c.session.observe(c.owner);options.access.authorize(token);send(200,frame);return;}
    if(req.url==='/action'){const result=await c.session.act(c.owner,d as OwnerAction);options.access.authorize(token);send(200,result);return;}
    send(404,{error:'NOT_FOUND'});
   }catch(e){const message=(e as Error).message;send(409,{error:/^[A-Z_]+$/.test(message)?message:'OPERATION_FAILED_NO_AUTOMATIC_RETRY'});}
  })();
 });
 server.requestTimeout=10000;server.headersTimeout=5000;server.maxConnections=8;
 // Revoke on a lost heartbeat, lock, target loss or permission loss, even without input.
 const watch=setInterval(()=>{const c=connection;if(!c||checking||closed)return;checking=true;
  void(async()=>{try{if(Date.now()-c.lastSeen>15000||!await c.backend.ready()){if(connection===c)drop();}}catch{if(connection===c)drop();}finally{checking=false;}})();
 },2000);watch.unref();
 server.on('close',revoke);
 return {server,stop:()=>{revoke();server.closeAllConnections();server.close();},listen:()=>new Promise<string>((resolve,reject)=>{
  server.once('error',reject);server.listen(0,options.address,()=>{const address=server.address();if(!address||typeof address==='string'){reject(Error('LISTEN_FAILED'));return;}origin=`https://${options.address}:${address.port}`;resolve(origin);});
 })};
}
