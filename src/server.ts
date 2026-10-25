import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import QRCode from 'qrcode';
import { stateDir, port } from './config.js';
import type { Store, Provider, Binding } from './store.js';
import type { Router } from './router.js';
import type { WhatsApp } from './whatsapp.js';
import type { Masters } from './masters.js';
import type { PowerPolicy } from './power.js';
import type { Workers } from './workers.js';
import { Artifacts } from './artifacts.js';
import { validateAudioConfig } from './audio.js';
import { audioReadiness } from './speech-bundle.js';

const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export function trustedRequest(req:IncomingMessage) {
  const allowed=[`127.0.0.1:${port}`,`localhost:${port}`];
  if(!allowed.includes(req.headers.host??''))return false;
  if(req.headers.origin&&!allowed.map(h=>`http://${h}`).includes(req.headers.origin))return false;
  return true;
}
async function body(req:IncomingMessage,limit=128000) {
  if(!req.headers['content-type']?.startsWith('application/json'))throw new Error('JSON body required');
  let data='';for await(const chunk of req){data+=chunk;if(data.length>limit)throw new Error('Request too large');}
  return JSON.parse(data||'{}');
}
const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const cleanBinding=(b:Binding)=>{const {token_hash,...rest}=b;return rest;};
export function saveBindingCredentials(b:Binding,token:string) {
  const dir=join(stateDir,'bindings');mkdirSync(dir,{recursive:true,mode:0o700});
  writeFileSync(join(dir,`${b.alias}.json`),JSON.stringify({id:b.id,token,alias:b.alias,provider:b.provider,nativeId:b.native_id,cwd:b.cwd}),{mode:0o600});
}
export function serve(store:Store,router:Router,wa:WhatsApp,adminToken:string,services?:{masters:Masters;power:PowerPolicy;workers?:Workers}) {
  const artifacts=new Artifacts(store);
  const server=createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    void (async()=>{
      if(!trustedRequest(req)){json(res,403,{error:'Local requests only'});return;}
      const url=new URL(req.url??'/',`http://127.0.0.1:${port}`),path=url.pathname;
      if(req.method==='GET'&&['/','/app.js','/style.css'].includes(path)) {
        json(res,410,{error:'The browser dashboard has been retired. Open FarFromDesk.'});return;
      }
      const token=(req.headers.authorization??'').replace(/^Bearer /,'');
      const isAdmin=equal(token,adminToken);
      const scopedId=req.headers['x-binding-id'];
      const binding=typeof scopedId==='string'?store.authBinding(scopedId,token):undefined;
      if(!isAdmin&&!binding){json(res,401,{error:'Use FarFromDesk or provide a valid session token.'});return;}
      if(path==='/api/session/document'&&req.method==='POST'&&binding) {
        const d=await body(req);
        if(typeof d.requestId!=='string'||typeof d.artifactId!=='string')throw new Error('Request and prepared artifact IDs required.');
        json(res,200,artifacts.reply(binding,d.requestId,d.artifactId,d.caption??''));return;
      }
      if(path==='/api/session/delivery'&&req.method==='GET'&&binding) {json(res,200,artifacts.status(binding,url.searchParams.get('id')??''));return;}
      if(path.startsWith('/api/master/')) {
        if(!binding||binding.id!==router.coordinator?.master()?.id){json(res,403,{error:'Only the WhatsApp master can use this endpoint'});return;}
        if(path==='/api/master/sessions'&&req.method==='GET') {const p=url.searchParams.get('page')??'0';json(res,200,{text:await router.coordinator.list(url.searchParams.get('search')??'',p==='more'||p==='back'?p:Number(p)),...router.coordinator.pageDetails()});return;}
        if(path==='/api/master/connect'&&req.method==='POST') {const d=await body(req);json(res,200,{sessions:await router.coordinator.connect(d.requestId,d.targets)});return;}
        if(path==='/api/master/create-worker'&&req.method==='POST') {if(!services?.workers)throw new Error('Worker creation is unavailable.');json(res,200,{operation:await services.workers.start(await body(req))});return;}
        if(path==='/api/master/worker-status'&&req.method==='GET') {if(!services?.workers)throw new Error('Worker creation is unavailable.');json(res,200,{operations:services.workers.view(url.searchParams.get('id')??undefined)});return;}
        if(path==='/api/master/recover-worker'&&req.method==='POST') {if(!services?.workers)throw new Error('Worker creation is unavailable.');const d=await body(req);json(res,200,{operation:await services.workers.recover(d.requestId,d.id)});return;}
        if(path==='/api/master/selected'&&req.method==='GET') {json(res,200,{sessions:router.coordinator.selected().map(b=>({id:b.id,alias:b.alias,name:router.coordinator!.name(b),provider:b.provider}))});return;}
        if(path==='/api/master/dispatch'&&req.method==='POST') {const d=await body(req);if(!Array.isArray(d.targets)||typeof d.text!=='string'||!d.text.trim()||d.text.length>32000||typeof d.eventId!=='string')throw new Error('Targets, nonempty text and event ID required');json(res,200,{jobs:router.coordinator.dispatch(d.requestId,d.targets,d.text,d.eventId)});return;}
        if(path==='/api/master/quiet'&&req.method==='POST') {const d=await body(req),job=store.job(d.requestId);if(!job||job.status==='replaced'||binding.id!==router.coordinator?.master()?.id||job.binding_id!==binding.id||!job.id.startsWith('report:'))throw new Error('Only a worker-report request may be acknowledged quietly');store.set(`explicit-final:${binding.id}`,String(Date.now()));store.jobState(job.id,'completed');json(res,200,{ok:true});return;}
      }
      if(path==='/api/session/reply'&&req.method==='POST') {
        const d=await body(req),b=binding??store.binding(d.bindingId);
        if(!b?.enabled)throw new Error('Registered session is missing or paused');
        if(typeof d.text!=='string'||!d.text.trim()||d.text.length>100000)throw new Error('Reply text must be nonempty and under 100,000 characters');
        if(d.kind!==undefined&&!['progress','final'].includes(d.kind))throw new Error('Use progress or final');
        router.channelReply(b,d.text,d.kind??'final',d.requestId,`direct:${b.id}:${d.eventId??randomUUID()}`);json(res,200,{queued:true});return;
      }
      if(path==='/api/session/poll'&&req.method==='POST'&&binding) {
        const d=await body(req);if(typeof d.clientId!=='string')throw new Error('Client ID required');
        json(res,200,{job:router.channelPoll(binding,d.clientId)});return;
      }
      if(path==='/api/session/permission'&&req.method==='POST'&&binding) {
        if(router.stopped)throw new Error('Background operation is paused; approval is unavailable.');
        const d=await body(req);if(typeof d.question!=='string')throw new Error('Question required');
        const answer=await router.approvals.ask(binding,d.question);
        json(res,200,{answer});return;
      }
      if(!isAdmin){json(res,403,{error:'This token can only operate its registered session'});return;}
      if(path==='/api/health'&&req.method==='GET'){json(res,200,{app:'FarFromDesk',protocol:1,pid:process.pid,platform:process.platform});return;}
      if(path==='/api/shutdown'&&req.method==='POST'){await body(req);json(res,200,{ok:true});setImmediate(()=>server.emit('ffd-shutdown'));return;}
      if(path==='/api/desktop/connect-sessions'&&req.method==='POST'){const d=await body(req);if(!router.coordinator||!Array.isArray(d.targets)||!d.targets.length||d.targets.length>50)throw new Error('Choose 1–50 exact sessions.');await router.coordinator.refresh();const chosen=d.targets.map((target:string)=>{const s=router.coordinator!.sessions.find(s=>`${s.provider}:${s.id}`===target);if(!s||s.available===false)throw new Error('Refresh and choose an available exact session.');return s;});json(res,200,{sessions:(await router.coordinator.connectSessions(chosen,true)).map(cleanBinding)});return;}
      if(path==='/api/request-review-bulk'&&req.method==='POST') {
        const d=await body(req);if(d.confirmed!==true)throw new Error('Explicit bulk review confirmation is required.');
        json(res,200,router.reviewRequests(d.requests));return;
      }
      if(path==='/api/request-cleanup'&&req.method==='POST') {
        const d=await body(req);json(res,200,router.updateCleanup(d.enabled,d.afterHours));return;
      }
      if(path==='/api/request-review'&&req.method==='POST') {
        const d=await body(req);
        if(typeof d.requestId!=='string'||typeof d.expectedStatus!=='string'||d.confirmed!==true)throw new Error('An exact request and explicit native-chat review confirmation are required.');
        json(res,200,router.reviewRequest(d.requestId,d.expectedStatus));return;
      }
      if(path==='/api/desktop/document'&&req.method==='POST') {
        const d=await body(req,14*1024*1024),b=store.binding(d.bindingId??'');
        if(!b||d.confirmed!==true)throw new Error('Choose an exact request and confirm the reviewed document.');
        const prepared=artifacts.prepare(b,d.requestId,d.filename,d.base64);
        json(res,200,artifacts.reply(b,d.requestId,prepared.artifactId,d.caption??''));return;
      }
      if(path==='/api/artifacts/prepare'&&req.method==='POST') {
        const d=await body(req,14*1024*1024),b=store.binding(d.bindingId??'');
        if(!b)throw new Error('Registered session required.');
        json(res,200,artifacts.prepare(b,d.requestId,d.filename,d.base64,d.destinationMode));return;
      }
      if(path==='/api/audio-config'&&req.method==='POST') {
        const d=validateAudioConfig(await body(req));store.set('audio-config',JSON.stringify(d));store.set('audio-origin','local');json(res,200,{provider:'local-whisper',configured:true});return;
      }
      if(path==='/api/preferences'&&req.method==='POST') {
        const d=await body(req);if(typeof d.backgroundEnabled!=='boolean'||typeof d.keepAwake!=='boolean'||!services)throw new Error('Explicit background and keep-awake choices are required.');
        await services.power.update(d.backgroundEnabled,d.keepAwake);json(res,200,services.power.view());return;
      }
      if(path==='/api/destination'&&req.method==='POST') {
        const d=await body(req);if(d.jid!==undefined&&(typeof d.jid!=='string'||d.jid.length>100))throw new Error('Invalid group');
        json(res,200,await wa.selectDestination(d.jid));return;
      }
      if(path==='/api/group-create'&&req.method==='POST') {const d=await body(req);json(res,200,await wa.createGroup(d.name,d.operationId));return;}
      if(path==='/api/group-recover'&&req.method==='GET') {json(res,200,{groups:await wa.recoverGroups()});return;}
      if(path==='/api/master-select'&&req.method==='POST') {
        const d=await body(req);if(!services?.power.enabled)throw new Error('Allow background operation first.');
        json(res,200,await services.masters.useSession(d.provider,d.executionMode,d.sessionId,d.operationId));return;
      }
      if(path==='/api/master-select-desktop'&&req.method==='POST') {
        const d=await body(req);if(!services?.power.enabled)throw new Error('Allow background operation first.');
        json(res,200,await services.masters.useDesktop(d.sessionId,d.operationId));return;
      }
      if(path==='/api/master-create'&&req.method==='POST') {
        const d=await body(req);if(!services?.power.enabled)throw new Error('Allow background operation first.');
        json(res,200,await services.masters.create(d.provider,d.operationId,d.executionMode,d.desktopParentId,d.name));return;
      }
      if(path==='/api/master-options'&&req.method==='GET') {if(!services)throw new Error('Update the background service.');await services.masters.discover(url.searchParams.get('fresh')==='1');json(res,200,services.masters.options());return;}
      if(path==='/api/master-recover'&&req.method==='POST') {const d=await body(req);if(!services?.power.enabled)throw new Error('Allow background operation first.');json(res,200,await services.masters.recover(d.operationId));return;}
      if(path==='/api/master-abandon'&&req.method==='POST') {const d=await body(req);if(!services)throw new Error('Update the service.');json(res,200,services.masters.abandon(d.operationId));return;}
      if(path==='/api/status'&&req.method==='GET') {
        const c=router.coordinator;
        json(res,200,{voice:audioReadiness(store),preferences:services?.power.view(),masterSetup:services?.masters.options(url.searchParams.get('catalogRevision')??undefined),destination:wa.destination?.(),whatsapp:{phoneNumber:wa.phoneNumber?.(),status:wa.status,error:wa.error,qr:wa.qr?await QRCode.toDataURL(wa.qr):undefined},apps:['codex','claude'].map(provider=>({provider,name:provider==='codex'?'Codex':'Claude Code',enabled:c?.enabled().includes(provider as Provider),sessions:c?.sessions.filter(s=>s.provider===provider).length??0,error:c?.errors[provider as Provider]})),master:c?.master()?{id:c.master()!.id,name:c.name(c.master()!),ready:true,provider:c.master()!.provider,executionMode:store.get(`execution-mode:${c.master()!.id}`)??'cli'}:null,selected:c?.selected().map(b=>({id:b.id,name:c.name(b),provider:b.provider})),bindings:store.bindings().map(b=>({...cleanBinding(b),name:store.get(`name:${b.id}`)??b.alias,running:router.busy.has(b.id),channelOnline:Date.now()-(router.channelClients.get(b.id)?.seen??0)<20000})),requestCleanup:router.cleanupPolicy(),pendingJobs:store.pendingJobs().map(j=>({...j,canClose:['submitted','uncertain','failed'].includes(j.status)&&!router.requestProtected(j.id,j.binding_id)})),jobs:store.jobs().map(({body,...j})=>j),approvals:router.approvals.view(),active:store.get('active')});return;
      }
      if(path==='/api/catalog'&&req.method==='GET') {
        const provider=url.searchParams.get('provider');if(!['codex','claude'].includes(provider??''))throw new Error('Unknown provider');
        json(res,200,await router.native.catalog(provider as Provider,url.searchParams.get('cursor')??undefined));return;
      }
      if(path==='/api/register'&&req.method==='POST') {
        const d=await body(req);if(!['codex','claude'].includes(d.provider)||!['desktop','channel'].includes(d.mode??'desktop'))throw new Error('Unknown provider or mode');
        if(d.provider==='codex'&&d.mode==='channel')throw new Error('Codex uses native mode.');
        if(typeof d.cwd!=='string'||!isAbsolute(d.cwd)||!existsSync(d.cwd)||!statSync(d.cwd).isDirectory())throw new Error('Select an existing absolute project directory');
        if(!/^[a-z][a-z0-9-]{0,39}$/.test(d.alias)||store.binding(d.alias))throw new Error('Choose a unique session name: lowercase letters, numbers and hyphens.');
        const nativeId=d.nativeId;
        await router.native.validate(d.provider,nativeId,d.cwd);
        const {binding:b,token:t}=store.register(d.alias,d.provider,nativeId,d.cwd,d.mode??'desktop');saveBindingCredentials(b,t);
        if(!store.get('active'))store.set('active',b.id);
        json(res,200,{binding:cleanBinding(b)});return;
      }
      if(path==='/api/action'&&req.method==='POST') {
        const d=await body(req);
        if(typeof d.command!=='string'||!d.command.startsWith('/'))throw new Error('A bridge command is required');
        await router.receive({id:`local:${randomUUID()}`,text:d.command});json(res,200,{ok:true});return;
      }
      if(path==='/api/apps'&&req.method==='POST') {
        const d=await body(req);if(!Array.isArray(d.enabled)||d.enabled.some((x:any)=>!['codex','claude'].includes(x)))throw new Error('Choose Codex or Claude Code');
        store.set('enabled-apps',JSON.stringify([...new Set(d.enabled)]));
        for(const b of store.bindings())if(!d.enabled.includes(b.provider)){store.enable(b.id,false);router.approvals.cancel(b.id);}
        const master=store.binding(store.get('master')??'');if(master&&d.enabled.includes(master.provider))store.enable(master.id,true);
        await router.coordinator?.refresh();json(res,200,{ok:true});return;
      }
      if(path==='/api/master-setup'&&req.method==='POST') {
        const d=await body(req),b=store.binding(d.bindingId);if(!b||b.provider!=='codex')throw new Error('Register an actual Codex master chat first');
        store.set('master',b.id);store.set('active',b.id);store.set(`name:${b.id}`,'WhatsApp master');json(res,200,{ok:true});return;
      }
      if(path==='/api/logout'&&req.method==='POST') {
        const d=await body(req);if(d.confirmed!==true)throw new Error('Confirm logout first.');
        if(!services)throw new Error('Update the background service.');
        try {await wa.logout();}catch(e){await services.power.update(false,false);throw e;}
        await services.power.update(false,false);wa.status='logged out';
        json(res,200,{ok:true});return;
      }
      if(path==='/api/connect'&&req.method==='POST') {await body(req);if(services&&!services.power.enabled)throw new Error('Allow background operation in Settings first.');wa.closed=false;await wa.connect();json(res,200,{ok:true});return;}
      json(res,404,{error:'Not found'});
    })().catch(e=>{if(!res.headersSent)json(res,400,{error:(e as Error).message});else res.end();});
  });
  server.headersTimeout=10000;
  server.requestTimeout=30000;
  server.keepAliveTimeout=5000;
  server.maxHeadersCount=64;
  server.listen(port,'127.0.0.1');return server;
}
