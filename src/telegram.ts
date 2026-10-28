import { TELEGRAM_COMMANDS, telegramCommand } from './owner-commands.js';
import { optionsMarkup } from './message-options.js';
import { randomBytes, createHash } from 'node:crypto';
import { constants, existsSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fchmodSync, ftruncateSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from './store.js';
import type { Router, Incoming } from './router.js';
import { stateDir } from './config.js';
import { Artifacts } from './artifacts.js';
import { stageMediaStream, type DownloadedMedia } from './media-download.js';
import { transcribeAudio } from './audio.js';
import { voiceEngine } from './voice-cloud.js';

export const TELEGRAM_DOWNLOAD_BYTES=20_000_000, TELEGRAM_DOCUMENT_BYTES=50_000_000;
const validId=(id:unknown):id is number=>Number.isSafeInteger(id)&&Number(id)>0;
export const telegramDestination=(bot:number,user:number)=>`tg:${bot}:${user}`;
export const telegramMessageId=(bot:number,chat:number,message:number)=>`tg:${bot}:${chat}:${message}`;
export class TelegramError extends Error {
  constructor(public code:number,public retryAfter=0){super(code===401?'Telegram rejected this bot token. Get a valid token from BotFather.':code===409?'This bot is already receiving updates elsewhere. Use a dedicated bot for FarFromDesk.':code===429?'Telegram rate limit reached. Waiting before retrying.':code===403?'Telegram cannot send to this account. Unblock the bot in Telegram.':'Telegram could not complete the request. Check your connection and try again.');}
}
// Safe subset of the existing phone format. Escape everything before adding tags;
// model text can never inject Telegram links or HTML.
export function telegramHTML(text:string) {
  const escape=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const parts:string[]=[];let offset=0;
  for(const m of text.matchAll(/```(?:[^\n`]*\n)?([\s\S]*?)```|\*([^*\n]+)\*/g)) {
    parts.push(escape(text.slice(offset,m.index)),m[1]!==undefined?`<pre>${escape(m[1])}</pre>`:`<b>${escape(m[2])}</b>`);offset=m.index!+m[0].length;
  }
  parts.push(escape(text.slice(offset)));return parts.join('');
}

type Candidate={id:number;name:string};
type Pairing={botId:number;secret:string;expires:number;candidate?:Candidate};
export class Telegram {
  status='disconnected'; error?:string; menuError?:string; closed=true;
  private token?:string; private bot?:{id:number;username:string};
  private pairing?:Pairing;
  private controller?:AbortController; private timer?:NodeJS.Timeout;
  private flushing=false; private configuring=false; private generation=0;
  private media=new Set<AbortController>();
  readonly artifacts:Artifacts;
  transcribe=transcribeAudio;
  constructor(private store:Store,private router:Router,private root=stateDir,private fetcher:typeof fetch=fetch) {
    this.artifacts=new Artifacts(store,root);
  }
  private get path(){return join(this.root,'telegram-token');}
  private readToken() {
    let fd:number|undefined;
    try {fd=openSync(this.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>256)throw new Error();return readFileSync(fd,'utf8').trim();}
    catch(e:any){if(e.code==='ENOENT')return undefined;throw new Error('Could not read the saved Telegram token. Reconnect locally.');}finally{if(fd!==undefined)closeSync(fd);}
  }
  private saveToken(token:string) {
    mkdirSync(this.root,{recursive:true,mode:0o700});
    const fd=openSync(this.path,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
    try{const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1)throw new Error('Invalid token file.');fchmodSync(fd,0o600);ftruncateSync(fd,0);writeFileSync(fd,token);
    }finally{closeSync(fd);}
  }
  private pendingPairing(botId:number):Pairing {
    const now=Date.now();
    try {
      const saved=JSON.parse(this.store.get('telegram-pairing')??'null') as Pairing|null;
      if(saved?.botId===botId&&typeof saved.secret==='string'&&/^[A-Za-z0-9_-]{32}$/.test(saved.secret)&&Number.isFinite(saved.expires)&&saved.expires>=now&&saved.expires<=now+600000&&(!saved.candidate||(validId(saved.candidate.id)&&typeof saved.candidate.name==='string'&&saved.candidate.name.length<=80)))return saved;
    } catch { /* Invalid pending state is replaced, never accepted as an owner. */ }
    const pairing={botId,secret:randomBytes(24).toString('base64url'),expires:now+600000};
    this.store.set('telegram-pairing',JSON.stringify(pairing));return pairing;
  }
  private clearPairing() {
    this.pairing=undefined;this.store.db.prepare("DELETE FROM settings WHERE key='telegram-pairing'").run();
  }
  switchState():'none'|'setup'|'saved'|'connected' {
    if(this.status==='connected')return 'connected';
    if(this.store.get('telegram-bot-id')||existsSync(this.path))return this.store.get('telegram-owner')?'saved':'setup';
    return this.configuring||this.pairing?'setup':'none';
  }
  view() {
    if(this.pairing&&Date.now()>this.pairing.expires){this.clearPairing();if(!this.store.get('telegram-owner'))this.status='pairing expired';}
    return {status:this.status,error:this.error??this.menuError,menuError:this.menuError,configured:!!this.store.get('telegram-bot-id'),username:this.bot?.username??this.store.get('telegram-username'),ownerId:this.store.get('telegram-user-id'),ownerName:this.store.get('telegram-owner-name'),
      ...(this.pairing?{pairingUrl:`https://t.me/${this.bot!.username}?start=${this.pairing.secret}`,expiresAt:this.pairing.expires,candidate:this.pairing.candidate}:{}),
      maxDownloadBytes:TELEGRAM_DOWNLOAD_BYTES,maxDocumentBytes:TELEGRAM_DOCUMENT_BYTES};
  }
  private async call(method:string,body:Record<string,unknown>|FormData={},signal?:AbortSignal,token=this.token) {
    if(!token)throw new TelegramError(401);
    try {
      const res=await this.fetcher(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:body instanceof FormData?undefined:{'Content-Type':'application/json'},body:body instanceof FormData?body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(method==='getUpdates'?35000:['getMe','getWebhookInfo','getFile','setMyCommands'].includes(method)?15000:60000),...(signal?[signal]:[])])});
      const data:any=await res.json();
      if(!res.ok||data.ok!==true)throw new TelegramError(Number(data.error_code)||res.status,Math.min(3600,Math.max(1,Number(data.parameters?.retry_after)||1)));
      return data.result;
    }catch(e){if(e instanceof TelegramError)throw e;throw new TelegramError(0);}
  }
  async connect(supplied?:string) {
    if(this.configuring)throw new Error('Telegram connection is already being checked.');
    this.configuring=true;
    this.close();const generation=this.generation;this.status='connecting';this.error=undefined;
    try {
      const token=supplied?.trim()||this.readToken();
      if(!token||!/^\d{5,20}:[A-Za-z0-9_-]{30,80}$/.test(token))throw new Error('Paste a valid Telegram bot token from BotFather.');
      const bot=await this.call('getMe',{},undefined,token),hook=await this.call('getWebhookInfo',{},undefined,token);
      if(!validId(bot?.id)||bot.is_bot!==true||typeof bot.username!=='string'||!/^\w{5,32}$/.test(bot.username))throw new Error('Telegram returned an invalid bot identity.');
      if(hook?.url)throw new Error('This bot has a webhook configured. Use a dedicated bot for FarFromDesk.');
      const old=this.store.get('telegram-bot-id');if(old&&old!==String(bot.id))throw new Error('Disconnect the existing bot before choosing another bot.');
      if(generation!==this.generation)return;
      this.saveToken(token);this.token=token;this.bot={id:bot.id,username:bot.username};
      this.store.set('telegram-bot-id',String(bot.id));this.store.set('telegram-username',bot.username);
      if(!this.store.get('telegram-owner'))this.pairing=this.pendingPairing(bot.id);else this.clearPairing();
      this.status=this.store.get('telegram-owner')?'connected':'pairing';this.closed=false;this.controller=new AbortController();
      await this.call('setMyCommands',{commands:TELEGRAM_COMMANDS,scope:{type:'all_private_chats'}},this.controller.signal).then(()=>{this.menuError=undefined;}).catch(()=>{this.menuError='Telegram command menu could not be updated. Typed commands still work.';});
      if(generation!==this.generation)return;
      this.timer=setInterval(()=>{void this.flush();},1500);this.timer.unref();
      void this.poll(this.controller.signal);
    }catch(e){if(generation===this.generation){this.status='disconnected';this.error=e instanceof TelegramError?e.message:e instanceof Error?e.message:'Telegram connection failed.';}throw e;}
    finally{this.configuring=false;}
  }
  confirm(userId:unknown) {
    const p=this.pairing;
    if(!p?.candidate||String(p.candidate.id)!==String(userId)||Date.now()>p.expires||!this.bot||this.closed)throw new Error('Pairing expired or the account changed. Reconnect Telegram and try again.');
    const owner=telegramDestination(this.bot.id,p.candidate.id);
    this.store.set('telegram-user-id',String(p.candidate.id));this.store.set('telegram-owner-name',p.candidate.name);this.store.set('telegram-owner',owner);
    this.store.set('telegram-paired-at',String(Math.floor(Date.now()/1000)));
    this.clearPairing();this.status='connected';this.error=undefined;
    this.store.output(undefined,'✅ *Connected*\nYour Telegram account is linked. Ask me to show your sessions or check your work.',`telegram-paired:${randomBytes(8).toString('hex')}`,owner);
    return this.view();
  }
  close() {++this.generation;this.closed=true;this.controller?.abort();clearInterval(this.timer);this.timer=undefined;for(const c of this.media)c.abort();}
  disconnect() {
    ++this.generation;this.close();this.clearPairing();this.token=undefined;this.bot=undefined;
    try{unlinkSync(this.path);}catch(e:any){if(e.code!=='ENOENT')throw new Error('Could not remove the Telegram token.');}
    for(const key of ['telegram-bot-id','telegram-username','telegram-user-id','telegram-owner-name','telegram-owner','telegram-paired-at'])this.store.db.prepare('DELETE FROM settings WHERE key=?').run(key);
    this.status='disconnected';this.error=undefined;
  }
  async resume(){if(this.closed&&this.store.get('telegram-bot-id'))await this.connect();}
  private async poll(signal:AbortSignal) {
    let failures=0;
    while(!signal.aborted&&!this.closed) {
      try {
        const key=`telegram-offset:${this.bot!.id}`,offset=Number(this.store.get(key)??0);
        const updates=await this.call('getUpdates',{offset,timeout:25,limit:20,allowed_updates:['message','callback_query']},signal);
        if(signal.aborted||this.closed)return;
        if(!Array.isArray(updates))throw new TelegramError(0);
        for(const update of updates){if(signal.aborted||this.closed)return;if(!Number.isSafeInteger(update.update_id)||update.update_id<offset)continue;await this.receive(update);this.store.set(key,String(update.update_id+1));}
        failures=0;this.error=undefined;if(this.store.get('telegram-owner'))this.status='connected';
      }catch(e){if(signal.aborted||this.closed)return;this.error=e instanceof TelegramError?e.message:'Telegram update processing failed. Check Activity.';
        if(e instanceof TelegramError&&[401,409].includes(e.code)){this.close();this.status='disconnected';return;}
        await delay(e instanceof TelegramError&&e.code===429?e.retryAfter*1000:Math.min(30000,1000*2**Math.min(++failures,5)),undefined,{signal}).catch(()=>{});
      }
    }
  }
  async receive(update:any) {
    const cb=update?.callback_query;
    if(cb){
      const m=cb.message;
      if(this.closed||!this.bot||this.router.stopped||this.store.controlChannel()!=='telegram'||!m||m.chat?.type!=='private'||!validId(m.chat.id)||!validId(cb.from?.id)||cb.from.is_bot||cb.from.id!==m.chat.id||m.from?.id!==this.bot.id||!validId(m.message_id)||telegramDestination(this.bot.id,m.chat.id)!==this.store.get('telegram-owner')||typeof cb.id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(cb.id)||typeof cb.data!=='string')return;
      const destination=telegramDestination(this.bot.id,m.chat.id);
      const result=await this.store.destinationContext.run(destination,()=>this.router.receive({id:`tg-choice:${this.bot!.id}:${cb.id}`,text:'Selected message option',quotedId:telegramMessageId(this.bot!.id,m.chat.id,m.message_id),optionToken:cb.data}));
      await this.call('answerCallbackQuery',{callback_query_id:cb.id,text:result.status==='blocked'?'Choice unavailable. Check the reply.':'Answer recorded.'}).catch(()=>{});
      return;
    }
    const m=update?.message;
    if(this.closed||!this.bot||!m||m.chat?.type!=='private'||!validId(m.chat.id)||!validId(m.from?.id)||m.from.is_bot||m.chat.id!==m.from.id||!validId(m.message_id))return;
    let text=typeof m.text==='string'?m.text:'';
    const ownerIntent=!m.reply_to_message&&!m.forward_origin&&!m.forward_from&&!m.forward_from_chat&&!m.forward_date&&!m.external_reply&&!m.quote&&!m.via_bot&&!m.document&&!m.photo;
    const ownerCommand=ownerIntent&&!m.voice;
    const id=telegramMessageId(this.bot.id,m.chat.id,m.message_id);
    if(this.store.seen(id))return;
    if(!this.store.get('telegram-owner')&&ownerCommand){
      const normalized=telegramCommand(text,this.bot.username);
      const start=normalized===null?null:/^\/start(?:\s+([\s\S]*))?$/.exec(normalized.trim());
      if(start){
        const p=this.pairing;
        if(p&&Date.now()<=p.expires&&start[1]===p.secret){
          if(!p.candidate){p.candidate={id:m.from.id,name:String(m.from.first_name??'Telegram account').replace(/[\x00-\x1f]/g,' ').slice(0,80)};this.store.set('telegram-pairing',JSON.stringify(p));}
        }else{
          // Optional guidance must not pin the polling offset ahead of the owner's real /start.
          this.store.remember(id);
          await this.call('sendMessage',{chat_id:m.chat.id,text:start[1]?'This pairing link is out of date. Open the newest link from the FarFromDesk app.':'Open the pairing link from the FarFromDesk app.'},this.controller?.signal).catch(()=>{});
        }
        this.store.remember(id);return;
      }
    }
    const destination=telegramDestination(this.bot.id,m.chat.id);
    if(this.router.stopped||this.store.controlChannel()!=='telegram'||destination!==this.store.get('telegram-owner')||!Number.isFinite(m.date)||m.date<Number(this.store.get('telegram-paired-at')??0))return;
    const quotedId=m.reply_to_message?.from?.id===this.bot.id&&validId(m.reply_to_message?.message_id)?telegramMessageId(this.bot.id,m.chat.id,m.reply_to_message.message_id):undefined;
    if(ownerCommand){const normalized=telegramCommand(text,this.bot.username);if(normalized===null){this.store.remember(id);return;}text=normalized;}
    const incoming:Incoming={id,text:text==='/start'&&ownerCommand?'Show my recent sessions':text,quotedId,ownerCommand,ownerIntent,ownerChoice:!m.forward_origin&&!m.forward_from&&!m.forward_from_chat&&!m.forward_date&&!m.external_reply&&!m.via_bot&&!m.voice&&!m.document&&!m.photo};
    await this.store.destinationContext.run(destination,async()=>{
      const file=m.voice??m.document??(Array.isArray(m.photo)?m.photo.at(-1):undefined);
      if(file){
        const table=m.voice?'audio_inbox':'media_inbox';
        if(this.store.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id))return;
        if(this.media.size>=2){this.store.output(undefined,'Two files are processing. Please wait, then resend this one.',`telegram-busy:${id}`,destination);this.store.remember(id);return;}
        this.store.db.prepare(`INSERT INTO ${table} VALUES(?,?,'processing',?)`).run(id,destination,Date.now());
        const controller=new AbortController();this.media.add(controller);
        void this.processMedia(m,incoming,file,destination,controller.signal).catch(()=>{}).finally(()=>this.media.delete(controller));return;
      }
      if(!text){this.store.output(undefined,'Send text, a voice note, an image or a document to control your sessions.',`telegram-unsupported:${id}`,destination);this.store.remember(id);return;}
      await this.router.receive(incoming);
    });
  }
  private async download(file:any,filename:string,signal:AbortSignal):Promise<DownloadedMedia> {
    if(!Number.isSafeInteger(file.file_size)||file.file_size<1||file.file_size>TELEGRAM_DOWNLOAD_BYTES)throw new Error('Telegram bot downloads must be at most 20 MB.');
    const meta=await this.call('getFile',{file_id:file.file_id},signal);
    if(typeof meta?.file_path!=='string'||!/^[A-Za-z0-9_./-]+$/.test(meta.file_path)||meta.file_path.startsWith('/')||meta.file_path.split('/').includes('..'))throw new Error('Telegram returned an invalid file path.');
    const abort=AbortSignal.any([signal,AbortSignal.timeout(120000)]);
    let response:Response;try{response=await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${meta.file_path}`,{redirect:'error',signal:abort});}catch{throw new TelegramError(0);}
    if(!response.ok||!response.body)throw new TelegramError(response.status);
    return stageMediaStream(response.body,filename,file.file_size,TELEGRAM_DOWNLOAD_BYTES,abort,this.root);
  }
  private async processMedia(m:any,incoming:Incoming,file:any,destination:string,signal:AbortSignal) {
    let downloaded:DownloadedMedia|undefined;const voice=!!m.voice,table=voice?'audio_inbox':'media_inbox';
    const routing=()=>JSON.stringify([this.store.get('active'),this.store.get('master'),this.store.get('selected'),this.store.get(`owner-target:${destination}`),this.store.get(`direct:${destination}`)]);const original=routing();
    try {
      if(voice){
        this.store.output(undefined,voiceEngine(this.store)==='local'?'Voice note received. I’m transcribing it locally on your computer.':'Voice note received. I’m transcribing it with your configured speech provider.',`audio-progress:${incoming.id}`,destination);
        const text=await this.transcribe(this.store,{mimetype:file.mime_type??'audio/ogg',seconds:file.duration,fileLength:file.file_size},signal,e=>this.store.voiceEvent(incoming.id,e),async()=>this.download(file,'voice.bin',signal));
        if(routing()!==original)throw new Error('The selected session changed. Resend to the intended session.');
        if(/^\/(?:approve|deny|answer)\b/i.test(text.trim()))throw new Error('Please type permission decisions.');
        incoming={...incoming,text,source:'voice',ownerCommand:false};
      }else{
        incoming={...incoming,text:typeof m.caption==='string'?m.caption:''};
      }
      const target=voice?undefined:this.router.attachmentTarget(incoming);
      if(!voice)downloaded=await this.download(file,m.document?.file_name??'image.jpg',signal);
      signal.throwIfAborted();
      if(this.closed||this.router.stopped||this.store.controlChannel()!=='telegram'||destination!==this.store.get('telegram-owner'))throw new Error('Connection changed. Resend from the intended chat.');
      if(voice)await this.router.receive(incoming);
      else this.router.receiveAttachment(incoming,{kind:m.document?'document':'image',filename:downloaded!.filename,sha256:downloaded!.sha256,download:downloaded!},target!);
      this.store.db.prepare(`UPDATE ${table} SET status='processed' WHERE id=?`).run(incoming.id);
    }catch(e){
      if(!this.closed){this.store.output(undefined,'I couldn’t process this file. Telegram bot downloads support up to 20 MB; local voice transcription supports up to five minutes. Check your voice setup or send text instead.',`telegram-media-error:${incoming.id}`,destination);this.store.remember(incoming.id);this.store.db.prepare(`UPDATE ${table} SET status='failed' WHERE id=?`).run(incoming.id);}
    }finally{downloaded?.dispose();}
  }
  async flush() {
    if(this.closed||this.router.stopped||this.flushing||!this.bot||!this.store.get('telegram-owner'))return;
    this.flushing=true;
    try {
      const row=this.store.outbound('telegram');if(!row)return;
      const destination=this.store.get('telegram-owner')!;
      if(row.destination!==destination){this.store.db.prepare("UPDATE outbox SET status='failed',error='Original Telegram account is not connected' WHERE id=?").run(row.id);return;}
      let body:Record<string,unknown>|FormData={chat_id:Number(this.store.get('telegram-user-id')),text:telegramHTML(row.body),parse_mode:'HTML',link_preview_options:{is_disabled:true}},method='sendMessage';
      const markup=optionsMarkup(this.store,row.id);if(markup)(body as Record<string,unknown>).reply_markup=markup;
      if(row.artifact_id){
        try {
          const a=this.store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(row.artifact_id) as any,b=this.store.binding(row.binding_id),job=this.store.job(a?.request_id??'');
          if(!a||a.removed_at||a.owner!==destination||a.destination!==destination||a.native_id!==b?.native_id||!job||job.binding_id!==b?.id||['replaced','cancelled','reviewed','auto_closed'].includes(job.status)||(a.bytes??a.data?.length)>TELEGRAM_DOCUMENT_BYTES)throw new Error();
          let bytes:Buffer;
          if(a.storage_key){const opened=await this.artifacts.disk.openForDelivery(a);try{const chunks:Buffer[]=[];for await(const chunk of opened.stream)chunks.push(Buffer.from(chunk));opened.valid();bytes=Buffer.concat(chunks);}finally{await opened.close();}}
          else bytes=Buffer.from(a.data);
          if(createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw new Error();
          if(row.body.length>1024)throw new Error();
          const form=new FormData();form.set('chat_id',String(this.store.get('telegram-user-id')));form.set('document',new Blob([new Uint8Array(bytes)],{type:a.mime}),a.filename);form.set('caption',row.body);body=form;method='sendDocument';
        }catch{this.store.db.prepare("UPDATE outbox SET status='failed',error='Document failed ownership, integrity or Telegram size checks (50 MB file, 1024 character caption)' WHERE id=?").run(row.id);return;}
      }
      if(this.closed||this.router.stopped||destination!==this.store.get('telegram-owner')||row.binding_id&&!this.store.binding(row.binding_id)?.enabled)return;
      this.store.db.prepare("UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='queued'").run(row.id);
      try {
        const sent=await this.call(method,body,this.controller?.signal);
        if(!validId(sent?.message_id)||sent.chat?.id!==Number(this.store.get('telegram-user-id')))throw new TelegramError(0);
        this.store.db.prepare('UPDATE outbox SET wa_id=? WHERE id=?').run(telegramMessageId(this.bot.id,sent.chat.id,sent.message_id),row.id);this.store.sent(row.id);
      }catch(e){
        this.error=e instanceof TelegramError?e.message:'Telegram delivery could not be confirmed.';
        if(e instanceof TelegramError&&e.code===429)this.store.db.prepare("UPDATE outbox SET status='queued',next_at=?,error='Telegram rate limit; retry scheduled' WHERE id=?").run(Date.now()+e.retryAfter*1000,row.id);
        else this.store.db.prepare("UPDATE outbox SET status=?,error=? WHERE id=?").run(e instanceof TelegramError&&e.code>=400&&e.code<500?'failed':'uncertain',e instanceof TelegramError?e.message:'Telegram delivery could not be confirmed; check the chat before resending.',row.id);
      }
    }finally{this.flushing=false;}
  }
}
