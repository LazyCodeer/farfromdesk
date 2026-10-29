import { WhatsAppPolls } from './whatsapp-polls.js';
import { canDeliverBrief } from './morning-brief.js';
import { scheduleDeliveryState } from './schedules.js';
import { contractDeliveryState } from './task-contracts.js';
import makeWASocket,{useMultiFileAuthState,DisconnectReason,jidNormalizedUser,normalizeMessageContent,Browsers,proto,type WASocket} from '@whiskeysockets/baileys';
import pino from 'pino';
import { join } from 'node:path';
import { rm, readFile } from 'node:fs/promises';
import { stateDir } from './config.js';
import type { Store } from './store.js';
import type { Router } from './router.js';
import { transcribeAudio, audioFormat, type AudioObserver, type VoiceOrigin } from './audio.js';
import { voiceEngine } from './voice-cloud.js';
import { createHash,randomUUID } from 'node:crypto';
import { BufferJSON } from '@whiskeysockets/baileys';
import { disposeIncoming, incomingMetadata, type AttachmentKind, type IncomingFile } from './attachments.js';
import { Artifacts } from './artifacts.js';
import { sendDiskDocument, MediaHostLimitError } from './document-delivery.js';
import { errorCode } from './request-events.js';
import { GuardedSocket, isSelfMessage, ownerOnlyGroup } from './wa-guard.js';

export { isSelfMessage, ownerOnlyGroup };
export class WhatsApp {
  sock?:GuardedSocket; qr?:string; status='not paired'; error?:string;
  owners:string[]=[]; selfJid?:string;
  closed=false; connecting=false; attempts=0; flushing=false;
  reconnect?:NodeJS.Timeout; flusher?:NodeJS.Timeout;
  creatingGroup=false;
  loggingOut=false;
  stopAuth?:()=>void;
  authWrites=new Set<Promise<void>>();
  receiving=new Set<string>();
  hasPendingIngress(){return this.receiving.size>0||this.audioControllers.size>0||this.mediaControllers.size>0;}
  audioBusy=0;
  audioControllers=new Set<AbortController>();
  mediaControllers=new Set<AbortController>();
  downloadFile=(media:any,kind:AttachmentKind,signal?:AbortSignal)=>this.router.attachments.download(media,kind,signal);
  artifacts:Artifacts;
  readonly polls:WhatsAppPolls;
  sendDocument=sendDiskDocument;
  transcribe=(audio:any,signal?:AbortSignal,observe?:AudioObserver,origin?:VoiceOrigin)=>transcribeAudio(this.store,audio,signal,observe,undefined,origin);
  constructor(private store:Store,private router:Router,private authDirectory=join(stateDir,'whatsapp-auth')) {
    this.artifacts=new Artifacts(store);this.polls=new WhatsAppPolls(store);
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
    this.store.set('incoming-owner-generation',randomUUID());
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
  async switchState():Promise<'none'|'setup'|'saved'|'connected'> {
    if(this.status==='connected')return 'connected';
    try {if(JSON.parse(await readFile(join(this.authDirectory,'creds.json'),'utf8')).registered===true)return 'saved';}
    catch(e:any){if(e.code!=='ENOENT')return 'saved';}
    return this.qr||this.status==='connecting'?'setup':'none';
  }
  async disconnectForSwitch(confirmed=true) {
    if(this.status==='connected'){
      if(!confirmed)throw new Error('WhatsApp connected since your last check. Confirm logout before switching.');
      await this.logout();return;
    }
    let registered=false;
    try{registered=JSON.parse(await readFile(join(this.authDirectory,'creds.json'),'utf8')).registered===true;}
    catch(e:any){if(e.code!=='ENOENT')throw new Error('Could not verify WhatsApp logout. Reconnect before switching.');}
    if(registered)throw new Error('Reconnect WhatsApp to log out before switching. You can also remove this device in WhatsApp Linked devices.');
    if(!confirmed&&(this.qr||this.status==='connecting'))throw new Error('WhatsApp pairing started. Confirm cancelling setup before switching.');
    this.close();await Promise.allSettled([...this.authWrites]);await rm(this.authDirectory,{recursive:true,force:true});
    this.qr=undefined;this.selfJid=undefined;this.owners=[];this.status='logged out';this.error=undefined;
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
    const matches=Object.values(groups).filter(g=>ownerOnlyGroup(g,this.owners));
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
      const sock=new GuardedSocket(makeWASocket({auth:state,logger:pino({level:'silent'}),browser:(process.platform==='win32'?Browsers.windows:process.platform==='darwin'?Browsers.macOS:Browsers.ubuntu)('FarFromDesk'),markOnlineOnConnect:false,syncFullHistory:false,shouldSyncHistoryMessage:()=>false,emitOwnEvents:false,
        getMessage:async key=>{const r=this.store.db.prepare('SELECT body,artifact_id,wa_message FROM outbox WHERE wa_id=?').get(key.id??'') as any;return r?.wa_message?JSON.parse(r.wa_message,BufferJSON.reviver):r&&!r.artifact_id?{conversation:r.body}:undefined;}}),
        {owners:()=>this.owners,ownedGroup:jid=>!!this.store.get(`owned-group:${jid}`)});
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
    if(this.store.controlChannel()!=='whatsapp'||this.closed||this.loggingOut||this.router.stopped||this.status!=='connected'||!m.key?.id||this.store.isOurs(m.key.id)||m.key.fromMe!==true)return;
    const id=`wa:${m.key.id}`,destination=this.destination().jid,self=isSelfMessage(m.key,this.owners);
    const group=m.key.remoteJid===destination&&destination?.endsWith('@g.us');
    if((!self&&!group)||this.store.seen(id)||this.receiving.has(id))return;
    const msg=normalizeMessageContent(m.message),audio=msg?.audioMessage;
    const media=msg?.imageMessage??msg?.documentMessage,kind:AttachmentKind=msg?.imageMessage?'image':'document';
    let text=msg?.conversation??msg?.extendedTextMessage?.text;
    if(!text&&!audio&&!media&&!msg?.pollUpdateMessage)return;
    // With a group selected, the self chat only accepts the /self escape back to it.
    if(self&&destination?.endsWith('@g.us')&&text?.trim()!=='/self')return;
    const origin=self?this.selfJid:destination;
    if(!origin||!this.selfJid||this.store.get('whatsapp-owner')!==this.selfJid)return;
    const owner=this.store.captureIncomingOwner(origin,'whatsapp');if(!owner)return;
    this.receiving.add(id);
    try {
      await this.store.incomingOwnerContext.run(owner,async()=>{
      if(group)await this.verifyGroup(destination!);
      if(this.closed||this.loggingOut||this.router.stopped||!this.store.incomingOwnerCurrent())return;
      const activityScope={destination:origin,owner:owner.owner};
      await this.store.destinationContext.run(origin,async()=>{
        if(msg?.pollUpdateMessage){const vote=this.polls.vote({...m,message:msg},origin,this.owners);if(vote)await this.router.receive({...vote,activityScope});return;}
        if(media) {
          if(!this.store.db.prepare("INSERT OR IGNORE INTO media_inbox VALUES(?,?,'processing',?)").run(id,origin,Date.now()).changes)return;
          this.store.recordIncomingInput(id);
          const controller=new AbortController();let file:IncomingFile|undefined;
          try {
            incomingMetadata(media,kind);
            const incoming={id,text:media.caption??'',quotedId:media.contextInfo?.stanzaId??undefined,ownerCommand:false};
            const target=this.router.attachmentTarget(incoming);
            if(this.mediaControllers.size>=2)throw new Error('Two attachments are already downloading. Please wait, then resend this one.');
            this.mediaControllers.add(controller);
            file=await this.downloadFile(media,kind,controller.signal);
            if(this.closed||this.loggingOut||this.router.stopped||!this.store.incomingOwnerCurrent())return;
            if(group)await this.verifyGroup(origin);
            if(this.closed||this.loggingOut||this.router.stopped||!this.store.incomingOwnerCurrent())return;
            this.router.receiveAttachment(incoming,file,target);
          }catch(e) {
            if(this.closed||!this.store.incomingOwnerCurrent())return;
            const message=(e as Error).message;
            const safe=/^(?:Use a simple|Unsupported|Attachment |Files must|Text files|Binary data|Invalid (?:PDF|PNG|JPEG|WebP|GIF|ZIP|gzip|executable|WebAssembly)|Expected a complete|The intended session|Choose an exact session|That quoted message|Session is missing|Two attachments|Incoming attachment)/;
            this.store.output(undefined,safe.test(message)?message:'I couldn’t receive this attachment. Please resend a supported image or document. Documents support the WhatsApp ceiling of 2,097,152,000 bytes when disk space permits.',`media-error:${id}`,origin);
            this.store.remember(id);this.store.db.prepare("UPDATE media_inbox SET status='failed' WHERE id=?").run(id);
          }finally{if(!this.store.incomingOwnerCurrent())this.store.db.prepare("UPDATE media_inbox SET status='interrupted' WHERE id=? AND status='processing'").run(id);disposeIncoming(file);this.mediaControllers.delete(controller);}
          return;
        }
        if(audio) {
          const claimed=this.store.db.prepare("INSERT OR IGNORE INTO audio_inbox VALUES(?,?,'processing',?)").run(id,origin,Date.now());
          if(!claimed.changes)return;
          this.store.recordIncomingInput(id);
          let started=false,routingStarted:number|undefined;const controller=new AbortController();
          this.store.event(id,'voice_received',{audioSeconds:Number(audio.seconds),...(voiceEngine(this.store)==='local'?{engine:'whisper.cpp',model:this.store.get('audio-origin')==='bundled'?'bundled':'custom'}:{engine:voiceEngine(this.store)})});
          const routing=()=>JSON.stringify([this.store.get('active'),this.store.get('master'),this.store.get('selected'),this.store.get(`owner-target:${origin}`),this.store.get(`direct:${origin}`)]);
          const originalRouting=routing();
          try {
            audioFormat(audio);
            if(this.audioBusy>=2)throw new Error('Two voice notes are already processing. Please wait for their replies, then resend this one.');
            this.audioBusy++;started=true;this.audioControllers.add(controller);
            this.store.output(undefined,(!this.store.get('audio-config')&&this.store.get('audio-tools')?'Voice note received. I’m downloading the voice model once, then I’ll transcribe it locally. This first note may take a few minutes.':'Voice note received. I’m transcribing it locally on your computer.'),`audio-progress:${id}`,origin);
            text=await this.transcribe(audio,controller.signal,event=>this.store.voiceEvent(id,event),{kind:'chat',destination:origin,owner:owner.owner});
            if(this.closed||this.loggingOut||this.router.stopped||!this.store.incomingOwnerCurrent())return; // Restart recovery reports interruption.
            if(group)await this.verifyGroup(origin);
            if(this.closed||this.loggingOut||this.router.stopped||!this.store.incomingOwnerCurrent())return;
            routingStarted=performance.now();this.store.voiceEvent(id,{stage:'route',state:'started'});
            if(routing()!==originalRouting)throw new Error('The selected session changed during transcription. Please resend the note to the intended session.');
            if(!text?.trim()||text.length>32000)throw new Error('No clear speech detected. Please resend or type your message.');
            if(/^\/(?:approve|deny|answer)\b/i.test(text.trim()))throw new Error('Please type permission decisions explicitly; voice transcription may mishear them.');
            const context=audio.contextInfo;
            const ownerIntent=!context?.stanzaId&&!context?.quotedMessage&&!context?.isForwarded&&!context?.forwardingScore;
            const result=await this.router.receive({id,text,quotedId:context?.stanzaId??undefined,source:'voice',ownerCommand:false,ownerIntent,activityScope});
            const routed=result.status==='queued'||result.status==='handled';
            this.store.voiceEvent(id,{stage:'route',state:routed?'completed':'failed',durationMs:performance.now()-routingStarted,...(!routed?{code:result.code??'routing_unavailable'}:{})});
            this.store.db.prepare('UPDATE audio_inbox SET status=? WHERE id=?').run(routed?'processed':'routing_blocked',id);
            if(!routed&&result.status!=='blocked')this.store.output(undefined,'Your voice note was transcribed, but could not be routed. Select an active session, then send a new request.',`audio-route:${id}`,origin);
          }catch(e) {
            if(this.closed||!this.store.incomingOwnerCurrent())return;
            if(routingStarted!==undefined)this.store.voiceEvent(id,{stage:'route',state:'failed',durationMs:performance.now()-routingStarted,code:errorCode(e)});
            this.store.event(id,'voice_failed',{code:errorCode(e)});
            // Never echo provider output, media URLs, transcript or command paths.
            const allowed=/^(?:Voice transcription is not configured|Voice model download did not finish|Unsupported voice-note format|Voice notes must|Two voice notes|The selected session changed|No clear speech detected|Please type permission|Deepgram |AssemblyAI |Couldn’t reach )/;
            const message=allowed.test((e as Error).message)?(e as Error).message:'I couldn’t transcribe this voice note. Please resend a clear recording (up to 5 minutes for local transcription), or type your message.';
            this.store.output(undefined,message,`audio-error:${id}`,origin);this.store.remember(id);
            this.store.db.prepare('UPDATE audio_inbox SET status=? WHERE id=?').run(routingStarted===undefined?'failed':'routing_blocked',id);
          }finally{if(!this.store.incomingOwnerCurrent())this.store.db.prepare("UPDATE audio_inbox SET status='interrupted' WHERE id=? AND status='processing'").run(id);if(started)this.audioBusy--;this.audioControllers.delete(controller);}
          return;
        }
        const context=msg?.extendedTextMessage?.contextInfo;
        const ownerCommand=!context?.stanzaId&&!context?.quotedMessage&&!context?.isForwarded&&!context?.forwardingScore;
        if(self&&ownerCommand&&text!.trim()==='/self') {
          const selecting=this.selectDestination(),updated=this.store.captureIncomingOwner(origin,'whatsapp');await selecting;
          if(updated&&updated.owner===owner.owner)this.store.incomingOwnerContext.run(updated,()=>{if(this.store.incomingOwnerCurrent()){this.store.output(undefined,'Switched to Message yourself. You can continue here.',`self-switch:${m.key.id}`,origin);this.store.remember(id);}});return;
        }
        await this.router.receive({id,text:text!,quotedId:context?.stanzaId??undefined,ownerCommand,ownerChoice:!context?.isForwarded&&!context?.forwardingScore,activityScope});
      });
      });
    }finally{this.receiving.delete(id);}
  }
  async flush() {
    if(this.loggingOut||this.flushing||this.status!=='connected'||!this.sock||!this.selfJid)return;
    this.flushing=true;
    try {
      for(let i=0;i<5;i++) {
        const m=this.store.routableOutbound('whatsapp');if(!m)break;
        if(!this.store.incomingOwnerDelivery(m.id)){this.store.db.prepare("UPDATE outbox SET status='cancelled',error='Original owner connection changed.' WHERE id=? AND status='queued'").run(m.id);continue;}
        const scheduleState=scheduleDeliveryState(this.store,m.id);if(scheduleState==='hold')return;
        if(scheduleState==='invalid'){this.store.db.prepare("UPDATE outbox SET status='failed',error='Paired owner changed; scheduled reminder was not sent' WHERE id=?").run(m.id);continue;}
        const contractState=contractDeliveryState(this.router,m.id);if(contractState==='hold')return;
        if(contractState==='invalid'){this.store.db.prepare("UPDATE outbox SET status='cancelled',error='Task contract expired or its owner changed.' WHERE id=?").run(m.id);continue;}
        if(m.binding_id&&!this.store.binding(m.binding_id)?.enabled)continue;
        const destination:string=m.destination??this.selfJid;
        let briefSending=false;
        try {
          const sock:GuardedSocket=this.sock;
          if(!canDeliverBrief(this.store,m,this.selfJid)){this.store.db.prepare("UPDATE outbox SET status='cancelled',error='Morning brief owner or destination changed' WHERE id=? AND status='queued'").run(m.id);continue;}
          if(destination!==this.selfJid)await this.verifyGroup(destination);
          if(this.closed||this.loggingOut||this.status!=='connected'||this.sock!==sock||!this.store.incomingOwnerDelivery(m.id)||scheduleDeliveryState(this.store,m.id)!=='ready'||contractDeliveryState(this.router,m.id)!=='ready')return;
          if(!canDeliverBrief(this.store,m,this.selfJid)){this.store.db.prepare("UPDATE outbox SET status='cancelled',error='Morning brief owner or destination changed' WHERE id=? AND status='queued'").run(m.id);continue;}
          const poll=this.polls.message(m.id);
          if(poll){
            this.store.db.prepare("UPDATE outbox SET status='sending' WHERE id=?").run(m.id);
            await sock.relayMessage(destination,poll,{messageId:m.wa_id});this.store.sent(m.id);continue;
          }
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
          if(!sent){
            if(m.source.startsWith('morning-brief:')){const claimed=this.store.db.prepare("UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='queued'").run(m.id);if(!claimed.changes)continue;briefSending=true;}
            sent=await sock.sendMessage(destination,content,{messageId:m.wa_id});
          }
          if(sent?.message)this.store.db.prepare('UPDATE outbox SET wa_message=? WHERE id=?').run(JSON.stringify(sent.message,BufferJSON.replacer),m.id);
          this.store.sent(m.id);this.polls.queue(m.id);
        }
        catch(e){this.error=briefSending?'Morning brief delivery could not be confirmed.':(e as Error).message;if(briefSending)this.store.db.prepare("UPDATE outbox SET status='uncertain',error='Morning brief delivery could not be confirmed; check your chat before retrying' WHERE id=? AND status='sending'").run(m.id);else if(this.polls.isPoll(m.id))this.store.db.prepare("UPDATE outbox SET status='uncertain',error='Poll delivery unavailable; use the original numbered reply' WHERE id=?").run(m.id);else if(e instanceof MediaHostLimitError)this.store.db.prepare("UPDATE outbox SET status='failed',error=? WHERE id=?").run(e.message,m.id);else this.store.sendFailed(m.id,m.attempts+1,'WhatsApp delivery held; check connection and group membership');break;}
      }
    } finally {this.flushing=false;}
  }
  close(){this.stopAuth?.();this.artifacts.disk.abortAll();if(!this.closed){this.store.interruptAudio('Background operation stopped while processing your voice note. Please resend it after the bridge reconnects.');this.router.attachments.interrupt('Background operation stopped while downloading your attachment. Please resend it after reconnection.');}this.closed=true;for(const controller of [...this.audioControllers,...this.mediaControllers])controller.abort();clearTimeout(this.reconnect);clearInterval(this.flusher);this.flusher=undefined;const sock=this.sock;this.sock=undefined;sock?.end(undefined);}
}
