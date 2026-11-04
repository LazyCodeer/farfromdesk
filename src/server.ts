import {socialImageProvider} from './desktop-social.js';
import {socialCreativeGuide} from './social-creative-skill.js';
import {assertCreativeRequest,renderSessionSocialCarousel} from './social-session-render.js';
import type {LocalMailHost} from './local-email/host.js';
import { reviewOrphanVoice } from './voice-attention.js';
import {ownerResearchRequest} from './agent-reach-request.js';
import {sessionResearchRead,sessionResearchRefine,sessionResearchRequest} from './session-research.js';
import {sessionSpecialty} from './session-specialty.js';
import { inboxSessions, inboxThread, inboxFeed } from './inbox-view.js';
import { saveBrainConfig } from './meta-brain-config.js';
import { dshSettings, dshStatus, readProfile, credentialRef } from './dsh-provider.js';
import { DEFAULT_DSH_LABEL, dshActiveLabelKey, dshCancel, dshLabels, dshLegacySessionKey, dshQueueState, dshSessionKey, addDshLabel } from './dsh-sessions.js';
import { listMessages, pendingMessages, sendMessage } from './dsh-inbox.js';
import { dshHome } from './dsh-paths.js';
import { SocialAssistant } from './social-assistant.js';
import { saveSessionSocialDrafts } from './social-session-drafts.js';
import { renderSessionSocialImage } from './social-session-image.js';
import { desktopSocialProof,dispatchDesktopSocial } from './desktop-social.js';
import { metaTimelineView,metaTimelineRevision } from './meta-timeline.js';
import { BrowserTabs } from './browser-tabs.js';
import {PhoneRemoteService} from './remote-desktop/phone-service.js';
import {RemoteDesktopService} from './remote-desktop/service.js';
import {RemoteControlService,voiceTranscriber} from './remote-p2p/service.js';
import {screenLockGate,sessionProbePath} from './session-lock.js';
import {RemotePasswordAccess} from './remote-desktop/access.js';
import type {PasswordRecord} from './remote-desktop/access.js';
import { DesktopControl } from './desktop-control.js';
import { MacControl } from './mac-control.js';
import { channelChosen, channelSwitchState, switchControlChannel, disconnectControlChannel } from './control-channel.js';
import { openClaudeDesktop,focusClaudeDesktop } from './session-activation.js';
import { listNamedAgents, defineNamedAgent, assignNamedAgent, syncNamedAgents } from './named-agents.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomUUID,createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import QRCode from 'qrcode';
import { stateDir, port } from './config.js';
import { homedir } from 'node:os';
import type { Store, Provider, Binding } from './store.js';
import type { Router } from './router.js';
import type { Telegram } from './telegram.js';
import type { WhatsApp } from './whatsapp.js';
import type { Masters } from './masters.js';
import type { PowerPolicy } from './power.js';
import type { Workers } from './workers.js';
import { Artifacts } from './artifacts.js';
import { Items, itemOperation } from './items.js';
import { validateAudioConfig } from './audio.js';
import { prepareVoiceModel } from './voice-model.js';
import { cleanKey, isCloud, removeVoiceKey, testVoiceKey, writeVoiceKey } from './voice-cloud.js';
import { audioReadiness } from './speech-bundle.js';
import { roleConfig, updateRole, companionStyles } from './roles.js';
import { fileTypes, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_OUTGOING_DOCUMENT_BYTES, MAX_INLINE_BYTES } from './file-types.js';
import { PREPARATION_TIMEOUT_MS } from './disk-artifacts.js';

const buildMeta=(()=>{try{return JSON.parse(readFileSync(new URL('../build.json',import.meta.url),'utf8'));}catch{return {};}})();
const sourceCommit=buildMeta.sourceCommit??null;
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export function trustedRequest(req:IncomingMessage) {
  const allowed=[`127.0.0.1:${port}`,`localhost:${port}`];
  if(!allowed.includes(req.headers.host??''))return false;
  if(req.headers.origin&&!allowed.map(h=>`http://${h}`).includes(req.headers.origin))return false;
  return true;
}
async function body(req:IncomingMessage,limit=128000) {
  if(!req.headers['content-type']?.startsWith('application/json'))throw new Error('JSON body required');
  const timer=setTimeout(()=>req.destroy(new Error('JSON request timed out')),30000);
  try {const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>limit)throw new Error('Request too large');chunks.push(bytes);}
    const data=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size));return JSON.parse(data||'{}');
  }finally{clearTimeout(timer);}
}
const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const cleanBinding=(b:Binding)=>{const {token_hash,...rest}=b;return rest;};
// A plain-language reading of the composer result. The status is the contract;
// this is only what the app can show next to it.
const APP_SEND_REASON:Record<string,string>={queued:'Waiting for the session to answer.',handled:'Handled in your chat.',blocked:'Nothing was sent to a session.',ignored:'This message was already handled.'};
export function saveBindingCredentials(b:Binding,token:string) {
  const dir=join(stateDir,'bindings');mkdirSync(dir,{recursive:true,mode:0o700});
  writeFileSync(join(dir,`${b.alias}.json`),JSON.stringify({id:b.id,token,alias:b.alias,provider:b.provider,nativeId:b.native_id,cwd:b.cwd}),{mode:0o600});
}
export function serve(store:Store,router:Router,wa:WhatsApp,adminToken:string,services?:{masters:Masters;power:PowerPolicy;workers?:Workers;telegram?:Telegram;desktopControl?:DesktopControl;macControl?:MacControl;remoteDesktop?:RemoteDesktopService;browser?:BrowserTabs;localMail?:LocalMailHost}) {
  // Execution mode is a per-session choice; binding.mode describes transport,
  // not whether a session runs in Desktop or CLI. A disagreement is unknown.
  const bindingExecutionMode=(b:Binding)=>{
    const saved=store.get(`execution-mode:${b.id}`);
    let routed:string|undefined;
    try {const route=router.native.connections?.route(b);if(route&&route.provider!==b.provider)return null;if(route)routed=route.executionMode;}catch{return null;}
    const savedMode=saved==='desktop'||saved==='cli'?saved:undefined;
    const routeMode=routed==='desktop'||routed==='cli'?routed:undefined;
    return savedMode&&routeMode&&savedMode!==routeMode?null:savedMode??routeMode??null;
  };
  let voiceSettingsRevision=0;
  const browser=services?.browser??new BrowserTabs();
  const desktopControl=services?.desktopControl??new DesktopControl(store);
  const macControl=services?.macControl??new MacControl(store);
  const remoteDesktop=services?.remoteDesktop??new RemoteDesktopService({load:()=>{try{return JSON.parse(store.get('remote-desktop-password')??'null') as PasswordRecord|undefined;}catch{return undefined;}},save:record=>store.set('remote-desktop-password',JSON.stringify(record)),loadEnabled:()=>store.get('remote-desktop-enabled')==='true',saveEnabled:value=>store.set('remote-desktop-enabled',String(value))});
  let macAccessEpoch=0;
  // App and browser automation are available only while macOS Accessibility is
  // granted. Never rely on a previously saved opt-in after permission is revoked.
  const syncMacPermission=(permission:ReturnType<MacControl['view']>)=>{
    const allowed=permission.supported===true&&permission.trusted===true;
    if(!allowed&&macControl.view().enabled){macAccessEpoch++;macControl.configure(false);desktopControl.stop();}
    else if(allowed&&!macControl.view().enabled)macControl.configure(true);
    return {...permission,enabled:allowed};
  };
  const requireMacPermission=async()=>{
    const permission=syncMacPermission(await macControl.status());
    if(!permission.enabled)throw new Error('ACCESSIBILITY_PERMISSION_REQUIRED: Allow Accessibility in macOS System Settings.');
  };
  // Desktop control runs through the vendored driver. In embedded mode that driver
  // is a child of our own helper, so macOS records the grant against FarFromDesk
  // and the driver has no separate grant of its own. Its preflight boolean can read
  // false while the path works (measured on 3 November: `accessibility: false` with
  // the app allowed and an accessibility read returning 13 elements), so it cannot
  // be the gate by itself. Ask it, and when it says no, prove the truth with a live
  // read through the driver before refusing.
  const requireDesktopPermission=async()=>{
    const permission=await desktopControl.permissionReport();
    if(permission?.accessibility)return;
    const capability=await desktopControl.capabilityProbe(5000);
    if(capability.ok)return;
    throw new Error(`ACCESSIBILITY_PERMISSION_REQUIRED: the desktop driver cannot read this Mac${capability.detail?` (${capability.detail})`:''}. Allow FarFromDesk under Privacy & Security > Accessibility, then retry.`);
  };
  const phoneRemote=new PhoneRemoteService({load:()=>{try{return JSON.parse(store.get('phone-remote-password')??'null') as PasswordRecord|undefined;}catch{return undefined;}},save:record=>store.set('phone-remote-password',JSON.stringify(record))});
  // Same remote password as Phone access; the chat command sends a peer-to-peer link.
  const remoteControl=new RemoteControlService(new RemotePasswordAccess({load:()=>{try{return JSON.parse(store.get('phone-remote-password')??'null') as PasswordRecord|undefined;}catch{return undefined;}},save:record=>store.set('phone-remote-password',JSON.stringify(record))}),undefined,text=>store.output(undefined,text,`remote-reconnect:${Date.now()}`,undefined,{plain:true}),voiceTranscriber(store));
  router.remoteControl=text=>remoteControl.chat(text);
  // A locked Mac still accepts synthetic input, but it arrives at the lock screen, so a
  // screen action is refused and the owner is handed the link the "control my screen"
  // command sends. See src/session-lock.ts for why that is the whole point.
  const requireUnlockedScreen=screenLockGate({
    probe:sessionProbePath,
    link:()=>remoteControl.chat('control my screen'),
    notify:text=>{store.output(undefined,text,`remote-locked:${Date.now()}`,undefined,{plain:true});},
  });
  const artifacts=new Artifacts(store),items=new Items(store,b=>router.coordinator?.name(b)??b.alias);
  const social=process.env.FFD_ISOLATED_LOCAL==='1'?new SocialAssistant(store.db,()=>undefined):undefined;
  artifacts.disk.recover();
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
      if(path==='/api/local-email') {
        if(!isAdmin||req.headers.origin||process.env.FFD_ISOLATED_LOCAL!=='1'){json(res,403,{error:'Email requires the Local desktop.'});return;}
        const mail=services?.localMail;if(!mail){json(res,200,{available:false,state:'unavailable'});return;}
        try {
          if(req.method==='GET'){json(res,200,mail.status());return;}
          if(req.method!=='POST')throw new Error('unsupported');
          const d=await body(req,400000);let result:unknown;
          switch(d.action){
            case 'configure': result=await mail.configure(d.account,d.credentials,d.id);break;
            case 'disconnect': result=await mail.mail.disconnect(d.accountId);break;
            case 'cleanup': await mail.mail.cleanupCredentials();result=mail.status();break;
            case 'consent': mail.setConsent(d.enabled);result=mail.status();break;
            case 'inbox': result={messages:await mail.assistant.inbox(d.accountId,d.limit??10)};break;
            case 'summary': result=await mail.assistant.summarize(d.accountId,d.limit??10);break;
            case 'prepare': result=await mail.assistant.prepareReply(d.accountId,d.uid,d.input);break;
            case 'save': result=mail.mail.saveDraft(d.accountId,d.draftId,d.input);break;
            case 'drafts': result={drafts:mail.mail.listDrafts(d.accountId)};break;
            case 'delete-draft': mail.mail.deleteDraft(d.draftId);result={ok:true};break;
            case 'send': result=await mail.send(d.accountId,d.draftId,d.revision,d.digest);break;
            case 'send-status': result=mail.mail.sendStatus(d.claimId);break;
            default: throw new Error('unsupported');
          }
          json(res,200,result);return;
        } catch {json(res,400,{error:'The email operation could not be completed. Check account, consent, and Brain settings.'});return;}
      }
      if(path==='/api/remote-control') {
        if(!isAdmin){json(res,403,{error:'Remote control settings require the app.'});return;}
        if(req.method==='GET'){json(res,200,remoteControl.status);return;}
        if(req.method==='POST'){remoteControl.stop();json(res,200,remoteControl.status);return;}
      }
      if(path==='/api/phone-remote') {
        if(!isAdmin){json(res,403,{error:'Phone Remote settings require the app.'});return;}
        if(req.method==='GET'){json(res,200,phoneRemote.status);return;}
        if(req.method==='POST'){json(res,200,await phoneRemote.command(await body(req,4096)));return;}
      }
      if(path==='/api/remote-desktop') {
        if(!isAdmin){json(res,403,{error:'Remote Desktop settings require the app.'});return;}
        if(req.method==='GET'){json(res,200,remoteDesktop.status);return;}
        if(req.method==='POST'){json(res,200,await remoteDesktop.command(await body(req,4096)));return;}
      }
      if(path==='/api/session/document'&&req.method==='POST'&&binding) {
        const d=await body(req);
        if(typeof d.requestId!=='string'||typeof d.artifactId!=='string')throw new Error('Request and prepared artifact IDs required.');
        json(res,200,artifacts.reply(binding,d.requestId,d.artifactId,d.caption??''));return;
      }
      if(path==='/api/session/delivery'&&req.method==='GET'&&binding) {json(res,200,artifacts.status(binding,url.searchParams.get('id')??''));return;}
      if(path==='/api/session/instructions'&&req.method==='GET'&&binding) {json(res,200,roleConfig(store,binding));return;}
      if(path==='/api/session/social-drafts'&&req.method==='POST'&&binding) {
        if(!social||req.headers.origin){json(res,403,{error:'Social drafts require a Local session.'});return;}
        const input=await body(req,150000);
        if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['requestId','eventId','drafts'].includes(k)))throw new Error('Use the exact Social request and generated drafts.');
        json(res,200,saveSessionSocialDrafts(store,binding,input.requestId,input.eventId,input.drafts));return;
      }
      if((path==='/api/session/social-creative'||path==='/api/session/social-render')&&req.method==='POST'&&binding){
        if(!social||req.headers.origin){json(res,403,{error:'Social creative tools require a Local session.'});return;}
        const input=await body(req,150000);
        const fields=path.endsWith('social-render')?['requestId','draftId','revision','plan']:['requestId'];
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k)))throw Error('Use the exact creative tool fields.');
        assertCreativeRequest(store,binding,input.requestId);
        json(res,200,path.endsWith('social-render')?await renderSessionSocialCarousel(store,binding,social,input.requestId,input.draftId,input.revision,input.plan):socialCreativeGuide(socialImageProvider(store,input.requestId)));return;
      }
      if(path==='/api/session/social-image'&&req.method==='POST'&&binding) {
        if(!social||req.headers.origin){json(res,403,{error:'Social images require a Local session.'});return;}
        const input=await body(req,4096);
        if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['requestId','draftId'].includes(k)))throw new Error('Use the exact Social request and saved draft.');
        json(res,200,await renderSessionSocialImage(store,binding,social,()=>router.brain.secret.read(),input.requestId,input.draftId));return;
      }
      if(path==='/api/session/research'&&req.method==='POST'&&binding) {
        const input=await body(req,4096);
        if(!input||typeof input!=='object'||Object.keys(input).some(k=>k!=='requestId'&&k!=='sourceIndex'&&k!=='focus')||(input.sourceIndex!==undefined&&input.focus!==undefined))throw new Error('Use the exact owner request ID and one source number or supported focus.');
        const result=input.sourceIndex!==undefined?await sessionResearchRead(store,router,binding,input.requestId,input.sourceIndex,sessionSpecialty):input.focus!==undefined?await sessionResearchRefine(store,router,binding,input.requestId,input.focus,sessionSpecialty):await sessionResearchRequest(store,router,binding,input.requestId,sessionSpecialty);
        json(res,200,{untrustedSourceText:true,result});return;
      }
      if(path==='/api/session/attachments'&&req.method==='GET'&&binding) {json(res,200,{attachments:router.attachments.references(binding,url.searchParams.get('requestId')??'',true)});return;}
      if(path.startsWith('/api/master/')) {
        if(!binding||!router.coordinator?.isCoordinator(binding.id)){json(res,403,{error:'Only the WhatsApp master can use this endpoint'});return;}
        return await router.coordinator!.scope.run(binding.id,async()=>{
        if(path==='/api/master/reach'&&req.method==='POST') {
          const input=await body(req,4096);
          if(!input||typeof input!=='object'||Object.keys(input).some(k=>k!=='requestId'))throw new Error('Only the exact owner request ID is accepted.');
          const result=await ownerResearchRequest(store,router,binding,input.requestId);
          json(res,200,{untrustedSourceText:true,result});return;
        }
        if(path==='/api/master/mac-control'&&req.method==='POST') {
          const {requestId,...input}=await body(req);
          router.coordinator!.ownerRequest(requestId);
          if(router.stopped&&input.action!=='stop'&&input.action!=='status')throw new Error('Background operation is paused.');
          if(input.action==='stop')macAccessEpoch++;
          if(input.action!=='stop'&&input.action!=='status'){const epoch=macAccessEpoch;await requireMacPermission();await requireUnlockedScreen(String(input.action));if(epoch!==macAccessEpoch)throw new Error('MAC_CONTROL_STOPPED');router.coordinator!.ownerRequest(requestId);if(router.stopped)throw new Error('Background operation is paused.');}
          let result=await macControl.run(`${binding.id}:${requestId}`,input);
          if(input.action==='status')result=syncMacPermission(result as ReturnType<MacControl['view']>);
          router.coordinator!.ownerRequest(requestId);
          if(input.action==='capture'){const {pngBase64,...evidence}=result as any;const artifact=artifacts.prepare(binding,requestId,'mac-control-screenshot.png',pngBase64);result={...evidence,...artifact,delivery:'prepared, not sent'};}
          store.audit('mac-control-action',binding.id,input.action);
          json(res,200,result);return;
        }
        if(path==='/api/master/browser'&&req.method==='POST') {
          if(router.stopped)throw new Error('Background operation is paused.');
          const {requestId,...input}=await body(req);
          router.coordinator!.ownerRequest(requestId);
          const result=await browser.run(`${binding.id}:${requestId}`,input);
          router.coordinator!.ownerRequest(requestId);
          store.audit('browser-action',binding.id,input.action);
          json(res,200,result);return;
        }
        if(path==='/api/master/direct'&&req.method==='POST'){const d=await body(req);json(res,200,router.coordinator!.direct(d.requestId,d.target));return;}
        if(path==='/api/master/items'&&req.method==='POST'){
          const d=await body(req),by=router.coordinator!.name(binding);
          const scopedNote=d.op==='set'&&d.note!==undefined&&d.status===undefined&&d.session===undefined;
          if(d.requestId===undefined||d.op!=='add'&&!scopedNote){json(res,200,itemOperation(items,d,by));return;}
          if(typeof d.requestId!=='string')throw new Error('An exact owner request ID is required.');
          const request=router.coordinator!.ownerRequest(d.requestId),origin=store.requestOwnerOrigin(d.requestId);
          if(!origin||request.destination!==origin.destination||origin.destination!==origin.owner&&(store.get('destination-jid')!==origin.destination||!store.get(`owned-group:${origin.destination}`)))throw new Error('This request has no verified current owner and chat. Create the item from a new owner request.');
          store.db.exec('SAVEPOINT scoped_item_add');
          try{
            if(scopedNote){
              const itemId=Number(d.id);if(!Number.isInteger(itemId)||itemId<1||!store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=? AND destination=? AND owner=?').get(itemId,origin.destination,origin.owner))throw new Error('This item does not belong to the owner and chat of this request.');
              const result=itemOperation(items,d,by,d.requestId);store.db.exec('RELEASE scoped_item_add');json(res,200,result);return;
            }
            const old=d.eventId?store.db.prepare('SELECT id FROM items WHERE event_id=?').get(String(d.eventId)) as {id:number}|undefined:undefined;
            const title=String(d.title??'').trim().replace(/\s+/g,' '),session=d.session?String(d.session).trim():null;
            const note=d.note?String(d.note).trim():null;
            const fingerprint=createHash('sha256').update(JSON.stringify([title,session,note,d.requestId])).digest('hex');
            if(old){
              const proof=store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=? AND destination=? AND owner=?').get(old.id,origin.destination,origin.owner);
              const prior=store.db.prepare('SELECT fingerprint FROM item_add_fingerprints WHERE item_id=?').get(old.id) as {fingerprint:string}|undefined;
              if(!proof||prior?.fingerprint!==fingerprint)throw new Error('This item event already belongs to different or unknown work. Use a new event ID.');
            }
            const result=itemOperation(items,old?{...d,note:undefined}:d,by,d.requestId);
            if(!result.item||!store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=? AND destination=? AND owner=?').get(result.item.id,origin.destination,origin.owner))throw new Error('Item ownership could not be verified.');
            if(!old)store.db.prepare('INSERT INTO item_add_fingerprints VALUES(?,?)').run(result.item.id,fingerprint);
            store.db.prepare('INSERT OR IGNORE INTO brain_item_routes(item_id,destination) VALUES(?,?)').run(result.item.id,origin.destination);
            store.db.exec('RELEASE scoped_item_add');json(res,200,result);return;
          }catch(e){store.db.exec('ROLLBACK TO scoped_item_add; RELEASE scoped_item_add');throw e;}
        }
        if(path==='/api/master/desktop-control'&&req.method==='POST') {
          const {requestId,...input}=await body(req);
          router.coordinator!.ownerRequest(requestId);
          if(router.stopped&&input.action!=='stop'&&input.action!=='status')throw new Error('Background operation is paused.');
          if(input.action==='stop'){macAccessEpoch++;macControl.stop();}
          if(input.action==='status'){syncMacPermission(await macControl.status());router.coordinator!.ownerRequest(requestId);}
          if(input.action!=='stop'&&input.action!=='status'){const epoch=macAccessEpoch;await requireDesktopPermission();await requireUnlockedScreen(String(input.action));if(epoch!==macAccessEpoch)throw new Error('DESKTOP_STOPPED');router.coordinator!.ownerRequest(requestId);if(router.stopped)throw new Error('Background operation is paused.');}
          const result=await desktopControl.run(`${binding.id}:${requestId}`,input,()=>{
            router.coordinator!.ownerRequest(requestId);
            if(router.stopped)throw new Error('Background operation is paused.');
          });
          router.coordinator!.ownerRequest(requestId);
          store.audit('desktop-control-action',binding.id,input.action);
          if(result?.screenshot?.pngBase64){const {pngBase64,...evidence}=result.screenshot as {pngBase64:string};const artifact=artifacts.prepare(binding,requestId,'desktop-window.png',pngBase64);json(res,200,{...result,screenshot:{...evidence,...artifact,delivery:'prepared, not sent'}});return;}
          json(res,200,result);return;
        }

        if(path==='/api/master/coordinators'&&req.method==='GET'){json(res,200,{coordinators:router.coordinator!.registry.view()});return;}
        if(path==='/api/master/delegate'&&req.method==='POST'){const d=await body(req);json(res,200,router.coordinator!.delegate(d.requestId,d.coordinatorId,d.text,d.eventId,d.itemId===undefined?undefined:Number(d.itemId)));return;}
        if(path==='/api/master/agents'&&req.method==='GET') {json(res,200,{agents:listNamedAgents(store).map(({instructions,...a})=>a)});return;}
        if(path==='/api/master/define-agent'&&req.method==='POST') {const d=await body(req);router.coordinator!.ownerRequest(d.requestId);json(res,200,defineNamedAgent(store,d));return;}
        if(path==='/api/master/assign-agent'&&req.method==='POST') {
          const d=await body(req);router.coordinator!.ownerRequest(d.requestId);
          const b=store.binding(d.bindingId);
          if(!b||!b.enabled||b.id!==binding.id&&!router.coordinator!.selected().some(s=>s.id===b.id))throw new Error('Choose the coordinator or an already selected worker.');
          json(res,200,assignNamedAgent(store,b,d.name));return;
        }
        if(path==='/api/master/sessions'&&req.method==='GET') {const p=url.searchParams.get('page')??'0';json(res,200,{text:await router.coordinator!.list(url.searchParams.get('search')??'',p==='more'||p==='back'?p:Number(p)),...router.coordinator!.pageDetails()});return;}
        if(path==='/api/master/connect'&&req.method==='POST') {const d=await body(req);json(res,200,{sessions:await router.coordinator!.connect(d.requestId,d.targets)});return;}
        if(path==='/api/master/create-worker'&&req.method==='POST') {if(!services?.workers)throw new Error('Worker creation is unavailable.');json(res,200,{operation:await services.workers.start(await body(req))});return;}
        if(path==='/api/master/worker-status'&&req.method==='GET') {if(!services?.workers)throw new Error('Worker creation is unavailable.');json(res,200,{operations:services.workers.view(url.searchParams.get('id')??undefined).filter(o=>o.masterId===binding.id)});return;}
        if(path==='/api/master/recover-worker'&&req.method==='POST') {if(!services?.workers)throw new Error('Worker creation is unavailable.');const d=await body(req);json(res,200,{operation:await services.workers.recover(d.requestId,d.id)});return;}
        if(path==='/api/master/selected'&&req.method==='GET') {json(res,200,{sessions:router.coordinator!.selected().map(b=>({id:b.id,alias:b.alias,name:router.coordinator!.name(b),provider:b.provider,executionMode:store.get(`execution-mode:${b.id}`),connection:router.native.connections?.route(b)?.label}))});return;}
        if(path==='/api/master/dispatch'&&req.method==='POST') {const d=await body(req);if(!Array.isArray(d.targets)||typeof d.text!=='string'||!d.text.trim()||d.text.length>32000||typeof d.eventId!=='string'||d.attachmentIds!==undefined&&!Array.isArray(d.attachmentIds))throw new Error('Targets, nonempty text, event ID and optional attachment IDs required');json(res,200,{jobs:router.coordinator!.dispatch(d.requestId,d.targets,d.text,d.eventId,d.attachmentIds,d.itemId===undefined?undefined:Number(d.itemId))});return;}
        if(path==='/api/master/quiet'&&req.method==='POST') {const d=await body(req);json(res,200,router.coordinator!.quiet(d.requestId,d.resolveOutcome));return;}
        if(path==='/api/master/resolve'&&req.method==='POST') {const d=await body(req);router.resolveOwner(d.requestId,d.outcome);json(res,200,{ok:true});return;}
        json(res,404,{error:'Unknown coordinator endpoint'});
        });
      }
      if(path==='/api/session/reply'&&req.method==='POST') {
        const d=await body(req),b=binding??store.binding(d.bindingId);
        if(!b?.enabled)throw new Error('Registered session is missing or paused');
        if(typeof d.text!=='string'||!d.text.trim()||d.text.length>100000)throw new Error('Reply text must be nonempty and under 100,000 characters');
        if(d.kind!==undefined&&!['progress','final'].includes(d.kind))throw new Error('Use progress or final');
        const respond=()=>router.channelReply(b,d.text,d.kind??'final',d.requestId,`direct:${b.id}:${d.eventId??randomUUID()}`,{turnId:d.turnId,outcome:d.outcome,options:d.options});
        if(typeof d.requestId==='string'&&d.requestId.startsWith('local:social:')){
          const proof=desktopSocialProof(store,d.requestId,b),origin=store.recordedIncomingInput(d.requestId);
          if(!proof||!origin||origin.owner!==proof.owner||origin.destination!==proof.destination||origin.channel!==proof.channel||origin.generation!==proof.generation)throw Error('The desktop request, session or paired owner changed.');
          const result=store.incomingOwnerContext.run(origin,()=>store.destinationContext.run(origin.destination,respond));json(res,200,result);return;
        }
        const result=respond();json(res,200,result);return;
      }
      if(path==='/api/session/poll'&&req.method==='POST'&&binding) {
        const d=await body(req);if(typeof d.clientId!=='string')throw new Error('Client ID required');
        json(res,200,{job:router.channelPoll(binding,d.clientId)});return;
      }
      if(path==='/api/session/permission'&&req.method==='POST'&&binding) {
        if(router.stopped)throw new Error('Background operation is paused; approval is unavailable.');
        const d=await body(req);if(typeof d.question!=='string')throw new Error('Question required');
        const jobs=store.unfinished(binding.id);
        const job=typeof d.requestId==='string'?store.job(d.requestId):jobs.length===1?jobs[0]:undefined;
        if(d.requestId!==undefined&&(!job||job.binding_id!==binding.id)||d.requestId===undefined&&jobs.length>1)throw new Error('Specify the exact request for this permission question.');
        const destination=job?.destination??store.destination();
        // A native question cannot be answered through the permission hook, which
        // carries allow or deny only. Tell the owner the real questions and hand
        // the prompt back to the app instead of asking for a yes or no.
        const answer=typeof d.tool==='string'&&d.tool==='AskUserQuestion'
          ?(destination?store.destinationContext.run(destination,()=>router.approvals.blockUnanswerable(binding,d.question,job?.id)):router.approvals.blockUnanswerable(binding,d.question,job?.id)).answer
          :await (destination?store.destinationContext.run(destination,()=>router.approvals.ask(binding,d.question,'approval',job?.id,'session')):router.approvals.ask(binding,d.question,'approval',job?.id,'session'));
        json(res,200,{answer});return;
      }
      // Desktop control for a named coding session, not only the WhatsApp master.
      // The request ID must be a job this exact session was given, so a session
      // cannot reach outside the work it was handed, and the macOS grant belongs to
      // the driver itself, same as the master route. There is no separate per-session
      // allowlist: the owner grants it once to the driver, in System Settings, and
      // then any session may drive the Mac on a request it was actually given.
      if(path==='/api/session/desktop-control'&&req.method==='POST'&&binding) {
        const {requestId,...input}=await body(req);
        if(typeof requestId!=='string')throw new Error('An exact owner request ID is required.');
        const job=store.job(requestId);
        if(!job||job.binding_id!==binding.id)throw new Error('This request does not belong to this session.');
        if(router.stopped&&input.action!=='stop'&&input.action!=='status'&&input.action!=='check_permissions')throw new Error('Background operation is paused.');
        if(input.action==='stop')macAccessEpoch++;
        if(input.action==='stop'&&desktopControl.view().enabled)desktopControl.stop();
        if(input.action!=='stop'&&input.action!=='status'&&input.action!=='check_permissions'){const epoch=macAccessEpoch;await requireDesktopPermission();await requireUnlockedScreen(String(input.action));if(epoch!==macAccessEpoch)throw new Error('DESKTOP_STOPPED');if(router.stopped)throw new Error('Background operation is paused.');}
        const result=await desktopControl.run(`${binding.id}:${requestId}`,input,()=>{if(router.stopped)throw new Error('Background operation is paused.');});
        store.audit('desktop-control-action',binding.id,String((input as {action?:string}).action??''));
        if(result?.screenshot?.pngBase64){const {pngBase64,...evidence}=result.screenshot as {pngBase64:string};const artifact=artifacts.prepare(binding,requestId,'desktop-window.png',pngBase64);json(res,200,{...result,screenshot:{...evidence,...artifact,delivery:'prepared, not sent'}});return;}
        json(res,200,result);return;
      }
      if(!isAdmin){json(res,403,{error:'This token can only operate its registered session'});return;}
      if(path==='/api/social/settings'){
        if(!social||req.headers.origin){json(res,403,{error:'Social settings require the Local desktop.'});return;}
        if(req.method==='POST'){
          const d=await body(req,6000);
          if(!d||!['local','meta'].includes(d.imageProvider)||Object.keys(d).some(k=>!['imageProvider','key'].includes(k)))throw Error('Choose Local SVG skill or Meta API.');
          if(d.key!==undefined){
            if(d.imageProvider!=='meta')throw Error('A Meta key is only needed for Meta API.');
            router.brain.secret.save(d.key);
          }
          if(d.imageProvider==='meta'&&!router.brain.view().configured)throw Error('Add a Meta Model API key or choose Local SVG skill.');
          store.set('social-image-provider',d.imageProvider);
        }else if(req.method!=='GET'){json(res,405,{error:'Use GET or POST.'});return;}
        json(res,200,{imageProvider:store.get('social-image-provider')==='meta'?'meta':'local',metaConfigured:router.brain.view().configured});return;
      }
      if(path==='/api/social/dispatch'&&req.method==='POST'){
        if(!social||req.headers.origin){json(res,403,{error:'Social generation requires the Local desktop.'});return;}
        json(res,200,dispatchDesktopSocial(store,router,await body(req,4096)));return;
      }
      if((path==='/api/social'||path==='/api/social/result')&&!social){json(res,404,{error:'Social is available in FarFromDesk Local only.'});return;}
      if(path==='/api/social'&&social&&req.method==='GET'){if(req.headers.origin)throw new Error('Use native desktop Social.');const id=url.searchParams.get('id'),receipt=url.searchParams.get('receipt');json(res,200,id?(receipt?{receipt:social.receipt(id,receipt)}:{draft:social.get(id)}):social.list(url.searchParams.get('before')));return;}
      if(path==='/api/social/result'&&social&&req.method==='POST'){if(req.headers.origin)throw new Error('Use native desktop Social.');const d=await body(req,20_500_000);json(res,200,{result:social.complete(d.id,d.operationId,d.result)});return;}
      if(path==='/api/social'&&social&&req.method==='POST'){
        if(req.headers.origin)throw new Error('Use native desktop Social.');
        const d=await body(req,32000);let result:unknown;
        switch(d.op){
          case 'create':result=social.create(d.brief);break;
          case 'update':result=social.update(d.id,d.revision,d.fields);break;
          case 'begin':result=social.begin(d.id,d.revision,d.kind);break;
          case 'fail':result=social.fail(d.id,d.operationId);break;
          case 'recover':result=social.recover(d.id,d.revision,d.operationId);break;
          case 'research':case 'draft':case 'image':json(res,403,{error:'Use the native Social screen to generate.'});return;
          case 'acknowledge':result=social.acknowledge(d.id,d.operationId);break;
          case 'delete':if(d.confirmed!==true)throw new Error('Confirm deletion.');result=social.delete(d.id,d.revision);break;
          case 'account':case 'remove-account':case 'prepare':case 'check':case 'review':case 'publish':json(res,403,{error:'Instagram publishing is disabled until owner-only authorization is available.'});return;
          default:throw new Error('Unknown social action.');
        }
        json(res,200,{result});return;
      }
      if(path==='/api/meta-brain'&&req.method==='POST'){if(req.headers.origin)throw new Error('Use native desktop Settings.');json(res,200,saveBrainConfig(store,router.brain.secret,await body(req)));return;}
      if(path==='/api/memory'&&req.method==='GET'){json(res,200,router.brain.owner.view());return;}
      if(path.startsWith('/api/memory')&&req.method==='POST'){
        if(req.headers.origin)throw new Error('Use native desktop Settings.');
        const d=await body(req),m=router.brain.owner;
        if(path==='/api/memory'){if(typeof d.path!=='string'||typeof d.content!=='string')throw new Error('Choose a memory file and its text.');
          // The editor sends what it loaded: if the Brain or another window changed the file since, keep theirs and show the newest.
          if(typeof d.expected==='string'&&(m.read(d.path)??'')!==d.expected){json(res,200,{...m.view(),notice:'This memory changed since you opened it, so nothing was saved. It now shows the newest version; make your change again.'});return;}
          m.write(d.path,d.content,'owner',typeof d.summary==='string'&&d.summary.trim()?d.summary:`You edited ${d.path}`);}
        else if(path==='/api/memory/undo'){if(!Number.isInteger(d.id))throw new Error('Choose a change to undo.');m.undo(d.id);}
        else throw new Error('Unknown memory action.');
        json(res,200,m.view());return;
      }
      if(path==='/api/meta-brain/tasks'&&req.method==='GET'){if(url.searchParams.get('fresh')==='1')await router.brain.refresh(router);json(res,200,{tasks:router.brain.tasks(),workItems:router.brain.memory.board()});return;}
      if(path==='/api/meta-timeline'&&req.method==='GET'){json(res,200,metaTimelineView(store));return;}
      if(path==='/api/meta-brain/verify'&&req.method==='POST'){const d=await body(req);if(d.confirmed!==true||typeof d.requestId!=='string')throw new Error('Owner verification requires an exact request and confirmation.');router.brain.verify(d.requestId);json(res,200,{ok:true});return;}

      if(path==='/api/control-channel/disconnect'&&req.method==='POST') {
        json(res,200,await disconnectControlChannel(store,{whatsapp:wa,telegram:services?.telegram},await body(req)));return;
      }
      if(path==='/api/control-channel'&&req.method==='POST') {
        const d=await body(req);json(res,200,await switchControlChannel(store,{whatsapp:wa,telegram:services?.telegram},d));return;
      }
      if(path.startsWith('/api/telegram/')&&req.method==='POST') {
        const tg=services?.telegram;if(!tg)throw new Error('Update the background service for Telegram support.');
        const d=await body(req);
        if(path==='/api/telegram/connect') {if(!services?.power.enabled)throw new Error('Allow background operation first.');if(d.token!==undefined&&typeof d.token!=='string')throw new Error('Bot token must be text.');await tg.connect(d.token);}
        else if(path==='/api/telegram/confirm') {if(!services?.power.enabled)throw new Error('Allow background operation first.');tg.confirm(d.userId);}
        else if(path==='/api/telegram/disconnect')tg.disconnect();
        else throw new Error('Unknown Telegram action.');
        json(res,200,tg.view());return;
      }
      if(path==='/api/agents'&&req.method==='GET') {json(res,200,{agents:listNamedAgents(store),installation:JSON.parse(store.get('agent-install-status')??'[]'),sync:JSON.parse(store.get('agent-sync-status')??'null')});return;}
      if(path==='/api/agents'&&req.method==='POST') {json(res,200,defineNamedAgent(store,await body(req)));return;}
      if(path==='/api/agents/sync'&&req.method==='POST') {await body(req);json(res,200,{agents:syncNamedAgents(store)});return;}
      if(path==='/api/agents/assign'&&req.method==='POST') {const d=await body(req),b=store.binding(d.bindingId);if(!b)throw new Error('Choose an exact session.');json(res,200,assignNamedAgent(store,b,d.name));return;}
      if(path==='/api/roles'&&req.method==='POST') {const d=await body(req),b=store.binding(d.bindingId);if(!b)throw new Error('Choose an exact registered session.');json(res,200,updateRole(store,b,d.style));return;}
      if(path==='/api/roles'&&req.method==='GET') {json(res,200,{styles:companionStyles,sessions:store.bindings().map(b=>{const {instructions,...role}=roleConfig(store,b);return {bindingId:b.id,...role};})});return;}
      if(path==='/api/media/capabilities'&&req.method==='GET') {json(res,200,{fileTypes,maxFileBytes:MAX_FILE_BYTES,maxImageBytes:MAX_IMAGE_BYTES,maxOutgoingDocumentBytes:MAX_OUTGOING_DOCUMENT_BYTES,maxArtifactStorageBytes:null,storagePolicy:'available-disk',maxInlineBytes:MAX_INLINE_BYTES,incomingImages:'WhatsApp-runtime-per-type-limit',preparation:'stream-v1',maxConcurrentPreparations:1,maxConcurrentDeliveries:1,liveLargeFileDeliveryVerified:false,claudeNativeImageBytes:5*1024*1024,desktop:'local-file-reference',managedCodex:'native-image-and-local-file-reference',managedClaude:'native-image-up-to-5MiB-and-local-file-reference',automaticExecution:false});return;}
      if(path==='/api/artifacts/reserve'&&req.method==='POST') {const d=await body(req),b=store.binding(d.bindingId??'');if(!b)throw new Error('Registered session required.');json(res,200,artifacts.disk.reserve(b,d.requestId,d,d.destinationMode));return;}
      if(path==='/api/artifacts/upload-cancel'&&req.method==='POST') {const d=await body(req);json(res,200,artifacts.disk.cancelUpload(d.uploadId));return;}
      if(path==='/api/artifacts/upload-status'&&req.method==='GET') {json(res,200,artifacts.disk.status(url.searchParams.get('id')??''));return;}
      if(path.startsWith('/api/artifacts/upload/')&&req.method==='PUT') {
        if(req.headers['content-type']!=='application/octet-stream'||req.headers['transfer-encoding'])throw new Error('A raw document with exact Content-Length is required.');
        const controller=new AbortController();req.once('aborted',()=>controller.abort());req.setTimeout(30000,()=>controller.abort());
        json(res,200,await artifacts.disk.receive(path.slice('/api/artifacts/upload/'.length),req,Number(req.headers['content-length']),controller.signal));return;
      }
      if(path==='/api/attachments/cancel'&&req.method==='POST') {const d=await body(req),b=store.binding(d.bindingId);if(!b)throw new Error('Unknown session.');router.attachments.cancel(b,d.requestId);json(res,200,{cancelled:true});return;}
      if(path==='/api/artifacts/cancel'&&req.method==='POST') {const d=await body(req),b=store.binding(d.bindingId);if(!b)throw new Error('Unknown session.');json(res,200,artifacts.cancel(b,d.artifactId));return;}
      if(path==='/api/media/cleanup'&&req.method==='POST') {await body(req);json(res,200,{incoming:router.attachments.cleanup(),outgoing:artifacts.cleanup()});return;}
      if(path==='/api/hook-update'&&req.method==='GET') {json(res,200,store.hookUpdate(url.searchParams.get('id')??'')??{text:'This local update has expired.'});return;}
      if(path==='/api/inbox-thread'&&req.method==='GET') {if(!isAdmin){json(res,403,{error:'Conversation history requires the app.'});return;}const id=url.searchParams.get('bindingId');const data=id?inboxThread(store,id,url.searchParams.get('beforeAt'),url.searchParams.get('beforeId')):inboxSessions(store,url.searchParams.get('q')??'');if('jobs' in data)data.jobs=data.jobs.map(j=>({...j,canClose:['submitted','uncertain','failed'].includes(j.status)&&!router.requestProtected(j.id,j.binding_id)}));json(res,200,data);return;}
      if(path==='/api/inbox-feed'&&req.method==='GET') {if(!isAdmin){json(res,403,{error:'Conversation history requires the app.'});return;}json(res,200,inboxFeed(store,{view:url.searchParams.get('view'),beforeAt:url.searchParams.get('beforeAt'),beforeKey:url.searchParams.get('beforeKey'),query:url.searchParams.get('q')}));return;}
      // The composer sends as the owner. The claim minted here is the only thing
      // that authenticates the app origin; a stopped bridge or an unpaired owner
      // chat cannot be claimed at all.
      if(path==='/api/inbox-send'&&req.method==='POST') {
        if(!isAdmin){json(res,403,{error:'Sending from the app requires the app.'});return;}
        const d=await body(req,20000),text=typeof d.text==='string'?d.text:'';
        if(!text.trim()){json(res,400,{error:'Type a message before sending.'});return;}
        if(text.length>4000){json(res,400,{error:'A message can be up to 4000 characters.'});return;}
        const destination=store.destination();
        if(router.stopped){json(res,409,{error:'The bridge is stopped. Turn background operation back on, then try again.'});return;}
        if(!destination||!store.ownerFor(destination)){json(res,409,{error:'No owner chat is connected yet. Pair WhatsApp or Telegram first.'});return;}
        const id=`app:${randomUUID()}`;
        if(!store.claimAppOrigin(id,destination,store.controlChannel(),store.get('incoming-owner-generation')??'')){json(res,409,{error:'This message could not be claimed. Try sending it again.'});return;}
        // No new dispatch path: the ordinary receive() pipeline stores, routes and answers it.
        // The flags mirror a fresh owner text message on WhatsApp or Telegram exactly: not a
        // reply, not a forward, so both transports pass ownerIntent and ownerCommand true
        // (whatsapp.ts:328, telegram.ts:192). Passing false here silently skipped the owner
        // paths that depend on them, which is not the equivalence the app promises.
        const result=await router.receive({id,text,ownerIntent:true,ownerCommand:true,ownerChoice:true});
        json(res,200,{requestId:result.requestId,status:result.status,code:result.code??null,reason:APP_SEND_REASON[result.status]??null});return;
      }
      if(path==='/api/request-events'&&req.method==='GET') {const id=url.searchParams.get('id')??'';json(res,200,{events:store.events(id),deliveries:store.deliveries(id)});return;}

      if(path==='/api/mac-control'&&req.method==='GET'){json(res,200,macControl.view());return;}
      if(path==='/api/mac-control'&&req.method==='POST') {
        const d=await body(req);
        if(Object.keys(d).length!==1||!['enable','disable','check','permission','capture-permission'].includes(d.action))throw new Error('Choose enable, disable, check, permission or capture-permission.');
        if(d.action==='disable'){macAccessEpoch++;desktopControl.stop();}
        const result=d.action==='enable'?macControl.configure(true):d.action==='disable'?macControl.configure(false):syncMacPermission(d.action==='capture-permission'?await macControl.capturePermissionRequest():await macControl.status(d.action==='permission'));
        json(res,200,result);return;
      }
      // The driver's own grant status, and whether it can actually read this Mac.
      // Which sessions may drive the Mac is decided by macOS permission alone, so
      // there is no allowlist to read or write here.
      if(path==='/api/desktop-control-permission'&&req.method==='POST'){
        const d=await body(req);
        const action=typeof d.action==='string'?d.action:'check';
        if(action!=='check'&&action!=='probe')throw new Error('Choose check or probe.');
        const permission=await desktopControl.permissionReport(15000);
        // A forced probe is the only way to re-test after the owner changes a grant,
        // and the only honest answer when the preflight says no.
        const capability=await desktopControl.capabilityProbe(15000,action==='probe');
        json(res,200,{permission,capability});return;
      }
      if(path==='/api/health'&&req.method==='GET'){json(res,200,{app:'FarFromDesk',protocol:1,sourceCommit,buildId:buildMeta.buildId??null,pid:process.pid,platform:process.platform});return;}
      if(path==='/api/update-shutdown'&&req.method==='POST') {
        await body(req);
        if(router.busy.size||router.hasPendingIngress()||wa.hasPendingIngress?.()||services?.telegram?.hasPendingIngress?.()||router.errands.hasActiveSearch()||router.approvals.pending.size||services?.masters.creating||services?.workers?.operations().some(o=>['checking','creating','awaiting_approval'].includes(o.status)))throw new Error('Finish the active request or session setup before restarting for an update. The downloaded update can be retried afterward.');
        router.stopped=true;
        json(res,200,{ok:true});setImmediate(()=>server.emit('ffd-shutdown'));return;
      }
      if(path==='/api/shutdown'&&req.method==='POST'){await body(req);json(res,200,{ok:true});setImmediate(()=>server.emit('ffd-shutdown'));return;}
      if(path==='/api/desktop/connect-sessions'&&req.method==='POST'){const d=await body(req);if(!router.coordinator||!Array.isArray(d.targets)||!d.targets.length||d.targets.length>50)throw new Error('Choose 1–50 exact sessions.');await router.coordinator.refresh();const chosen=d.targets.map((target:string)=>{const s=router.coordinator!.sessions.find(s=>`${s.provider}:${s.executionMode??'cli'}:${s.id}`===target||`${s.provider}:${s.id}`===target);if(!s||s.available===false)throw new Error('Refresh and choose an available exact session.');return s;});json(res,200,{sessions:(await router.coordinator.connectSessions(chosen,true,()=>{},d.reviewConnections===true)).map(cleanBinding)});return;}
      if(path==='/api/request-review-bulk'&&req.method==='POST') {
        const d=await body(req);if(d.confirmed!==true)throw new Error('Explicit bulk review confirmation is required.');
        json(res,200,router.reviewRequests(d.requests));return;
      }
      if(path==='/api/request-cleanup'&&req.method==='POST') {
        const d=await body(req);json(res,200,router.updateCleanup(d.enabled,d.afterHours));return;
      }
      if(path==='/api/voice-attention-review'&&req.method==='POST') {if(!isAdmin){json(res,403,{error:'Voice review requires the app.'});return;}json(res,200,reviewOrphanVoice(store,await body(req,4096)));return;}
      if(path==='/api/request-review'&&req.method==='POST') {
        const d=await body(req);
        if(typeof d.requestId!=='string'||typeof d.expectedStatus!=='string'||d.confirmed!==true)throw new Error('An exact request and explicit native-chat review confirmation are required.');
        json(res,200,router.reviewRequest(d.requestId,d.expectedStatus));return;
      }
      if(path==='/api/desktop/document'&&req.method==='POST') {
        const d=await body(req,35*1024*1024),b=store.binding(d.bindingId??'');
        if(!b||d.confirmed!==true)throw new Error('Choose an exact request and confirm the reviewed document.');
        const prepared=d.artifactId?{artifactId:d.artifactId}:artifacts.prepare(b,d.requestId,d.filename,d.base64);
        json(res,200,artifacts.reply(b,d.requestId,prepared.artifactId,d.caption??''));return;
      }
      if(path==='/api/artifacts/prepare'&&req.method==='POST') {
        const d=await body(req,35*1024*1024),b=store.binding(d.bindingId??'');
        if(!b)throw new Error('Registered session required.');
        json(res,200,artifacts.prepare(b,d.requestId,d.filename,d.base64,d.destinationMode));return;
      }
      if(path==='/api/audio-config'&&req.method==='POST') {
        const d=validateAudioConfig(await body(req));store.set('audio-config',JSON.stringify(d));store.set('audio-origin','local');json(res,200,{provider:'local-whisper',configured:true});return;
      }
      if(path==='/api/preferences'&&req.method==='POST') {
        const d=await body(req);if(typeof d.backgroundEnabled!=='boolean'||typeof d.keepAwake!=='boolean'||!services)throw new Error('Explicit background and keep-awake choices are required.');
        if(d.serverMode!==undefined&&typeof d.serverMode!=='boolean')throw new Error('Server mode must be an explicit on or off choice.');
        if(d.serverMode===true&&!d.backgroundEnabled)throw new Error('Allow background operation before enabling server mode.');
        if(d.removeServerHelper===true)await services.power.removeServerHelper();
        await services.power.update(d.backgroundEnabled,d.keepAwake,d.serverMode);json(res,200,services.power.view());return;
      }
      if(path==='/api/deepseek'&&(req.method==='GET'||req.method==='POST')) {
        // The app cannot borrow the desktop session's DeepSeek credential, so the owner stores one
        // here (or exports the variable before launching). The key is never returned, only whether
        // one is held, and the provider/model become a per-run `--patch` rather than an edit to the
        // profile the owner installed.
        let action:any=null;
        if(req.method==='POST') {
          const d=await body(req);
          action=d;
          const line=(value:unknown,label:string,max=120)=>{
            if(value===undefined)return undefined;
            if(typeof value!=='string'||value.length>max)throw new Error(`${label} has to be text.`);
            return value.trim();
          };
          const provider=line(d.provider,'The provider route');
          const model=line(d.model,'The model');
          const effort=line(d.reasoningEffort,'The reasoning effort',40);
          const keyEnv=line(d.keyEnv,'The key variable',80);
          const key=line(d.apiKey,'The API key',4000);
          if(keyEnv!==undefined&&keyEnv&&!/^[A-Z][A-Z0-9_]*$/.test(keyEnv))throw new Error('The key variable has to look like AN_ENVIRONMENT_VARIABLE.');
          if(provider!==undefined)store.set('deepseek-provider',provider);
          if(model!==undefined)store.set('deepseek-model',model);
          if(effort!==undefined)store.set('deepseek-reasoning-effort',effort);
          if(keyEnv!==undefined)store.set('deepseek-key-env',keyEnv);
          if(d.clearKey===true)store.set('deepseek-api-key','');
          else if(key!==undefined&&key)store.set('deepseek-api-key',key);
        }
        const folder=typeof action?.folder==='string'&&action.folder.trim()?action.folder.trim():(store.get('deepseek-workspace')||homedir());
        const named=(value:unknown,label:string)=>{
          const text=typeof value==='string'?value.trim():'';
          if(!text||text.length>80||!/^[A-Za-z0-9._-]+$/.test(text))throw new Error(`${label} has to be a short name without spaces.`);
          return text;
        };
        // The sessions view is what the app draws: the labelled conversations of one workspace, each
        // with its own session, queue and undelivered messages. It reads the same keys and records the
        // chat commands write, so the panel and the chat can never disagree.
        const view=()=>{
          const labels=dshLabels(name=>store.get(name)??undefined,folder);
          const active=(store.get(dshActiveLabelKey(folder))??'').trim()||DEFAULT_DSH_LABEL;
          return {
            folder,
            activeLabel:labels.includes(active)?active:DEFAULT_DSH_LABEL,
            sessions:labels.map(label=>{
              const queue=dshQueueState(folder,label);
              const stored=store.get(dshSessionKey(folder,label))||(label===DEFAULT_DSH_LABEL?store.get(dshLegacySessionKey(folder))||'':'');
              return {label,sessionId:stored||null,active:label===(labels.includes(active)?active:DEFAULT_DSH_LABEL),busy:queue.busy,waiting:queue.waiting,pending:pendingMessages(stateDir,folder,label).length};
            }),
            inboxLabel:labels.includes(active)?active:DEFAULT_DSH_LABEL,
            inbox:listMessages(stateDir,folder,labels.includes(active)?active:DEFAULT_DSH_LABEL).slice(-20),
          };
        };
        if(action?.action==='new'){
          const label=named(action.label??'','The session name');
          addDshLabel(name=>store.get(name)??undefined,(name,value)=>store.set(name,value),folder,label);
          store.set(dshSessionKey(folder,label),'');
          store.set(dshActiveLabelKey(folder),label);
        } else if(action?.action==='use'){
          const label=named(action.label??'','The session name');
          if(!dshLabels(name=>store.get(name)??undefined,folder).includes(label))throw new Error('Choose one of the DeepSeek sessions in this folder.');
          store.set(dshActiveLabelKey(folder),label);
        } else if(action?.action==='stop'){
          const label=named(action.label??'','The session name');
          dshCancel(folder,label);
        } else if(action?.action==='send'){
          const label=named(action.label??'','The session name');
          if(!dshLabels(name=>store.get(name)??undefined,folder).includes(label))throw new Error('Choose one of the DeepSeek sessions in this folder.');
          const text=typeof action.text==='string'?action.text.trim():'';
          if(!text)throw new Error('Write the message to leave for that session.');
          if(text.length>4000)throw new Error('That message is too long for an inbox note.');
          sendMessage({root:stateDir,folder,label,text,from:'the app'});
        }
        const profile=readProfile(dshHome()),keyOf=(name:string)=>credentialRef(dshHome(),name);
        const settings=dshSettings(name=>store.get(name)??undefined,profile),status=dshStatus(settings,process.env,keyOf);
        json(res,200,{...status,reasoningEffort:settings.reasoningEffort??'',hasStoredKey:!!settings.key,workspace:store.get('deepseek-workspace')??'',...view()});return;
      }
      if(path==='/api/destination'&&req.method==='POST') {
        const d=await body(req);if(d.jid!==undefined&&(typeof d.jid!=='string'||d.jid.length>100))throw new Error('Invalid group');
        json(res,200,await wa.selectDestination(d.jid));return;
      }
      if(path==='/api/group-create'&&req.method==='POST') {const d=await body(req);json(res,200,await wa.createGroup(d.name,d.operationId));return;}
      if(path==='/api/group-recover'&&req.method==='GET') {json(res,200,{groups:await wa.recoverGroups()});return;}
      if(path==='/api/master-select'&&req.method==='POST') {
        const d=await body(req);if(!services?.power.enabled)throw new Error('Allow background operation first.');
        json(res,200,await services.masters.useSession(d.provider,d.executionMode,d.sessionId,d.operationId,d.connectionRevision));return;
      }
      if(path==='/api/master-open-proposal'&&req.method==='POST') {
        const d=await body(req),op=services?.masters.operation(d.operationId),start=op?.bindingId?services?.masters.desktop.get(op.bindingId):undefined;
        if(start&&!start.parentId){await focusClaudeDesktop();json(res,200,{opened:true});return;}
        if(!start?.proposalId)throw new Error('No saved Claude proposal exists for this setup.');
        const catalog=await router.native.catalog('claude',undefined,{fresh:true});
        const parent=catalog.sessions.find(s=>s.id===start.parentId&&s.executionMode==='desktop');
        if(!parent||(start.accountScope&&parent.accountScope!==start.accountScope))throw new Error('The original Claude coordinator account is unavailable.');
        await openClaudeDesktop(parent);json(res,200,{opened:true});return;
      }
      if(path==='/api/coordinators/default'&&req.method==='POST'){const d=await body(req);if(!router.coordinator)throw new Error('Coordinators unavailable.');router.coordinator.registry.setDefault(d.bindingId);json(res,200,{ok:true});return;}
      if(path==='/api/platform-preference'&&req.method==='POST') {
        const d=await body(req);if(!services)throw new Error('Platform discovery is unavailable.');
        json(res,200,{platformPreferences:await services.masters.setPlatformPreference(d.provider,d.executionMode,d.desktopParentId,d.connectionRevision)});return;
      }
      if(path==='/api/master-select-desktop'&&req.method==='POST') {
        const d=await body(req);if(!services?.power.enabled)throw new Error('Allow background operation first.');
        json(res,200,await services.masters.useDesktop(d.sessionId,d.operationId));return;
      }
      if(path==='/api/voice-engine'&&req.method==='POST') {
        const d=await body(req);
        // A newer provider choice or removal supersedes any key check still awaiting the network.
        const revision=(d.remove===true||d.engine==='local'||isCloud(d.engine))?++voiceSettingsRevision:voiceSettingsRevision;
        if(d.remove===true){removeVoiceKey();store.set('voice-engine','local');}
        if(typeof d.fallback==='boolean')store.set('voice-fallback',d.fallback?'1':'0');
        if(d.engine==='local')store.set('voice-engine','local');
        if(isCloud(d.engine)) {
          // The brain's Meta key is reused server-side so it never travels back to the UI.
          const brainKey=d.engine==='meta'&&d.useBrainKey===true?router.brain.secret.read():undefined;
          if(d.engine==='meta'&&d.useBrainKey===true&&!brainKey)throw new Error('Save a Meta key in Brain settings first, or paste one here.');
          const key=cleanKey(brainKey??d.key);await testVoiceKey(d.engine,key);
          if(revision!==voiceSettingsRevision)throw new Error('Voice settings changed while this key was being checked. The older choice was not saved.');
          writeVoiceKey(d.engine,key);store.set('voice-engine',d.engine);
        }
        json(res,200,audioReadiness(store));return;
      }
      if(path==='/api/voice-model'&&req.method==='POST') {
        if(!store.get('audio-tools'))throw new Error('Bundled voice tools are unavailable.');
        void prepareVoiceModel(store).catch(()=>{});json(res,200,{started:true});return;
      }
      if(path==='/api/master-create'&&req.method==='POST') {
        const d=await body(req);if(!services?.power.enabled)throw new Error('Allow background operation first.');
        json(res,200,await services.masters.create(d.provider,d.operationId,d.executionMode,d.desktopParentId,d.name,d.connectionRevision,d.workspaceId,d.trustWorkspace));return;
      }
      if(path==='/api/master-options'&&req.method==='GET') {if(!services)throw new Error('Update the background service.');const fresh=url.searchParams.get('fresh')==='1';if(fresh){router.native.retryDiscovery?.();services.masters.workspaceScanner.retry();}await services.masters.discover(fresh);json(res,200,services.masters.options());return;}
      if(path==='/api/master-recover'&&req.method==='POST') {const d=await body(req);if(!services?.power.enabled)throw new Error('Allow background operation first.');json(res,200,await services.masters.recover(d.operationId));return;}
      if(path==='/api/master-abandon'&&req.method==='POST') {const d=await body(req);if(!services)throw new Error('Update the service.');json(res,200,services.masters.abandon(d.operationId));return;}
      if(path==='/api/status'&&req.method==='GET') {
        const c=router.coordinator;
        const driverPermission=await desktopControl.permissionReport(15000);
        // The pane must not show "Not allowed" for a path that works. The preflight
        // is cached for 15s and only re-tested while it disagrees with reality.
        if(!driverPermission?.accessibility)await desktopControl.capabilityProbe(15000);
        json(res,200,{metaTimelineScope:metaTimelineRevision(store),metaBrain:router.brain.view(),macControl:macControl.view(),desktopControl:desktopControl.view(),channelSwitch:await channelSwitchState(store,{whatsapp:wa,telegram:services?.telegram}),channelChosen:channelChosen(store),controlChannel:store.controlChannel(),telegram:services?.telegram?.view(),unlinkedUpdates:store.unlinkedHooks(),voiceRequests:store.voiceRequests(),commandTurns:store.commandTurns(),voice:audioReadiness(store),preferences:services?.power.view(),coordinators:c?.registry.view(),platformPreferences:services?.masters.platformPreferences(),masterSetup:services?.masters.options(url.searchParams.get('catalogRevision')??undefined),destination:wa.destination?.(),whatsapp:{phoneNumber:wa.phoneNumber?.(),status:wa.status,error:wa.error,qr:wa.qr?await QRCode.toDataURL(wa.qr):undefined},apps:['codex','claude','muse','deepseek','cursor'].map(provider=>({provider,name:provider==='codex'?'Codex':provider==='muse'?'Muse Code':provider==='deepseek'?'DeepSeek Harness':provider==='cursor'?'Cursor':'Claude Code',enabled:c?.enabled().includes(provider as Provider),sessions:c?.sessions.filter(s=>s.provider===provider).length??0,error:c?.errors[provider as Provider]})),master:c?.master()?{id:c.master()!.id,name:c.name(c.master()!),ready:true,provider:c.master()!.provider,executionMode:store.get(`execution-mode:${c.master()!.id}`)??'cli',connection:services?.masters.connections.route(c.master()!)?.label??'Existing connection · account review pending'}:null,selected:c?.selected().map(b=>({id:b.id,name:c.name(b),provider:b.provider})),bindings:store.bindings().map(b=>({...cleanBinding(b),name:store.get(`name:${b.id}`)??b.alias,executionMode:bindingExecutionMode(b),running:router.busy.has(b.id),channelOnline:Date.now()-(router.channelClients.get(b.id)?.seen??0)<20000})),requestCleanup:router.cleanupPolicy(),pendingJobs:store.pendingJobs().map(j=>({...j,canClose:['submitted','uncertain','failed'].includes(j.status)&&!router.requestProtected(j.id,j.binding_id)})),jobs:store.jobs().map(({body,...j})=>({...j,preview:body.replace(/\s+/g,' ').slice(0,180)})),approvals:router.approvals.view(),active:store.get('active')});return;
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
        router.coordinator?.registry.register(b);router.coordinator?.registry.setDefault(b.id);store.set(`name:${b.id}`,'WhatsApp master');json(res,200,{ok:true});return;
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
  // Raw uploads have their own wall-clock limit and 30-second idle timeout.
  server.requestTimeout=PREPARATION_TIMEOUT_MS;
  server.keepAliveTimeout=5000;
  server.maxHeadersCount=64;
  server.on('close',()=>{remoteControl.stop();phoneRemote.stop();desktopControl.stop();macControl.stop();void remoteDesktop.suspend().catch(()=>{});});
  server.listen(port,'127.0.0.1');return server;
}
