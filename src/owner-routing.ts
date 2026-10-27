import type { Store, Binding } from './store.js';

/** Where an owner message goes before the proxy guesses: a named item's session, or the session
 * the owner chose to talk to directly. Both only pick routing; permissions never change. */
const words:Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12};

const num=(w:string)=>/^\d+$/.test(w)?Number(w):words[w.toLowerCase()];
const letters:Record<string,string>={t:'T',p:'P',d:'D',todo:'T','to do':'T',new:'T',progress:'P','in progress':'P',done:'D'};

/** "#3 …", "item 3: …", a list code "P2 …", or a voice note's "item three" / "progress task two". */
export function namedItem(text:string,codes:Record<string,number>={}) {
  const m=/^(?:#\s?(\d{1,5})|item\s+(?:number\s+)?(\d{1,5}|[a-z]+)|([tpd])\s?(\d{1,3})|(to do|todo|new|in progress|progress|done)\s+(?:task|item)\s+(\d{1,3}|[a-z]+))\b[\s:,.-]*/i.exec(text);
  if(!m)return undefined;
  const id=m[1]?Number(m[1]):m[2]?num(m[2]):codes[`${letters[(m[3]??m[5]).toLowerCase()]}${num(m[4]??m[6])}`];
  return id?{id,rest:text.slice(m[0].length).trim()}:undefined;
}

/** Every item the owner names anywhere in a sentence: "#3", "item 3", or a code from the last list ("update on P1"). */
export function mentionedItems(text:string,codes:Record<string,number>={}) {
  const ids=new Set<number>();
  for(const m of text.matchAll(/(?:^|[^\w#])(?:#\s?(\d{1,5})|item\s+(?:number\s+)?(\d{1,5}|[a-z]+)\b|([tpd])(\d{1,3})\b|(to do|todo|in progress|progress|done)\s+(?:task|item)\s+(\d{1,3}|[a-z]+)\b)/gi)){
    const id=m[1]?Number(m[1]):m[2]?num(m[2]):codes[`${letters[(m[3]??m[5]).toLowerCase()]}${num(m[4]??m[6])}`];
    if(id)ids.add(id);
  }
  return [...ids];
}

export const DIRECT_IDLE_MS=2*60*60_000;
type Direct={bindingId:string;at:number};
const key=(store:Store)=>`direct:${store.destination()??'owner'}`;

/** The session this chat talks to directly, if the owner chose one and has used it in the last two hours. */
export function directSession(store:Store,isProxy:(id:string)=>boolean,now=Date.now()):Binding|undefined {
  const raw=store.get(key(store));if(!raw)return undefined;
  const d=JSON.parse(raw) as Direct,b=store.binding(d.bindingId);
  if(!b?.enabled||isProxy(b.id)||now-d.at>DIRECT_IDLE_MS){store.db.prepare('DELETE FROM settings WHERE key=?').run(key(store));return undefined;}
  store.set(key(store),JSON.stringify({...d,at:now}));
  return b;
}
export function startDirect(store:Store,b:Binding,destination?:string|null) {
  store.destinationContext.run(destination??store.destination()??'owner',()=>store.set(key(store),JSON.stringify({bindingId:b.id,at:Date.now()})));
}
export function endDirect(store:Store) {
  const had=!!store.get(key(store));
  store.db.prepare('DELETE FROM settings WHERE key=?').run(key(store));
  return had;
}
export const backToProxy=/^(?:\/back|back|go back|back to (?:the |my )?proxy|stop (?:talking )?direct(?:ly)?|end direct(?: mode)?)[.!]?$/i;
