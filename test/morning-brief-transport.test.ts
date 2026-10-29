import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root=mkdtempSync(join(tmpdir(),'ffd-brief-transport-'));process.env.WSB_STATE_DIR=root;test.after(()=>rmSync(root,{recursive:true,force:true}));
const {Store}=await import('../src/store.js');
const {Router}=await import('../src/router.js');
const {Approvals}=await import('../src/approvals.js');
const {MetaBrain}=await import('../src/meta-brain.js');
const {DEFAULT_BRAIN,MetaSecret}=await import('../src/meta-brain-config.js');
const {MorningBrief}=await import('../src/morning-brief.js');
const {WhatsApp}=await import('../src/whatsapp.js');

function fixture(){
  const store=new Store(':memory:'),approvals=new Approvals(store),native={run:async()=>{},stop:()=>{}},router=new Router(store,native as any,approvals);
  store.set('whatsapp-owner','owner@s.whatsapp.net');store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true}));
  const secret=new MetaSecret(root);secret.save('synthetic-transport-key');router.brain=new MetaBrain(store,secret,{interpret:async()=>{throw Error('unused');}});
  const brief=new MorningBrief(store,router,async()=>({opening:'Hello.',priorities:[]}));
  const wa=new WhatsApp(store,router);wa.status='connected';wa.selfJid='owner@s.whatsapp.net';wa.owners=[wa.selfJid];
  return {store,router,approvals,brief,wa,close(){wa.close();approvals.cancel();store.close();}};
}
test('brief delivery is marked in flight before WhatsApp I/O and an ambiguous failure never retries',async()=>{
  const f=fixture();try{
    assert.equal(await f.brief.request('owner@s.whatsapp.net','first-message'),true);
    let calls=0;f.wa.sock={sendMessage:async()=>{calls++;const row=f.store.db.prepare("SELECT status,attempts FROM outbox WHERE source LIKE 'morning-brief:%'").get() as any;assert.equal(row.status,'sending');assert.equal(row.attempts,1);throw Error('simulated lost response');},end:()=>{}} as any;
    await f.wa.flush();const row=f.store.db.prepare("SELECT status,attempts FROM outbox WHERE source LIKE 'morning-brief:%'").get() as any;
    assert.equal(row.status,'uncertain');assert.equal(row.attempts,1);await f.wa.flush();assert.equal(calls,1);
    assert.equal(await f.brief.request('owner@s.whatsapp.net','first-message'),false);
  }finally{f.close();}
});
test('a restart preserves an interrupted brief send as uncertain',async()=>{
  const f=fixture();try{
    assert.equal(await f.brief.request('owner@s.whatsapp.net','first-message'),true);
    f.store.db.prepare("UPDATE outbox SET status='sending',attempts=1 WHERE source LIKE 'morning-brief:%'").run();f.store.recover();
    assert.equal((f.store.db.prepare("SELECT status FROM outbox WHERE source LIKE 'morning-brief:%'").get() as any).status,'uncertain');
    assert.equal(await f.brief.request('owner@s.whatsapp.net','first-message'),false);
  }finally{f.close();}
});
test('owner changes during group verification cancel the queued brief before any send',async()=>{
  const f=fixture();try{
    const group='team@g.us';f.store.set('destination-jid',group);f.store.set('owned-group:'+group,'true');
    assert.equal(await f.brief.request(group,'first-message'),true);
    let sends=0;f.wa.sock={sendMessage:async()=>{sends++;return {};},end:()=>{}} as any;
    f.wa.verifyGroup=async()=>{f.store.set('whatsapp-owner','new-owner@s.whatsapp.net');f.wa.selfJid='new-owner@s.whatsapp.net';};
    await f.wa.flush();assert.equal(sends,0);assert.equal((f.store.db.prepare("SELECT status FROM outbox WHERE source LIKE 'morning-brief:%'").get() as any).status,'cancelled');
  }finally{f.close();}
});
