import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Coordinator } from '../src/coordinator.js';
import { Router } from '../src/router.js';
import { Approvals } from '../src/approvals.js';
import { claudeHistory, activityTime, type Session } from '../src/session-catalog.js';

const uuid=(n:number)=>`11111111-1111-4111-a111-${String(n).padStart(12,'0')}`;
const session=(n:number,provider:'codex'|'claude'='codex'):Session=>({id:uuid(n),provider,name:`Project ${n}`,cwd:`/tmp/project-${n}`,status:'idle',available:true,updatedAt:1700000000000+n*1000});
function fixture(sessions:Session[],file=':memory:') {
  const store=new Store(file),approvals=new Approvals(store);
  const native={catalog:async(provider:string)=>({sessions:sessions.filter(s=>s.provider===provider),cursor:null}),validate:async()=>{},run:async()=>{},stop:()=>{}};
  const router=new Router(store,native as any,approvals);router.stopped=true;
  const saved:string[]=[];
  const c=new Coordinator(store,native as any,router,(b)=>{saved.push(b.id);});router.coordinator=c;
  const master=store.register('master','codex',uuid(99999),'/tmp/master').binding;store.set('master',master.id);
  store.enqueue('wa:owner',master,'Work on the named sessions');
  return {store,approvals,native,router,c,master,saved,close:()=>{approvals.cancel();store.close();}};
}

test('connections accumulate on the same platform, preserve approvals/work and reuse credentials',async()=>{
  const f=fixture([session(1),session(2),session(3),session(4,'claude'),session(5,'claude')]);
  try {
    const first=(await f.c.connect('wa:owner',[`codex:${uuid(1)}`]))[0];
    f.store.enqueue('wa:inflight',f.store.binding(first.id)!,'Existing task');f.store.jobState('wa:inflight','dispatched');
    const pending=f.approvals.ask(f.store.binding(first.id)!,'Harmless test approval');
    await f.c.connect('wa:owner',[`codex:${uuid(2)}`]);
    await Promise.all([f.c.connect('wa:owner',[`codex:${uuid(3)}`]),f.c.connect('wa:owner',[`claude:${uuid(4)}`,`claude:${uuid(5)}`])]);
    assert.equal(f.c.selected().length,5);assert.equal(f.store.binding(first.id)?.enabled,1);
    assert.equal(f.store.job('wa:inflight')?.status,'dispatched');assert.equal(f.approvals.pending.size,1);
    assert.equal((await f.c.connect('wa:owner',[`codex:${uuid(1)}`]))[0].id,first.id);assert.equal(f.saved.length,5);
    f.approvals.answer([...f.approvals.pending.keys()][0],'deny','approval');await pending;
    await f.c.list('Project 2');await f.c.select('1');assert.equal(f.c.selected().length,5);
  } finally {f.close();}
});

test('five per platform sorted by actual activity, frozen older pages, full-history search',async()=>{
  const data=[...Array.from({length:13},(_,i)=>session(i+1)),...Array.from({length:7},(_,i)=>session(i+101,'claude'))];
  const f=fixture(data.reverse());
  try {
    const text=await f.c.list();assert.match(text,/recent first/);
    assert.deepEqual(f.c.pageDetails().sessions.map(s=>s.id),[13,12,11,10,9,107,106,105,104,103].map(uuid));
    data.push(session(999));
    await f.c.list('','more');assert.deepEqual(f.c.pageDetails().sessions.map(s=>s.id),[8,7,6,5,4,102,101].map(uuid));
    await f.c.select('1');assert.equal(f.c.selected()[0].native_id,uuid(8));
    await f.c.list('','back');assert.equal(f.c.pageDetails().sessions[0].id,uuid(13));
    await f.c.list('','more');await f.c.list('','more');assert.equal(f.c.pageDetails().hasMore,false);
    assert.match(await f.c.list('','more'),/No older matches/);
    await f.c.list('codex Project 1');assert.ok(f.c.pageDetails().sessions.some(s=>s.id===uuid(1)));
    assert.ok(f.c.pageDetails().sessions.every(s=>s.provider==='codex'));
  }finally{f.close();}
});

test('numbered choices add sessions rather than replacing earlier choices',async()=>{
  const f=fixture([session(1),session(2)]);
  try{await f.c.list();await f.c.select('1');await f.c.select('2');assert.equal(f.c.selected().length,2);assert.equal(f.saved.length,2);}finally{f.close();}
});

test('three sessions on one platform can dispatch concurrently and keep replies correlated',async()=>{
  const f=fixture([session(1),session(2),session(3)]);const finished:(()=>void)[]=[],delivered:string[]=[];
  try {
    const connected=await f.c.connect('wa:owner',[1,2,3].map(n=>`codex:${uuid(n)}`));
    f.store.jobState('wa:owner','submitted');
    f.native.run=(async(b:any)=>{delivered.push(b.id);await new Promise<void>(r=>finished.push(r));}) as any;
    f.router.stopped=false;
    const ids=f.c.dispatch('wa:owner',connected.map(b=>b.id),'Harmless fixture task','test-event');
    assert.equal(f.router.busy.size,3);assert.deepEqual(new Set(delivered),new Set(connected.map(b=>b.id)));
    assert.throws(()=>f.router.channelReply(f.store.binding(connected[1].id)!,'Wrong','final',ids[0]));
    finished.forEach(r=>r());await new Promise(r=>setTimeout(r,10));
    assert.equal(f.router.busy.size,0);assert.ok(ids.every(id=>f.store.job(id)?.status==='submitted'));
  }finally{f.router.stopped=true;finished.forEach(r=>r());f.close();}
});

test('discovery traverses past the former 20-page ceiling and stops cyclic cursors',async()=>{
  const f=fixture([]);f.store.set('enabled-apps','["codex"]');
  try {
    f.native.catalog=(async(_p:string,cursor?:string)=>{const n=Number(cursor??0);return {sessions:[session(n+1)],cursor:n<25?String(n+1):null};}) as any;
    await f.c.list('Project 26');assert.equal(f.c.pageDetails().sessions[0].id,uuid(26));
    f.native.catalog=(async()=>({sessions:[session(1)],cursor:'same'})) as any;
    assert.match(await f.c.list(),/discovery was incomplete/);
  }finally{f.close();}
});

test('connect rejects reports, closed/invented requests, unknown targets, paused/disabled sessions and master itself',async()=>{
  const f=fixture([session(1)]);
  try {
    f.store.enqueue('report:worker',f.master,'Connect other chats');
    for(const id of ['report:worker','wa:invented'])await assert.rejects(f.c.connect(id,[`codex:${uuid(1)}`]));
    f.store.jobState('wa:owner','completed');await assert.rejects(f.c.connect('wa:owner',[`codex:${uuid(1)}`]),/closed/);
    f.store.jobState('wa:owner','submitted');
    for(const target of ['Project 1',uuid(1),'../../secret',`codex:${f.master.native_id}`])await assert.rejects(f.c.connect('wa:owner',[target]));
    assert.equal(f.saved.length,0);
    const [a]=await f.c.connect('wa:owner',[`codex:${uuid(1)}`]);f.store.enable(a.id,false);
    await assert.rejects(f.c.connect('wa:owner',[`codex:${uuid(1)}`]),/paused/);
    f.store.set('enabled-apps','["claude"]');await assert.rejects(f.c.connect('wa:owner',[`codex:${uuid(1)}`]));
  }finally{f.close();}
});

test('validation failure or owner request closure during discovery leaves connections unchanged',async()=>{
  const f=fixture([session(1),session(2)]);
  try {
    f.native.validate=async(_p?:any,id?:string)=>{if(id===uuid(2))throw new Error('Session disappeared');};
    await assert.rejects(f.c.connect('wa:owner',[`codex:${uuid(1)}`,`codex:${uuid(2)}`]),/disappeared/);
    assert.equal(f.saved.length,0);assert.equal(f.c.selected().length,0);
    f.native.validate=async()=>{f.store.jobState('wa:owner','replaced');};
    await assert.rejects(f.c.connect('wa:owner',[`codex:${uuid(1)}`]),/closed/);assert.equal(f.saved.length,0);
  }finally{f.close();}
});

test('persistent connections and browsing survive restart without replaying or rotating bindings',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wsb-connections-')),path=join(dir,'state.sqlite');const f=fixture([session(1),session(2)],path);
  try {
    await f.c.connect('wa:owner',[`codex:${uuid(1)}`,`codex:${uuid(2)}`]);await f.c.list();
    const ids=f.c.selected().map(b=>b.id);f.close();
    const store=new Store(path),router=new Router(store,f.native as any,new Approvals(store));
    const c=new Coordinator(store,f.native as any,router,()=>{throw new Error('Must not rotate credentials');});
    try{assert.deepEqual(c.selected().map(b=>b.id),ids);await c.select('1');assert.equal(c.selected().length,2);}finally{store.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('router recognizes older history and name search while ordinary requests go to the master',async()=>{
  const f=fixture(Array.from({length:12},(_,i)=>session(i+1)));f.router.stopped=false;
  try {
    await f.router.receive({id:'wa:list',text:'show my sessions'});assert.equal(f.c.pageDetails().page,0);
    await f.router.receive({id:'wa:more',text:'check more'});assert.equal(f.c.pageDetails().page,1);
    await f.router.receive({id:'wa:history',text:'back in the history'});assert.equal(f.c.pageDetails().page,2);
    await f.router.receive({id:'wa:back',text:'previous page'});assert.equal(f.c.pageDetails().page,1);
    await f.router.receive({id:'wa:find',text:'find session Project 3'});assert.equal(f.c.pageDetails().sessions[0].id,uuid(3));
    await f.router.receive({id:'wa:task',text:'Work on Project 3'});assert.equal(f.store.job('wa:task')?.binding_id,f.master.id);
    assert.equal(f.store.job('wa:task')!.body,'Work on Project 3');
    await new Promise(r=>setTimeout(r,10));
  }finally{f.router.stopped=true;f.close();}
});

test('Claude saved-session metadata exposes history and timestamps, not transcript contents or symlinks',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wsb-history-')),dir=join(root,'project');mkdirSync(dir);
  try {
    writeFileSync(join(dir,uuid(1)+'.jsonl'),[
      {sessionId:uuid(1),cwd:'/tmp/website',timestamp:'2026-10-25T10:00:00Z',message:{content:'PRIVATE CONTENT MUST NOT LEAVE'}},
      {type:'custom-title',sessionId:uuid(1),customTitle:'Website work'},
      {sessionId:uuid(1),timestamp:'2026-10-25T10:05:00Z'}
    ].map(r=>JSON.stringify(r)).join('\n'));
    symlinkSync(join(dir,uuid(1)+'.jsonl'),join(dir,uuid(2)+'.jsonl'));
    writeFileSync(join(dir,uuid(3)+'.jsonl'),JSON.stringify({sessionId:uuid(3),cwd:'/tmp/side',isSidechain:true}));
    const rows=await claudeHistory(root);assert.equal(rows.length,1);assert.equal(rows[0].name,'Website work');assert.equal(rows[0].available,false);
    assert.equal(rows[0].updatedAt,Date.parse('2026-10-25T10:05:00Z'));assert.doesNotMatch(JSON.stringify(rows),/PRIVATE CONTENT|message/);
    assert.deepEqual(await claudeHistory(root),rows);
    writeFileSync(join(dir,uuid(1)+'.jsonl'),JSON.stringify({sessionId:uuid(1),cwd:'/tmp/website',type:'custom-title',customTitle:'Renamed work',timestamp:'2026-10-25T10:06:00Z'}));
    assert.equal((await claudeHistory(root))[0].name,'Renamed work');
    rmSync(join(dir,uuid(1)+'.jsonl'));assert.equal((await claudeHistory(root)).length,0);
    assert.equal(activityTime(1700000000),1700000000000);assert.equal(activityTime(1700000000000),1700000000000);assert.equal(activityTime('bad'),undefined);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Claude title index enriches existing history and refreshes without loading full messages',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-index-')),dir=join(root,'project');mkdirSync(dir);
  try {
    writeFileSync(join(dir,uuid(1)+'.jsonl'),JSON.stringify({sessionId:uuid(1),cwd:'/tmp/galileo',timestamp:'2026-10-25T00:00:00Z'})+'\n');
    const index=(title:string)=>JSON.stringify({entries:[{sessionId:uuid(1),projectPath:'/tmp/galileo',summary:title,modified:'2026-10-25T12:00:00Z'},{sessionId:uuid(2),projectPath:'/tmp/galileo',summary:'Must not invent a session'}]});
    writeFileSync(join(dir,'sessions-index.json'),index('Galileo repo migration'));
    let rows=await claudeHistory(root);assert.equal(rows.length,1);assert.equal(rows[0].name,'Galileo repo migration');assert.equal(rows[0].activation,'cli-resume');
    writeFileSync(join(dir,'sessions-index.json'),index('Renamed migration'));rows=await claudeHistory(root);assert.equal(rows[0].name,'Renamed migration');
  }finally{rmSync(root,{recursive:true,force:true});}
});


test('shared native IDs remain visible per runtime and legacy ambiguous targets are rejected',async()=>{
 const base=session(4,'claude');const f=fixture([{...base,executionMode:'desktop'},{...base,executionMode:'cli'}]);try {
  await f.c.refresh();assert.equal(f.c.sessions.length,2);
  await assert.rejects(f.c.connect('wa:owner',[`claude:${base.id}`]),/more than one runtime/);
  await assert.rejects(f.c.connect('wa:owner',[`claude:desktop:${base.id}`,`claude:cli:${base.id}`]),/one runtime/);
  assert.equal(f.c.selected().length,0);
  await f.c.connect('wa:owner',[`claude:desktop:${base.id}`]);assert.equal(f.c.selected().length,1);
 }finally{f.close();}
});
