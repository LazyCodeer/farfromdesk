import { Store, type Binding } from './store.js';
import type { NativeAgents } from './native.js';
import type { Approvals } from './approvals.js';
import type { Coordinator } from './coordinator.js';

export type Incoming = {id:string;text:string;quotedId?:string};
export const help = `Commands\n/sessions [NAME] — five recent sessions per platform, or search\n/sessions more — older sessions\n/sessions back — previous page\n/use NAME — set direct-session focus\n/to NAME message — send to one connected session\n/status — bridge and queue\n/workspace — approved project location\n/workspace revoke — pause created workers and revoke workspace access\n/stop NAME — interrupt bridge-run work\n/pause NAME — stop forwarding\n/resume NAME — enable forwarding\n/approve CODE or /deny CODE\n/answer CODE your answer\nReview unfinished requests in the app’s Activity page.\n\nTell the master which session to work on; it connects that exact session automatically. Connections accumulate across platforms. Ambiguous names get a choice of matches. Quote an agent reply to address that exact session.`;
export class Router {
  coordinator?:Coordinator;
  hasPendingCreation?:(requestId:string)=>boolean;
  workspaceCommand?:(args:string)=>string;
  busy=new Set<string>();
  channelClients=new Map<string,{id:string;seen:number}>();
  stopped=false;
  constructor(public store:Store,public native:NativeAgents,public approvals:Approvals) {}
  async receive(m:Incoming) {
    if(this.stopped)return;
    if(this.store.seen(m.id))return;
    const text=m.text.trim();if(!text)return;
    // Commands are deterministic. Their text is never interpreted by a routing model.
    try {
      const browsing=/^(?:\/sessions(?:\s+.*)?|sessions|list sessions|show my sessions|list all sessions|(?:check|show) more(?: sessions)?|more sessions|(?:go )?back(?: in)? (?:the )?history|older sessions|previous page|(?:find|search)(?: for)? sessions? .+)$/i.test(text);
      if(this.coordinator&&!m.quotedId&&browsing) {
        let search=text.replace(/^\/sessions\s*/i,'');
        const more=/^(?:(?:check|show) more(?: sessions)?|more sessions|(?:go )?back(?: in)? (?:the )?history|older sessions|\/sessions more)$/i.test(text);
        const back=/^(?:previous page|\/sessions back)$/i.test(text);
        if(!/^\/sessions\s+/i.test(text))search=/^(?:find|search)(?: for)? sessions? (.+)$/i.exec(text)?.[1]??'';
        this.store.output(undefined,await this.coordinator.list(search,more?'more':back?'back':0),`command:${m.id}`);this.store.remember(m.id);return;
      }
      const selection=/^(?:(?:\/select|select|choose|pick)\s+)?(\d+(?:(?:\s*,\s*|\s+and\s+|\s+)\d+)*)$/i.exec(text);
      if(this.coordinator&&!m.quotedId&&selection&&(this.store.get('selection-awaiting')==='true'||/^(?:\/select|select|choose|pick)\s/i.test(text))) {
        this.store.output(undefined,await this.coordinator.select(selection[1].replace(/\band\b/gi,',')),`command:${m.id}`);this.store.remember(m.id);return;
      }
      if(text.startsWith('/')) {
        const match=/^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)!;
        const cmd=match[1].toLowerCase(),args=match[2]?.trim()??'';
        if(cmd==='help')this.store.output(undefined,help,`command:${m.id}`);
        else if(cmd==='workspace'){if(!this.workspaceCommand)throw new Error('Workspace creation is unavailable.');this.store.output(undefined,this.workspaceCommand(args),`command:${m.id}`);}
        else if(cmd==='sessions')this.store.output(undefined,this.store.bindings().map(b=>`${b.enabled?'●':'○'} ${b.alias} · ${b.provider} · ${b.mode}`).join('\n')||'No sessions registered. Open Session Bridge.app.',`command:${m.id}`);
        else if(cmd==='use') {const b=this.need(args);this.store.set('active',b.id);this.store.output(b,'Selected. Your next messages go to this exact session.',`command:${m.id}`);}
        else if(cmd==='to') {const [alias,...words]=args.split(/\s+/);if(!words.length)throw new Error('Use /to NAME message');this.queue(m.id,this.need(alias),words.join(' '));}
        else if(cmd==='status')this.store.output(undefined,`Active: ${this.store.binding(this.store.get('active')??'')?.alias??'none'}\nRunning: ${this.busy.size}\nWaiting permissions: ${this.approvals.pending.size}\n${this.store.jobs().slice(0,8).map(j=>`${j.id} · ${this.store.binding(j.binding_id)?.alias} · ${j.status}${j.error?` · ${j.error}`:''}`).join('\n')}`,`command:${m.id}`);
        else if(cmd==='stop') {const b=this.need(args);this.native.stop(b);this.store.output(b,'Pending bridge approvals denied. Interrupt active work using the native app stop control. The bridge does not kill your session.',`command:${m.id}`);}
        else if(cmd==='pause'||cmd==='resume') {const b=this.store.binding(args);if(!b)throw new Error('Unknown session');this.store.enable(b.id,cmd==='resume');if(cmd==='pause'){this.native.stop(b);this.channelClients.delete(b.id);}this.store.output(undefined,`${b.alias}: ${cmd==='resume'?'enabled':'paused'}`,`command:${m.id}`);}
        else if(cmd==='approve'||cmd==='deny') {this.approvals.answer(args,cmd,'approval');this.store.output(undefined,'Decision delivered.',`command:${m.id}`);}
        else if(cmd==='answer') {const [code,...words]=args.split(/\s+/);if(!words.length)throw new Error('Use /answer CODE your answer');this.approvals.answer(code,words.join(' '),'question');this.store.output(undefined,'Answer delivered.',`command:${m.id}`);}
        else if(cmd==='retry') {throw new Error('Uncertain native submissions are never resent automatically. Check the exact native session and delivery receipt before deciding to send a new request.');}
        else throw new Error('Unknown command. Send /help.');
      } else {
        let b:Binding|undefined;
        if(m.quotedId) {
          b=this.store.quotedBinding(m.quotedId);
          if(!b)throw new Error('That quoted message does not identify a registered session. Use /to NAME message.');
        } else if(this.coordinator){this.coordinator.routeToMaster(m.id,text);this.store.remember(m.id);this.pump();return;}
        else b=this.store.binding(this.store.get('active')??'');
        if(!b)throw new Error('Choose a session with /use NAME or quote an agent reply. Send /sessions to see your sessions.');
        this.queue(m.id,this.need(b.id),text);
      }
      this.store.remember(m.id);
    } catch(e) {this.store.output(undefined,(e as Error).message,`command-error:${m.id}`);this.store.remember(m.id);}
    this.pump();
  }
  requestProtected(id:string,bindingId:string) {
    if(this.busy.has(bindingId)||this.store.hasDispatched(bindingId)||[...this.approvals.pending.values()].some(p=>p.binding.id===bindingId))return true;
    // A parent's tracking must remain open while delegated requests are outstanding.
    return !!this.store.db.prepare(`SELECT 1 FROM inbox i JOIN settings s ON s.key='parent:'||i.id
      WHERE s.value=? AND i.status IN ('queued','dispatched','submitted','uncertain','failed') LIMIT 1`).get(id);
  }
  cleanupPolicy() {
    const hours=Number(this.store.get('cleanup-hours')??24);
    return {enabled:this.store.get('cleanup-enabled')==='true',afterHours:[24,72,168].includes(hours)?hours:24};
  }
  updateCleanup(enabled:boolean,afterHours:number) {
    if(typeof enabled!=='boolean'||![24,72,168].includes(afterHours))throw new Error('Choose 24 hours, 3 days or 7 days.');
    this.store.set('cleanup-hours',String(afterHours));this.store.set('cleanup-enabled',String(enabled));
    return this.cleanupPolicy();
  }
  reviewRequests(items:{requestId:string;expectedStatus:string;expectedUpdatedAt:number}[]) {
    if(!Array.isArray(items)||!items.length||items.length>500||new Set(items.map(i=>i.requestId)).size!==items.length)throw new Error('Select 1–500 distinct requests.');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for(const item of items) {
        if(!item||typeof item.requestId!=='string'||typeof item.expectedStatus!=='string'||!Number.isFinite(item.expectedUpdatedAt))throw new Error('Request identity, status and last update are required.');
        const j=this.store.job(item.requestId);
        if(!j||j.status!==item.expectedStatus||(j.updated_at??j.created_at)!==item.expectedUpdatedAt)throw new Error('A selected request changed. Refresh Activity and select it again.');
        if(!['submitted','uncertain','failed'].includes(j.status)||this.requestProtected(j.id,j.binding_id))throw new Error('A selected request is active, has pending permission, or has unfinished delegated work. Nothing was closed.');
      }
      for(const item of items) {
        const j=this.store.job(item.requestId)!;
        this.store.jobState(j.id,'reviewed');this.store.audit('request-reviewed',j.binding_id,JSON.stringify({requestId:j.id,previousStatus:j.status,bulk:true}));
      }
      this.store.db.exec('COMMIT');return {closed:items.length};
    } catch(e) {this.store.db.exec('ROLLBACK');throw e;}
  }
  autoCloseStale(now=Date.now()) {
    const policy=this.cleanupPolicy();if(this.stopped||!policy.enabled)return 0;
    let closed=0;
    for(const j of this.store.pendingJobs()) {
      if(!['submitted','uncertain','failed'].includes(j.status)||(j.updated_at??j.created_at)>now-policy.afterHours*3600000||this.requestProtected(j.id,j.binding_id))continue;
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.store.jobState(j.id,'auto_closed');
        this.store.audit('request-auto-closed',j.binding_id,JSON.stringify({requestId:j.id,previousStatus:j.status,afterHours:policy.afterHours}));
        this.store.db.exec('COMMIT');closed++;
      }catch(e){this.store.db.exec('ROLLBACK');throw e;}
    }
    return closed;
  }
  reviewRequest(id:string,expectedStatus:string) {
    const job=this.store.job(id);
    if(!job)throw new Error('Request not found. Refresh Activity.');
    if(job.status==='reviewed')return {ok:true};
    if(job.status!==expectedStatus)throw new Error('This request changed. Refresh Activity before reviewing it.');
    if(!['submitted','uncertain','failed'].includes(job.status))throw new Error('Only requests awaiting a reply or needing review can be closed after checking the native chat.');
    if(this.requestProtected(job.id,job.binding_id))throw new Error('This session is still delivering a request. Wait for delivery, permissions and delegated work to finish before reviewing it.');
    // Owner review is not an agent completion receipt and never resends work.
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.jobState(id,'reviewed');
      this.store.audit('request-reviewed',job.binding_id,JSON.stringify({requestId:id,previousStatus:job.status}));
      this.store.db.exec('COMMIT');
    } catch(e) {this.store.db.exec('ROLLBACK');throw e;}
    return {ok:true};
  }
  need(id:string){const b=this.store.binding(id);if(!b?.enabled)throw new Error('Session is missing or paused. Send /sessions.');return b;}
  queue(id:string,b:Binding,text:string) {
    if(text.length>32000)throw new Error('Message exceeds 32,000 characters.');
    this.store.enqueue(id,b,text);
  }
  pump() {
    if(this.stopped)return;
    for(const b of this.store.bindings()) {
      if(!b.enabled||b.mode==='channel'||this.busy.has(b.id))continue;
      const job=this.store.queued(b.id);if(!job)continue;
      this.busy.add(b.id);this.store.jobState(job.id,'dispatched');
      void this.native.run(b,job.body,job.id).then(()=>{if(this.store.job(job.id)?.status==='dispatched')this.store.jobState(job.id,'submitted');}).catch(e=>{
        if(this.store.job(job.id)?.status==='replaced')return;
        this.store.jobState(job.id,'uncertain',(e as Error).message);
        this.store.output(b,`I couldn't confirm a reply from this session, so I won't repeat the task automatically. Please check the native session before sending a new request.\nDetails: ${(e as Error).message}\nReference: ${job.id}`,`error:${job.id}`,job.destination??this.store.get('whatsapp-owner')??null);
      }).finally(()=>{this.busy.delete(b.id);this.pump();});
    }
  }
  channelPoll(b:Binding,client:string) {
    if(b.mode!=='channel')throw new Error('Session is not registered in channel mode.');
    const prior=this.channelClients.get(b.id);
    if(prior&&prior.id!==client&&Date.now()-prior.seen<20000)throw new Error('Another channel client owns this binding.');
    this.channelClients.set(b.id,{id:client,seen:Date.now()});
    if(this.store.hasDispatched(b.id))return null;
    const job=this.store.queued(b.id);if(!job)return null;
    this.store.jobState(job.id,'dispatched');return job;
  }
  channelReply(b:Binding,text:string,kind:string,requestId?:string,source?:string) {
    if(!this.store.binding(b.id)?.enabled)throw new Error('This session is inactive.');
    if(requestId&&this.store.job(requestId)?.status==='replaced')throw new Error('This request was closed when its master was replaced.');
    if(kind==='final'&&requestId&&this.hasPendingCreation?.(requestId))throw new Error('Session creation is still pending. Send progress and keep the owner request open.');
    if(kind==='final'&&!requestId&&this.store.unfinished(b.id).length)throw new Error('This session has open bridge requests. Use respond NAME REQUEST-ID (or whatsapp_reply with requestId) from the original message so the final reply closes the correct request. Use progress for an interim update.');
    if(requestId){const j=this.store.job(requestId);if(!j||j.binding_id!==b.id)throw new Error('Reply request does not belong to this session.');}
    this.store.output(b,text,source,requestId?this.store.job(requestId)?.destination??this.store.get('whatsapp-owner')??null:this.store.destination());
    if(requestId&&kind==='final')this.store.jobState(requestId,'completed');
    else if(requestId)this.store.db.prepare('UPDATE inbox SET updated_at=? WHERE id=?').run(Date.now(),requestId);
    if(kind==='final')this.store.set(`explicit-final:${b.id}`,String(Date.now()));
    if(kind==='final'&&requestId)this.coordinator?.workerReply(b,text,requestId);
  }
}
