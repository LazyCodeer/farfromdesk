import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {MetaBrain} from '../src/meta-brain.js';
import {DEFAULT_BRAIN,MetaSecret,saveBrainConfig} from '../src/meta-brain-config.js';
import {TaskContracts,contractDeliveryState} from '../src/task-contracts.js';
import {Masters} from '../src/masters.js';
import {roleConfig} from '../src/roles.js';

async function fixture(provider:'codex'|'claude'='codex'){
  const dir=mkdtempSync(join(tmpdir(),'ffd-proof-report-')),store=new Store(':memory:'),approvals=new Approvals(store);
  const router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);router.pump=()=>{};
  store.set('whatsapp-owner','owner@s.whatsapp.net');const binding=store.register(`${provider}-one`,provider,randomUUID(),dir).binding;store.set('active',binding.id);
  const secret=new MetaSecret(dir);secret.save('synthetic-key-not-a-real-secret');
  router.brain=new MetaBrain(store,secret,{interpret:async()=>{throw new Error('unused');}} as any);
  saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:[provider],failure:'block'}});
  router.contracts=new TaskContracts(store,secret,async()=>({kind:'contract',goal:'Add a dark mode',exclusions:[],checks:['Dark mode can be enabled','Existing mode still works'],question:''}));
  await router.receive({id:'wa:request',text:'Add a dark mode',ownerIntent:true,ownerCommand:true});
  store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  await router.receive({id:'wa:approve',text:'ok',ownerIntent:true,ownerCommand:true});
  return {store,router,binding,id:'wa:approve',reports:()=>store.db.prepare("SELECT * FROM outbox WHERE source LIKE 'proof-report:%' ORDER BY rowid").all() as any[],
    close(){approvals.cancel();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('final completion queues a scoped report with explicit unverified claims and per-check confirmation',async()=>{
  const f=await fixture();try{
    f.store.jobState(f.id,'dispatched');
    const result=f.router.channelReply(f.binding,'Tests passed. PR https://github.com/example/project/pull/12','final',f.id,undefined,{outcome:'done'});
    assert.equal(result.accepted,true);const reports=f.reports();assert.equal(reports.length,1);
    assert.match(reports[0].body,/Session reported \(unverified\): Tests passed/);
    assert.match(reports[0].body,/PR mentioned \(unverified\): https:\/\/github\.com\/example\/project\/pull\/12/);
    assert.match(reports[0].body,/Checks needing confirmation:\n1\. Dark mode can be enabled\n2\. Existing mode still works/);
    assert.match(reports[0].body,/No test, PR or screenshot has been independently verified/);
    assert.equal(reports[0].destination,'owner@s.whatsapp.net');assert.equal(reports[0].request_id,f.id);
    assert.equal(contractDeliveryState(f.router,reports[0].id),'ready');
    assert.equal(f.router.channelReply(f.binding,'Tests passed. PR https://github.com/example/project/pull/12','final',f.id,undefined,{outcome:'done'}).newlyQueued,false);
    assert.equal(f.reports().length,1);
    assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='proof_corrections'").get(),undefined);
  }finally{f.close();}
});

test('a queued report is withheld if the owner or approved contract changes',async()=>{
  for(const change of ['owner','contract']){const f=await fixture();try{
    f.store.jobState(f.id,'dispatched');f.router.channelReply(f.binding,'Finished','final',f.id,undefined,{outcome:'done'});
    const report=f.reports()[0];assert.ok(report);
    if(change==='owner')f.store.set('whatsapp-owner','other@s.whatsapp.net');
    else f.store.db.prepare("UPDATE task_contracts SET draft='{}' WHERE dispatch_id=?").run(f.id);
    assert.equal(contractDeliveryState(f.router,report.id),'invalid');
  }finally{f.close();}}
});

test('a channel switch holds the report on its original channel',async()=>{
  const f=await fixture();try{
    f.store.jobState(f.id,'dispatched');f.router.channelReply(f.binding,'Finished','final',f.id,undefined,{outcome:'done'});
    const report=f.reports()[0];assert.ok(report);
    f.store.set('telegram-owner','tg:123');f.store.set('control-channel','telegram');
    assert.equal(contractDeliveryState(f.router,report.id),'hold');
    f.store.set('control-channel','whatsapp');assert.equal(contractDeliveryState(f.router,report.id),'ready');
  }finally{f.close();}
});

test('blocked, never-dispatched and noncontract tasks do not create a proof report',async()=>{
  for(const mode of ['blocked','no-attempt','noncontract']){const f=await fixture();try{
    if(mode==='noncontract'){
      f.store.enqueue('wa:other',f.binding,'Another task','owner@s.whatsapp.net');f.store.jobState('wa:other','dispatched');
      f.router.channelReply(f.binding,'Finished','final','wa:other',undefined,{outcome:'done'});
    }else{
      if(mode==='blocked')f.store.jobState(f.id,'dispatched');
      f.router.channelReply(f.binding,'Finished','final',f.id,undefined,{outcome:mode==='blocked'?'blocked':'done'});
    }
    assert.equal(f.reports().length,0,mode);
  }finally{f.close();}}
});

test('a damaged contract suppresses only the report, not the session final',async()=>{
  const f=await fixture();try{
    f.store.jobState(f.id,'dispatched');f.store.db.prepare("UPDATE task_contracts SET draft='{}' WHERE dispatch_id=?").run(f.id);
    assert.equal(f.router.channelReply(f.binding,'Finished','final',f.id,undefined,{outcome:'done'}).accepted,true);
    assert.equal(f.store.job(f.id)?.status,'completed');assert.equal(f.reports().length,0);
  }finally{f.close();}
});

test('ambiguous PR claims are not presented as a single selected PR',async()=>{
  const f=await fixture();try{
    f.store.jobState(f.id,'dispatched');
    f.router.channelReply(f.binding,'PRs https://github.com/example/one/pull/1 and https://github.com/example/two/pull/2','final',f.id,undefined,{outcome:'done'});
    assert.doesNotMatch(f.reports()[0].body,/PR mentioned \(unverified\):/);
    assert.match(f.reports()[0].body,/Session reported \(unverified\)/);
  }finally{f.close();}
});

test('normal final without an outcome requests confirmation without asserting success',async()=>{
  const f=await fixture();try{
    f.store.jobState(f.id,'dispatched');f.router.channelReply(f.binding,'I could not run the tests.','final',f.id);
    assert.equal(f.store.job(f.id)?.outcome,null);assert.equal(f.reports().length,1);
    assert.match(f.reports()[0].body,/Session reported \(unverified\): I could not run the tests/);
    assert.match(f.reports()[0].body,/Checks needing confirmation/);
    assert.doesNotMatch(f.reports()[0].body,/verified pass|check passed/i);
  }finally{f.close();}
});

test('a managed Codex final reports the approved checks without asserting verification',async()=>{
  const f=await fixture();const masters=new Masters(f.store,f.router);
  try{
    const runtime=new EventEmitter() as EventEmitter&{alive:boolean;request:(method:string)=>Promise<any>;close:()=>void};
    runtime.alive=true;runtime.close=()=>{};
    runtime.request=async(method)=>{assert.equal(method,'turn/start');queueMicrotask(()=>{
      runtime.emit('notification','item/completed',{threadId:f.binding.native_id,turnId:'turn-managed',item:{type:'agentMessage',phase:'final_answer',text:'Implemented; tests reported passing.'}});
      runtime.emit('notification','turn/completed',{threadId:f.binding.native_id,turn:{id:'turn-managed',status:'completed'}});
    });return {turn:{id:'turn-managed'}};};
    masters.connections.assert=async()=>{};
    masters.runtimes.set(f.binding.id,runtime as any);
    masters.runtimeRoles.set(f.binding.id,roleConfig(f.store,f.binding).version);
    f.store.jobState(f.id,'dispatched');
    await masters.run(f.binding,f.store.job(f.id)!.body,f.id);
    assert.equal(f.store.job(f.id)?.status,'completed');assert.equal(f.reports().length,1);
    assert.match(f.reports()[0].body,/Session reported \(unverified\): Implemented; tests reported passing/);
    assert.match(f.reports()[0].body,/No test, PR or screenshot has been independently verified/);
  }finally{masters.close();f.close();}
});

test('managed Codex accepts only the exact started turn, including early events',async()=>{
  for(const scenario of ['early','mismatched','failed-start','malformed-start'] as const){
    const f=await fixture(),masters=new Masters(f.store,f.router);
    try{
      let resolveStart!:(value:unknown)=>void,rejectStart!:(error:Error)=>void,started!:()=>void;
      const entered=new Promise<void>(r=>started=r),start=new Promise<unknown>((r,j)=>{resolveStart=r;rejectStart=j;});
      const runtime=new EventEmitter() as EventEmitter&{alive:boolean;request:(method:string)=>Promise<unknown>;close:()=>void};
      runtime.alive=true;runtime.close=()=>{};runtime.request=async(method)=>{assert.equal(method,'turn/start');started();return await start;};
      masters.connections.assert=async()=>{};masters.runtimes.set(f.binding.id,runtime as any);masters.runtimeRoles.set(f.binding.id,roleConfig(f.store,f.binding).version);
      f.store.jobState(f.id,'dispatched');let finished=false;
      const task=masters.run(f.binding,f.store.job(f.id)!.body,f.id).finally(()=>{finished=true;});await entered;
      const item=(id:unknown,text:string)=>runtime.emit('notification','item/completed',{threadId:f.binding.native_id,turnId:id,item:{type:'agentMessage',phase:'final_answer',text}});
      const done=(id:unknown)=>runtime.emit('notification','turn/completed',{threadId:f.binding.native_id,turn:{id,status:'completed'}});
      item('other','Unrelated turn');done('other');done(undefined);
      if(scenario==='early'){item('exact','Approved result.');done('exact');resolveStart({turn:{id:'exact'}});await task;}
      else if(scenario==='failed-start'){rejectStart(new Error('Synthetic start failure'));await assert.rejects(task,/Synthetic start failure/);}
      else if(scenario==='malformed-start'){resolveStart({turn:{id:''}});await assert.rejects(task,/identity could not be confirmed/);}
      else{
        resolveStart({turn:{id:'exact'}});await new Promise<void>(r=>setImmediate(r));
        item(undefined,'Malformed event');done(undefined);done('other');await new Promise<void>(r=>setImmediate(r));
        assert.equal(finished,false);assert.equal(f.store.job(f.id)?.status,'dispatched');assert.equal(f.reports().length,0);
        item('exact','Approved result.');done('exact');done('exact');await task;
      }
      if(scenario==='early'||scenario==='mismatched'){
        assert.equal(f.store.job(f.id)?.status,'completed');assert.equal(f.reports().length,1);
        assert.match(f.reports()[0].body,/Approved result/);assert.doesNotMatch(f.reports()[0].body,/Unrelated turn|Malformed event/);
      }else{assert.equal(f.store.job(f.id)?.status,'dispatched');assert.equal(f.reports().length,0);}
    }finally{masters.close();f.close();}
  }
});

test('a managed Claude final reports the approved checks without asserting verification',async()=>{
  const f=await fixture('claude');const masters=new Masters(f.store,f.router);
  try{
    const runtime={alive:true,lastUsage:undefined,run:async()=> 'Implemented; tests reported passing.',close:()=>{}};
    masters.connections.assert=async()=>{};
    masters.claudeRuntimes.set(f.binding.id,runtime as any);
    masters.runtimeRoles.set(f.binding.id,roleConfig(f.store,f.binding).version);
    f.store.set(`managed-claude:${f.binding.id}`,'true');
    f.store.jobState(f.id,'dispatched');
    await masters.run(f.binding,f.store.job(f.id)!.body,f.id);
    assert.equal(f.store.job(f.id)?.status,'completed');assert.equal(f.reports().length,1);
    assert.match(f.reports()[0].body,/Session reported \(unverified\): Implemented; tests reported passing/);
    assert.match(f.reports()[0].body,/No test, PR or screenshot has been independently verified/);
  }finally{masters.close();f.close();}
});

test('a hook-first final still produces one report, without resending the agent final',async()=>{
  const f=await fixture();try{
    f.store.jobState(f.id,'dispatched');
    f.store.output(f.binding,'Tests reported passing','synthetic-hook','owner@s.whatsapp.net',{requestId:f.id,kind:'hook',origin:'hook',turnId:'turn-1'});
    const result=f.router.channelReply(f.binding,'Unsent agent details','final',f.id,undefined,{turnId:'turn-1',outcome:'done'});
    assert.equal(result.newlyQueued,false);assert.equal(f.store.job(f.id)?.outcome,'done');assert.equal(f.reports().length,1);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE source LIKE 'reply:final:%'").get()?.n,0);
    assert.doesNotMatch(f.reports()[0].body,/Unsent agent details/);
    f.router.channelReply(f.binding,'Unsent agent details','final',f.id,undefined,{turnId:'turn-1',outcome:'done'});
    assert.equal(f.reports().length,1);assert.equal(contractDeliveryState(f.router,f.reports()[0].id),'ready');
  }finally{f.close();}
});

test('coordinator resolution queues one report without inventing a session reply',async()=>{
  const f=await fixture();try{
    f.store.jobState(f.id,'dispatched');
    f.router.coordinator={requestMaster:()=>f.binding,registry:{entry:()=>undefined},scope:{getStore:()=>undefined}} as any;
    f.router.resolveOwner(f.id,'done');f.router.resolveOwner(f.id,'done');
    assert.equal(f.reports().length,1);assert.match(f.reports()[0].body,/completion outcome was reported/);
    assert.doesNotMatch(f.reports()[0].body,/Session reported \(unverified\):/);
    assert.equal(contractDeliveryState(f.router,f.reports()[0].id),'ready');
    f.store.set('whatsapp-owner','other@s.whatsapp.net');assert.equal(contractDeliveryState(f.router,f.reports()[0].id),'invalid');
  }finally{f.close();}
});

test('only a whole PR URL is selected, never a numeric prefix of a longer path',async()=>{
  for(const [token,accepted] of [
    ['https://github.com/example/project/pull/12garbage',false],
    ['https://github.com/example/project/pull/12/path',false],
    ['https://github.com/example/project/pull/12?x=1',false],
    ['(https://github.com/example/project/pull/12).',true],
  ] as const){const f=await fixture();try{
    f.store.jobState(f.id,'dispatched');f.router.channelReply(f.binding,`PR: ${token}`,'final',f.id,undefined,{outcome:'done'});
    assert.equal(/PR mentioned \(unverified\):/.test(f.reports()[0].body),accepted,token);
  }finally{f.close();}}
});
