import { execFile } from 'node:child_process';
import type { Store } from './store.js';

/** One PR as `gh pr view --json state,title,statusCheckRollup` returns it. */
type PrView={state:string;title:string;statusCheckRollup?:{name?:string;context?:string;conclusion?:string;state?:string;status?:string}[]};
export type GhRunner=(repo:string,number:number)=>Promise<PrView>;

// Uses the owner's own gh login on this computer, so private repos work and the token never leaves it.
const gh:GhRunner=(repo,number)=>new Promise((ok,fail)=>execFile('gh',['pr','view',String(number),'--repo',repo,'--json','state,title,statusCheckRollup'],{timeout:30_000},(e,out)=>{if(e)return fail(e);try{ok(JSON.parse(out));}catch(x){fail(x);}}));

const PR=/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const BAD=new Set(['FAILURE','ERROR','CANCELLED','TIMED_OUT','ACTION_REQUIRED','STARTUP_FAILURE']);
const CHECK_MS=3*60_000,WATCH_DAYS=7;

/** merged | closed | failing:<names> | green | pending */
export function prStatus(v:PrView):string {
  if(v.state==='MERGED')return 'merged';
  if(v.state==='CLOSED')return 'closed';
  const checks=v.statusCheckRollup??[];
  const failed=checks.filter(c=>BAD.has(c.conclusion??c.state??'')).map(c=>c.name??c.context??'check').sort();
  if(failed.length)return 'failing:'+failed.join(', ');
  if(checks.length&&checks.every(c=>['SUCCESS','NEUTRAL','SKIPPED'].includes(c.conclusion??c.state??'')))return 'green';
  return 'pending';
}

function notice(repo:string,number:number,title:string,status:string){
  const pr=`${repo}#${number} "${title}"`;
  if(status==='merged')return `Merged: ${pr}.`;
  if(status==='closed')return `Closed without merging: ${pr}.`;
  if(status==='green')return `All checks passed, ready to merge: ${pr}.`;
  return `Checks failing on ${pr}: ${status.slice(8)}.`;
}

/** Notices PRs that sessions open, and tells the owner when they go green, fail or merge. Also sends the end-of-day summary. */
export class PrWatch {
  private ticking=false;
  constructor(private store:Store,private run:GhRunner=gh,private now=()=>Date.now()){
    store.db.exec(`CREATE TABLE IF NOT EXISTS pr_watches(repo TEXT NOT NULL,number INTEGER NOT NULL,destination TEXT,title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,changed_at INTEGER NOT NULL,checked_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(repo,number))`);
  }

  async tick(){
    if(this.ticking)return;this.ticking=true;
    try{this.discover();await this.check();this.summary();}finally{this.ticking=false;}
  }

  /** PR links in what sessions sent the owner since the last look. */
  private discover(){
    const since=Number(this.store.get('pr-watch-cursor')??this.now());
    const rows=this.store.db.prepare('SELECT body,destination,created_at FROM outbox WHERE binding_id IS NOT NULL AND created_at>? ORDER BY created_at LIMIT 500').all(since) as {body:string;destination:string|null;created_at:number}[];
    const add=this.store.db.prepare('INSERT OR IGNORE INTO pr_watches(repo,number,destination,created_at,changed_at) VALUES(?,?,?,?,?)');
    for(const r of rows)for(const m of r.body.matchAll(PR))add.run(m[1],Number(m[2]),r.destination,r.created_at,r.created_at);
    this.store.set('pr-watch-cursor',String(rows.at(-1)?.created_at??since));
  }

  private async check(){
    const now=this.now();
    const due=this.store.db.prepare("SELECT * FROM pr_watches WHERE status NOT IN ('merged','closed') AND created_at>? AND checked_at<? ORDER BY checked_at LIMIT 10").all(now-WATCH_DAYS*86400_000,now-CHECK_MS) as any[];
    for(const w of due){
      let v:PrView;
      try{v=await this.run(w.repo,w.number);}catch{this.store.db.prepare('UPDATE pr_watches SET checked_at=? WHERE repo=? AND number=?').run(now,w.repo,w.number);continue;}
      const status=prStatus(v),changed=status!==w.status;
      this.store.db.prepare('UPDATE pr_watches SET status=?,title=?,checked_at=?,changed_at=? WHERE repo=? AND number=?').run(status,v.title,now,changed?now:w.changed_at,w.repo,w.number);
      if(changed&&status!=='pending'&&w.destination)this.store.output(undefined,notice(w.repo,w.number,v.title,status),`pr:${w.repo}#${w.number}:${status}`,w.destination,{kind:'system',origin:'system',plain:true});
    }
  }

  /** Once a day at the owner's time (default 19:00): what sessions finished, PRs, and what is still running. */
  private summary(){
    const zone=this.store.get('morning-brief-zone')??'Asia/Kolkata',at=this.store.get('day-summary-time')??'19:00';
    if(at==='off')return;
    const now=this.now(),fmt=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
    const p=(t:string)=>fmt.find(x=>x.type===t)!.value,today=`${p('year')}-${p('month')}-${p('day')}`;
    if(`${p('hour')}:${p('minute')}`<at||this.store.get('day-summary-date')===today)return;
    const destination=this.store.destination();
    this.store.set('day-summary-date',today);
    if(!destination)return;
    const since=now-24*3600_000;
    const done=this.store.db.prepare("SELECT b.alias AS name,count(*) AS n FROM outbox o JOIN bindings b ON b.id=o.binding_id WHERE o.reply_kind='final' AND o.created_at>? GROUP BY b.alias ORDER BY n DESC").all(since) as {name:string;n:number}[];
    const prs=this.store.db.prepare('SELECT * FROM pr_watches WHERE changed_at>? OR status NOT IN (\'merged\',\'closed\') ORDER BY changed_at DESC LIMIT 15').all(since) as any[];
    const running=Number((this.store.db.prepare("SELECT count(*) AS n FROM inbox WHERE status='submitted'").get() as {n:number}).n);
    if(!done.length&&!prs.length&&!running)return;
    const label=(s:string)=>s==='green'?'ready to merge':s.startsWith('failing:')?'checks failing':s;
    const lines=['End of day:'];
    lines.push(done.length?'Finished: '+done.map(d=>`${d.name} (${d.n})`).join(', ')+'.':'No session finished anything today.');
    for(const w of prs)lines.push(`- ${w.repo}#${w.number} ${w.title?`"${w.title}" `:''}${label(w.status)}`);
    if(running)lines.push(`Still running: ${running} task${running===1?'':'s'}.`);
    this.store.output(undefined,lines.join('\n'),`day-summary:${today}`,destination,{kind:'system',origin:'system',plain:true});
  }
}
