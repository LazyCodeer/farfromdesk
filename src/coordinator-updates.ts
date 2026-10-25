import { createHash } from 'node:crypto';
import type { Store, Job } from './store.js';
import type { Router } from './router.js';

export const COORDINATOR_UPDATE_INTERVAL_MS=10*60*1000;
const active=['queued','dispatched','submitted'];
const open=[...active,'uncertain','failed'];
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const label=(s:string)=>s.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069*_~`]/g,' ').replace(/\s+/g,' ').trim().slice(0,80);
type Snapshot={parents:{id:string;status:string}[];jobs:{id:string;status:string;updatedAt:number;bindingId:string}[];masterId:string;destination:string;fingerprint:string};
// Retain the preview API; summaries intentionally never quote request/transcript text.
export function progressUpdateText(_request:string,rows:string[],more=0) {
  return `🕒 *Work update*\n${rows.map(row=>'- '+row).join('\n')}${more?`\n- ${more} more active sessions.`:''}\n\nI’ll share new progress when it arrives.`;
}
export function initializeCoordinatorUpdates(store:Store,now=Date.now()) {
  // No historical enrollment on upgrade or restart. The watermark is persistent.
  if(store.get('coordinator-summary-since')===undefined)store.set('coordinator-summary-since',String(now));
  store.db.prepare("UPDATE outbox SET status='cancelled',error='Legacy per-request reminder retired' WHERE status='queued' AND source LIKE 'coordinator-progress:%'").run();
}
export function queueCoordinatorUpdates(store:Store,router:Router,now=Date.now()) {
  initializeCoordinatorUpdates(store,now);
  const master=router.coordinator?.master();
  if(router.stopped||!master||store.get('coordinator-updates-enabled')==='false')return 0;
  const since=Number(store.get('coordinator-summary-since'));
  if(!Number.isFinite(since))return 0;
  const parents=store.db.prepare("SELECT id,binding_id,status,created_at,updated_at,destination FROM inbox WHERE binding_id=? AND id LIKE 'wa:%' AND created_at>=? AND status IN ('queued','dispatched','submitted','uncertain','failed') ORDER BY created_at,id").all(master.id,since) as unknown as Job[];
  const groups=new Map<string,{parents:Job[];jobs:Job[]}>();
  for(const parent of parents) {
    if(!parent.destination)continue;
    const children=store.db.prepare("SELECT i.* FROM inbox i JOIN settings s ON s.key='parent:'||i.id WHERE s.value=? ORDER BY i.id").all(parent.id) as unknown as Job[];
    const jobs=(children.length?children:[parent]).filter(j=>active.includes(j.status)&&j.destination===parent.destination&&store.binding(j.binding_id)?.enabled);
    // An open tracking row alone is not ongoing work. Completed/blocked children
    // stay in Activity; they do not become recurring phone notifications.
    if(!jobs.length)continue;
    const group=groups.get(parent.destination)??{parents:[],jobs:[]};group.parents.push(parent);group.jobs.push(...jobs);groups.set(parent.destination,group);
  }
  let count=0;
  for(const [destination,group] of groups) {
    const route=hash(master.id+'\0'+destination),key=`coordinator-summary-state:${route}`;
    let prior:{at:number;fingerprint:string}={at:0,fingerprint:''};
    try {prior=JSON.parse(store.get(key)??JSON.stringify(prior));}catch{}
    const sessions=new Map<string,{name:string;queued:number;waiting:number}>();
    for(const job of group.jobs){const b=store.binding(job.binding_id)!;const row=sessions.get(b.id)??{name:label(store.get(`name:${b.id}`)??b.alias),queued:0,waiting:0};if(job.status==='queued')row.queued++;else row.waiting++;sessions.set(b.id,row);}
    const rows=[...sessions.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,s])=>`${s.name}: ${[s.queued?`${s.queued} queued`:null,s.waiting?`${s.waiting} waiting for a reply`:null].filter(Boolean).join(', ')}`);
    const fingerprint=hash(JSON.stringify({requests:group.parents.map(p=>p.id).sort(),rows}));
    if(prior.fingerprint===fingerprint)continue; // No repeat of an unchanged waiting notice.
    const latest=store.db.prepare("SELECT MAX(COALESCE(sent_at,created_at)) at FROM outbox WHERE destination=? AND status IN ('queued','sent')").get(destination) as {at:number|null};
    const last=Math.max(Number.isFinite(prior.at)?prior.at:now,since,latest.at??0,...group.parents.map(p=>p.created_at));
    if(now-last<COORDINATOR_UPDATE_INTERVAL_MS)continue;
    if(store.db.prepare("SELECT 1 FROM outbox WHERE destination=? AND status='queued' LIMIT 1").get(destination))continue;
    const source=`coordinator-summary:${route}:${now}`;
    const snapshot:Snapshot={masterId:master.id,destination,fingerprint,parents:group.parents.map(p=>({id:p.id,status:p.status})),jobs:group.jobs.map(j=>({id:j.id,status:j.status,updatedAt:j.updated_at??j.created_at,bindingId:j.binding_id}))};
    store.db.exec('SAVEPOINT coordinator_summary');
    try {
      store.set(`coordinator-summary-data:${source}`,JSON.stringify(snapshot));
      if(store.output(master,progressUpdateText('',rows.slice(0,5),Math.max(0,rows.length-5)),source,destination,{kind:'system',origin:'system'}))count++;
      store.set(key,JSON.stringify({at:now,fingerprint}));store.db.exec('RELEASE coordinator_summary');
    }catch(e){store.db.exec('ROLLBACK TO coordinator_summary; RELEASE coordinator_summary');throw e;}
  }
  return count;
}
export function cancelObsoleteCoordinatorUpdates(store:Store) {
  store.db.prepare("UPDATE outbox SET status='cancelled',error='Legacy per-request reminder retired' WHERE status='queued' AND source LIKE 'coordinator-progress:%'").run();
  const queued=store.db.prepare("SELECT rowid,id,source,binding_id,destination FROM outbox WHERE status='queued' AND source LIKE 'coordinator-summary:%'").all() as unknown as {rowid:number;id:string;source:string;binding_id:string;destination:string}[];
  for(const row of queued) {
    let valid=false;
    try {
      const data=JSON.parse(store.get(`coordinator-summary-data:${row.source.replace(/:\d+$/,'')}`)??'null') as Snapshot;
      valid=!!data&&store.get('coordinator-updates-enabled')!=='false'&&data.masterId===store.get('master')&&data.masterId===row.binding_id&&data.destination===row.destination&&!!store.binding(row.binding_id)?.enabled&&data.parents.length>0&&data.jobs.length>0;
      if(valid)valid=data.parents.every(p=>{const j=store.job(p.id);return j?.binding_id===data.masterId&&j.destination===data.destination&&open.includes(j.status)&&j.status===p.status;})&&data.jobs.every(p=>{const j=store.job(p.id);return !!j&&active.includes(j.status)&&j.status===p.status&&(j.updated_at??j.created_at)===p.updatedAt&&!!store.binding(p.bindingId)?.enabled;});
      if(valid&&store.db.prepare("SELECT 1 FROM outbox WHERE destination=? AND rowid>? AND source NOT LIKE 'coordinator-summary:%' AND status IN ('queued','sent') LIMIT 1").get(row.destination,row.rowid))valid=false;
    }catch{valid=false;}
    if(!valid)store.db.prepare("UPDATE outbox SET status='cancelled',error='Work summary superseded' WHERE id=? AND status='queued'").run(row.id);
  }
}
