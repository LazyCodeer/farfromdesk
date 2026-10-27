import type { Store, Binding } from './store.js';
import { itemSessionLabel } from './item-session-label.js';

/** The coordinators' shared work list: one numbered row per piece of owner work, with its session
 * and short dated notes. It lives in the bridge DB, so every coordinator sees the same numbers. */
export const ITEM_STATUSES=['not started','in progress','waiting on owner','blocked','done'] as const;
export type ItemStatus=typeof ITEM_STATUSES[number];
export type Item={id:number;title:string;status:ItemStatus;binding_id:string|null;created_at:number;updated_at:number};
export type ItemNote={item_id:number;at:number;by:string|null;note:string};

const icon:Record<ItemStatus,string>={'not started':'⚪','in progress':'🛠️','waiting on owner':'⚠️','blocked':'⛔','done':'✅'};

export function itemStatus(value:string):ItemStatus {
  const s=value.trim().toLowerCase().replace(/[-_]+/g,' ').replace(/^waiting$/,'waiting on owner').replace(/^todo$/,'not started');
  if(!(ITEM_STATUSES as readonly string[]).includes(s))throw new Error(`Status must be one of: ${ITEM_STATUSES.join(', ')}.`);
  return s as ItemStatus;
}

export class Items {
  constructor(private store:Store,private name:(b:Binding)=>string=b=>store.get(`name:${b.id}`)??b.alias) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,status TEXT NOT NULL,binding_id TEXT,event_id TEXT UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS item_notes(id INTEGER PRIMARY KEY,item_id INTEGER NOT NULL REFERENCES items(id),at INTEGER NOT NULL,by TEXT,note TEXT NOT NULL,event_id TEXT UNIQUE);`);
  }
  list(all=false):Item[] {return this.store.db.prepare(`SELECT id,title,status,binding_id,created_at,updated_at FROM items ${all?'':"WHERE status<>'done'"} ORDER BY id`).all() as Item[];}
  get(id:number):Item {
    const item=this.store.db.prepare('SELECT id,title,status,binding_id,created_at,updated_at FROM items WHERE id=?').get(id) as Item|undefined;
    if(!item)throw new Error(`There is no item ${id}. Run ffd items to see the list.`);
    return item;
  }
  notes(id:number):ItemNote[] {return this.store.db.prepare('SELECT item_id,at,by,note FROM item_notes WHERE item_id=? ORDER BY id').all(id) as ItemNote[];}
  /** A session reference is a binding ID, alias or exact name. */
  session(ref:string):Binding {
    const all=this.store.bindings(),wanted=ref.trim().toLowerCase();
    const exact=all.filter(b=>b.id===ref||b.alias===ref),named=all.filter(b=>this.name(b).trim().toLowerCase()===wanted||itemSessionLabel(this.store,b).toLowerCase()===wanted),matches=exact.length?exact:named;
    if(matches.length>1)throw new Error(`More than one session is named "${ref}". Use its alias: ${matches.map(b=>b.alias).join(', ')}.`);
    if(!matches.length)throw new Error(`No session called "${ref}". Run ffd sessions to find its name.`);
    return matches[0];
  }
  /** Repeating an add with the same eventId returns the item it already made. */
  add(title:string,by?:string,sessionRef?:string,eventId?:string):Item {
    const t=title.trim().replace(/\s+/g,' ');
    if(!t||t.length>200)throw new Error('An item needs a short title (up to 200 characters).');
    const existing=eventId&&this.store.db.prepare('SELECT id FROM items WHERE event_id=?').get(eventId) as {id:number}|undefined;
    if(existing)return this.get(existing.id);
    const binding=sessionRef?this.session(sessionRef):undefined,now=Date.now();
    const r=this.store.db.prepare('INSERT INTO items(title,status,binding_id,event_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(t,binding?'in progress':'not started',binding?.id??null,eventId??null,now,now);
    const id=Number(r.lastInsertRowid);
    this.note(id,binding?`Added and given to ${itemSessionLabel(this.store,binding)}.`:'Added.',by);
    return this.get(id);
  }
  setStatus(id:number,status:string,by?:string) {
    const s=itemStatus(status),item=this.get(id);
    if(item.status!==s){this.store.db.prepare('UPDATE items SET status=?,updated_at=? WHERE id=?').run(s,Date.now(),id);this.note(id,`Status: ${s}.`,by);}
    return this.get(id);
  }
  setSession(id:number,ref:string,by?:string) {
    const b=this.session(ref),item=this.get(id);
    if(item.binding_id!==b.id){this.store.db.prepare('UPDATE items SET binding_id=?,updated_at=? WHERE id=?').run(b.id,Date.now(),id);this.note(id,`Given to ${itemSessionLabel(this.store,b)}.`,by);}
    return this.get(id);
  }
  note(id:number,text:string,by?:string,eventId?:string) {
    const t=text.trim();if(!t||t.length>500)throw new Error('A note needs short text (up to 500 characters).');
    this.get(id);
    this.store.db.prepare('INSERT OR IGNORE INTO item_notes(item_id,at,by,note,event_id) VALUES(?,?,?,?,?)').run(id,Date.now(),by??null,t,eventId??null);
    this.store.db.prepare('UPDATE items SET updated_at=? WHERE id=?').run(Date.now(),id);
    return this.get(id);
  }
  sessionName(item:Item) {const b=item.binding_id?this.store.bindings().find(b=>b.id===item.binding_id):undefined;return b?itemSessionLabel(this.store,b):'no session';}
  line(item:Item) {return `${item.id}. ${icon[item.status]} ${item.title} · ${item.status} · ${this.sessionName(item)}`;}
  /** Three sections with short codes (T1 to do, P1 in progress, D1 done) so open work never drowns in finished items.
   * Codes are positions in the last list sent; the bridge keeps that snapshot so "P2" means what the owner saw. */
  text(all=false,scopedRows?:Item[],codesKey='item-codes') {
    const rows=scopedRows??this.list(true);
    if(!rows.length)return 'No items yet. Add one with ffd item add.';
    const todo=rows.filter(i=>i.status==='not started');
    // Work waiting on the owner or blocked leads its section, so it is never below the fold.
    const progress=rows.filter(i=>i.status!=='not started'&&i.status!=='done').sort((a,b)=>Number(b.status!=='in progress')-Number(a.status!=='in progress')||a.id-b.id);
    const done=rows.filter(i=>i.status==='done').sort((a,b)=>b.updated_at-a.updated_at||b.id-a.id);
    const shownDone=all?done:done.slice(0,5),codes:Record<string,number>={};
    const section=(title:string,letter:string,items:Item[])=>items.length?[`*${title}*`,...items.map((item,n)=>{codes[`${letter}${n+1}`]=item.id;return `${letter}${n+1} ${icon[item.status]} ${item.title} · ${item.status==='in progress'||item.status==='not started'||item.status==='done'?'':item.status+' · '}${this.sessionName(item)} (#${item.id})`;})].join('\n'):'';
    const needs=progress.filter(i=>i.status!=='in progress').length;
    const text=[`${todo.length} to do, ${progress.length} in progress${needs?` (${needs} need the owner or are blocked)`:''}, ${done.length} done.`,
      section('To do','T',todo),section('In progress','P',progress),
      section(all||done.length<=5?'Done':`Done, latest 5 of ${done.length}`,'D',shownDone)+(shownDone.length<done.length?`\n…and ${done.length-shownDone.length} older. Ask for all items to see them.`:''),
    ].filter(Boolean).join('\n\n');
    this.store.set(codesKey,JSON.stringify(codes));
    return text;
  }
  show(id:number) {
    const item=this.get(id),day=(at:number)=>new Date(at).toISOString().slice(0,16).replace('T',' ');
    const b=item.binding_id?this.store.binding(item.binding_id):undefined;
    return [this.line(item),...(b?[`Original chat title: ${this.name(b).replace(/\s+/g,' ')}`]:[]),...this.notes(id).map(n=>`- ${day(n.at)} ${n.note}`)].join('\n');
  }
  /** Owner-facing summary per session for the desktop app. */
  view() {return this.list(true).map(i=>{const b=i.binding_id?this.store.binding(i.binding_id):undefined;return {...i,session:this.sessionName(i),sessionTitle:b?this.name(b):null,sessionAlias:b?.alias??null,notes:this.notes(i.id)};});}
}

/** One endpoint for every item operation, so the ffd command, MCP tool and app share it. */
export function itemOperation(items:Items,d:any,by:string):{text:string;item?:Item} {
  const id=Number(d.id);
  const needId=()=>{if(!Number.isInteger(id)||id<1)throw new Error('Give the item number.');return id;};
  switch(d.op) {
    case 'list':return {text:items.text(d.all===true)};
    case 'show':return {text:items.show(needId())};
    case 'add':{const item=items.add(String(d.title??''),by,d.session?String(d.session):undefined,d.eventId?String(d.eventId):undefined);if(d.note)items.note(item.id,String(d.note),by);return {text:`Added item ${item.id}.\n${items.line(item)}`,item};}
    case 'set':{
      const item=d.status!==undefined?items.setStatus(needId(),String(d.status),by):d.session!==undefined?items.setSession(needId(),String(d.session),by):d.note!==undefined?items.note(needId(),String(d.note),by,d.eventId?String(d.eventId):undefined):undefined;
      if(!item)throw new Error('Set a status, session or note.');
      return {text:items.line(item),item};
    }
    default:throw new Error('Item operation must be list, show, add or set.');
  }
}
