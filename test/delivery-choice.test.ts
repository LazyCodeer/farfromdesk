import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Application modules cache their state root at import time.
const root=mkdtempSync(join(tmpdir(),'ffd-delivery-test-'));process.env.WSB_STATE_DIR=root;process.env.FARFROMDESK_HOME=join(root,'home');
test.after(()=>rmSync(root,{recursive:true,force:true}));
const {Store}=await import('../src/store.js');
const {Router}=await import('../src/router.js');
const {Coordinator}=await import('../src/coordinator.js');
const {Approvals}=await import('../src/approvals.js');
const {DEFAULT_BRAIN}=await import('../src/meta-brain-config.js');
const {readDeliveryHold,saveDeliveryHold}=await import('../src/delivery-choice.js');

const owner='owner@s.whatsapp.net';
const uuid=(n:number)=>`33333333-3333-4333-a333-${String(n).padStart(12,'0')}`;
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

type Fixture=ReturnType<typeof fixture>;
/** A Codex Desktop coordinator whose app is closed, plus a Claude CLI session that is ready. */
function fixture(o:{codex?:boolean}={}) {
  const store=new Store(':memory:'),approvals=new Approvals(store);
  const submitted:{binding:string;body:string}[]=[];
  const native={run:async(b:any,body:string)=>{submitted.push({binding:b.id,body});},stop:()=>{},warmDesktop:()=>{},catalog:async()=>({sessions:[],cursor:null})};
  const router=new Router(store,native as any,approvals),coordinator=new Coordinator(store,native as any,router,()=>{});
  router.coordinator=coordinator;router.livenessProbe=()=>({codex:!!o.codex,claude:false});
  const opened:string[]=[];router.openTarget=async(b:any)=>{opened.push(b.id);};
  store.set('control-channel','whatsapp');store.set('whatsapp-owner',owner);
  const master=store.register('codex-atlas','codex',uuid(1),'/tmp/project','desktop').binding;
  store.set(`name:${master.id}`,'FarFromDesk coordinator setup');
  store.set(`execution-mode:${master.id}`,'desktop');store.set('master',master.id);store.set('active',master.id);
  coordinator.registry.register(master);
  const alt=store.register('claude-cli','claude',uuid(2),'/tmp/project','desktop').binding;
  store.set(`name:${alt.id}`,'Claude CLI');
  store.set(`execution-mode:${alt.id}`,'cli');
  const receive=(id:string,text:string,extra:Record<string,unknown>={})=>store.destinationContext.run(owner,()=>router.receive({id,text,...extra} as any));
  const rows=(source:string)=>store.db.prepare('SELECT id,body,wa_id,status,destination FROM outbox WHERE source LIKE ? ORDER BY rowid').all(`${source}%`) as {id:string;body:string;wa_id:string;status:string;destination:string}[];
  const bodies=(source:string)=>rows(source).map(row=>row.body);
  const answer=async(id:string,text:string,card:{id:string;wa_id:string})=>{store.sent(card.id);return receive(id,text,{quotedId:card.wa_id,ownerChoice:true,source:'text'});};
  return {store,approvals,router,coordinator,master,alt,submitted,opened,receive,rows,bodies,answer,close:()=>{router.stopped=true;approvals.cancel();store.close();}};
}

test('a message for a closed desktop app is held, and the card offers the real choice',async()=>{
  const f:Fixture=fixture();try{
    const result=await f.receive('wa:hey','Hey');
    assert.equal(result.status,'queued');
    await wait(20);
    assert.equal(f.submitted.length,0,'nothing is submitted while the owner is being asked');
    assert.equal(f.store.job('wa:hey')?.status,'queued');
    assert.ok(readDeliveryHold(f.store,'wa:hey'));
    const card=f.bodies('delivery-choice:')[0];
    assert.match(card,/Codex Desktop is closed/);
    assert.match(card,/Held for FarFromDesk coordinator setup/);
    assert.match(card,/Nothing has been sent to Codex Desktop yet/);
    assert.match(card,/1\. Open Codex Desktop and send it there/);
    assert.match(card,/2\. Send it to Claude CLI · project/);
    assert.match(card,/3\. Keep it queued until Codex Desktop opens/);
    assert.match(card,/15 minutes/);
    // The card's choices are action options, not messages for a session.
    const option=f.store.db.prepare("SELECT o.id,a.kind FROM message_options o JOIN option_actions a ON a.option_id=o.id").get() as {id:string;kind:string};
    assert.equal(option?.kind,'delivery');
    assert.equal(f.store.db.prepare('SELECT status FROM outbox WHERE source=?').get('delivery-choice:wa:hey:0')?.status,'queued');
  }finally{f.close();}
});

test('keeping it queued releases the hold and sends it to the original session once',async()=>{
  const f:Fixture=fixture();try{
    await f.receive('wa:hey','Hey');await wait(20);
    const card=f.rows('delivery-choice:')[0];
    const reply=await f.answer('wa:keep','3',card);
    assert.equal(reply.status,'handled');
    await wait(20);
    assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].binding,f.master.id);
    assert.equal(f.submitted[0].body,'Hey');
    assert.equal(readDeliveryHold(f.store,'wa:hey'),undefined);
    assert.match(f.bodies('delivery-wait:').join('\n'),/Kept for FarFromDesk coordinator setup/);
  }finally{f.close();}
});

test('sending it to another session replaces the held copy, so the task cannot run twice',async()=>{
  const f:Fixture=fixture();try{
    await f.receive('wa:hey','Hey');await wait(20);
    const card=f.rows('delivery-choice:')[0];
    const reply=await f.answer('wa:move','2',card);
    assert.equal(reply.status,'handled');
    await wait(30);
    assert.equal(f.submitted.length,1,'only the chosen session is dispatched');
    assert.equal(f.submitted[0].binding,f.alt.id);
    assert.equal(f.submitted[0].body,'Hey');
    assert.equal(f.store.job('wa:hey')?.status,'replaced');
    assert.equal(f.store.job('wa:hey')?.outcome,'cancelled');
    assert.equal(readDeliveryHold(f.store,'wa:hey'),undefined);
    const said=f.bodies('delivery-move:').concat(f.bodies('delivery-moved:')).join('\n');
    assert.match(said,/Sending this to Claude CLI/);
    assert.match(said,/never received it, so it will not run twice/);
  }finally{f.close();}
});

test('opening the app reports the real sequence and then sends exactly once',async()=>{
  const f:Fixture=fixture();try{
    await f.receive('wa:hey','Hey');await wait(20);
    const card=f.rows('delivery-choice:')[0];
    await f.answer('wa:open','1',card);
    await wait(30);
    assert.deepEqual(f.opened,[f.master.id]);
    assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].binding,f.master.id);
    assert.equal(readDeliveryHold(f.store,'wa:hey'),undefined);
    assert.match(f.bodies('delivery-open:')[0],/Opening Codex Desktop/);
    assert.match(f.bodies('delivery-opened:')[0],/Codex Desktop is open\. Sending your message to FarFromDesk coordinator setup now/);
    assert.match(f.bodies('delivery-opened:')[0],/as soon as it answers/);
  }finally{f.close();}
});

test('an app the owner opens by hand releases the hold instead of leaving the message stranded',async()=>{
  const f:Fixture=fixture();try{
    await f.receive('wa:hey','Hey');await wait(20);
    assert.equal(f.submitted.length,0);
    f.store.set('app-running:codex','true');
    f.router.settleDeliveryHolds();
    await wait(20);
    assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].binding,f.master.id);
    assert.equal(readDeliveryHold(f.store,'wa:hey'),undefined);
    assert.match(f.bodies('delivery-opened:')[0],/is open now, so your held message is on its way/);
  }finally{f.close();}
});

test('an unanswered choice falls back to the old behaviour instead of losing the message',async()=>{
  const f:Fixture=fixture();try{
    await f.receive('wa:hey','Hey');await wait(20);
    const hold=readDeliveryHold(f.store,'wa:hey')!;
    saveDeliveryHold(f.store,{...hold,expiresAt:Date.now()-1});
    f.router.settleDeliveryHolds();
    await wait(20);
    assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].binding,f.master.id);
    assert.equal(readDeliveryHold(f.store,'wa:hey'),undefined);
    assert.match(f.bodies('delivery-expired:')[0],/no answer for 15 minutes/);
    assert.match(f.bodies('delivery-expired:')[0],/runs when the app opens/);
  }finally{f.close();}
});

test('an open app keeps the plain receipt and never asks',async()=>{
  const f:Fixture=fixture({codex:true});try{
    await f.receive('wa:hey','Hey');await wait(20);
    assert.equal(f.rows('delivery-choice:').length,0);
    assert.equal(readDeliveryHold(f.store,'wa:hey'),undefined);
    assert.match(f.bodies('owner-receipt:')[0],/Queued for Codex Desktop/);
    assert.equal(f.submitted.length,1);
  }finally{f.close();}
});

test('work already inside the app queue escalates with a card that can only open it',async()=>{
  const f:Fixture=fixture();try{
    f.router.silenceNoticeMs=5;f.router.silenceEscalateMs=5;
    await f.receive('wa:hey','Hey');await wait(20);
    const card=f.rows('delivery-choice:')[0];
    await f.answer('wa:keep','3',card);
    await wait(60);
    const wake=f.rows('silence:wa:hey:2');
    assert.equal(wake.length,1);
    assert.match(wake[0].body,/Codex Desktop still has not started this after 1 min/);
    assert.match(wake[0].body,/already in Codex Desktop's own queue, so I can only open the app, not move it to another session/);
    assert.match(wake[0].body,/1\. Open Codex Desktop now/);
    assert.match(wake[0].body,/2\. Leave it queued/);
    assert.doesNotMatch(wake[0].body,/send \/status/);
    // Opening from that card never resubmits the message the app already holds.
    const before=f.submitted.length;
    await f.answer('wa:wake','1',wake[0]);
    await wait(30);
    assert.deepEqual(f.opened,[f.master.id]);
    assert.equal(f.submitted.length,before);
    assert.match(f.bodies('delivery-opened:')[0],/will pick up the queued message/);
  }finally{f.close();}
});

test('the brain writes the lead when it is configured, and the facts stay the bridge\'s own words',async()=>{
  const f:Fixture=fixture();try{
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:false}));
    f.router.brain.secret.save('synthetic-delivery-choice-key');
    const seen:{facts?:any;system?:string}[]=[];
    f.router.noticeModel={compose:async(_key:string,_policy:any,system:string,facts:any)=>{seen.push({system,facts});return 'Codex Desktop is shut, so your Hey is parked with me for now.';}} as any;
    await f.receive('wa:hey','Hey');await wait(30);
    assert.equal(seen.length,1);
    assert.deepEqual(seen[0].facts?.running,['Muse Code']);
    assert.match(seen[0].system??'',/never say work was sent/i);
    const card=f.bodies('delivery-choice:')[0];
    assert.match(card,/Codex Desktop is shut, so your Hey is parked with me for now\./);
    assert.match(card,/1\. Open Codex Desktop and send it there/);
    assert.match(card,/2\. Send it to Claude CLI · project/);
    assert.match(card,/15 minutes/);
  }finally{f.close();}
});

test('an over-claiming or failing brain falls back to the plain wording',async()=>{
  const f:Fixture=fixture();try{
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:false}));
    f.router.brain.secret.save('synthetic-delivery-choice-key');
    f.router.noticeModel={compose:async()=>'Your Hey has been sent to Codex Desktop and is running now.'} as any;
    await f.receive('wa:claim','Hey');await wait(30);
    assert.match(f.bodies('delivery-choice:')[0],/^📴 Codex Desktop is closed/);
    f.router.noticeModel={compose:async()=>{throw new Error('Meta API unavailable (HTTP 503).');}} as any;
    await f.receive('wa:fail','Second message');await wait(30);
    assert.match(f.bodies('delivery-choice:')[1],/^📴 Codex Desktop is closed/);
    assert.equal(f.submitted.length,0);
  }finally{f.close();}
});

test('a message for a session that is not a desktop app is never held',async()=>{
  const f:Fixture=fixture();try{
    f.store.db.prepare("UPDATE bindings SET mode='channel' WHERE id=?").run(f.alt.id);
    f.store.set(`execution-mode:${f.alt.id}`,'desktop');
    const alternatives=await import('../src/delivery-choice.js').then(m=>m.deliveryAlternatives(f.store,f.master,id=>f.coordinator.isCoordinator(id),p=>f.router.appOnline(p as any)));
    assert.equal(alternatives.some(a=>a.bindingId===f.alt.id),false,'a channel session cannot be offered');
    await f.receive('wa:hey','Hey');await wait(20);
    assert.equal(f.rows('delivery-choice:').length,0,'with nothing available the ordinary receipt stands');
    assert.match(f.bodies('owner-receipt:')[0],/is closed/);
    assert.equal(f.submitted.length,1);
  }finally{f.close();}
});