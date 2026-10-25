import makeWASocket,{useMultiFileAuthState,DisconnectReason,jidNormalizedUser,normalizeMessageContent,Browsers,proto,type WASocket} from '@whiskeysockets/baileys';
import pino from 'pino';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { stateDir } from './config.js';
import type { Store } from './store.js';
import type { Router } from './router.js';
import { transcribeAudio, audioFormat, type AudioObserver } from './audio.js';
import { createHash } from 'node:crypto';
import { BufferJSON } from '@whiskeysockets/baileys';
import { disposeIncoming, incomingMetadata, type AttachmentKind, type IncomingFile } from './attachments.js';
import { Artifacts } from './artifacts.js';
import { sendDiskDocument, MediaHostLimitError } from './document-delivery.js';
import { errorCode } from './request-events.js';

export function isSelfMessage(key:{fromMe?:boolean|null;remoteJid?:string|null;remoteJidAlt?:string|null},owners:string[]) {
  if(key.fromMe!==true)return false;
  return [key.remoteJid,key.remoteJidAlt].some(j=>j&&owners.includes(jidNormalizedUser(j)));
}
export function ownerOnlyGroup(metadata:any,owners:string[]) {
  return Array.isArray(metadata?.participants)&&metadata.participants.length>0&&metadata.participants.every((p:any)=>
    [p.id,p.phoneNumber,p.lid].some(id=>typeof id==='string'&&owners.includes(jidNormalizedUser(id))));
}
export class WhatsApp {
  sock?:WASocket; qr?:string; status='not paired'; error?:string;
  owners:string[]=[]; selfJid?:string;
  closed=false; connecting=false; attempts=0; flushing=false;
  reconnect?:NodeJS.Timeout; flusher?:NodeJS.Timeout;
  creatingGroup=false;
  loggingOut=false;
  stopAuth?:()=>void;
  authWrites=new Set<Promise<void>>();
  receiving=new Set<string>();
  audioBusy=0;
  audioControllers=new Set<AbortController>();
  mediaControllers=new Set<AbortController>();
  downloadFile=(media:any,kind:AttachmentKind,signal?:AbortSignal)=>this.router.attachments.download(media,kind,signal);
  artifacts:Artifacts;
  sendDocument=sendDiskDocument;
  transcribe=(audio:any,signal?:AbortSignal,observe?:AudioObserver)=>transcribeAudio(this.store,audio,signal,observe);
  constructor(private store:Store,private router:Router,private authDirectory=join(stateDir,'whatsapp-auth')) {
    this.artifacts=new Artifacts(store);
    router.attachments.interrupt('The bridge restarted while downloading your attachment. Please resend it.');
    router.attachments.cleanup();this.artifacts.cleanup();
  }
  phoneNumber() {
    if(this.status==='logged out')return undefined;
    const jid=this.selfJid??this.store.get('whatsapp-owner');
    const match=jid&&/^(\d{7,15})@s\.whatsapp\.net$/.exec(jidNormalizedUser(jid));
    return match?`+${match[1]}`:undefined;
  }
  async logout() {
    if(this.loggingOut)throw new Error('Logout is already in progress.');
    if(!this.sock||this.status!=='connected')throw new Error('Reconnect to log out here, or remove this device in WhatsApp → Linked devices.');
    this.loggingOut=true;
    try {
      await this.sock.logout();
      this.close();
      await Promise.allSettled([...this.authWrites]);
      await rm(this.authDirectory,{recursive:true,force:true});
      this.qr=undefined;this.selfJid=undefined;this.owners=[];
      this.status='logged out';this.error=undefined;
      this.store.audit('whatsapp-logout');
      // Keep the original owner binding so old queues cannot leak to a different account.
      return {ok:true};
    }catch {
      throw new Error('Logout could not finish. Reconnect and try again, or remove this device in WhatsApp → Linked devices.');
    }finally{this.loggingOut=false;}
  }
  destination(){return {jid:this.store.get('destination-jid')??this.selfJid??null,kind:this.store.get('destination-kind')??'self',name:this.store.get('destination-name')??'Message yourself'};}
  async verifyGroup(jid:string) {
    if(!this.sock||!this.store.get(`owned-group:${jid}`))throw new Error('This group is not registered to this bridge.');
    if(!ownerOnlyGroup(await this.sock.groupMetadata(jid),this.owners))throw new Error('Group forwarding paused: remove other participants or choose Message yourself. Only an owner-only group is supported.');
  }
  async selectDestination(jid?:string) {
    if(this.status!=='connected'||!this.selfJid)throw new Error('Connect WhatsApp first.');
    const target=jid??this.selfJid;
    if(target!==this.selfJid)await this.verifyGroup(target);
    this.store.set('destination-jid',target);this.store.set('destination-kind',target===this.selfJid?'self':'group');
    this.store.set('destination-name',target===this.selfJid?'Message yourself':this.store.get(`owned-group:${target}`)!);
    const op=JSON.parse(this.store.get('group-operation')??'null');
    if(op&&target!==this.selfJid)this.store.set('group-operation',JSON.stringify({...op,jid:target,status:'created'}));
    return this.destination();
  }
  async createGroup(name:string,operationId:string) {
    if(typeof name!=='string'||!name.trim()||name.length>70||/[\r\n\x00-\x1f]/.test(name))throw new Error('Choose a group name of 1–70 characters.');
    if(!/^[0-9a-f-]{36}$/i.test(operationId))throw new Error('A stable creation ID is required.');
    if(this.status!=='connected'||!this.sock)throw new Error('Connect WhatsApp first.');
    const prior=this.store.get('group-operation');
    if(prior){const op=JSON.parse(prior);if(op.jid){await this.selectDestination(op.jid);return op;}
      throw new Error('An earlier group creation is unconfirmed. Use Recover group; do not create another group blindly.');}
    if(this.creatingGroup)throw new Error('Group creation is already in progress.');
    this.creatingGroup=true;
    this.store.set('group-operation',JSON.stringify({id:operationId,name:name.trim(),status:'creating'}));
    try {
      const group=await this.sock.groupCreate(name.trim(),[]);
      const op={id:operationId,name:name.trim(),jid:group.id,status:'created'};
      this.store.set(`owned-group:${group.id}`,name.trim());this.store.set('group-operation',JSON.stringify(op));
      await this.selectDestination(group.id);return op;
    }catch(e){const op=JSON.parse(this.store.get('group-operation')!);if(!op.jid){op.status='uncertain';this.store.set('group-operation',JSON.stringify(op));}throw e;}
    finally{this.creatingGroup=false;}
  }
  async recoverGroups() {
    if(!this.sock||this.status!=='connected')throw new Error('Connect WhatsApp first.');
    const groups=await this.sock.groupFetchAllParticipating();
    const op=JSON.parse(this.store.get('group-operation')??'null');
    const matches=Object.values(groups).filter(g=>ownerOnlyGroup(g,this.owners)&&(this.store.get(`owned-group:${g.id}`)||(op&&g.subject===op.name)));
    for(const g of matches)this.store.set(`owned-group:${g.id}`,g.subject);
    return matches.map(g=>({id:g.id,name:g.subject}));
  }
  async connect() {
    if(this.closed||this.connecting||this.sock||this.loggingOut)return;
    this.connecting=true;
    try {
      const {state,saveCreds}=await useMultiFileAuthState(this.authDirectory);
      if(this.closed)return; // Consent may have been withdrawn while reading credentials.
      let authActive=true;
      this.stopAuth=()=>{authActive=false;};
      const write=async(operation:()=>Promise<void>)=>{
        if(!authActive)return;
        const pending=operation();this.authWrites.add(pending);
        try{await pending;}finally{this.authWrites.delete(pending);}
      };
      const setKeys=state.keys.set;
      state.keys.set=data=>write(async()=>{await setKeys(data);});
      this.status='connecting';
      const sock=makeWASocket({auth:state,logger:pino({level:'silent'}),browser:(process.platform==='win32'?Browsers.windows:process.platform==='darwin'?Browsers.macOS:Browsers.ubuntu)('FarFromDesk'),markOnlineOnConnect:false,syncFullHistory:false,shouldSyncHistoryMessage:()=>false,emitOwnEvents:false,
        getMessage:async key=>{const r=this.store.db.prepare('SELECT body,artifact_id,wa_message FROM outbox WHERE wa_id=?').get(key.id??'') as any;return r?.wa_message?JSON.parse(r.wa_message,BufferJSON.reviver):r&&!r.artifact_id?{conversation:r.body}:undefined;}});
      this.sock=sock;
      sock.ev.on('creds.update',()=>void write(saveCreds).catch(()=>{this.error='Could not save WhatsApp credentials';}));
      sock.ev.on('connection.update',u=>{
        if(this.sock!==sock)return;
        if(u.qr){this.qr=u.qr;this.status='scan QR';this.error=undefined;}
        if(u.connection==='open') {
          this.qr=undefined;this.status='connected';this.error=undefined;this.attempts=0;
          this.owners=[sock.user?.id,sock.user?.lid].filter((x):x is string=>!!x).map(jidNormalizedUser);
          this.selfJid=jidNormalizedUser(sock.user!.id);
          const saved=this.store.get('whatsapp-owner');
          if(saved&&saved!==this.selfJid){this.status='account mismatch';this.error='Linked account differs from the original owner. Stop and reconfigure locally.';this.close();return;}
          this.store.set('whatsapp-owner',this.selfJid);
          if(!this.store.get('destination-jid')){this.store.set('destination-jid',this.selfJid);this.store.set('destination-kind','self');}
          void this.flush();
        }
        if(u.connection==='close') {
          authActive=false;
          this.sock=undefined;this.qr=undefined;
          const code=(u.lastDisconnect?.error as any)?.output?.statusCode;
          if(code===DisconnectReason.loggedOut){this.status='logged out';this.error='WhatsApp unlinked this device. Re-pair in Session Bridge.app.';return;}
          this.status='reconnecting';this.error=`WhatsApp connection closed (${code??'network'})`;
          if(!this.closed&&!this.loggingOut)this.reconnect=setTimeout(()=>void this.connect().catch(()=>{}),Math.min(60000,1000*2**Math.min(this.attempts++,6))+Math.random()*1000);
        }
      });
      sock.ev.on('messages.upsert',e=>{
        if(this.sock!==sock||e.type!=='notify'||this.status!=='connected')return;
        for(const m of e.messages)void this.receiveMessage(m).catch(()=>{this.error='Incoming message could not be processed.';});
      });
      sock.ev.on('messages.update',updates=>{
        if(this.sock!==sock||this.closed||this.loggingOut||this.status!=='connected')return;
        for(const {key,update} of updates)this.receiveReceipt(key,update.status);
      });
      sock.ev.on('message-receipt.update',updates=>{
        if(this.sock!==sock||this.closed||this.loggingOut||this.status!=='connected')return;
        for(const {key,receipt} of updates){
          if(!receipt.userJid||!this.owners.includes(jidNormalizedUser(receipt.userJid)))continue;
          if(receipt.readTimestamp||receipt.playedTimestamp)this.receiveReceipt(key,proto.WebMessageInfo.Status.READ);
          else if(receipt.receiptTimestamp)this.receiveReceipt(key,proto.WebMessageInfo.Status.DELIVERY_ACK);
        }
      });
      if(!this.flusher)this.flusher=setInterval(()=>void this.flush(),1500);
    } finally {this.connecting=false;}
  }
  receiveReceipt(key:{id?:string|null;remoteJid?:string|null;fromMe?:boolean|null},status?:number|null) {
    if(this.closed||this.loggingOut||this.status!=='connected'||key.fromMe!==true||!key.id||!key.remoteJid)return false;
    const destination=key.remoteJid.endsWith('@g.us')?key.remoteJid:this.owners.includes(jidNormalizedUser(key.remoteJid))?this.selfJid:undefined;
    if(!destination)return false;
    if(status===proto.WebMessageInfo.Status.READ||status===proto.WebMessageInfo.Status.PLAYED)return this.store.deliveryReceipt(key.id,destination,'read');
    if(status===proto.WebMessageInfo.Status.DELIVERY_ACK)return this.store.deliveryReceipt(key.id,destination,'delivered');
    return false; // SERVER_ACK alone proves neither delivery nor reading.
  }
  async receiveMessage(m:any) {
    if(this.closed||this.loggingOut||this.router.stopped||this.status!=='connected'||!m.key?.id||this.store.isOurs(m.key.id)||m.key.fromMe!==true)return;
    const id=`wa:${m.key.id}`,destination=this.destination().jid,self=isSelfMessage(m.key,this.owners);
    const group=m.key.remoteJid===destination&&destination?.endsWith('@g.us');
    if((!self&&!group)||this.store.seen(id)||this.receiving.has(id))return;
    const msg=normalizeMessageContent(m.message),audio=msg?.audioMessage;
    const media=msg?.imageMessage??msg?.documentMessage,kind:AttachmentKind=msg?.imageMessage?'image':'document';
    let text=msg?.conversation??msg?.extendedTextMessage?.text;
    if(!text&&!audio&&!media)return;
    this.receiving.add(id);
    try {
      if(group)await this.verifyGroup(destination!);
      if(this.closed||this.loggingOut||this.router.stopped)return;
      const origin=self?this.selfJid!:destination!;
      await this.store.destinationContext.run(origin,async()=>{
        if(media) {
          if(!this.store.db.prepare("INSERT OR IGNORE INTO media_inbox VALUES(?,?,'processing',?)").run(id,origin,Date.now()).changes)return;
          const controller=new AbortController();let file:IncomingFile|undefined;
          try {
            incomingMetadata(media,kind);
            const incoming={id,text:media.caption??'',quotedId:media.contextInfo?.stanzaId??undefined};
            const target=this.router.attachmentTarget(incoming);
            if(this.mediaControllers.size>=2)throw new Error('Two attachments are already downloading. Please wait, then resend this one.');
            this.mediaControllers.add(controller);
            file=await this.downloadFile(media,kind,controller.signal);
            if(this.closed||this.loggingOut||this.router.stopped)return;
            if(group)await this.verifyGroup(origin);
            if(this.closed||this.loggingOut||this.router.stopped)return;
            this.router.receiveAttachment(incoming,file,target);
          }catch(e) {
            if(this.closed)return;
            const message=(e as Error).message;
            const safe=/^(?:Use a simple|Unsupported|Attachment |Files must|Text files|Binary data|Invalid (?:PDF|PNG|JPEG|WebP|GIF|ZIP|gzip|executable|WebAssembly)|Expected a complete|The intended session|Choose an exact session|That quoted message|Session is missing|Two attachments|Incoming attachment)/;
            this.store.output(undefined,safe.test(message)?message:'I couldn’t receive this attachment. Please resend a supported image or document. Documents support the WhatsApp ceiling of 2,097,152,000 bytes when disk space permits.',`media-error:${id}`,origin);
            this.store.remember(id);this.store.db.prepare("UPDATE media_inbox SET status='failed' WHERE id=?").run(id);
          }finally{disposeIncoming(file);this.mediaControllers.delete(controller);}
          return;
        }
        if(audio) {
          const claimed=this.store.db.prepare("INSERT OR IGNORE INTO audio_inbox VALUES(?,?,'processing',?)").run(id,origin,Date.now());
          if(!claimed.changes)return;
          let started=false,routingStarted:number|undefined;const controller=new AbortController();
          this.store.event(id,'voice_received',{audioSeconds:Number(audio.seconds),engine:'whisper.cpp',model:this.store.get('audio-origin')==='bundled'?'bundled':'custom'});
          const routing=()=>JSON.stringify([this.store.get('active'),this.store.get('master'),this.store.get('selected')]);
          const originalRouting=routing();
          try {
            audioFormat(audio);
            if(this.audioBusy>=2)throw new Error('Two voice notes are already processing. Please wait for their replies, then resend this one.');
            this.audioBusy++;started=true;this.audioControllers.add(controller);
            this.store.output(undefined,'Voice note received. I’m transcribing it locally on your computer.',`audio-progress:${id}`,origin);
            text=await this.transcribe(audio,controller.signal,event=>this.store.voiceEvent(id,event));
            if(this.closed||this.loggingOut||this.router.stopped)return; // Restart recovery reports interruption.
            if(group)await this.verifyGroup(origin);
            if(this.closed||this.loggingOut||this.router.stopped)return;
            routingStarted=performance.now();this.store.voiceEvent(id,{stage:'route',state:'started'});
            if(routing()!==originalRouting)throw new Error('The selected session changed during transcription. Please resend the note to the intended session.');
            if(!text?.trim()||text.length>32000)throw new Error('No clear speech detected. Please resend or type your message.');
            if(/^\/(?:approve|deny|answer)\b/i.test(text.trim()))throw new Error('Please type permission decisions explicitly; voice transcription may mishear them.');
            const result=await this.router.receive({id,text,quotedId:audio.contextInfo?.stanzaId??undefined});
            const routed=result.status==='queued'||result.status==='handled';
            this.store.voiceEvent(id,{stage:'route',state:routed?'completed':'failed',durationMs:performance.now()-routingStarted,...(!routed?{code:result.code??'routing_unavailable'}:{})});
            this.store.db.prepare('UPDATE audio_inbox SET status=? WHERE id=?').run(routed?'processed':'routing_blocked',id);
            if(!routed&&result.status!=='blocked')this.store.output(undefined,'Your voice note was transcribed, but could not be routed. Select an active session, then send a new request.',`audio-route:${id}`,origin);
          }catch(e) {
            if(this.closed)return;
            if(routingStarted!==undefined)this.store.voiceEvent(id,{stage:'route',state:'failed',durationMs:performance.now()-routingStarted,code:errorCode(e)});
            this.store.event(id,'voice_failed',{code:errorCode(e)});
            // Never echo provider output, media URLs, transcript or command paths.
            const allowed=/^(?:Voice transcription is not configured|Unsupported voice-note format|Voice notes must|Two voice notes|The selected session changed|No clear speech detected|Please type permission)/;
            const message=allowed.test((e as Error).message)?(e as Error).message:'I couldn’t transcribe this voice note. Please resend a clear recording (up to 5 minutes for local transcription), or type your message.';
            this.store.output(undefined,message,`audio-error:${id}`,origin);this.store.remember(id);
            this.store.db.prepare('UPDATE audio_inbox SET status=? WHERE id=?').run(routingStarted===undefined?'failed':'routing_blocked',id);
          }finally{if(started)this.audioBusy--;this.audioControllers.delete(controller);}
          return;
        }
        if(self&&text!.trim()==='/self') {
          await this.selectDestination();this.store.output(undefined,'Switched to Message yourself. You can continue here.',`self-switch:${m.key.id}`,origin);this.store.remember(id);return;
        }
        await this.router.receive({id,text:text!,quotedId:msg?.extendedTextMessage?.contextInfo?.stanzaId??undefined});
      });
    }finally{this.receiving.delete(id);}
  }
  async flush() {
    if(this.loggingOut||this.flushing||this.status!=='connected'||!this.sock||!this.selfJid)return;
    this.flushing=true;
    try {
      for(let i=0;i<5;i++) {
        const m=this.store.outbound();if(!m)break;
        if(m.binding_id&&!this.store.binding(m.binding_id)?.enabled)continue;
        const destination:string=m.destination??this.selfJid;
        try {
          const sock:WASocket=this.sock;
          if(destination!==this.selfJid)await this.verifyGroup(destination);
          if(this.closed||this.loggingOut||this.status!=='connected'||this.sock!==sock)return;
          let content:any={text:m.body},sent:any;
          if(m.artifact_id) {
            const a=this.store.db.prepare('SELECT * FROM artifacts WHERE id=? AND binding_id=?').get(m.artifact_id,m.binding_id) as any;
            const b=this.store.binding(m.binding_id),job=a&&this.store.job(a.request_id);
            if(!a||a.removed_at||a.owner&&a.owner!==this.selfJid||a.native_id&&a.native_id!==b?.native_id||!job||job.binding_id!==m.binding_id||['replaced','cancelled','reviewed','auto_closed'].includes(job.status)||a.destination&&a.destination!==destination||!a.storage_key&&createHash('sha256').update(a.data).digest('hex')!==a.sha256){this.store.db.prepare("UPDATE outbox SET status='failed',error='Prepared document integrity or ownership check failed' WHERE id=?").run(m.id);continue;}
            if(a.storage_key) {
              sent=await this.sendDocument(sock,destination,a,m.body,m.wa_id,this.artifacts.disk,async()=>{
                if(this.closed||this.loggingOut||this.router.stopped||this.status!=='connected'||this.sock!==sock)throw new Error('WhatsApp delivery was stopped.');
                if(destination!==this.selfJid)await this.verifyGroup(destination);
                if(this.closed||this.loggingOut||this.router.stopped||this.sock!==sock)throw new Error('WhatsApp delivery was stopped.');
              });
            }else content={document:Buffer.from(a.data),fileName:a.filename,mimetype:a.mime,caption:m.body};
          }
          if(!sent)sent=await sock.sendMessage(destination,content,{messageId:m.wa_id});
          if(sent?.message)this.store.db.prepare('UPDATE outbox SET wa_message=? WHERE id=?').run(JSON.stringify(sent.message,BufferJSON.replacer),m.id);
          this.store.sent(m.id);
        }
        catch(e){this.error=(e as Error).message;if(e instanceof MediaHostLimitError)this.store.db.prepare("UPDATE outbox SET status='failed',error=? WHERE id=?").run(e.message,m.id);else this.store.sendFailed(m.id,m.attempts+1,'WhatsApp delivery held; check connection and group membership');break;}
      }
    } finally {this.flushing=false;}
  }
  close(){this.stopAuth?.();this.artifacts.disk.abortAll();if(!this.closed){this.store.interruptAudio('Background operation stopped while processing your voice note. Please resend it after the bridge reconnects.');this.router.attachments.interrupt('Background operation stopped while downloading your attachment. Please resend it after reconnection.');}this.closed=true;for(const controller of [...this.audioControllers,...this.mediaControllers])controller.abort();clearTimeout(this.reconnect);clearInterval(this.flusher);this.flusher=undefined;const sock=this.sock;this.sock=undefined;sock?.end(undefined);}
}
