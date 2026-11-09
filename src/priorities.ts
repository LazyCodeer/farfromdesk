import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the owner told us matters most, from memory/priorities.md. Read fresh each time; the file is tiny. */
export type Priorities={top:string[];quiet?:{from:number;to:number}};

const minutes=(t:string)=>{const [h,m]=t.split(':').map(Number);return h<24&&m<60?h*60+m:NaN;};

export function parsePriorities(text:string):Priorities {
  const top:string[]=[];let quiet:Priorities['quiet'],section='';
  for(const raw of text.split('\n')){
    const line=raw.trim();
    if(/^#/.test(line)){section=line.toLowerCase();continue;}
    const q=/quiet hours?\b[^0-9]*(\d{1,2}:\d{2})\s*(?:-|–|to)\s*(\d{1,2}:\d{2})/i.exec(line);
    if(q){const from=minutes(q[1]),to=minutes(q[2]);if(from>=0&&to>=0&&from!==to)quiet={from,to};continue;}
    const item=/^[-*]\s+(.+)$/.exec(line)?.[1].replace(/\s+[-(—].*$/,'').trim();
    if(item&&/top|priorit|important/.test(section)&&item.length>=2&&top.length<20)top.push(item);
  }
  return {top,quiet};
}

export function readPriorities(stateRoot:string):Priorities {
  try{return parsePriorities(readFileSync(join(stateRoot,'memory','priorities.md'),'utf8'));}catch{return {top:[]};}
}

const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Index of the first top priority the text names (whole words, any case), or -1. */
export function priorityRank(p:Priorities,text:string):number {
  return p.top.findIndex(term=>new RegExp(`(?:^|[^\\p{L}\\p{N}])${escape(term)}(?:$|[^\\p{L}\\p{N}])`,'iu').test(text));
}

export const statedUrgent=(text:string)=>/^(?:urgent|asap|critical|high priority)\s*[:!-]\s+/i.test(text.trim())&&!/\b(?:not|never|no|isn.t|don.t|doesn.t|without)\b/i.test(text);

/** When `at` falls inside quiet hours (in `zone`), the moment they end; otherwise `at`. */
export function afterQuiet(p:Priorities,at:number,zone:string):number {
  if(!p.quiet)return at;
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at);
  const now=Number(parts.find(x=>x.type==='hour')!.value)*60+Number(parts.find(x=>x.type==='minute')!.value);
  const {from,to}=p.quiet,inside=from<to?now>=from&&now<to:now>=from||now<to;
  if(!inside)return at;
  const wait=((to-now)+1440)%1440;
  return at-at%60_000+wait*60_000;
}
