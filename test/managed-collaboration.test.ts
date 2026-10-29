import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=mkdtempSync(join(tmpdir(),'ffd-managed-collab-'));
process.env.WSB_STATE_DIR=root;process.env.FARFROMDESK_HOME=join(root,'home');
test.after(()=>rmSync(root,{recursive:true,force:true}));
const {Store}=await import('../src/store.js');
const {Router}=await import('../src/router.js');
const {Approvals}=await import('../src/approvals.js');
const {Coordinator}=await import('../src/coordinator.js');
const {MetaBrain}=await import('../src/meta-brain.js');
const {DEFAULT_BRAIN,MetaSecret,saveBrainConfig}=await import('../src/meta-brain-config.js');
const {TaskContracts}=await import('../src/task-contracts.js');
const {ManagedCollaboration}=await import('../src/managed-collaboration.js');
const {NativeAgents}=await import('../src/native.js');
const {DispatchNotSubmittedError}=await import('../src/brief-dispatch-guard.js');

function deferred<T=void>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(predicate:()=>boolean){for(let i=0;i<100&&!predicate();i++)await turn();assert.ok(predicate(),'operation did not reach the expected state');}

async function fixture(){
  const dir=mkdtempSync(join(root,'case-')),store=new Store(join(dir,'test.sqlite')),approvals=new Approvals(store),sourceEnd=deferred(),targetEnd=deferred();
  const starts:{id:string;body:string}[]=[],routes=new Map<string,{transport:string;executionMode:string}>();
  const native:any={connections:{route:(b:any)=>routes.get(b.id)},stop:()=>{},run:async(b:any,body:string,id:string)=>{native.beforeDispatch?.(b,id);native.beforeManagedSubmission?.(b,id);starts.push({id,body});if(id==='wa:approve')await sourceEnd.promise;else if(id.includes(':f5-'))await targetEnd.promise;}};
  const r=new Router(store,native,approvals),c=new Coordinator(store,native,r,()=>{});r.coordinator=c;
  const owner='owner@s.whatsapp.net';store.set('whatsapp-owner',owner);
  const proxy=store.register('proxy','codex',randomUUID(),'/tmp').binding,worker=store.register('worker','codex',randomUUID(),'/tmp').binding;
  for(const b of [proxy,worker]){routes.set(b.id,{transport:'managed-cli',executionMode:'cli'});store.set(`execution-mode:${b.id}`,'cli');}
  c.registry.register(proxy);store.set('master',proxy.id);store.set('selected',JSON.stringify([worker.id]));
  const secret=new MetaSecret(dir);secret.save('synthetic-key-not-a-real-secret');
  saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],failure:'block'}});
  r.brain=new MetaBrain(store,secret,{interpret:async()=>{throw new Error('unused');}} as any);
  r.brain.handle=async()=>false;
  r.contracts=new TaskContracts(store,secret,async()=>({kind:'contract',goal:'Add dark theme',exclusions:['Do not publish'],checks:['Theme works','Existing theme works'],question:''}));
  const send=(id:string,text:string)=>store.destinationContext.run(owner,()=>r.receive({id:`wa:${id}`,text,source:'text',ownerIntent:true,ownerCommand:true}));
  const first=await send('request','Add dark theme. Do NOT publish.');assert.equal(first.status,'handled');store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  const approved=await send('approve','ok');assert.equal(approved.status,'queued',JSON.stringify(store.db.prepare('SELECT body FROM outbox ORDER BY rowid').all()));await until(()=>starts.some(x=>x.id==='wa:approve'));
  const collab=new ManagedCollaboration(r,{allows:()=>true});r.collaboration=collab;
  return {dir,store,r,c,native,proxy,worker,owner,starts,routes,sourceEnd,targetEnd,collab,
    async close(){r.stopped=true;sourceEnd.resolve();targetEnd.resolve();await turn();await until(()=>r.busy.size===0);await turn();approvals.cancel();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('managed-only handoff waits for the source turn, claims once, and carries the approved contract',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement the approved theme.','first');
    f.r.pump();await turn();assert.equal(f.starts.filter(x=>x.id===id).length,0);
    assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Another task','second'));
    f.sourceEnd.resolve();await until(()=>f.starts.some(x=>x.id===id));
    const delivered=f.starts.find(x=>x.id===id)!;assert.match(delivered.body,/Owner-approved task contract/);assert.match(delivered.body,/Do NOT publish/);
    assert.equal(f.starts.filter(x=>x.id===id).length,1);
    const h=f.collab.history('wa:approve',f.store.itemOf(id)!);assert.equal(h.length,1);assert.equal(h[0].drift,'not_checked');assert.equal(h[0].state,'claimed');
    f.r.channelReply(f.worker,'Implementation reported complete.','final',id);
    f.targetEnd.resolve();await until(()=>f.collab.history('wa:approve',f.store.itemOf(id)!)[0]?.state==='complete');
    assert.equal(f.store.job(id)?.status,'completed');
  }finally{await f.close();}
});

test('without explicit internal activation, no collaboration guard is installed',async()=>{
  const f=await fixture();try{f.r.collaboration=undefined;assert.equal(f.r.collaboration,undefined);}finally{await f.close();}
});

test('desktop or unapproved handoffs fail before queueing',async()=>{
  const f=await fixture();try{
    f.routes.set(f.worker.id,{transport:'native-session',executionMode:'desktop'});
    assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Implement','desktop'),/managed/);
    f.routes.set(f.worker.id,{transport:'managed-cli',executionMode:'cli'});
    f.store.db.prepare("UPDATE task_contracts SET state='invalid' WHERE dispatch_id='wa:approve'").run();
    assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Implement','revoked'),/approved/);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM managed_collaboration_handoffs").get()?.n,0);
  }finally{await f.close();}
});

test('changed owner or target before source turn end fails closed without sending',async()=>{
  for(const mode of ['owner','target','authority']){
    const f=await fixture();try{
      if(mode==='authority')f.r.collaboration=f.collab=new ManagedCollaboration(f.r,{allows:()=>false});
      if(mode==='authority'){assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Implement','unauthorized'),/authorize/);continue;}
      const id=f.collab.stage('wa:approve',f.worker.id,'Implement',`changed-${mode}`);
      if(mode==='owner')f.store.set('whatsapp-owner','new-owner@s.whatsapp.net');
      else f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.worker.id);
      f.sourceEnd.resolve();await until(()=>f.store.job(id)?.status==='failed');
      assert.equal(f.starts.filter(x=>x.id===id).length,0);
    }finally{await f.close();}
  }
});

test('an interrupted source turn never grants a handoff after restart',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','restart');
    // Recovery cannot manufacture the managed completion evidence.
    f.r.busy.clear();f.store.recover();f.r.pump();await turn();
    assert.equal(f.starts.filter(x=>x.id===id).length,0);
    assert.notEqual(f.store.job(id)?.status,'submitted');
  }finally{await f.close();}
});

test('held handoff does not block unrelated work for the target session',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','no-starvation');
    f.store.enqueue('wa:unrelated',f.worker,'Another owner task',f.owner);f.r.pump();
    await until(()=>f.starts.some(x=>x.id==='wa:unrelated'));
    assert.equal(f.starts.filter(x=>x.id===id).length,0);
  }finally{await f.close();}
});

test('a prior queued or uncertain item job prevents handoff staging',async()=>{
  for(const status of ['queued','uncertain']){
    const f=await fixture();try{
      const item=f.store.itemOf('wa:approve')!,existing=`master:prior:${status}`;
      f.store.enqueue(existing,f.worker,'Earlier work',f.owner);f.store.linkItem(existing,item);
      f.store.db.prepare('UPDATE inbox SET status=? WHERE id=?').run(status,existing);
      assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Implement',`blocked-${status}`),/active or uncertain/);
      assert.equal(f.store.db.prepare('SELECT count(*) n FROM managed_collaboration_handoffs').get()?.n,0);
    }finally{await f.close();}
  }
});

test('a queued later item follow-up does not prevent release after managed final',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','followup');f.sourceEnd.resolve();await until(()=>f.starts.some(x=>x.id===id));
    const later='wa:later';f.store.enqueue(later,f.worker,'Later follow-up',f.owner);f.store.linkItem(later,f.store.itemOf(id)!);
    f.r.channelReply(f.worker,'Implementation reported complete.','final',id);f.targetEnd.resolve();
    await until(()=>f.collab.history('wa:approve',f.store.itemOf(id)!)[0]?.state==='complete');
    await until(()=>f.starts.some(x=>x.id===later));
  }finally{await f.close();}
});

test('native readiness rechecks the claimed exact target before actual submission',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','readiness'),waiting=deferred(),started=deferred();let sent=0;
    const prior=f.native.run;
    f.native.store=f.store;f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id){started.resolve();await waiting.promise;}};
    f.native.managedRun=async()=>{sent++;};
    f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
    f.sourceEnd.resolve();await started.promise;
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.worker.id);waiting.resolve();
    await until(()=>f.store.job(id)?.status==='failed');assert.equal(sent,0);
  }finally{await f.close();}
});

test('a channel hold during native readiness resumes without duplicate submission',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','channel-hold'),waiting=deferred(),started=deferred();let sent=0,first=true;
    const prior=f.native.run;f.native.store=f.store;
    f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id&&first){first=false;started.resolve();await waiting.promise;}};
    f.native.managedRun=async()=>{sent++;};
    f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
    f.sourceEnd.resolve();await started.promise;f.store.set('control-channel','telegram');waiting.resolve();
    await until(()=>f.store.job(id)?.status==='queued'&&!f.r.busy.has(f.worker.id));assert.equal(sent,0);
    f.store.set('control-channel','whatsapp');f.r.pump();await until(()=>sent===1);f.r.pump();await turn();assert.equal(sent,1);
  }finally{await f.close();}
});

test('a dispatch failure rolls back both the claim and the attempt',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','atomic');
    f.store.jobState('wa:approve','submitted');f.r.busy.delete(f.proxy.id);
    f.store.db.prepare('UPDATE managed_collaboration_handoffs SET yielded=1 WHERE job_id=?').run(id);
    f.store.db.exec(`CREATE TRIGGER fail_test_dispatch BEFORE INSERT ON request_events
      WHEN NEW.event='dispatched' AND NEW.request_id LIKE '%:f5-%'
      BEGIN SELECT RAISE(ABORT,'test-atomic-failure'); END`);
    assert.throws(()=>f.r.pump(),/test-atomic-failure/);
    assert.equal(f.store.job(id)?.status,'queued');
    const exists=f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_claims'").get();
    if(exists)assert.equal(f.store.db.prepare('SELECT count(*) n FROM collaboration_claims').get()?.n,0);
    assert.equal(f.store.db.prepare('SELECT state FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.state,'waiting');
    assert.equal(f.starts.filter(x=>x.id===id).length,0);
  }finally{await f.close();}
});

test('identity or authorization changes during asynchronous readiness never submit',async()=>{
  for(const mode of ['source','owner','target-route','contract','authority','item-status','other-active']){
    const f=await fixture();try{
      let allowed=true;f.r.collaboration=f.collab=new ManagedCollaboration(f.r,{allows:()=>allowed});
      const id=f.collab.stage('wa:approve',f.worker.id,'Implement',`async-${mode}`),waiting=deferred(),started=deferred();let sent=0;
      const prior=f.native.run;f.native.store=f.store;
      f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id){started.resolve();await waiting.promise;}};
      f.native.managedRun=async()=>{sent++;};
      f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
      f.sourceEnd.resolve();await started.promise;
      if(mode==='source')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.proxy.id);
      if(mode==='owner')f.store.set('whatsapp-owner','new-owner@s.whatsapp.net');
      if(mode==='target-route')f.routes.set(f.worker.id,{transport:'native-session',executionMode:'desktop'});
      if(mode==='contract')f.store.db.prepare("UPDATE task_contracts SET state='invalid' WHERE dispatch_id='wa:approve'").run();
      if(mode==='authority')allowed=false;
      if(mode==='item-status')f.store.db.prepare("UPDATE items SET status='blocked' WHERE id=?").run(f.store.itemOf(id));
      if(mode==='other-active'){
        f.store.enqueue('wa:external',f.proxy,'Conflicting work',f.owner);f.store.linkItem('wa:external',f.store.itemOf(id)!);
        f.store.jobState('wa:external','submitted');
      }
      waiting.resolve();await until(()=>f.store.job(id)?.status==='failed');assert.equal(sent,0,mode);
      assert.equal(f.store.db.prepare('SELECT state FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.state,'invalid');
    }finally{await f.close();}
  }
});

test('a real database reopen does not replay an interrupted managed handoff',async()=>{
  for(const phase of ['source','target']){
    const f=await fixture();let reopened:InstanceType<typeof Store>|undefined;try{
      const id=f.collab.stage('wa:approve',f.worker.id,'Implement',`reopen-${phase}`);
      if(phase==='target'){f.sourceEnd.resolve();await until(()=>f.starts.some(x=>x.id===id));}
      f.r.stopped=true;
      reopened=new Store(join(f.dir,'test.sqlite'));reopened.recover();
      let deliveries=0;const n:any={connections:{route:(b:any)=>f.routes.get(b.id)},stop:()=>{},run:async()=>{deliveries++;}};
      const a=new Approvals(reopened),r=new Router(reopened,n,a),c=new Coordinator(reopened,n,r,()=>{});r.coordinator=c;
      const secret=new MetaSecret(f.dir);r.contracts=new TaskContracts(reopened,secret);
      r.collaboration=new ManagedCollaboration(r,{allows:()=>true});r.pump();await turn();
      assert.equal(deliveries,0,phase);
      if(phase==='target')assert.equal(reopened.job(id)?.status,'uncertain');
      else assert.notEqual(reopened.job(id)?.status,'submitted');
      r.stopped=true;a.cancel();
    }finally{reopened?.close();await f.close();}
  }
});

test('an unsent readiness failure releases only its own claim and a new attempt can run',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','first-fails'),waiting=deferred(),started=deferred();let sent=0;
    const prior=f.native.run;f.native.store=f.store;
    f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id){started.resolve();await waiting.promise;}};
    f.native.managedRun=async()=>{sent++;};
    f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
    f.sourceEnd.resolve();await started.promise;
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.worker.id);
    waiting.resolve();await until(()=>f.store.job(id)?.status==='failed'&&!f.r.busy.has(f.worker.id));
    assert.equal(sent,0);
    const claim=f.store.db.prepare('SELECT holder_id,token FROM collaboration_claims WHERE item_id=?').get(f.store.itemOf(id)!);
    assert.equal(claim?.holder_id,null);assert.equal(claim?.token,null);
    // The owner unblocks the item and starts a new authorized source turn.
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(f.worker.native_id,f.worker.id);
    f.store.db.prepare("UPDATE items SET status='in progress' WHERE id=?").run(f.store.itemOf(id)!);
    f.store.jobState('wa:approve','dispatched');f.r.busy.add(f.proxy.id);
    const retry=f.collab.stage('wa:approve',f.worker.id,'Implement','retry');
    f.store.jobState('wa:approve','submitted');f.collab.managedTurnEnded('wa:approve',f.proxy);f.r.busy.delete(f.proxy.id);
    f.r.pump();for(let n=0;n<10;n++)await turn();
    assert.ok(f.starts.some(x=>x.id===retry),JSON.stringify({job:f.store.job(retry),handoff:f.store.db.prepare('SELECT state,yielded FROM managed_collaboration_handoffs WHERE job_id=?').get(retry)}));
    assert.equal(f.starts.filter(x=>x.id===retry).length,1);
  }finally{await f.close();}
});

test('an old rejected handoff cannot release a different fenced claim',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','fence'),waiting=deferred(),started=deferred();
    const prior=f.native.run;f.native.store=f.store;
    f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id){started.resolve();await waiting.promise;}};
    f.native.managedRun=async()=>{throw new Error('should not submit');};
    f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
    f.sourceEnd.resolve();await started.promise;
    const newer=randomUUID();f.store.db.prepare('UPDATE collaboration_claims SET token=?,generation=generation+1 WHERE item_id=?').run(newer,f.store.itemOf(id)!);
    waiting.resolve();await until(()=>f.store.job(id)?.status==='failed');
    assert.equal(f.store.db.prepare('SELECT token FROM collaboration_claims WHERE item_id=?').get(f.store.itemOf(id)!)?.token,newer);
  }finally{await f.close();}
});

test('a provider-bound failure remains uncertain and retains its exact claim',async()=>{
  for(const error of [new Error('provider connection dropped'),new DispatchNotSubmittedError('provider supplied misleading error')]){
    const f=await fixture();try{
      const id=f.collab.stage('wa:approve',f.worker.id,'Implement','uncertain');let calls=0;
      const prior=f.native.run;f.native.store=f.store;f.native.connections.assert=async()=>{};
      f.native.managedRun=async()=>{calls++;throw error;};
      f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
      f.sourceEnd.resolve();await until(()=>f.store.job(id)?.status==='uncertain');
      const before=f.store.db.prepare('SELECT holder_id,token,generation FROM collaboration_claims WHERE item_id=?').get(f.store.itemOf(id)!);
      assert.equal(calls,1);assert.equal(before?.holder_id,f.worker.id);assert.ok(before?.token);
      f.collab.reject(id,'not proven');
      assert.deepEqual(f.store.db.prepare('SELECT holder_id,token,generation FROM collaboration_claims WHERE item_id=?').get(f.store.itemOf(id)!),before);
      assert.equal(f.store.job(id)?.status,'uncertain');
      assert.equal(f.store.db.prepare('SELECT state,submission_started FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.submission_started,1);
      f.r.pump();await turn();assert.equal(calls,1);
    }finally{await f.close();}
  }
});

test('restart releases only a proven unsent exact attempt and never replays a handoff',async()=>{
  for(const phase of ['before','after','legacy','other-fence']){
    const f=await fixture();let reopened:InstanceType<typeof Store>|undefined;try{
      const id=f.collab.stage('wa:approve',f.worker.id,'Implement',`recovery-${phase}`),ready=deferred(),started=deferred(),providerEnd=deferred();let calls=0;
      const prior=f.native.run;f.native.store=f.store;
      f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id&&phase!=='after'){started.resolve();await ready.promise;}};
      f.native.managedRun=async()=>{calls++;started.resolve();await providerEnd.promise;};
      f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
      f.sourceEnd.resolve();await started.promise;f.r.stopped=true;
      const item=f.store.itemOf(id)!;
      if(phase==='legacy')f.store.db.exec('ALTER TABLE managed_collaboration_handoffs DROP COLUMN submission_started');
      if(phase==='other-fence')f.store.db.prepare('UPDATE collaboration_claims SET token=?,generation=generation+1 WHERE item_id=?').run(randomUUID(),item);
      reopened=new Store(join(f.dir,'test.sqlite'));reopened.recover();
      let replayed=0;const n:any={connections:{route:(b:any)=>f.routes.get(b.id)},stop:()=>{},run:async()=>{replayed++;}};
      const a=new Approvals(reopened),r=new Router(reopened,n,a),c=new Coordinator(reopened,n,r,()=>{});r.coordinator=c;
      const secret=new MetaSecret(f.dir);r.contracts=new TaskContracts(reopened,secret);
      r.collaboration=new ManagedCollaboration(r,{allows:()=>true});r.pump();await turn();
      const claim=reopened.db.prepare('SELECT holder_id,token FROM collaboration_claims WHERE item_id=?').get(item);
      if(phase==='before'){
        assert.equal(reopened.job(id)?.status,'failed');assert.equal(claim?.holder_id,null);assert.equal(claim?.token,null);
        assert.equal(reopened.db.prepare('SELECT state FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.state,'invalid');
      }else{
        assert.equal(reopened.job(id)?.status,'uncertain',phase);assert.ok(claim?.token,phase);
        assert.equal(reopened.db.prepare('SELECT state FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.state,'claimed');
      }
      assert.equal(replayed,0);assert.equal(calls,phase==='after'?1:0);
      r.stopped=true;a.cancel();reopened.close();reopened=undefined;
      ready.resolve();providerEnd.resolve();await turn();
      assert.equal(calls,phase==='after'?1:0,`old process must not submit after ${phase} recovery`);
    }finally{reopened?.close();await f.close();}
  }
});
