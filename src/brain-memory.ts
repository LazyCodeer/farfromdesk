import {unreachable} from './meta-brain.js';
import { itemSessionLabel } from './item-session-label.js';
import { Items, type Item } from './items.js';
import type { Store, Binding } from './store.js';
import type { Router, Incoming } from './router.js';
import type { Interpretation } from './meta-model.js';

/** The existing shared work list is the memory, not a second independent todo database. */
export class BrainMemory {
  readonly items:Items;
  constructor(private store:Store) {
    this.items=new Items(store);
    store.db.exec('CREATE TABLE IF NOT EXISTS brain_item_routes(item_id INTEGER NOT NULL,destination TEXT NOT NULL,PRIMARY KEY(item_id,destination));');
  }
  /** One item of this chat, found directly rather than through the 100-row board view. */
  item(id:number,destination=this.store.destination()) {return this.board(destination,id)[0];}
  board(destination=this.store.destination(),only?:number,verifiedOwner?:string) {
    if(!destination)return [];
    return (this.store.db.prepare(`SELECT DISTINCT i.* FROM items i WHERE (?1 IS NULL OR i.id=?1) AND (
      EXISTS(SELECT 1 FROM brain_item_routes r WHERE r.item_id=i.id AND r.destination=?2) OR
      EXISTS(SELECT 1 FROM item_requests r JOIN inbox j ON j.id=r.request_id WHERE r.item_id=i.id AND j.destination=?2))
      AND (?3 IS NULL OR EXISTS(SELECT 1 FROM item_owner_origins o WHERE o.item_id=i.id AND o.destination=?2 AND o.owner=?3))
      ORDER BY i.updated_at DESC,i.id DESC LIMIT 100`).all(only??null,destination,verifiedOwner??null) as Item[]).map(item=>{
        let jobs=this.store.db.prepare('SELECT j.id,j.binding_id,j.status,j.outcome,j.first_reply_at,j.created_at,j.updated_at FROM inbox j JOIN item_requests r ON r.request_id=j.id WHERE r.item_id=? AND j.destination=? ORDER BY j.created_at DESC,j.rowid DESC').all(item.id,destination)
          // Status questions are about the work, not part of it, so their state never drives the item's.
          .filter(j=>!this.store.get(`brain-ask:${j.id}`));
        // Keep prior attempts in the ledger, but only the latest owner-authorized run drives current tracking.
        const restart=jobs.findIndex(j=>this.store.get(`brain-restart:${j.id}`)===String(item.id));
        if(restart>=0)jobs=jobs.slice(0,restart+1);
        const latest=jobs[0];
        const gone=this.gone(latest);
        const executionState=!latest?'not dispatched':gone?gone:latest.outcome==='blocked'||['failed','uncertain'].includes(String(latest.status))?'blocked':latest.outcome==='done'?'reported done, not owner verified':latest.status==='completed'?'reported finished':latest.first_reply_at?'in progress':latest.status==='submitted'?'sent to session; no reply yet':String(latest.status);
        return {...item,executionState,ref:`item:${item.id}`,jobs,session:item.binding_id&&this.store.binding(item.binding_id)?itemSessionLabel(this.store,this.store.binding(item.binding_id)!):null};
      });
  }
  /** Why the latest dispatch can no longer finish: its session was replaced or paused before a final answer. */
  gone(job?:Record<string,any>):string|undefined {
    if(!job||(job.status==='completed'&&job.outcome==='done'))return undefined;
    const b=this.store.binding(String(job.binding_id)),name=b?(this.store.get(`name:${b.id}`)??b.alias).replace(/\s+/g,' ').slice(0,60):'its session';
    if(job.status==='replaced')return `${name} was replaced before it finished. Nothing was resent`;
    if(!b)return 'its session was removed before it finished. Nothing was resent';
    if(!b.enabled&&['queued','dispatched','submitted'].includes(String(job.status)))return `${name} is paused, so it can't finish or answer. Nothing was resent`;
    return undefined;
  }
  /** What the owner can do next for an item whose session can no longer answer. */
  attention(item:{id:number;title:string;jobs:Record<string,any>[]}) {
    const why=this.gone(item.jobs[0]);
    return why?`#${item.id} ${item.title}: ${why}. Say "start #${item.id} again" to send it to your current proxy, or "mark #${item.id} as done".`:undefined;
  }
  synchronize() {
    for(const item of this.board()){
      if(!item.jobs.length)continue;
      const latest=item.jobs[0];
      if(!item.binding_id){
        const ids=[...new Set(item.jobs.map(j=>String(j.binding_id)))];
        if(ids.length===1&&this.store.binding(ids[0]))this.items.setSession(item.id,ids[0],'Brain evidence');
      }
      const complete=item.jobs.every(j=>j.status==='completed'&&j.outcome==='done'&&this.store.db.prepare("SELECT 1 FROM reply_receipts WHERE request_id=? AND kind='final' AND origin='agent'").get(j.id));
      // A block the Brain set itself lifts on later evidence; one the owner set stays.
      if(complete&&(item.status==='in progress'||item.status==='blocked'&&this.items.statusBy(item.id)==='Brain evidence')){
        this.items.setStatus(item.id,'done','Brain evidence');
        this.items.note(item.id,'All linked sessions reported completion with final replies. Owner verification is separate.','Brain evidence',`brain-complete:${item.id}:${latest.id}`);
      }else if(['in progress','not started'].includes(item.status)&&this.gone(latest)){
        this.items.setStatus(item.id,'waiting on owner','Brain evidence');
        this.items.note(item.id,`${this.gone(latest)}. Waiting for the owner to resend or close it.`,'Brain evidence',`brain-gone:${item.id}:${latest.id}`);
      }else if(item.status==='in progress'&&(latest.outcome==='blocked'||['uncertain','failed'].includes(String(latest.status))))this.items.setStatus(item.id,'blocked','Brain evidence');
      else if(item.status==='not started'&&['queued','dispatched','submitted'].includes(String(latest.status)))this.items.setStatus(item.id,'in progress','Brain evidence');
    }
  }
  candidates(router:Router) {
    const ids=new Set(this.board().flatMap(i=>i.jobs.map(j=>String(j.binding_id))));
    // Connected sessions count before their first job, so naming one routes to it instead of a guess.
    for(const b of router.coordinator?.selected()??[])ids.add(b.id);
    // Every enabled session the owner can see counts too: prod 'selected' is often empty, so the brain
    // couldn't list, pause or schedule sessions the owner named (sim, 7 Nov 2026).
    // A paused session the owner has named stays reachable, or "resume X" could never find it.
    return this.store.bindings().filter(b=>b.enabled||ids.has(b.id)||router.coordinator?.isCoordinator(b.id)||!!this.store.get(`name:${b.id}`));
  }
  resolve(ref:string):Item {
    const id=/^item:(\d+)$/.exec(ref)?.[1];
    const itemId=id?Number(id):this.store.itemOf(ref);
    const item=this.board().find(i=>i.id===itemId);
    if(!item)throw new Error('That topic does not belong to this chat. Please name the task again.');
    return item;
  }
  owner(item:Item,router:Router):Binding|undefined {
    const board=this.board().find(i=>i.id===item.id)!;
    // An explicit current assignment is preferred. Multiple worker branches are ambiguous.
    const workers=[...new Set(board.jobs.map(j=>String(j.binding_id)).filter(id=>!router.coordinator?.isCoordinator(id)))];
    const assignedWorker=item.binding_id&&!router.coordinator?.isCoordinator(item.binding_id)?item.binding_id:undefined;
    if(!assignedWorker&&workers.length>1)throw new Error('More than one session worked on this topic. Please name the session.');
    const id=assignedWorker??workers[0]??item.binding_id;
    if(!id)return undefined;
    if(!board.jobs.some(j=>j.binding_id===id))throw new Error('This assignment has no linked dispatch evidence. Please confirm the owning session through its coordinator.');
    const b=this.store.binding(id);if(!b)throw new Error('The saved session is missing. Review this task before rerouting it.');
    return b;
  }
  link(requestId:string,itemId:number) {
    this.store.linkItem(requestId,itemId);
    const destination=this.store.destination();
    if(destination)this.store.db.prepare('INSERT OR IGNORE INTO brain_item_routes VALUES(?,?)').run(itemId,destination);
  }
  add(requestId:string,title:string) {
    const item=this.items.add(title.slice(0,200),'Owner',undefined,`brain-item:${requestId}`,requestId);
    this.link(requestId,item.id);return item;
  }
  /** Interpretation proposes a management operation; literal original commands authorize it. */
  manage(router:Router,m:Incoming,d:Interpretation):string {
    if(d.operation==='add_todo') {
      // The owner says this the way people say it: "don't let me forget to call Ashitosh" was
      // refused live with a scolding about "Add todo:", because the model read the intent
      // correctly and this literal check did not accept the phrasing.
      const match=/^(?:please\s+)?(?:add (?:a )?(?:to-do|todo|task)|remember(?: this)?(?: task)?|don'?t (?:let me )?forget)[ :]+(?:to\s+)?([\s\S]+)$/i.exec(m.text.trim());
      if(!match)throw new Error('To save without starting work, say “Add todo: …”.');
      // "add todos: X; Y" or one per line saves each (sim, 7 Nov 2026: refused as "one list change per message").
      // ponytail: only lines, semicolons and numbered/bulleted lists split; "call mom and dad" stays one item.
      const titles=match[1].split(/\n|;|\s(?=\d+[.)]\s)/).map(t=>t.replace(/^\s*(?:[-*•]|\d+[.)])\s*/,'').trim()).filter(Boolean);
      const items=titles.map((t,i)=>this.add(i?`${m.id}#${i}`:m.id,t));
      return items.length===1?`Saved #${items[0].id}: ${items[0].title}. Status: not started. No session was dispatched.`
        :`Saved ${items.length} to-dos:\n${items.map(i=>`#${i.id}: ${i.title}`).join('\n')}\nStatus: not started. No session was dispatched.`;
    }
    if(d.operation==='set_todo') {
      const match=/^(?:please\s+)?(?:mark|set) ["“]?(.+?)["”]?(?:\s+(?:as|to))?\s+(not started|in progress|waiting on owner|blocked|done)[.!]?$/i.exec(m.text.trim());
      // "isko complete mark kar do" got 'Name one task...' (sim, 7 Nov 2026). The owner's own words must still say the status.
      const said:Record<string,RegExp>={done:/\b(?:done|complete[d]?|finished|ho gaya|khatam|poora|pura)\b/i,blocked:/\b(?:blocked|stuck|atka)\b/i,'in progress':/\b(?:in progress|started|chal raha)\b/i,'not started':/\bnot started\b/i,'waiting on owner':/\bwaiting on (?:me|owner)\b/i};
      const loose=d.taskIds.length===1&&!!d.itemStatus&&!!said[d.itemStatus]?.test(m.text)&&/\b(?:mark|set|kar)\b/i.test(m.text);
      if(!loose&&(!match||d.taskIds.length!==1||match[2].toLowerCase()!==d.itemStatus))throw new Error('Name one task and its status, for example “Mark invoice export as blocked”.');
      const item=this.resolve(d.taskIds[0]);this.link(m.id,item.id);
      this.items.setStatus(item.id,d.itemStatus!,'Owner');
      this.items.note(item.id,'Owner changed the board status; this does not certify execution or approve native actions.','Owner',`brain-note:${m.id}`);
      return d.itemStatus==='done'?`Marked "${item.title}" done.`:`"${item.title}" is now ${d.itemStatus}.`;
    }
    if(d.operation==='pause_session'||d.operation==='resume_session') {
      // Owners say "pause the Acme one" or "Client: Acme storefront ko pause karo". The model picks the session;
      // code only checks the verb matches and the owner's words name that session (sim, 7 Nov 2026).
      const said=m.text.toLowerCase(),resume=d.operation==='resume_session';
      // The first verb decides: "Pause X. I'll ask you to resume it shortly" is a pause (sim, 7 Nov 2026).
      const first=/\b(resume|reconnect|connect|unpause|start again|pause|disconnect|stop|hold)\b/.exec(said)?.[1];
      const verb=first?(/^(pause|disconnect|stop|hold)$/.test(first)?'pause':'resume'):undefined;
      // "Mark Portfolio as paused" in a status line is not a pause (sim, 7 Nov 2026).
      if(verb!==(resume?'resume':'pause'))throw new Error(`I didn't ${resume?'resume':'pause'} anything. To change a session, say “${resume?'Resume':'Pause'}” and its name.`);
      const words=(b:Binding)=>[b.alias,this.store.get(`name:${b.id}`)??b.alias].flatMap(n=>[n.toLowerCase(),...n.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>=4)]);
      const matches=this.candidates(router).filter(b=>b.id===d.sessionId&&words(b).some(w=>said.includes(w)));
      if(matches.length!==1)throw new Error('Please name one session already associated with this chat.');
      const b=matches[0],policy=JSON.parse(this.store.get('meta-brain-policy')??'{}');
      if(!policy.providers?.includes(b.provider)||!router.coordinator?.enabled().includes(b.provider))throw new Error(unreachable(this.store.get(`name:${b.id}`)??b.alias,{...b,enabled:1},policy.providers??[],router.coordinator?.enabled()??[]));
      const coordinator=router.coordinator.registry.bindingFor(b);
      // A paused coordinator can resume itself; its own pause must not lock it out.
      if(!coordinator||!(coordinator.enabled||resume&&coordinator.id===b.id)||router.coordinator.registry.identity(coordinator).key!==router.coordinator.registry.entry(coordinator.id)?.key)throw new Error('Review the saved coordinator connection before changing this session.');
      if(resume){const selected=JSON.parse(this.store.get('selected')??'[]') as string[];this.store.set('selected',JSON.stringify([...new Set([...selected,b.id])]));}
      this.store.enable(b.id,resume);
      // Pausing forwarding does not terminate native work or disconnect the owner messaging account.
      if(!resume)router.channelClients.delete(b.id);
      this.store.audit(resume?'brain-session-resumed':'brain-session-paused',b.id);
      return `${resume?'Resumed':'Paused'} ${this.store.get(`name:${b.id}`)??b.alias}. ${resume?'New messages can go to it again.':'New messages will not go to it.'} Work already running is not stopped.`;
    }
    throw new Error('Please clarify which task or session change you want.');
  }
}
