import { randomBytes } from 'node:crypto';
import type { Binding } from './store.js';
import { Store } from './store.js';
import { briefTargetIdentity } from './brief-dispatch-guard.js';
import { blockCard, recordDecision, recordHandover, takeoverGuide, type HandoverReason } from './companion.js';
import { computerName } from './platform.js';
/** What the owner calls this computer in messages: Mac, PC or computer. */
const PC=computerName();

/** allow, deny, or hand the prompt back to the app so the owner does it there. */
export type Decision='approve'|'deny'|'native';
const NUMBERED:Record<string,Decision>={1:'approve',2:'deny',3:'native'};

export class Approvals {
  pending = new Map<string,{binding:Binding; question:string; kind:'approval'|'question'; source:'session'|'other'; expires:number; destination:string|null; owner:string|undefined; requestId?:string; targetIdentity?:string; attemptId?:string; identityEpoch?:number; settle:(answer:string)=>void; timer:NodeJS.Timeout}>();
  private identityFenceReady=false;
  constructor(private store:Store) {
    // The optional stuck notice cannot revive a prompt when identity changes
    // away and back. Failure to install this fence must not block the original
    // native permission message or its existing handler.
    try{
      store.db.exec('SAVEPOINT permission_epoch_install');
      try{
        store.db.exec('CREATE TABLE IF NOT EXISTS permission_identity_epoch(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL); INSERT OR IGNORE INTO permission_identity_epoch VALUES(1,0)');
        const schema=store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='permission_identity_epoch'").get() as {sql:string}|undefined;
        if(schema?.sql.replace(/\s+/g,'').toLowerCase()!=='createtablepermission_identity_epoch(idintegerprimarykeycheck(id=1),epochintegernotnull)')throw new Error('Invalid permission epoch schema');
        for(const op of ['INSERT','UPDATE','DELETE'] as const){
          const row=op==='DELETE'?'OLD':'NEW',changed=op==='UPDATE'?' AND OLD.value IS NOT NEW.value':'';
          store.db.exec(`DROP TRIGGER IF EXISTS permission_epoch_settings_${op.toLowerCase()}; DROP TRIGGER IF EXISTS permission_epoch_binding_${op.toLowerCase()};
            CREATE TRIGGER permission_epoch_settings_${op.toLowerCase()} AFTER ${op} ON settings
            WHEN (${row}.key='coordinator-registry' OR ${row}.key LIKE 'execution-mode:%' OR ${row}.key LIKE 'session-route:%' OR ${row}.key LIKE 'role-kind:%' OR ${row}.key LIKE 'coordinator-retired:%')${changed}
            BEGIN UPDATE permission_identity_epoch SET epoch=epoch+1 WHERE id=1; END;
            CREATE TRIGGER permission_epoch_binding_${op.toLowerCase()} AFTER ${op} ON bindings
            BEGIN UPDATE permission_identity_epoch SET epoch=epoch+1 WHERE id=1; END`);
        }
        store.db.exec('RELEASE permission_epoch_install');this.identityFenceReady=true;
      }catch(e){store.db.exec('ROLLBACK TO permission_epoch_install; RELEASE permission_epoch_install');throw e;}
    }catch{/* Optional alert authorization stays unavailable. */}
  }
  identityEpoch(){if(!this.identityFenceReady)return;try{const row=this.store.db.prepare('SELECT epoch FROM permission_identity_epoch WHERE id=1').get() as {epoch:number}|undefined;return Number.isSafeInteger(row?.epoch)?row!.epoch:undefined;}catch{return undefined;}}
  ask(binding:Binding, question:string, kind:'approval'|'question'='approval',requestId?:string,source:'session'|'other'='other'):Promise<string> {
    const code=randomBytes(4).toString('hex'), expires=Date.now()+15*60_000;
    return new Promise(resolve=>{
      const settle=(answer:string)=>{const p=this.pending.get(code);if(!p)return;clearTimeout(p.timer);this.pending.delete(code);this.store.audit('permission-answer',binding.id,`${code}:${kind==='approval'?answer:'answered'}`);if(p.requestId)try{recordDecision(this.store,{requestId:p.requestId,bindingId:binding.id,code,answer,at:Date.now()});}catch{}resolve(answer);};
      const timer=setTimeout(()=>settle('deny'),15*60_000);
      const destination=this.store.destination(),origin=requestId?this.store.requestOwnerOrigin(requestId):undefined;
      // A group JID survives account changes, so a current owner alone cannot prove the prompt's origin.
      const owner=destination&&destination===this.store.ownerFor(destination)?destination:origin?.destination===destination?origin.owner:undefined;
      let targetIdentity:string|undefined,attemptId:string|undefined,identityEpoch:number|undefined;
      if(requestId)try{const current=this.store.binding(binding.id),same=current&&current.native_id===binding.native_id&&current.cwd===binding.cwd&&current.token_hash===binding.token_hash&&current.mode===binding.mode&&current.provider===binding.provider&&current.created_at===binding.created_at;
        const job=this.store.job(requestId);
        if(same){targetIdentity=briefTargetIdentity(this.store,binding.id);identityEpoch=this.identityEpoch();if(job?.binding_id===binding.id&&job.destination===destination&&job.attempt_id)attemptId=job.attempt_id;}
      }catch{} // Missing identity only suppresses the optional stuck notice, never the native prompt.
      this.pending.set(code,{binding,question,kind,source,expires,destination,owner,requestId,targetIdentity,attemptId,identityEpoch,settle,timer});
      const body=source==='session'
        ?this.sessionText(binding,question)
        :`${kind==='approval'?'Permission needed':'Answer needed'}\n${question}\n\n${kind==='approval'?'Reply to this message with “Yes, allow it” or “No, deny it”.':'Reply to this message with your answer.'}\nExpires in 15 minutes.`;
      this.store.output(binding,body, `permission:${code}`);
    });
  }
  /** The card an owner sees for a real session prompt: what, where, and three real options. */
  private sessionText(binding:Binding,question:string) {
    return blockCard({store:this.store,binding,question,expiresMinutes:15}).text;
  }
  private hookReports() {try{const raw=this.store.get('provider-hooks-status');return raw?JSON.parse(raw):undefined;}catch{return undefined;}}
  /** Deliver the handover guide and remember it, so /done can check the real state. */
  private handOver(code:string,reason:HandoverReason) {
    const p=this.pending.get(code);if(!p)return;
    const {owner,destination,binding,requestId}=p;if(!owner||!destination)return;
    try{
      this.store.output(binding,takeoverGuide({store:this.store,binding,reason,hookReports:this.hookReports()}),`handover:${code}`,destination,{kind:'system',origin:'system',plain:true,...(requestId?{requestId}:{})});
      recordHandover(this.store,{owner,destination,bindingId:binding.id,requestId,reason,at:Date.now()});
    }catch{}
  }
  /**
   * A native question cannot travel through the permission hook: that channel
   * carries allow or deny only. Tell the owner the real questions at once and
   * hand the prompt back to the app, instead of offering a yes or no that can
   * never answer it.
   */
  blockUnanswerable(binding:Binding,question:string,requestId?:string):{answer:'native'} {
    const origin=requestId?this.store.requestOwnerOrigin(requestId):undefined;
    const destination=origin?.destination??this.store.destination();
    const owner=destination&&destination===this.store.ownerFor(destination)?destination:origin?.owner===destination?origin.owner:undefined;
    if(destination&&owner)try{
      this.store.output(binding,this.sessionText(binding,question),`permission-question:${randomBytes(4).toString('hex')}`,destination,{kind:'system',origin:'system',plain:true,...(requestId?{requestId}:{})});
      recordHandover(this.store,{owner,destination,bindingId:binding.id,requestId,reason:'question',at:Date.now()});
    }catch{}
    return {answer:'native'};
  }
  answer(code:string,answer:string,kind:'approval'|'question') {
    const p=this.pending.get(code);if(!p || p.kind!==kind || Date.now()>p.expires)throw new Error('That request has expired, belongs to another action, or was already answered.');
    if(this.store.destinationContext.getStore()&&p.destination!==this.store.destination())throw new Error('Reply in the original chat where this permission was requested.');
    if(kind==='approval'&&!['approve','deny','native'].includes(answer))throw new Error('Choose allow, deny or take over.');
    if(answer==='native')this.handOver(code,'owner-choice');
    p.settle(answer);
  }
  naturalReply(text:string,quotedId?:string,source:'text'|'voice'='text') {
    const trimmed=text.trim();
    const words=/^(?:yes(?:[, ]+allow it)?|allow it|approve(?: it)?|yes[, ]+go ahead)[.!]?$/i.test(trimmed)?'approve':/^(?:no(?:[, ]+(?:deny|don['’]t allow) it)?|deny(?: it)?|don['’]t allow it)[.!]?$/i.test(trimmed)?'deny':/^(?:take over|i(?:'|’)?ll do it(?: on the mac| myself)?|do it on the mac|let me do it)$/i.test(trimmed)?'native':undefined;
    const quoted=quotedId?this.store.db.prepare('SELECT source,status FROM outbox WHERE wa_id=?').get(quotedId) as {source:string;status:string}|undefined:undefined;
    const code=quoted?.source.match(/^permission:([a-f0-9]{8}):\d+$/)?.[1];
    // A number is a decision only when it replies to the permission card it answers.
    const decision=code&&NUMBERED[trimmed]?NUMBERED[trimmed]:words;
    let pending=code?this.pending.get(code):undefined,selected=code;
    if(code&&!pending)throw new Error('That permission or question has expired or was already answered. Ask me to continue if you still need it.');
    if(!code&&(!words||!this.pending.size))return;
    if(!code&&/^(yes|no)[.!]?$/i.test(trimmed))return;
    if(!code&&quotedId)return; // A reply to ordinary work must never answer a different permission.
    if(!code){
      const approvals=[...this.pending.entries()].filter(([,p])=>p.kind==='approval'&&Date.now()<=p.expires);
      if(approvals.length!==1||this.pending.size!==1)throw new Error(`Please reply to the specific permission message with 1 to allow, 2 to deny or 3 to do it on the ${PC}, so I know which action you mean.`);
      [selected,pending]=approvals[0];
      const sent=this.store.db.prepare("SELECT 1 FROM outbox WHERE source LIKE ? AND status='sent'").get(`permission:${selected}:%`);
      if(!sent)throw new Error('Wait for the permission message, then reply to it with your decision.');
    }
    if(!pending||!selected)return;
    if(pending.destination!==this.store.destination())throw new Error('Reply in the original chat where this permission was requested.');
    if(quoted&&quoted.status!=='sent')throw new Error('Wait for the permission message, then reply to it with your decision.');
    if(!this.store.binding(pending.binding.id)?.enabled)throw new Error('That session is paused. Resume it in the app before answering.');
    if(source==='voice')throw new Error('Please type your permission decision or answer; voice transcription may mishear it.');
    if(pending.kind==='approval'&&!decision)throw new Error(`Reply to this permission message with 1 to allow, 2 to deny, or 3 to do it on the ${PC}.`);
    this.answer(selected,pending.kind==='approval'?decision!:trimmed,pending.kind);
    return {binding:pending.binding,message:pending.kind==='question'?'Your answer was sent.':decision==='approve'?'Allowed. I sent your decision to the session, and I will tell you if it still does not move.':decision==='deny'?'Denied. That action was not approved.':`Taking over. Nothing was approved, and I sent you the steps for the ${PC}.`};
  }
  cancel(bindingId?:string) {for(const p of this.pending.values())if(!bindingId||p.binding.id===bindingId)p.settle('deny');}
  view(){return [...this.pending.entries()].map(([code,p])=>({code,alias:p.binding.alias,question:p.question,kind:p.kind,expires:p.expires}));}
}
