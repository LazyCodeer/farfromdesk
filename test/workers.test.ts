import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Coordinator } from '../src/coordinator.js';
import { Approvals } from '../src/approvals.js';
import { Connections, connectionProfile } from '../src/connections.js';
import { Workers } from '../src/workers.js';
import { ClaudeSession } from '../src/claude-session.js';

const uuid='44444444-4444-4444-a444-444444444444';
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'tether-workers-')),root=join(dir,'Projects');
  const store=new Store(':memory:'),approvals=new Approvals(store);
  const prefer=(provider:string,mode:string,desktopParentId?:string)=>store.set(`platform-preference:${provider}`,JSON.stringify({executionMode:mode,desktopParentId,route:{accountKey:'test-account',profileId:connectionProfile(provider as any,mode as any)}}));
  prefer('codex','cli');prefer('claude','cli');
  const native={run:async()=>{},stop:()=>{},validate:async()=>{},catalog:async()=>({sessions:[],cursor:null})};
  const router=new Router(store,native as any,approvals),c=new Coordinator(store,native as any,router,()=>{});router.coordinator=c;
  const master=store.register('test-master','codex',uuid,dir).binding;store.set('master',master.id);store.set('whatsapp-owner','123@s.whatsapp.net');
  store.enqueue('wa:create',master,'Create a test project');
  let creations=0,stops=0;
  const masters={connections:new Connections(store,async()=>({state:"verified",label:"Test account",accountKey:"test-account"})),provisionWorker:async()=>{creations++;},recoverWorker:async()=>{},stopWorker:()=>{stops++;}};
  const workers=new Workers(store,router,masters as any,root,()=>{});router.hasPendingCreation=id=>workers.pending(id);
  const request={requestId:'wa:create',provider:'codex' as const,name:'Website',text:'Make a test website',eventId:'first'};
  return {dir,root,store,approvals,router,c,master,masters,workers,request,prefer,counts:()=>({creations,stops}),close:()=>{router.stopped=true;approvals.cancel();store.close();rmSync(dir,{recursive:true,force:true});}};
}
async function settled(f:ReturnType<typeof fixture>){await Promise.all([...f.workers.tasks.values()]);await new Promise(r=>setTimeout(r,5));}
function approve(f:ReturnType<typeof fixture>,answer='approve'){const code=[...f.approvals.pending.keys()][0];assert.ok(code);f.approvals.answer(code,answer,'approval');}

test('phone workspace approval precedes all folder/session creation and later projects reuse consent',async()=>{
  const f=fixture();
  try {
    const op=await f.workers.start(f.request);assert.equal(op.status,'awaiting_approval');assert.equal(existsSync(f.root),false);assert.equal(f.counts().creations,0);
    assert.throws(()=>f.router.channelReply(f.master,'Done','final','wa:create'),/pending/);
    approve(f);await settled(f);assert.equal(f.workers.get(op.id)?.status,'ready');assert.equal(f.c.selected().length,1);
    const b=f.c.selected()[0];assert.ok(b.cwd.startsWith(realpathSync(f.root)));assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,1);f.workers.ensureRun(b);
    await f.workers.start({...f.request,eventId:'second',provider:'claude',name:'Another project'});await settled(f);
    assert.equal(f.approvals.pending.size,0);assert.equal(f.counts().creations,2);assert.equal(f.c.selected().length,2);
  }finally{f.close();}
});

test('denial creates nothing; approval replay, unknown owner requests and event substitution are rejected',async()=>{
  const f=fixture();
  try {
    await assert.rejects(f.workers.start({...f.request,requestId:'report:fake'}),/owner request/);
    await assert.rejects(f.workers.start({...f.request,eventId:undefined as any}));
    const op=await f.workers.start(f.request),code=[...f.approvals.pending.keys()][0];approve(f,'deny');await settled(f);
    assert.equal(f.workers.get(op.id)?.status,'denied');assert.equal(existsSync(f.root),false);assert.equal(f.counts().creations,0);
    assert.throws(()=>f.approvals.answer(code,'approve','approval'));
    await assert.rejects(f.workers.start({...f.request,text:'Different task'}),/different task/);
    await f.workers.start(f.request);assert.equal(f.approvals.pending.size,0);
  }finally{f.close();}
});

test('master-supplied paths and binding IDs cannot enter creation state',async()=>{
  const f=fixture();
  try {
    const op=await f.workers.start({...f.request,cwd:'/private',bindingId:f.master.id} as any);
    assert.equal(f.workers.get(op.id)?.bindingId,undefined);assert.equal(f.workers.get(op.id)?.cwd,undefined);
    approve(f,'deny');await settled(f);assert.equal(f.counts().stops,0);assert.equal(f.store.binding(f.master.id)?.enabled,1);
  }finally{f.close();}
});

test('simultaneous project requests share one workspace approval',async()=>{
  const f=fixture();
  try {
    await f.workers.start(f.request);await f.workers.start({...f.request,eventId:'parallel',provider:'claude'});
    assert.equal(f.approvals.pending.size,1);approve(f);await settled(f);assert.equal(f.counts().creations,2);
  }finally{f.close();}
});

test('duplicates do not create twice and uncertain native creation never retries blindly',async()=>{
  const f=fixture();
  try {
    let attempts=0;f.masters.provisionWorker=async()=>{attempts++;throw new Error('Native test failure');};
    const op=await f.workers.start(f.request);await f.workers.start(f.request);assert.equal(f.approvals.pending.size,1);
    approve(f);await settled(f);assert.equal(f.workers.get(op.id)?.status,'uncertain');assert.equal(attempts,1);
    await f.workers.start(f.request);assert.equal(attempts,1);assert.equal(f.c.selected().length,0);
  }finally{f.close();}
});

test('symlink workspace and stale master authorization cannot acquire workspace access',async()=>{
  const f=fixture();
  try {
    mkdirSync(join(f.dir,'outside'));symlinkSync(join(f.dir,'outside'),f.root);
    const op=await f.workers.start(f.request);approve(f);await settled(f);assert.equal(f.workers.get(op.id)?.status,'blocked');assert.equal(f.counts().creations,0);
    assert.equal(f.store.get('worker-workspace'),undefined);
  }finally{f.close();}
  const g=fixture();
  try {
    await g.workers.start(g.request);g.store.jobState('wa:create','replaced');approve(g);await settled(g);
    assert.equal(existsSync(g.root),false);assert.equal(g.counts().creations,0);
  }finally{g.close();}
});

test('workspace revocation pauses managed workers and prevents a resumed binding from running',async()=>{
  const f=fixture();
  try {
    await f.workers.start(f.request);approve(f);await settled(f);const b=f.c.selected()[0];
    f.workers.revoke();assert.equal(f.store.binding(b.id)?.enabled,0);assert.equal(f.counts().stops,1);
    f.store.enable(b.id,true);assert.throws(()=>f.workers.ensureRun(b),/not approved/);
    assert.equal(existsSync(b.cwd),true);
  }finally{f.close();}
});

test('restart preserves exact uncertain creation and requires a fresh nonce for interrupted approval',async()=>{
  const f=fixture();
  try {
    f.workers.save({...f.request,id:'one',masterId:f.master.id,status:'creating',bindingId:'known'});
    f.workers.save({...f.request,id:'two',masterId:f.master.id,status:'awaiting_approval'});
    const reopened=new Workers(f.store,f.router,f.masters as any,f.root,()=>{});
    assert.equal(reopened.get('one')?.status,'uncertain');assert.equal(reopened.get('one')?.bindingId,'known');assert.equal(reopened.get('two')?.status,'needs_approval');assert.equal(f.counts().creations,0);
  }finally{f.close();}
});

test('phone recovery resumes the saved binding and holds any existing task against replay',async()=>{
  const f=fixture();
  try {
    f.masters.provisionWorker=async()=>{throw new Error('Authentication expired');};
    const op=await f.workers.start(f.request);approve(f);await settled(f);const bindingId=f.workers.get(op.id)!.bindingId;
    f.store.enqueue('wa:recover',f.master,'I fixed login, recover the same session');
    await f.workers.recover('wa:recover',op.id);await settled(f);
    assert.equal(f.workers.get(op.id)!.bindingId,bindingId);assert.equal(f.c.selected().length,1);
    const jobs=f.store.jobs().filter(j=>j.id.startsWith('master:'));assert.equal(jobs.length,1);
    f.workers.save({...f.workers.get(op.id)!,status:'uncertain'});f.store.enqueue('wa:recover-again',f.master,'Check recovery');
    const result=await f.workers.recover('wa:recover-again',op.id);assert.match(result!.note??'',/not resubmitted/);
    assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,1);
  }finally{f.close();}
});

test('revoking consent during native startup never activates the new worker',async()=>{
  const f=fixture();
  try {
    let finish!:()=>void;f.masters.provisionWorker=()=>new Promise<void>(r=>{finish=r;});
    const op=await f.workers.start(f.request);approve(f);
    for(let i=0;i<30&&!finish;i++)await new Promise(r=>setTimeout(r,5));assert.ok(finish);
    f.workers.revoke();finish();await settled(f);
    assert.equal(f.workers.get(op.id)?.status,'uncertain');assert.equal(f.c.selected().length,0);assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,0);
  }finally{f.close();}
});

test('Claude SDK protocol transports allow/deny decisions, exact identity and native edit mode',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tether-claude-protocol-')),fake=join(dir,'claude');
  writeFileSync(fake,`#!${process.execPath}
const fs=require('node:fs');fs.writeFileSync('args.json',JSON.stringify(process.argv));
const args=process.argv;const id=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
if(m.type==='user') {if(m.message.content==='wrong')send({type:'result',session_id:'wrong',subtype:'success',result:'BAD'});else send({type:'control_request',request_id:'tool-1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'test only'}}});}
if(m.type==='control_response')send({type:'result',session_id:id,subtype:'success',is_error:false,result:m.response.response.behavior});
});`,{mode:0o700});
  let allow=false;const calls:unknown[]=[];
  const runtime=new ClaudeSession(fake,dir,uuid,false,async(tool,input)=>{calls.push({tool,input});return allow;});
  try {
    await runtime.initialize();assert.equal(await runtime.run('permission'),'deny');allow=true;assert.equal(await runtime.run('permission'),'allow');assert.equal(calls.length,2);
    const args=JSON.parse(readFileSync(join(dir,'args.json'),'utf8'));assert.ok(args.includes('acceptEdits'));assert.ok(args.includes('host'));assert.ok(!args.includes('bypassPermissions'));
    await assert.rejects(runtime.run('wrong'),/different session/);
  }finally{runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('worker creation freezes execution mode and configured Desktop launcher without CLI fallback',async()=>{
  const f=fixture();try {
    f.store.set('claude-execution-mode','desktop');f.prefer('claude','desktop',uuid);f.store.set('claude-desktop-parent',uuid);
    let parents=0;(f.masters as any).desktop={parent:async(id:string)=>{assert.equal(id,uuid);parents++;return {id:uuid};}};
    const request={...f.request,provider:'claude' as const};
    const op=await f.workers.start(request);await new Promise(r=>setTimeout(r,0));approve(f);await settled(f);
    assert.equal(f.workers.get(op.id)?.executionMode,'desktop');assert.equal(parents,1);
    const b=f.c.selected()[0];assert.equal(f.store.get(`execution-mode:${b.id}`),'desktop');assert.equal(f.store.get(`desktop-parent:${b.id}`),uuid);
    f.prefer('claude','cli');await f.workers.start(request);assert.equal(parents,1);
    await assert.rejects(f.workers.start({...request,executionMode:'cli'}),/different task/);
    assert.equal(f.store.get(`execution-mode:${b.id}`),'desktop');
  }finally{f.close();}
});

test('new Codex workers honor a saved Desktop choice without invoking a Claude launcher',async()=>{
  const f=fixture();try {
    f.prefer('codex','desktop');
    const op=await f.workers.start(f.request);assert.equal(op.executionMode,'desktop');assert.equal(op.desktopParentId,undefined);
    approve(f);await settled(f);const b=f.c.selected()[0];
    assert.equal(f.workers.get(op.id)?.status,'ready');assert.equal(f.masters.connections.route(b)?.transport,'native-session');
    assert.equal(f.store.get(`execution-mode:${b.id}`),'desktop');
    await assert.rejects(f.workers.start({...f.request,executionMode:'cli'}),/different task/);
  }finally{f.close();}
});
test('new platform with no saved runtime requires a choice instead of defaulting to CLI',async()=>{
  const f=fixture();try {
    f.store.db.prepare('DELETE FROM settings WHERE key=?').run('platform-preference:claude');
    await assert.rejects(f.workers.start({...f.request,provider:'claude'}),/Choose claude Desktop or CLI/);
    assert.equal(f.workers.operations().length,0);assert.equal(f.approvals.pending.size,0);assert.equal(f.counts().creations,0);
  }finally{f.close();}
});


test('new workers reject changed preferred CLI accounts before approval or creation',async()=>{
  const f=fixture();try {
    f.masters.connections=new Connections(f.store,async()=>({state:'verified',label:'Different CLI account',accountKey:'changed-account'}));
    await assert.rejects(f.workers.start(f.request),/preferred CLI account or provider changed/);
    assert.equal(f.workers.operations().length,0);assert.equal(f.approvals.pending.size,0);assert.equal(f.counts().creations,0);
  }finally{f.close();}
});


test('missing Desktop launcher is blocked before approval and the same operation recovers once',async()=>{
 const f=fixture();try {
  f.prefer('claude','desktop');let available=false,launches=0;
  (f.masters as any).desktop={parent:async()=>{launches++;if(!available)throw new Error('No owner-connected Claude Desktop launcher is available.');return {id:uuid,accountScope:'owner'};}};
  const request={...f.request,provider:'claude' as const};
  const op=await f.workers.start(request);await settled(f);
  assert.equal(f.workers.get(op.id)?.status,'blocked');assert.equal(f.workers.view(op.id)[0].execution,'not_started');
  assert.equal(f.workers.get(op.id)?.bindingId,undefined);assert.equal(f.approvals.pending.size,0);assert.equal(existsSync(f.root),false);
  f.store.jobState(request.requestId,'completed',null,'blocked');f.store.enqueue('wa:recover',f.master,'Recover original creation');available=true;
  const [a,b]=await Promise.all([f.workers.recover('wa:recover',op.id),f.workers.recover('wa:recover',op.id)]);
  assert.equal(a.id,op.id);assert.equal(b.id,op.id);
  for(let i=0;i<30&&!f.approvals.pending.size;i++)await new Promise(r=>setTimeout(r,5));
  approve(f);await settled(f);
  const result=f.workers.get(op.id)!;assert.equal(result.status,'ready');assert.equal(result.originRequestId,request.requestId);assert.equal(result.eventId,request.eventId);
  assert.equal(f.counts().creations,1);assert.equal(launches,2);assert.equal(f.workers.operations().length,1);
  assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,1);
 }finally{f.close();}
});

test('legacy no-binding uncertainty recovers without changing the operation ID or runtime',async()=>{
 const f=fixture();try {
  const route=await f.masters.connections.prepare({provider:'codex',cwd:f.root},'cli',true);
  f.workers.save({...f.request,id:'legacy',masterId:f.master.id,route,executionMode:'cli',status:'uncertain',error:'Preflight failure'});
  f.prefer('codex','desktop');f.store.enqueue('wa:recover',f.master,'Recover');
  await f.workers.recover('wa:recover','legacy');
  for(let i=0;i<30&&!f.approvals.pending.size;i++)await new Promise(r=>setTimeout(r,5));
  approve(f);await settled(f);assert.equal(f.workers.get('legacy')?.status,'ready');assert.equal(f.workers.get('legacy')?.executionMode,'cli');assert.equal(f.counts().creations,1);
 }finally{f.close();}
});

test('pre-start recovery refuses changed accounts and leftover local state',async()=>{
 const f=fixture();try {
  const route=await f.masters.connections.prepare({provider:'codex',cwd:f.root},'cli',true);
  f.workers.save({...f.request,id:'blocked',masterId:f.master.id,route,executionMode:'cli',status:'blocked'});f.store.enqueue('wa:recover',f.master,'Recover');
  f.masters.connections=new Connections(f.store,async()=>({state:'verified',label:'Other account',accountKey:'other'}));
  await f.workers.recover('wa:recover','blocked');await settled(f);assert.equal(f.workers.get('blocked')?.status,'blocked');assert.match(f.workers.get('blocked')?.error??'',/account or profile changed/);assert.equal(f.counts().creations,0);assert.equal(f.approvals.pending.size,0);
  mkdirSync(join(f.root,'project-blocked'),{recursive:true});await assert.rejects(f.workers.recover('wa:recover','blocked'),/local state/);assert.equal(f.counts().creations,0);
 }finally{f.close();}
});

test('pre-start recovery revalidates the current owner request after account lookup',async()=>{
 const f=fixture();try {
  const route=await f.masters.connections.prepare({provider:'codex',cwd:f.root},'cli',true);
  f.workers.save({...f.request,id:'cancelled',masterId:f.master.id,route,executionMode:'cli',status:'blocked'});f.store.enqueue('wa:recover',f.master,'Recover');
  f.masters.connections=new Connections(f.store,async()=>{f.store.jobState('wa:recover','replaced');return {state:'verified',label:'Test account',accountKey:'test-account'};});
  await f.workers.recover('wa:recover','cancelled');await settled(f);assert.equal(f.workers.get('cancelled')?.status,'blocked');assert.equal(f.counts().creations,0);assert.equal(f.approvals.pending.size,0);
 }finally{f.close();}
});
