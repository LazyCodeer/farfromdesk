import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,type ChildProcess} from 'node:child_process';

// Isolate before loading application modules, including on direct test runs.
const root=mkdtempSync(join(tmpdir(),'ffd-collaboration-test-'));
process.env.WSB_STATE_DIR=root;process.env.FARFROMDESK_HOME=join(root,'home');
test.after(()=>rmSync(root,{recursive:true,force:true}));
const {Store}=await import('../src/store.js');
const {CollaborationHarness}=await import('../src/collaboration-harness.js');
type Scope=import('../src/collaboration-harness.js').CollaborationScope;
type Binding=import('../src/store.js').Binding;

function fixture() {
  const db=join(mkdtempSync(join(root,'db-')),'state.sqlite'),store=new Store(db);
  const coordinator=store.register('proxy','codex',randomUUID(),'/tmp').binding;
  const a=store.register('worker-a','codex',randomUUID(),'/tmp').binding;
  const b=store.register('worker-b','claude',randomUUID(),'/tmp').binding;
  const owner='owner@s.whatsapp.net',request='wa:owner-request';
  store.set('whatsapp-owner',owner);
  store.enqueue(request,coordinator,'Owner task',owner);
  store.db.prepare("UPDATE inbox SET status='completed' WHERE id=?").run(request);
  const row=store.db.prepare("INSERT INTO items(title,status,created_at,updated_at) VALUES('Task','not started',?,?)").run(1,1),itemId=Number(row.lastInsertRowid);
  store.linkItem(request,itemId);store.db.prepare('INSERT INTO item_owner_origins VALUES(?,?,?)').run(itemId,owner,owner);
  const scope:Scope={owner,destination:owner,rootRequestId:request,itemId,contractId:'contract-a',revision:1,approvedHash:'a'.repeat(64)};
  let now=1_000_000,allowed=true;
  const authority={approved:(r:string,i:number)=>allowed&&r===request&&i===itemId?{...scope}:undefined,mayWork:(_s:Scope,c:Binding)=>c.id===a.id||c.id===b.id};
  const clock=()=>now,ledger=new CollaborationHarness(store,authority,clock);
  return {db,store,coordinator,a,b,owner,request,itemId,scope,authority,clock,ledger,
    tick(ms:number){now+=ms;},revoke(){allowed=false;},close(){store.close();}};
}

test('only one exact session can claim an item and repeated event is idempotent',()=>{
  const f=fixture();try{
    const claim=f.ledger.claim(f.request,f.itemId,f.a.id,'event-1');
    assert.deepEqual(f.ledger.claim(f.request,f.itemId,f.a.id,'event-1'),claim);
    assert.throws(()=>f.ledger.claim(f.request,f.itemId,f.b.id,'event-2'),/already claimed/);
    assert.throws(()=>f.ledger.claim(f.request,f.itemId,f.b.id,'event-1'),/cannot be reused/);
    assert.deepEqual(f.ledger.history(f.request,f.itemId).map(x=>x.kind),['claimed']);
  }finally{f.close();}
});

test('separate SQLite connections cannot both claim the same item',()=>{
  const f=fixture(),other=new Store(f.db);try{
    const second=new CollaborationHarness(other,f.authority,f.clock);
    const a=f.ledger.claim(f.request,f.itemId,f.a.id,'a');
    assert.throws(()=>second.claim(f.request,f.itemId,f.b.id,'b'),/already claimed/);
    assert.equal(a.bindingId,f.a.id);
  }finally{other.close();f.close();}
});

test('simultaneous processes produce exactly one successful claim',async()=>{
  const f=fixture(),children:ChildProcess[]=[];
  try{
    const run=(bindingId:string,eventId:string)=>{
      const child=spawn(process.execPath,['--import','tsx','test/fixtures/collaboration-claim-worker.mts',f.db,f.owner,f.request,String(f.itemId),bindingId,eventId],{stdio:['ignore','ignore','ignore','ipc']});
      children.push(child);
      let readyResolve!:()=>void,resultResolve!:(value:boolean)=>void;
      const ready=new Promise<void>(resolve=>{readyResolve=resolve;}),result=new Promise<boolean>(resolve=>{resultResolve=resolve;});
      child.on('message',(msg:any)=>{if(msg?.ready)readyResolve();else if(typeof msg?.ok==='boolean')resultResolve(msg.ok);});
      return {child,ready,result};
    };
    const a=run(f.a.id,'process-a'),b=run(f.b.id,'process-b');
    const timeout=new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(Error('claim workers timed out')),10000);t.unref();});
    await Promise.race([Promise.all([a.ready,b.ready]),timeout]);
    a.child.send?.('go');b.child.send?.('go');
    const results=await Promise.race([Promise.all([a.result,b.result]),timeout]);
    assert.equal(results.filter(Boolean).length,1);
    assert.equal(f.ledger.history(f.request,f.itemId).filter(x=>x.kind==='claimed').length,1);
  }finally{for(const child of children)child.kill();f.close();}
});

test('expired work cannot be stolen while linked work is queued, running or uncertain',()=>{
  for(const status of ['queued','dispatched','submitted','uncertain']){
    const f=fixture();try{
      const claim=f.ledger.claim(f.request,f.itemId,f.a.id,`claim-${status}`);
      const id=`master:${f.request}:child`;f.store.set(`parent:${id}`,f.request);
      f.store.enqueue(id,f.a,'Work',f.owner);f.store.db.prepare('UPDATE inbox SET status=? WHERE id=?').run(status,id);
      f.tick(15*60_000+1);
      assert.throws(()=>f.ledger.claim(f.request,f.itemId,f.b.id,`other-${status}`),/active or uncertain/);
      const renewed=f.ledger.renew(f.request,f.itemId,claim.token,`renew-${status}`);
      assert.equal(renewed.generation,claim.generation);
      assert.throws(()=>f.ledger.handoff(f.request,f.itemId,claim.token,f.b.id,'Work still running',`handoff-${status}`),/active or uncertain/);
    }finally{f.close();}
  }
});

test('an idle expired claim requires a new explicit claimant and fences stale holders',()=>{
  const f=fixture();try{
    const old=f.ledger.claim(f.request,f.itemId,f.a.id,'old');f.tick(15*60_000+1);
    assert.throws(()=>f.ledger.renew(f.request,f.itemId,old.token,'late-renew'),/expired/);
    assert.throws(()=>f.ledger.handoff(f.request,f.itemId,old.token,f.b.id,'Late','late'),/expired/);
    const next=f.ledger.claim(f.request,f.itemId,f.b.id,'next');
    assert.equal(next.generation,old.generation+1);assert.notEqual(next.token,old.token);
    assert.throws(()=>f.ledger.release(f.request,f.itemId,old.token,'old-release'),/unavailable/);
  }finally{f.close();}
});

test('handoff records contract history but does not dispatch or automatically claim',()=>{
  const f=fixture();try{
    const claim=f.ledger.claim(f.request,f.itemId,f.a.id,'claim');
    f.ledger.handoff(f.request,f.itemId,claim.token,f.b.id,'Plan is ready for implementation.','handoff');
    f.ledger.handoff(f.request,f.itemId,claim.token,f.b.id,'Plan is ready for implementation.','handoff');
    const history=f.ledger.history(f.request,f.itemId);
    assert.deepEqual(history.map(x=>x.kind),['claimed','handoff']);
    assert.equal(history[1].fromBindingId,f.a.id);assert.equal(history[1].toBindingId,f.b.id);
    assert.equal(history[1].contractId,'contract-a');assert.equal(history[1].revision,1);
    assert.equal(history[1].approvedHash,f.scope.approvedHash);
    assert.equal(history[1].drift,'not_checked');assert.equal(f.store.unfinished(f.b.id).length,0);
    const next=f.ledger.claim(f.request,f.itemId,f.b.id,'claim-b');assert.equal(next.generation,2);
    assert.throws(()=>f.ledger.handoff(f.request,f.itemId,claim.token,f.b.id,'Changed','handoff'),/cannot be reused/);
  }finally{f.close();}
});

test('owner, item, binding and contract changes fail closed',()=>{
  for(const change of ['owner','item','binding','contract','revoked']){
    const f=fixture();try{
      const claim=f.ledger.claim(f.request,f.itemId,f.a.id,`claim-${change}`);
      if(change==='owner')f.store.set('whatsapp-owner','another@s.whatsapp.net');
      if(change==='item')f.store.db.prepare('DELETE FROM item_owner_origins WHERE item_id=?').run(f.itemId);
      if(change==='binding')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.a.id);
      if(change==='contract')f.scope.revision++;
      if(change==='revoked')f.revoke();
      assert.throws(()=>f.ledger.handoff(f.request,f.itemId,claim.token,f.b.id,'Done',`handoff-${change}`),/changed|unavailable/);
    }finally{f.close();}
  }
});

test('new approved contract revisions can claim an idle item without mixing history',()=>{
  const f=fixture();try{
    const first=f.ledger.claim(f.request,f.itemId,f.a.id,'v1-claim');
    f.ledger.release(f.request,f.itemId,first.token,'v1-release');
    f.scope.revision=2;f.scope.approvedHash='b'.repeat(64);
    const second=f.ledger.claim(f.request,f.itemId,f.b.id,'v2-claim');
    assert.equal(second.generation,2);
    assert.deepEqual(f.ledger.history(f.request,f.itemId).map(x=>x.eventId),['v2-claim']);
  }finally{f.close();}
});

test('claims and history persist across restart and never expose another owner',()=>{
  const f=fixture();try{
    const claim=f.ledger.claim(f.request,f.itemId,f.a.id,'claim');f.store.close();
    const reopened=new Store(f.db),ledger=new CollaborationHarness(reopened,f.authority,f.clock);
    try{
      assert.equal(ledger.claim(f.request,f.itemId,f.a.id,'claim').token,claim.token);
      assert.equal(ledger.history(f.request,f.itemId).length,1);
      reopened.set('whatsapp-owner','another@s.whatsapp.net');
      assert.throws(()=>ledger.history(f.request,f.itemId),/changed/);
    }finally{reopened.close();}
  }finally{try{f.close();}catch{}}
});

test('an unproven legacy item, unauthorized session and revoked contract cannot be claimed',()=>{
  const f=fixture();try{
    f.store.db.prepare('DELETE FROM item_owner_origins WHERE item_id=?').run(f.itemId);
    assert.throws(()=>f.ledger.claim(f.request,f.itemId,f.a.id,'unknown-owner'),/changed/);
    f.store.db.prepare('INSERT INTO item_owner_origins VALUES(?,?,?)').run(f.itemId,f.owner,f.owner);
    assert.throws(()=>f.ledger.claim(f.request,f.itemId,f.coordinator.id,'unknown-session'),/not authorized/);
    f.revoke();assert.throws(()=>f.ledger.claim(f.request,f.itemId,f.a.id,'revoked'),/unavailable/);
  }finally{f.close();}
});

test('blocked, waiting and completed items cannot be claimed automatically',()=>{
  const f=fixture();try{
    for(const status of ['blocked','waiting on owner','done']){
      f.store.db.prepare('UPDATE items SET status=? WHERE id=?').run(status,f.itemId);
      assert.throws(()=>f.ledger.claim(f.request,f.itemId,f.a.id,`status-${status.replaceAll(' ','-')}`),/not available/);
    }
    f.store.db.prepare("UPDATE items SET status='in progress' WHERE id=?").run(f.itemId);
    const claim=f.ledger.claim(f.request,f.itemId,f.a.id,'after-owner-resume');assert.equal(claim.bindingId,f.a.id);
    f.store.db.prepare("UPDATE items SET status='done' WHERE id=?").run(f.itemId);
    assert.throws(()=>f.ledger.handoff(f.request,f.itemId,claim.token,f.b.id,'Done','finished-handoff'),/not available/);
  }finally{f.close();}
});
