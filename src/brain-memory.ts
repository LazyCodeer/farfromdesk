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
  board(destination=this.store.destination()) {
    if(!destination)return [];
    return (this.store.db.prepare(`SELECT DISTINCT i.* FROM items i WHERE
      EXISTS(SELECT 1 FROM brain_item_routes r WHERE r.item_id=i.id AND r.destination=?) OR
      EXISTS(SELECT 1 FROM item_requests r JOIN inbox j ON j.id=r.request_id WHERE r.item_id=i.id AND j.destination=?)
      ORDER BY i.updated_at DESC,i.id DESC LIMIT 100`).all(destination,destination) as Item[]).map(item=>{
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
      if(complete&&item.status==='in progress'){
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
    return this.store.bindings().filter(b=>ids.has(b.id)||router.coordinator?.isCoordinator(b.id));
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
    const item=this.items.add(title.slice(0,200),'Owner',undefined,`brain-item:${requestId}`);
    this.link(requestId,item.id);return item;
  }
  /** Interpretation proposes a management operation; literal original commands authorize it. */
  manage(router:Router,m:Incoming,d:Interpretation):string {
    if(d.operation==='add_todo') {
      const match=/^(?:please\s+)?(?:add (?:a )?(?:to-do|todo|task)|remember(?: this)?(?: task)?)[ :]+([\s\S]+)$/i.exec(m.text.trim());
      if(!match)throw new Error('To save without starting work, say “Add todo: …”.');
      const item=this.add(m.id,match[1]);
      return `Saved #${item.id}: ${item.title}. Status: not started. No session was dispatched.`;
    }
    if(d.operation==='set_todo') {
      const match=/^(?:please\s+)?(?:mark|set) (.+?) (?:as|to) (not started|in progress|waiting on owner|blocked|done)[.!]?$/i.exec(m.text.trim());
      if(!match||d.taskIds.length!==1||match[2].toLowerCase()!==d.itemStatus)throw new Error('Name one task and its status, for example “Mark invoice export as blocked”.');
      const item=this.resolve(d.taskIds[0]);this.link(m.id,item.id);
      this.items.setStatus(item.id,d.itemStatus,'Owner');
      this.items.note(item.id,'Owner changed the board status; this does not certify execution or approve native actions.','Owner',`brain-note:${m.id}`);
      return `#${item.id}: ${d.itemStatus}. Saved as your board update; execution evidence is unchanged.`;
    }
    if(d.operation==='pause_session'||d.operation==='resume_session') {
      const match=/^(?:please\s+)?(pause|disconnect|resume|reconnect|connect) (?:the )?(?:session )?(.+?)[.!]?$/i.exec(m.text.trim());
      const resume=d.operation==='resume_session';
      if(!match||resume!==/^(resume|reconnect|connect)$/i.test(match[1]))throw new Error('Say “Pause session NAME” or “Resume session NAME” for one exact session.');
      const matches=this.candidates(router).filter(b=>[b.alias,this.store.get(`name:${b.id}`)??b.alias].some(n=>n.toLowerCase()===match[2].toLowerCase()));
      if(matches.length!==1||matches[0].id!==d.sessionId)throw new Error('Please use the exact name of one session already associated with this chat.');
      const b=matches[0],policy=JSON.parse(this.store.get('meta-brain-policy')??'{}');
      if(!policy.providers?.includes(b.provider)||!router.coordinator?.enabled().includes(b.provider))throw new Error('This platform is disabled or denied by your policy.');
      const coordinator=router.coordinator.registry.bindingFor(b);
      if(!coordinator?.enabled||router.coordinator.registry.identity(coordinator).key!==router.coordinator.registry.entry(coordinator.id)?.key)throw new Error('Review the saved coordinator connection before changing this session.');
      if(resume){const selected=JSON.parse(this.store.get('selected')??'[]') as string[];this.store.set('selected',JSON.stringify([...new Set([...selected,b.id])]));}
      this.store.enable(b.id,resume);
      // Pausing forwarding does not terminate native work or disconnect the owner messaging account.
      if(!resume)router.channelClients.delete(b.id);
      this.store.audit(resume?'brain-session-resumed':'brain-session-paused',b.id);
      return `${b.alias}: bridge forwarding ${resume?'enabled':'paused'}. Native work and permissions are unchanged.`;
    }
    throw new Error('Please clarify which task or session change you want.');
  }
}
