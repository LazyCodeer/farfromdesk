import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Store as StoreType } from '../src/store.js';

const instant=Date.parse('2026-10-29T03:00:00Z'); // 08:30 in India
const testState=mkdtempSync(join(tmpdir(),'ffd-brief-media-'));process.env.WSB_STATE_DIR=testState;test.after(()=>rmSync(testState,{recursive:true,force:true}));
// The app caches its state directory at import time. Set the isolated root
// before loading any application module, even for direct test invocations.
const {stateDir}=await import('../src/config.js');
const {Store,hash}=await import('../src/store.js');
const {Router}=await import('../src/router.js');
const {Approvals}=await import('../src/approvals.js');
const {MetaBrain}=await import('../src/meta-brain.js');
const {DEFAULT_BRAIN,MetaSecret}=await import('../src/meta-brain-config.js');
const {MorningBrief,canDeliverBrief}=await import('../src/morning-brief.js');
const {Coordinator}=await import('../src/coordinator.js');
const {WhatsApp}=await import('../src/whatsapp.js');
test('application modules use the isolated test state',()=>assert.equal(stateDir,testState));
function setup(file?:string){
  const dir=mkdtempSync(join(tmpdir(),'ffd-brief-')),store=new Store(file??join(dir,'test.db'));
  store.set('whatsapp-owner','owner@s.whatsapp.net');
  store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,taskContracts:false,enabled:true,allowStatus:true,allowRouting:true,providers:['codex','claude']}));
  const approvals=new Approvals(store),native={run:async()=>{},stop:()=>{}},router=new Router(store,native as any,approvals);
  const secret=new MetaSecret(dir);secret.save('synthetic-test-key-not-real');router.brain=new MetaBrain(store,secret,{interpret:async()=>{throw Error('unused');}});
  return {dir,store,router,approvals,secret,close(){approvals.cancel();store.close();rmSync(dir,{recursive:true,force:true});}};
}
const sourceRows=(s:StoreType)=>s.db.prepare("SELECT * FROM outbox WHERE source LIKE 'morning-brief:%' ORDER BY source").all() as any[];
function addScoped(f:ReturnType<typeof setup>,id:string,title:string){const owner='owner@s.whatsapp.net';f.store.recordOwnerOrigin(id,owner,owner);return f.store.destinationContext.run(owner,()=>f.router.brain.memory.add(id,title));}
test('first-message and scheduled race queue one grounded brief and persist the item numbers',async()=>{
  const f=setup();try{
    const a=addScoped(f,'wa:a','Build landing page'),b=addScoped(f,'wa:b','Fix export');
    let input:any,calls=0,release!:()=>void;const hold=new Promise<void>(r=>release=r);
    const brief=new MorningBrief(f.store,f.router,async data=>{calls++;input=data;await hold;return {opening:'Good morning.',priorities:[b.id,999]};},()=>instant);
    const first=brief.request('owner@s.whatsapp.net','first-message'),second=brief.request('owner@s.whatsapp.net','scheduled');release();
    assert.deepEqual(await Promise.all([first,second]),[true,false]);assert.equal(calls,1);
    const [out]=sourceRows(f.store);assert.ok(out);assert.match(out.body,/1\. Fix export \(suggested\)/);assert.match(out.body,/2\. Build landing page/);
    assert.equal(out.destination,'owner@s.whatsapp.net');assert.equal(input.entries.length,2);assert.ok(input.entries.every((e:any)=>!('identity' in e)&&!('binding' in e)));
    assert.equal(await new MorningBrief(f.store,f.router,async()=>{throw Error('must not call');},()=>instant).request('owner@s.whatsapp.net','scheduled'),false);
    assert.equal(sourceRows(f.store).length,1);
  }finally{f.close();}
});
test('timer honours the selected time and first message does not wait for it',async()=>{
  const f=setup();try{
    let calls=0;const brief=new MorningBrief(f.store,f.router,async()=>{calls++;return {opening:'Hello.',priorities:[]};},()=>instant-3600000);
    assert.equal(await brief.request('owner@s.whatsapp.net','scheduled'),false);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);assert.equal(calls,1);
  }finally{f.close();}
});
test('snapshot excludes other chats, reports waiting approvals and never exposes approval codes to the model',async()=>{
  const f=setup();try{
    addScoped(f,'wa:own','Own task');
    f.store.destinationContext.run('other@s.whatsapp.net',()=>f.router.brain.memory.add('wa:other','Private other task'));
    const binding=f.store.register('test-agent','codex',randomUUID(),'/tmp').binding;
    void f.approvals.ask(binding,'May I run tests?');let input:any;
    const brief=new MorningBrief(f.store,f.router,async data=>{input=data;return {opening:'Good morning.',priorities:[]};},()=>instant);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);
    assert.doesNotMatch(JSON.stringify(input),/Private other task/);
    assert.equal(input.entries.find((x:any)=>x.kind==='approval').id,0);
    assert.match(sourceRows(f.store)[0].body,/Permission needed: May I run tests/);
  }finally{f.close();}
});
test('titles, blocked reports and permission prompts containing credentials never leave for Meta',async()=>{
  const f=setup();try{
    const marker='SYNTHETIC_PRIVATE_TOKEN_12345';
    const item=addScoped(f,'wa:a',`Task credential ${marker}`);
    const binding=f.store.register('test-agent','codex',randomUUID(),'/tmp').binding;
    f.store.enqueue('wa:blocked',binding,'Example');f.store.linkItem('wa:blocked',item.id);f.store.jobState('wa:blocked','failed');f.store.set('blocked-text:wa:blocked',`Bearer ${marker}`);
    void f.approvals.ask(binding,`Authorization: Bearer ${marker}`);let input:any;
    const brief=new MorningBrief(f.store,f.router,async data=>{input=data;return {opening:'Good morning.',priorities:[]};},()=>instant);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);
    assert.doesNotMatch(JSON.stringify(input),new RegExp(marker));assert.doesNotMatch(JSON.stringify(input),/Authorization|Bearer/);
    assert.ok(input.entries.some((e:any)=>e.kind==='item'&&e.id===item.id));
  }finally{f.close();}
});
test('Meta receives useful allowlisted task signals without task names or raw text',async()=>{
  const f=setup();try{
    const urgent=addScoped(f,'wa:a','Urgent: security issue for customer Widget'),docs=addScoped(f,'wa:b','Update documentation for customer Gadget');
    let input:any;const brief=new MorningBrief(f.store,f.router,async data=>{input=data;return {opening:'Good morning.',priorities:[urgent.id]};},()=>instant);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);
    const first=input.entries.find((x:any)=>x.id===urgent.id),second=input.entries.find((x:any)=>x.id===docs.id);
    assert.equal(first.category,'security');assert.equal(first.urgency,'stated urgent');assert.equal(second.category,'documentation');
    assert.ok(Number.isFinite(first.ageHours));assert.ok(Number.isFinite(first.idleHours));assert.equal(first.sessionState,'unassigned');
    assert.doesNotMatch(JSON.stringify(input),/Widget|Gadget|Urgent: security issue|Update documentation/);
    assert.match(sourceRows(f.store)[0].body,/Urgent: security issue for customer Widget \(suggested\)/);
  }finally{f.close();}
});
test('negated urgency is not presented to Meta as an urgent task',async()=>{
  const f=setup();try{
    const a=addScoped(f,'wa:a','This is not a critical release'),b=addScoped(f,'wa:b','This is not high priority');let input:any;
    const brief=new MorningBrief(f.store,f.router,async data=>{input=data;return {opening:'Good morning.',priorities:[]};},()=>instant);
    await brief.request('owner@s.whatsapp.net','first-message');
    assert.equal(input.entries.find((e:any)=>e.id===a.id).urgency,'not stated');assert.equal(input.entries.find((e:any)=>e.id===b.id).urgency,'not stated');
  }finally{f.close();}
});
test('a changed owner or revoked brain during the model call prevents output',async()=>{
  for(const change of ['owner','policy','key']){
    const f=setup();try{let release!:()=>void;const hold=new Promise<void>(r=>release=r);
      const brief=new MorningBrief(f.store,f.router,async()=>{await hold;return {opening:'Hello.',priorities:[]};},()=>instant);
      const pending=brief.request('owner@s.whatsapp.net','first-message');
      if(change==='owner')f.store.set('whatsapp-owner','new@s.whatsapp.net');
      if(change==='policy')f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:false}));
      if(change==='key')f.secret.remove();
      release();assert.equal(await pending,false);assert.equal(sourceRows(f.store).length,0);
    }finally{f.close();}
  }
});
test('only public GitHub PRs linked to this destination are checked; merge evidence comes from GitHub',async()=>{
  const f=setup();try{
    const a=addScoped(f,'wa:a','Owner task');f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.brain.memory.items.note(a.id,'https://github.com/Owner/Repo/pull/42',undefined,undefined,'wa:a'));
    f.router.brain.memory.items.note(a.id,'https://github.com/Unscoped/Hidden/pull/77');
    f.store.destinationContext.run('other@s.whatsapp.net',()=>{const other=f.router.brain.memory.add('wa:other','Other task');f.router.brain.memory.items.note(other.id,'https://github.com/Private/Hidden/pull/99');});
    const checked:string[]=[];const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant,async(o,r,n)=>{checked.push(`${o}/${r}/${n}`);return {title:'Improve app',html_url:`https://github.com/${o}/${r}/pull/${n}`,merged_at:'2026-10-28T22:00:00Z'};});
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);
    assert.deepEqual(checked,['Owner/Repo/42']);assert.match(sourceRows(f.store)[0].body,/Merged PR: Improve app/);
  }finally{f.close();}
});
test('unknown-owner unlinked items are never exposed after an owner switch',async()=>{
  const f=setup();try{
    f.router.brain.memory.items.add('Previous owner private task');
    f.store.set('whatsapp-owner','new-owner@s.whatsapp.net');let input:any;
    const brief=new MorningBrief(f.store,f.router,async data=>{input=data;return {opening:'Hello.',priorities:[]};},()=>instant);
    assert.equal(await brief.request('new-owner@s.whatsapp.net','first-message'),true);
    assert.doesNotMatch(sourceRows(f.store)[0].body,/Previous owner private task/);assert.doesNotMatch(JSON.stringify(input),/Previous owner private task/);
    assert.match(sourceRows(f.store)[0].body,/other local items may be in the app/);
  }finally{f.close();}
});
test('group and self briefs exclude previous-owner items even after a new request links them',async()=>{
  for(const mode of ['group','self']){
    const f=setup();try{
      const old=addScoped(f,'wa:old','Previous owner secret task'),dest=mode==='group'?'team@g.us':'new-owner@s.whatsapp.net';
      f.store.set('whatsapp-owner','new-owner@s.whatsapp.net');if(mode==='group'){f.store.set('destination-jid',dest);f.store.set('owned-group:'+dest,'true');}
      const b=f.store.register('worker','codex',randomUUID(),'/tmp').binding;f.store.enqueue('wa:new',b,'new request',dest);f.store.linkItem('wa:new',old.id);
      f.store.db.prepare('INSERT OR IGNORE INTO brain_item_routes VALUES(?,?)').run(old.id,dest);
      const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);
      assert.equal(await brief.request(dest,'first-message'),true);assert.doesNotMatch(sourceRows(f.store)[0].body,/Previous owner secret task/);
    }finally{f.close();}
  }
});
test('new authenticated group items retain owner provenance and do not transfer after re-pairing',async()=>{
  const f=setup();try{
    const group='team@g.us',oldOwner='owner@s.whatsapp.net';f.store.set('destination-jid',group);f.store.set('owned-group:'+group,'true');
    f.store.recordOwnerOrigin('wa:old',group,oldOwner);
    const item=f.store.destinationContext.run(group,()=>f.router.brain.memory.add('wa:old','Old group task'));
    assert.ok(f.store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=? AND destination=? AND owner=?').get(item.id,group,oldOwner));
    f.store.set('whatsapp-owner','new-owner@s.whatsapp.net');
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);
    assert.equal(await brief.request(group,'first-message'),true);assert.doesNotMatch(sourceRows(f.store)[0].body,/Old group task/);
  }finally{f.close();}
});
test('legacy rows are filtered before the board limit so verified owner work cannot be starved',async()=>{
  const f=setup();try{
    const item=addScoped(f,'wa:real','Verified older task');f.store.db.prepare('UPDATE items SET updated_at=1 WHERE id=?').run(item.id);
    for(let i=0;i<101;i++){const legacy=f.router.brain.memory.items.add(`Legacy ${i}`);f.store.db.prepare('INSERT INTO brain_item_routes VALUES(?,?)').run(legacy.id,'owner@s.whatsapp.net');f.store.db.prepare('UPDATE items SET updated_at=2 WHERE id=?').run(legacy.id);}
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);assert.match(sourceRows(f.store)[0].body,/Verified older task/);assert.doesNotMatch(sourceRows(f.store)[0].body,/Legacy \d/);
  }finally{f.close();}
});
test('a numbered item remains actionable after more than 100 newer verified items arrive',async()=>{
  const f=setup();try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:original','Original task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);
    f.store.db.prepare('UPDATE items SET updated_at=1 WHERE id=?').run(item.id);
    for(let i=0;i<101;i++){const newer=addScoped(f,`wa:new-${i}`,`New ${i}`);f.store.db.prepare('UPDATE items SET updated_at=2 WHERE id=?').run(newer.id);}
    assert.equal(brief.action({id:'wa:go',text:'go 1'})?.target,worker.id);
  }finally{f.close();}
});
test('delegated provenance requires a same-destination chain and unchanged owner, not current channel',()=>{
  const f=setup();try{
    const group='team@g.us',owner='owner@s.whatsapp.net',binding=f.store.register('proxy','codex',randomUUID(),'/tmp').binding;
    f.store.set('destination-jid',group);f.store.set('owned-group:'+group,'true');f.store.recordOwnerOrigin('wa:root',group,owner);
    f.store.enqueue('wa:root',binding,'task',group);f.store.set('parent:master:child','wa:root');f.store.enqueue('master:child',binding,'child',group);
    f.store.set('control-channel','telegram');assert.deepEqual(f.store.requestOwnerOrigin('master:child'),{owner,destination:group});
    const item=f.router.brain.memory.items.add('Scoped child',undefined,undefined,'child-add','master:child');
    assert.ok(f.store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=? AND owner=?').get(item.id,owner));
    f.store.db.prepare('UPDATE inbox SET destination=? WHERE id=?').run('other@g.us','master:child');assert.equal(f.store.requestOwnerOrigin('master:child'),undefined);
    f.store.db.prepare('UPDATE inbox SET destination=? WHERE id=?').run(group,'master:child');f.store.set('whatsapp-owner','new-owner@s.whatsapp.net');assert.equal(f.store.requestOwnerOrigin('master:child'),undefined);
  }finally{f.close();}
});
test('numbered actions require authenticated owner, an actually sent brief and the original scoped session',async()=>{
  const f=setup();try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Do the work');
    const b=f.store.register('test-agent','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,b.id);
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);
    assert.match(brief.action({id:'wa:1',text:'go 1'})?.reply??'',/Wait/);
    const [out]=sourceRows(f.store);f.store.sent(out.id);
    assert.match(brief.action({id:'wa:2',text:'go 1'})?.text??'',/^#1 Please check/);
    assert.match(brief.action({id:'wa:3',text:'pause 1'})?.text??'',/^#1 Please pause/);
    assert.equal(brief.action({id:'parent:1',text:'go 1'}),undefined);
    f.store.db.prepare('UPDATE items SET binding_id=NULL WHERE id=?').run(item.id);
    assert.match(brief.action({id:'wa:4',text:'go 1'})?.reply??'',/session.*changed/i);
  }finally{f.close();}
});
test('go and pause use ordinary item routing while later defers only the chosen item',async()=>{
  const f=setup();try{
    const coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});f.router.coordinator=coordinator;f.router.pump=()=>{};
    const item=addScoped(f,'wa:task','Do the work');
    const worker=f.store.register('test-worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const other=f.store.register('other-worker','claude',randomUUID(),'/tmp').binding;f.store.set('selected',JSON.stringify([other.id]));
    const identity=hash(JSON.stringify([other.id,other.native_id,other.cwd,other.token_hash,f.store.get(`execution-mode:${other.id}`),f.store.get(`session-route:${other.id}`),coordinator.registry.entry(other.id)]));
    f.store.set('owner-target:owner@s.whatsapp.net',JSON.stringify({kind:'session',id:other.id,identity}));
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);f.store.sent(sourceRows(f.store)[0].id);
    assert.equal((await f.router.receive({id:'wa:go',text:'go 1'})).status,'queued');
    assert.equal(f.store.job('wa:go')?.binding_id,worker.id);assert.match(f.store.job('wa:go')?.body??'',/Do not repeat/);assert.equal(f.store.itemOf('wa:go'),item.id);
    assert.equal((await f.router.receive({id:'wa:pause',text:'pause 1'})).status,'queued');assert.match(f.store.job('wa:pause')?.body??'',/pause work/);
    assert.equal((await f.router.receive({id:'wa:later',text:'later 1'})).status,'handled');assert.equal(f.store.job('wa:later'),undefined);
    assert.equal((f.store.db.prepare('SELECT until_day FROM morning_brief_deferrals').get() as any).until_day,'2026-10-30');
    const ack=f.store.db.prepare("SELECT * FROM outbox WHERE source='brief-action:wa:go:0'").get() as any;
    assert.equal(canDeliverBrief(f.store,ack,'owner@s.whatsapp.net',instant),true);f.store.set('whatsapp-owner','other-owner@s.whatsapp.net');assert.equal(canDeliverBrief(f.store,ack,'other-owner@s.whatsapp.net',instant),false);
  }finally{f.close();}
});
test('a disabled platform or changed session identity blocks numbered actions',async()=>{
  const f=setup();try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Task'),worker=f.store.register('test-worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);
    f.store.set('enabled-apps','["claude"]');assert.match(brief.action({id:'wa:a',text:'go 1'})?.reply??'',/unavailable/);
    f.store.set('enabled-apps','["codex"]');f.store.set(`session-route:${worker.id}`,'changed');assert.match(brief.action({id:'wa:b',text:'go 1'})?.reply??'',/changed/);
  }finally{f.close();}
});
for(const change of ['native-id','owner','disabled','route','item','mode'] as const)test(`queued brief action fails closed before native dispatch when ${change} changes`,async()=>{
  const f=setup();try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Original task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const calls:any[]=[];(f.router.native as any).run=async (...args:any[])=>{calls.push(args);};
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);f.router.busy.add(worker.id);
    assert.equal((await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:action',text:'go 1'}))).status,'queued');
    if(change==='native-id')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),worker.id);
    if(change==='owner')f.store.set('whatsapp-owner','other@s.whatsapp.net');
    if(change==='disabled')f.store.enable(worker.id,false);
    if(change==='route')f.store.set(`session-route:${worker.id}`,'changed');
    if(change==='item')f.store.db.prepare('UPDATE items SET title=? WHERE id=?').run('Changed task',item.id);
    if(change==='mode')f.store.db.prepare("UPDATE bindings SET mode='channel' WHERE id=?").run(worker.id);
    f.router.busy.delete(worker.id);f.router.pump();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,0);assert.equal(f.store.job('wa:action')?.status,'failed');assert.match(f.store.job('wa:action')?.error??'',/not sent/);
    const notice=f.store.db.prepare("SELECT destination FROM outbox WHERE source='brief-action-error:wa:action:0'").get() as any;
    if(change==='owner')assert.equal(notice,undefined);else assert.equal(notice?.destination,'owner@s.whatsapp.net');
  }finally{f.close();}
});
test('a revoked inbound context settles a brief action without sending its rejection notice',async()=>{
  const f=setup();try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Original task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);f.router.busy.add(worker.id);
    assert.equal((await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:action',text:'go 1'}))).status,'queued');
    const captured=f.store.captureIncomingOwner('owner@s.whatsapp.net','whatsapp')!;
    f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner','owner@s.whatsapp.net');
    f.store.incomingOwnerContext.run(captured,()=>f.router.failBeforeSubmission('wa:action','Nothing was sent.'));
    assert.equal(f.store.job('wa:action')?.status,'failed');assert.equal(f.store.db.prepare("SELECT 1 FROM outbox WHERE source='brief-action-error:wa:action:0'").get(),undefined);
  }finally{f.close();}
});

for(const change of ['logout-generation','owner-roundtrip','legacy'] as const)test(`queued brief actions do not run after ${change}`,async()=>{
  const f=setup();try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Original task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const calls:any[]=[];(f.router.native as any).run=async(...args:any[])=>{calls.push(args);};
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);f.router.busy.add(worker.id);
    assert.equal((await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:action',text:'go 1'}))).status,'queued');
    if(change==='logout-generation')f.store.set('incoming-owner-generation',randomUUID());
    if(change==='owner-roundtrip'){f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner','owner@s.whatsapp.net');}
    if(change==='legacy')f.store.db.prepare('UPDATE brief_dispatch_guards SET owner_generation=NULL WHERE request_id=?').run('wa:action');
    f.router.busy.delete(worker.id);f.router.pump();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,0);assert.equal(f.store.job('wa:action')?.status,'failed');
    assert.equal(f.store.db.prepare("SELECT 1 FROM outbox WHERE source='brief-action-error:wa:action:0'").get(),undefined);
  }finally{f.close();}
});

test('WhatsApp logout revokes a queued brief action before it can reach the session',async()=>{
  const f=setup();try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Original task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const calls:any[]=[];(f.router.native as any).run=async(...args:any[])=>{calls.push(args);};
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);f.router.busy.add(worker.id);
    assert.equal((await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:action',text:'go 1'}))).status,'queued');
    const wa=new WhatsApp(f.store,f.router,join(f.dir,'synthetic-wa'));wa.status='connected';wa.selfJid='owner@s.whatsapp.net';wa.owners=[wa.selfJid];
    wa.sock={logout:async()=>{},end:()=>{}} as any;await wa.logout();
    f.router.busy.delete(worker.id);f.router.pump();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,0);assert.equal(f.store.job('wa:action')?.status,'failed');
    assert.equal(f.store.db.prepare("SELECT 1 FROM outbox WHERE source='brief-action-error:wa:action:0'").get(),undefined);
  }finally{f.close();}
});

test('a revoked brief action is not delivered through channel polling',async()=>{
  const f=setup();try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Original task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp','channel').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);
    assert.equal((await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:action',text:'go 1'}))).status,'queued');
    f.store.set('incoming-owner-generation',randomUUID());
    assert.equal(f.router.channelPoll(f.store.binding(worker.id)!,'client'),null);assert.equal(f.store.job('wa:action')?.status,'failed');
    assert.equal(f.store.db.prepare("SELECT 1 FROM outbox WHERE source='brief-action-error:wa:action:0'").get(),undefined);
  }finally{f.close();}
});

test('an in-flight brief handoff is rejected when the owner generation changes before submission',async()=>{
  const f=setup();try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Original task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    let start!:()=>void,release!:()=>void,sends=0;const entered=new Promise<void>(r=>start=r),gate=new Promise<void>(r=>release=r);
    (f.router.native as any).run=async(b:any,_body:string,id:string)=>{start();await gate;f.router.assertDispatchAllowed(id,b);sends++;};
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);f.router.busy.add(worker.id);
    assert.equal((await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:action',text:'go 1'}))).status,'queued');
    const captured=f.store.captureIncomingOwner('owner@s.whatsapp.net','whatsapp')!;f.router.busy.delete(worker.id);
    f.store.incomingOwnerContext.run(captured,()=>f.router.pump());await entered;f.store.set('incoming-owner-generation',randomUUID());release();
    for(let i=0;i<20&&f.router.busy.size;i++)await new Promise<void>(r=>setImmediate(r));
    assert.equal(sends,0);assert.equal(f.store.job('wa:action')?.status,'failed');
    assert.equal(f.store.db.prepare("SELECT 1 FROM outbox WHERE source='brief-action-error:wa:action:0'").get(),undefined);
  }finally{f.close();}
});

test('brief owner generation survives restart and an old guard without it fails closed',async()=>{
  for(const mode of ['valid','revoked','legacy'] as const){const f=setup();let reopened:InstanceType<typeof Store>|undefined;try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Original task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);f.router.busy.add(worker.id);
    assert.equal((await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:action',text:'go 1'}))).status,'queued');
    if(mode==='revoked')f.store.set('incoming-owner-generation',randomUUID());
    if(mode==='legacy')f.store.db.exec('ALTER TABLE brief_dispatch_guards DROP COLUMN owner_generation');
    f.approvals.cancel();f.store.close();reopened=new Store(join(f.dir,'test.db'));
    const calls:any[]=[],approvals=new Approvals(reopened),router=new Router(reopened,{run:async(...args:any[])=>{calls.push(args);},stop:()=>{}} as any,approvals);
    router.brain=new MetaBrain(reopened,new MetaSecret(f.dir),{interpret:async()=>{throw Error('unused');}});router.coordinator=new Coordinator(reopened,router.native,router,()=>{});
    router.pump();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,mode==='valid'?1:0,mode);assert.equal(reopened.job('wa:action')?.status,mode==='valid'?'submitted':'failed',mode);
    if(mode!=='valid')assert.equal(reopened.db.prepare("SELECT 1 FROM outbox WHERE source='brief-action-error:wa:action:0'").get(),undefined,mode);
    approvals.cancel();reopened.close();reopened=undefined;
  }finally{reopened?.close();try{f.close();}catch{rmSync(f.dir,{recursive:true,force:true});}}}
});
test('a queued channel action is never delivered if its saved session identity changes',async()=>{
  const f=setup();try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp','channel').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);
    assert.equal((await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:channel-action',text:'pause 1'}))).status,'queued');
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),worker.id);
    assert.equal(f.router.channelPoll(f.store.binding(worker.id)!,'client'),null);assert.equal(f.store.job('wa:channel-action')?.status,'failed');
  }finally{f.close();}
});
test('a valid guarded channel action reaches only its bound channel once',async()=>{
  const f=setup();try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp','channel').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);
    await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:channel-action',text:'go 1'}));
    const job=f.router.channelPoll(worker,'client');assert.equal(job?.id,'wa:channel-action');assert.match(job?.body??'',/Do not repeat/);
    assert.equal(f.router.channelPoll(worker,'client'),null);
  }finally{f.close();}
});
test('a queued guarded action retains its owner and target checks after reopening the database',async()=>{
  const f=setup();try{
    f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);f.router.busy.add(worker.id);
    await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:action',text:'go 1'}));
    const reopened=new Store(join(f.dir,'test.db')),approvals=new Approvals(reopened),calls:any[]=[];
    try{const native={run:async(...args:any[])=>{calls.push(args);},stop:()=>{}},router=new Router(reopened,native as any,approvals);router.coordinator=new Coordinator(reopened,native as any,router,()=>{});
      reopened.set('whatsapp-owner','other@s.whatsapp.net');router.pump();await new Promise(resolve=>setImmediate(resolve));
      assert.equal(calls.length,0);assert.equal(reopened.job('wa:action')?.status,'failed');
    }finally{approvals.cancel();reopened.close();}
  }finally{f.close();}
});
test('a guarded native action with an unverified legacy connection stops before delivery',async()=>{
  const f=setup();try{
    const {NativeAgents}=await import('../src/native.js');f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const native=f.router.native as any;native.store=f.store;native.connections={assert:async()=>{},route:()=>undefined};native.run=NativeAgents.prototype.run;
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);
    await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:legacy-action',text:'go 1'}));
    await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.store.job('wa:legacy-action')?.status,'failed');assert.match(f.store.job('wa:legacy-action')?.error??'',/no verified connection/);
  }finally{f.close();}
});
for(const mode of ['native-preflight','managed-preflight','post-submit'] as const)test(`guarded ${mode} distinguishes not-sent from uncertain delivery`,async()=>{
  const f=setup();try{
    const {NativeAgents}=await import('../src/native.js'),{Masters}=await import('../src/masters.js');f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});f.router.uncertainNoticeMs=0;
    const item=addScoped(f,'wa:task','Task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const route={transport:'managed-cli',executionMode:'cli'};f.store.set(`execution-mode:${worker.id}`,'cli');f.store.set(`session-route:${worker.id}`,JSON.stringify(route));
    let sends=0;const native=f.router.native as any;native.store=f.store;native.connections={assert:async()=>{if(mode==='native-preflight')throw Error('synthetic secret failure');},route:()=>route};native.run=NativeAgents.prototype.run;
    const managed=Object.create(Masters.prototype) as any;managed.store=f.store;managed.router=f.router;managed.connections={assert:async()=>{throw Error('synthetic secret failure');}};
    native.managedRun=mode==='managed-preflight'?(...args:any[])=>managed.run(...args):async()=>{sends++;throw Error('delivery reply lost');};
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);
    await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:preflight-action',text:'go 1'}));
    await new Promise(resolve=>setTimeout(resolve,20));const job=f.store.job('wa:preflight-action')!;
    if(mode==='post-submit'){assert.equal(sends,1);assert.equal(job.status,'uncertain');}
    else {assert.equal(sends,0);assert.equal(job.status,'failed');assert.match(job.error??'',/not sent/);assert.doesNotMatch(job.error??'',/synthetic secret/);
      const notice=f.store.db.prepare("SELECT body FROM outbox WHERE source='brief-action-error:wa:preflight-action:0'").get() as any;assert.match(notice.body,/not sent/);}
  }finally{f.close();}
});
for(const outcome of ['resolve','reject'] as const)test(`native readiness rechecks owner after an awaited connection check that ${outcome}s`,async()=>{
  const f=setup();try{
    const {NativeAgents}=await import('../src/native.js');f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Task'),worker=f.store.register('worker','codex',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    let release!:()=>void,fail!:(e:Error)=>void;const held=new Promise<void>((r,j)=>{release=r;fail=j;});const native=f.router.native as any;
    native.store=f.store;native.connections={assert:async()=>held,route:()=>({transport:'native-session'})};native.run=NativeAgents.prototype.run;
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);
    assert.equal((await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:wait-action',text:'go 1'}))).status,'queued');
    assert.equal(f.store.job('wa:wait-action')?.status,'dispatched');f.store.set('whatsapp-owner','other@s.whatsapp.net');if(outcome==='resolve')release();else fail(Error('connection lookup failed'));
    await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.store.job('wa:wait-action')?.status,'failed');assert.match(f.store.job('wa:wait-action')?.error??'',/not sent/);
  }finally{f.close();}
});
test('desktop readiness cancels an unsent opening notice when the session changes mid-wait',async()=>{
  const f=setup();try{
    const {NativeAgents}=await import('../src/native.js');f.router.coordinator=new Coordinator(f.store,f.router.native,f.router,()=>{});
    const item=addScoped(f,'wa:task','Task'),worker=f.store.register('worker','claude',randomUUID(),'/tmp').binding;f.router.brain.memory.items.setSession(item.id,worker.id);
    const route={transport:'native-session',executionMode:'desktop'};f.store.set(`execution-mode:${worker.id}`,'desktop');f.store.set(`session-route:${worker.id}`,JSON.stringify(route));
    let started!:()=>void,release!:(value:any)=>void;const startedPromise=new Promise<void>(r=>started=r),held=new Promise<any>(r=>release=r);
    const session={id:worker.native_id,cwd:worker.cwd,provider:'claude',executionMode:'desktop',activation:'desktop-open',available:false};const native=f.router.native as any;
    native.store=f.store;native.connections={assert:async()=>{},route:()=>route};native.catalog=async()=>({sessions:[session]});native.activation={ready:()=>{started();return held;}};native.run=NativeAgents.prototype.run;
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);
    await f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.receive({id:'wa:desktop-action',text:'go 1'}));await startedPromise;
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),worker.id);release({...session,available:true});
    await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.store.job('wa:desktop-action')?.status,'failed');assert.match(f.store.job('wa:desktop-action')?.error??'',/not sent/);
    assert.equal((f.store.db.prepare("SELECT status FROM outbox WHERE source='native-opening:wa:desktop-action:0'").get() as any).status,'cancelled');
  }finally{f.close();}
});
test('a linked pull request lookup failure is disclosed without fabricating a merge',async()=>{
  const f=setup();try{
    const item=addScoped(f,'wa:task','Task');f.store.destinationContext.run('owner@s.whatsapp.net',()=>f.router.brain.memory.items.note(item.id,'https://github.com/Owner/Repo/pull/42',undefined,undefined,'wa:task'));
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant,async()=>{throw Error('not authorized');});
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);
    assert.match(sourceRows(f.store)[0].body,/Some linked PR status could not be checked/);assert.doesNotMatch(sourceRows(f.store)[0].body,/Merged PR/);
  }finally{f.close();}
});
test('the sent-day record survives reopening the database',async()=>{
  const f=setup();const file=join(f.dir,'test.db');try{
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);
    const reopened=new Store(file);try{
      const approvals=new Approvals(reopened),router=new Router(reopened,{run:async()=>{},stop:()=>{}} as any,approvals);
      router.brain=new MetaBrain(reopened,f.secret,{interpret:async()=>{throw Error('unused');}});
      const again=new MorningBrief(reopened,router,async()=>{throw Error('must not call');},()=>instant);
      assert.equal(await again.request('owner@s.whatsapp.net','scheduled'),false);assert.equal(sourceRows(reopened).length,1);approvals.cancel();
    }finally{reopened.close();}
  }finally{f.close();}
});
test('changing the brief time while generating prevents the old schedule from sending',async()=>{
  const f=setup();try{
    let release!:()=>void;const held=new Promise<void>(r=>release=r);
    const brief=new MorningBrief(f.store,f.router,async()=>{await held;return {opening:'Hello.',priorities:[]};},()=>instant);
    const pending=brief.request('owner@s.whatsapp.net','scheduled');f.store.set('morning-brief-time','09:30');release();
    assert.equal(await pending,false);assert.equal(sourceRows(f.store).length,0);
  }finally{f.close();}
});
test('failed generation has a persistent daily attempt limit, a safe notice and an explicit retry',async()=>{
  const f=setup();try{
    let now=instant,calls=0;const brief=new MorningBrief(f.store,f.router,async()=>{calls++;throw Error('private provider details');},()=>now);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),false);now+=60_001;
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),false);now+=300_001;
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),false);now+=900_001;
    assert.equal(await new MorningBrief(f.store,f.router,async()=>{calls++;throw Error('must not retry');},()=>now).request('owner@s.whatsapp.net','scheduled'),false);
    assert.equal(calls,3);const notices=f.store.db.prepare("SELECT body FROM outbox WHERE source LIKE 'morning-brief-error:%'").all() as any[];
    assert.equal(notices.length,1);assert.doesNotMatch(notices[0].body,/private provider details/);assert.match(notices[0].body,/\/brief retry/);
    const retry=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>now);
    assert.match(retry.action({id:'wa:retry',text:'/brief retry',ownerCommand:true})?.reply??'',/retry/);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(sourceRows(f.store).length,1);
  }finally{f.close();}
});
test('scheduled brief checks cancellation after Meta and shares daily dedupe with normal triggers',async()=>{
  const f=setup();try{
    let allow=true,release!:()=>void;const held=new Promise<void>(r=>release=r);
    const brief=new MorningBrief(f.store,f.router,async()=>{await held;return {opening:'Hello.',priorities:[]};},()=>instant);
    const work=brief.scheduledBrief('owner@s.whatsapp.net','owner@s.whatsapp.net','occurrence-1',()=>allow);allow=false;release();
    assert.equal(await work,'retry');assert.equal(sourceRows(f.store).length,0);
    let now=instant+60_001;const again=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>now);
    assert.equal(await again.scheduledBrief('owner@s.whatsapp.net','wrong@s.whatsapp.net','occurrence-1'),'invalid');
    assert.equal(await again.scheduledBrief('owner@s.whatsapp.net','owner@s.whatsapp.net','occurrence-1'),'queued');
    assert.equal(await again.scheduledBrief('owner@s.whatsapp.net','owner@s.whatsapp.net','occurrence-1'),'already-queued');assert.equal(sourceRows(f.store).length,1);
  }finally{f.close();}
});
test('only a proven unsent cancellation may regenerate with a fresh delivery ID; stale days cannot send',async()=>{
  const f=setup();try{
    let now=instant;const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>now);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);const [first]=sourceRows(f.store);
    assert.equal(canDeliverBrief(f.store,first,'owner@s.whatsapp.net',now),true);assert.equal(canDeliverBrief(f.store,first,'owner@s.whatsapp.net',now+86400000),false);
    f.store.db.prepare("UPDATE outbox SET status='cancelled',error='Morning brief owner or destination changed' WHERE id=?").run(first.id);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);const rows=sourceRows(f.store);assert.equal(rows.length,2);assert.notEqual(rows[0].wa_id,rows[1].wa_id);
    const next=rows.find(r=>r.id!==first.id);f.store.db.prepare("UPDATE outbox SET status='cancelled',attempts=1,error='Morning brief owner or destination changed' WHERE id=?").run(next.id);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),false);assert.equal(sourceRows(f.store).length,2);
  }finally{f.close();}
});
test('an approval answered during generation is omitted and numbers reflect the fresh snapshot',async()=>{
  const f=setup();try{
    const item=addScoped(f,'wa:a','Open item'),binding=f.store.register('test-agent','codex',randomUUID(),'/tmp').binding;
    void f.approvals.ask(binding,'May I run tests?');let release!:()=>void;const held=new Promise<void>(r=>release=r);
    const brief=new MorningBrief(f.store,f.router,async()=>{await held;return {opening:'Hello.',priorities:[]};},()=>instant);
    const pending=brief.request('owner@s.whatsapp.net','first-message');const code=[...f.approvals.pending.keys()][0];f.approvals.answer(code,'approve','approval');release();
    assert.equal(await pending,true);const [out]=sourceRows(f.store);assert.doesNotMatch(out.body,/Permission needed/);assert.match(out.body,/1\. Open item/);
    const saved=f.store.db.prepare('SELECT entries FROM morning_briefs').get() as {entries:string};assert.equal(JSON.parse(saved.entries)[0].id,item.id);
  }finally{f.close();}
});
test('an unavailable voice note is reported but its ID is not given to Meta',async()=>{
  const f=setup();try{
    f.store.db.prepare("INSERT INTO audio_inbox VALUES(?,?,'failed',?)").run('wa:private-audio','owner@s.whatsapp.net',instant-1000);
    let input:any;const brief=new MorningBrief(f.store,f.router,async data=>{input=data;return {opening:'Hello.',priorities:[]};},()=>instant);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);
    assert.match(sourceRows(f.store)[0].body,/Voice note needs attention/);assert.doesNotMatch(JSON.stringify(input),/private-audio/);
  }finally{f.close();}
});
test('the latest permission decision cannot be approved by a brief number',async()=>{
  const f=setup();try{
    const binding=f.store.register('test-agent','codex',randomUUID(),'/tmp').binding;void f.approvals.ask(binding,'May I run tests?');
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);
    assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);f.store.sent(sourceRows(f.store)[0].id);
    assert.match(brief.action({id:'wa:go',text:'go 1'})?.reply??'',/original permission/);assert.equal(f.approvals.pending.size,1);
  }finally{f.close();}
});
test('the first authenticated WhatsApp message queues the brief while preserving normal routing',async()=>{
  const f=setup();try{
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>instant);f.router.morningBrief=brief;f.router.pump=()=>{};
    assert.equal((await f.router.receive({id:'wa:hello',text:'/help',ownerCommand:true})).status,'handled');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(sourceRows(f.store).length,1);assert.ok(f.store.db.prepare("SELECT 1 FROM outbox WHERE source='command:wa:hello:0'").get());
  }finally{f.close();}
});
test('later hides an item for the rest of the current local day and returns it tomorrow',async()=>{
  const f=setup();try{
    addScoped(f,'wa:task','Task');let clock=instant;
    const brief=new MorningBrief(f.store,f.router,async()=>({opening:'Hello.',priorities:[]}),()=>clock);
    await brief.request('owner@s.whatsapp.net','first-message');f.store.sent(sourceRows(f.store)[0].id);
    assert.match(brief.action({id:'wa:later',text:'later 1'})?.reply??'',/for later/);
    clock+=24*60*60*1000;assert.equal(await brief.request('owner@s.whatsapp.net','first-message'),true);
    const next=f.store.db.prepare("SELECT o.body FROM morning_briefs b JOIN outbox o ON o.source=b.source||':0' WHERE b.day='2026-10-30'").get() as any;
    assert.match(next.body,/Task/);
  }finally{f.close();}
});
