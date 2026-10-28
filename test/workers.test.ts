import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Coordinator } from '../src/coordinator.js';
import { Approvals } from '../src/approvals.js';
import { Connections, connectionProfile } from '../src/connections.js';
import { Workers } from '../src/workers.js';
import { coordinatorHome } from '../src/config.js';
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

test('worker creation freezes Desktop execution mode without a launcher chat or CLI fallback',async()=>{
  const f=fixture();try {
    f.store.set('claude-execution-mode','desktop');f.prefer('claude','desktop',uuid);
    let parents=0;(f.masters as any).desktop={parent:async()=>{parents++;return {id:uuid};}};
    const request={...f.request,provider:'claude' as const};
    const op=await f.workers.start(request);await new Promise(r=>setTimeout(r,0));approve(f);await settled(f);
    assert.equal(f.workers.get(op.id)?.executionMode,'desktop');assert.equal(parents,0);
    const b=f.c.selected()[0];assert.equal(f.store.get(`execution-mode:${b.id}`),'desktop');
    f.prefer('claude','cli');await f.workers.start(request);assert.equal(parents,0);
    await assert.rejects(f.workers.start({...request,executionMode:'cli'}),/different task/);
    assert.equal(f.store.get(`execution-mode:${b.id}`),'desktop');
  }finally{f.close();}
});

test('Desktop workers wait for the owner to press Send, write nothing into the project, then connect and queue the task',async()=>{
  const f=fixture();try {
    f.prefer('claude','desktop');let receipt:string|null=null,opens=0,confirms=0;
    (f.masters as any).desktop={acknowledgment:()=>receipt};
    f.masters.provisionWorker=async()=>{opens++;throw new Error('Desktop start needs owner action: confirm the folder and press Send in the new Claude chat that just opened.');};
    f.masters.recoverWorker=async()=>{confirms++;};
    const op=await f.workers.start({...f.request,provider:'claude'});await new Promise(r=>setTimeout(r,0));approve(f);await settled(f);
    const saved=f.workers.get(op.id)!;assert.equal(saved.status,'needs_action');assert.equal(opens,1);
    assert.deepEqual(readdirSync(saved.cwd!),[]);
    const support=f.store.get(`master-support:${saved.bindingId}`)!;assert.equal(support,join(realpathSync(f.root),'.farfromdesk',`project-${op.id}`));assert.ok(existsSync(support));
    assert.ok((f.store.db.prepare('SELECT body FROM outbox').all() as any[]).some(o=>/Press Send there to start it/.test(o.body)));
    assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,0);
    // No receipt yet: nothing opens, starts or connects.
    f.workers.reconcileDesktop();await settled(f);assert.equal(confirms,0);assert.equal(f.workers.get(op.id)?.status,'needs_action');
    receipt='ready';f.workers.reconcileDesktop();f.workers.reconcileDesktop();await settled(f);
    assert.equal(confirms,1);assert.equal(opens,1);assert.equal(f.workers.get(op.id)?.status,'ready');
    assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,1);
    f.workers.reconcileDesktop();await settled(f);assert.equal(confirms,1);
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


test('new workers default to projects inside FarFromDesk home without creating before consent',async()=>{
  const f=fixture();try{
    f.workers=new Workers(f.store,f.router,f.masters as any,undefined,()=>{});
    assert.equal(f.workers.root,join(coordinatorHome,'projects'));
    const op=await f.workers.start(f.request);
    assert.equal(f.workers.get(op.id)?.workspaceRoot,join(coordinatorHome,'projects'));
    assert.equal(op.status,'awaiting_approval');assert.equal(f.counts().creations,0);
    approve(f,'deny');await settled(f);assert.equal(f.workers.get(op.id)?.status,'denied');
  }finally{f.close();}
});

test('changing the default preserves legacy grants, folders and recovery while new projects ask for their own location',async()=>{
  const f=fixture();try{
    const old=await f.workers.start(f.request);approve(f);await settled(f);
    const saved=f.workers.get(old.id)!,binding=f.store.binding(saved.bindingId!)!;
    writeFileSync(join(binding.cwd,'keep.txt'),'existing work');
    // Reconstruct the single-grant/operation format from before the default-root change.
    const {workspaceRoot,...legacyOp}=saved;f.workers.save(legacyOp);
    const {root,...grant}=JSON.parse(f.store.get('worker-workspace')!);
    f.store.set('worker-workspace',JSON.stringify(grant));f.store.db.prepare('DELETE FROM settings WHERE key=?').run('worker-workspaces');
    f.workers.save({...f.request,id:'preflight-old',masterId:f.master.id,status:'blocked',route:await f.masters.connections.prepare({provider:'codex',cwd:f.root},'cli',true)});
    const nextRoot=join(f.dir,'.farfromdesk','projects');
    f.workers=new Workers(f.store,f.router,f.masters as any,nextRoot,()=>{});
    assert.equal(f.workers.workspace(),null);f.workers.ensureRun(binding);
    assert.ok(f.workers.workspaceSummary().includes(grant.path));assert.ok(f.workers.workspaceSummary().includes(nextRoot));
    assert.equal(f.workers.get('preflight-old')?.workspaceRoot,grant.path);
    const next=await f.workers.start({...f.request,eventId:'new-home'});
    assert.equal(next.status,'awaiting_approval');assert.equal(existsSync(nextRoot),false);
    approve(f);await settled(f);
    const nextBinding=f.store.binding(f.workers.get(next.id)!.bindingId!)!;
    assert.equal(nextBinding.cwd,join(realpathSync(nextRoot),`project-${next.id}`));
    f.workers.ensureRun(binding);f.workers.ensureRun(nextBinding);
    assert.equal(readFileSync(join(binding.cwd,'keep.txt'),'utf8'),'existing work');
    f.store.enqueue('wa:legacy-recover',f.master,'Recover the old unfinished operation');
    await f.workers.recover('wa:legacy-recover','preflight-old');await settled(f);
    assert.equal(f.approvals.pending.size,0);
    assert.equal(f.workers.get('preflight-old')?.cwd,join(grant.path,'project-preflight-old'));
    f.workers.revoke();assert.match(f.workers.workspaceSummary(),/No project workspace approved/);assert.throws(()=>f.workers.ensureRun(binding),/not approved/);assert.throws(()=>f.workers.ensureRun(nextBinding),/not approved/);
    assert.equal(readFileSync(join(binding.cwd,'keep.txt'),'utf8'),'existing work');
  }finally{f.close();}
});


test('revoked legacy folders can be reapproved through recovery without replaying existing tasks',async()=>{
  const f=fixture();try{
    const old=await f.workers.start(f.request);approve(f);await settled(f);
    const saved=f.workers.get(old.id)!,binding=f.store.binding(saved.bindingId!)!;
    writeFileSync(join(binding.cwd,'keep.txt'),'old project');
    f.workers=new Workers(f.store,f.router,f.masters as any,join(f.dir,'new-home','projects'),()=>{});
    f.workers.revoke();
    const newer=await f.workers.start({...f.request,eventId:'new-location'});approve(f);await settled(f);
    assert.equal(f.workers.get(newer.id)?.status,'ready');assert.throws(()=>f.workers.ensureRun(binding),/not approved/);
    assert.equal(f.workers.view(old.id)[0].canRecover,true);assert.equal(f.workers.view(old.id)[0].workspaceRequired,true);
    let nativeRecoveries=0;f.masters.recoverWorker=async()=>{nativeRecoveries++;};
    const before=f.store.jobs().filter(j=>j.id.startsWith('master:')).length;
    f.store.enqueue('wa:restore-old',f.master,'Restore the original project folder approval');
    await f.workers.recover('wa:restore-old',old.id);await f.workers.recover('wa:restore-old',old.id);
    assert.equal(f.approvals.pending.size,1);assert.equal(f.workers.pending('wa:restore-old'),true);assert.ok([...f.approvals.pending.values()][0].question.includes(f.root));
    approve(f,'deny');await settled(f);assert.throws(()=>f.workers.ensureRun(binding),/not approved/);
    assert.equal(f.workers.get(old.id)?.taskOwnerRequestId,saved.requestId);
    f.store.enqueue('wa:restore-approved',f.master,'Approve the original folder');
    await f.workers.recover('wa:restore-approved',old.id);
    const nextRoot=f.workers.root;f.workers.close();f.approvals.cancel();await settled(f);
    f.workers=new Workers(f.store,f.router,f.masters as any,nextRoot,()=>{});
    assert.equal(f.workers.get(old.id)?.status,'needs_approval');assert.match(f.workers.get(old.id)?.error??'',/Recover this same operation/);assert.equal(f.workers.view(old.id)[0].canRecover,true);
    await f.workers.recover('wa:restore-approved',old.id);approve(f);await settled(f);
    f.workers.ensureRun(binding);assert.equal(f.store.binding(binding.id)?.enabled,0);
    assert.equal(nativeRecoveries,0);assert.equal(f.counts().creations,2);
    assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,before);
    assert.equal(f.workers.get(old.id)?.taskOwnerRequestId,saved.requestId);
    assert.equal(readFileSync(join(binding.cwd,'keep.txt'),'utf8'),'old project');
    f.store.enable(binding.id,true);f.workers.ensureRun(binding); // the owner's later /resume
  }finally{f.close();}
});

test('reapproval denial or a new revocation cannot resume a bound unfinished creation',async()=>{
  const f=fixture();try{
    f.masters.provisionWorker=async()=>{throw Error('Synthetic native interruption');};
    const op=await f.workers.start(f.request);approve(f);await settled(f);
    const bindingId=f.workers.get(op.id)!.bindingId!;f.workers.revoke();
    f.store.enqueue('wa:restore-cancel',f.master,'Recover the same session');
    await f.workers.recover('wa:restore-cancel',op.id);
    approve(f);f.workers.revoke();await settled(f);
    assert.equal(f.workers.workspace(),null);assert.equal(f.store.binding(bindingId)?.enabled,0);
    assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,0);
    f.store.enqueue('wa:restore-final',f.master,'Recover the same session');
    await f.workers.recover('wa:restore-final',op.id);approve(f);await settled(f);
    assert.equal(f.workers.get(op.id)?.bindingId,bindingId);assert.equal(f.workers.get(op.id)?.status,'ready');
    assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,1);
  }finally{f.close();}
});


test('workspace recovery denial and later failure report to their own requests without changing the original task',async()=>{
  const f=fixture();try{
    const op=await f.workers.start(f.request);approve(f);await settled(f);
    const original=f.workers.view(op.id)[0].taskRequestId!;
    f.workers.revoke();f.store.enqueue('wa:deny-recovery',f.master,'Restore access');
    await f.workers.recover('wa:deny-recovery',op.id);approve(f,'deny');await settled(f);
    assert.equal(f.workers.get(op.id)?.status,'ready');
    assert.equal(f.workers.view(op.id)[0].taskRequestId,original);
    const reports=()=>f.store.jobs().filter(j=>j.id.startsWith(`report:creation:${op.id}:`));
    assert.equal(reports().length,1);
    assert.equal(f.store.get(`report-parent:${reports()[0].id}`),'wa:deny-recovery');
    assert.match(reports()[0].body,/not approved/);
    f.store.enqueue('wa:failed-recovery',f.master,'Try restoring access again');
    await f.workers.recover('wa:failed-recovery',op.id);
    rmSync(f.store.binding(f.workers.get(op.id)!.bindingId!)!.cwd,{recursive:true});
    approve(f);await settled(f);
    assert.equal(f.workers.get(op.id)?.status,'uncertain');
    assert.equal(reports().length,2);
    assert.deepEqual(new Set(reports().map(j=>f.store.get(`report-parent:${j.id}`))),new Set(['wa:deny-recovery','wa:failed-recovery']));
    assert.equal(f.workers.view(op.id)[0].taskRequestId,original);
    assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,1);
  }finally{f.workers.close();f.approvals.cancel();await settled(f);f.close();}
});

test('workspace recovery protects only its current request across restart and denial preserves ready status',async()=>{
  const f=fixture();try{
    const op=await f.workers.start(f.request);approve(f);await settled(f);
    const original=f.workers.view(op.id)[0].taskRequestId!;
    f.workers.revoke();f.store.enqueue('wa:pending-recovery',f.master,'Restore access');
    await f.workers.recover('wa:pending-recovery',op.id);
    assert.equal(f.workers.pending('wa:create'),false);
    assert.equal(f.workers.pending('wa:pending-recovery'),true);
    f.workers.close();f.approvals.cancel();await settled(f);
    f.workers=new Workers(f.store,f.router,f.masters as any,f.root,()=>{});
    assert.equal(f.workers.pending('wa:create'),false);
    assert.equal(f.workers.pending('wa:pending-recovery'),false);
    assert.doesNotThrow(()=>f.router.channelReply(f.master,'Approval expired; ask to recover again','final','wa:pending-recovery'));
    f.store.jobState(original,'completed');
    assert.doesNotThrow(()=>f.router.channelReply(f.master,'Original task finished','final','wa:create'));
    f.store.enqueue('wa:after-restart',f.master,'Ask for access again');
    await f.workers.recover('wa:after-restart',op.id);approve(f,'deny');await settled(f);
    assert.equal(f.workers.get(op.id)?.status,'ready');
    assert.equal(f.workers.pending('wa:pending-recovery'),false);
    assert.equal(f.workers.pending('wa:after-restart'),false);
    assert.equal(f.workers.view(op.id)[0].taskRequestId,original);
  }finally{f.workers.close();f.approvals.cancel();await settled(f);f.close();}
});

test('revocation cancels the recovering coordinator prompt and a new grant does not join the revoked generation',async()=>{
  const f=fixture();try{
    const op=await f.workers.start(f.request);approve(f);await settled(f);f.workers.revoke();
    const replacement=f.store.register('replacement-master','codex','55555555-5555-4555-a555-555555555555',f.dir).binding;
    f.store.set('master',replacement.id);
    f.store.enqueue('wa:new-master-recover',replacement,'Restore access');
    await f.workers.recover('wa:new-master-recover',op.id);
    assert.equal([...f.approvals.pending.values()][0].binding.id,replacement.id);
    f.workers.revoke();assert.equal(f.approvals.pending.size,0);
    // Start another operation before the cancelled grant continuation has settled.
    f.store.enqueue('wa:fresh-create',replacement,'Create another project');
    await f.workers.start({...f.request,requestId:'wa:fresh-create',eventId:'fresh'});
    assert.equal(f.approvals.pending.size,1);approve(f);await settled(f);
    assert.ok(f.workers.workspace());
    assert.equal(f.workers.get(op.id)?.status,'ready');
  }finally{f.workers.close();f.approvals.cancel();await settled(f);f.close();}
});


test('repeated workspace recovery failures never reuse a report delivery with different content',async()=>{
  const f=fixture();try{
    const op=await f.workers.start(f.request);approve(f);await settled(f);f.workers.revoke();
    f.store.enqueue('wa:retry-access',f.master,'Restore access');
    for(let i=0;i<2;i++){
      await f.workers.recover('wa:retry-access',op.id);approve(f,'deny');await settled(f);
    }
    await f.workers.recover('wa:retry-access',op.id);
    rmSync(f.store.binding(f.workers.get(op.id)!.bindingId!)!.cwd,{recursive:true});
    approve(f);await settled(f); // A report-ID collision used to reject this background task.
    const reports=f.store.jobs().filter(j=>j.id.startsWith(`report:creation:${op.id}:`));
    assert.equal(reports.length,3);
    assert.equal(new Set(reports.map(j=>j.id)).size,3);
    assert.ok(reports.every(j=>f.store.get(`report-parent:${j.id}`)==='wa:retry-access'));
    assert.equal(f.workers.tasks.size,0);
  }finally{f.workers.close();f.approvals.cancel();await settled(f);f.close();}
});


test('Desktop reconciliation never requests revoked workspace permission even after explicit recovery denial',async()=>{
  const f=fixture();try{
    f.prefer('claude','desktop');(f.masters as any).desktop={acknowledgment:()=> 'ready'};
    f.masters.provisionWorker=async()=>{throw Error('Desktop start needs owner action: press Send');};
    const op=await f.workers.start({...f.request,provider:'claude'});approve(f);await settled(f);
    f.workers.revoke();
    for(let i=0;i<3;i++){f.workers.reconcileDesktop();assert.equal(f.approvals.pending.size,0);await settled(f);}
    f.store.enqueue('wa:manual-recover',f.master,'Restore access');
    await f.workers.recover('wa:manual-recover',op.id);approve(f,'deny');await settled(f);
    assert.equal(f.workers.get(op.id)?.status,'needs_action');
    for(let i=0;i<3;i++){f.workers.reconcileDesktop();assert.equal(f.approvals.pending.size,0);await settled(f);}
    assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,0);
  }finally{f.workers.close();f.approvals.cancel();await settled(f);f.close();}
});

test('preflight retries with the same owner request retain distinct failure deliveries',async()=>{
  const f=fixture();try{
    const route=await f.masters.connections.prepare({provider:'codex',cwd:f.root},'cli',true);
    f.workers.save({...f.request,id:'preflight-repeat',masterId:f.master.id,route,executionMode:'cli',status:'blocked'});
    f.store.enqueue('wa:preflight-retry',f.master,'Recover');
    for(const error of ['probe failure A','probe failure B']){
      f.masters.connections.prepare=async()=>{throw Error(error);};
      await f.workers.recover('wa:preflight-retry','preflight-repeat');await settled(f);
    }
    const reports=f.store.jobs().filter(j=>j.id.startsWith('report:creation:preflight-repeat:'));
    assert.equal(reports.length,2);assert.equal(f.workers.get('preflight-repeat')?.error,'probe failure B');
    assert.equal(f.counts().creations,0);
  }finally{f.workers.close();f.approvals.cancel();await settled(f);f.close();}
});

test('restarted creation attempts retain distinct failure deliveries',async()=>{
  const f=fixture();try{
    f.workers.workspace=()=>{throw Error('workspace failure A');};
    const op=await f.workers.start(f.request);await settled(f);
    f.workers.save({...f.workers.get(op.id)!,status:'needs_approval'});
    f.workers.workspace=()=>{throw Error('workspace failure B');};
    await f.workers.start(f.request);await settled(f);
    assert.equal(f.workers.get(op.id)?.error,'workspace failure B');
    assert.equal(f.store.jobs().filter(j=>j.id.startsWith(`report:creation:${op.id}:`)).length,2);
    assert.equal(f.counts().creations,0);
  }finally{f.workers.close();f.approvals.cancel();await settled(f);f.close();}
});

test('closed shared approval origin leaves a joined ready session unchanged',async()=>{
  const f=fixture();try{
    const op=await f.workers.start(f.request);approve(f);await settled(f);f.workers.revoke();
    f.store.enqueue('wa:grant-origin',f.master,'Create a second project');
    await f.workers.start({...f.request,requestId:'wa:grant-origin',eventId:'second'});
    f.store.enqueue('wa:grant-joiner',f.master,'Restore the existing workspace');
    await f.workers.recover('wa:grant-joiner',op.id);
    assert.equal(f.approvals.pending.size,1);
    f.store.jobState('wa:grant-origin','completed');approve(f);await settled(f);
    assert.equal(f.workers.get(op.id)?.status,'ready');assert.equal(f.workers.workspace(),null);
    assert.equal(f.counts().creations,1);
  }finally{f.workers.close();f.approvals.cancel();await settled(f);f.close();}
});

test('native recovery restart clears old pre-approval status before a later denial',async()=>{
  const f=fixture();try{
    const op=await f.workers.start(f.request);approve(f);await settled(f);
    f.workers.save({...f.workers.get(op.id)!,status:'creating',recoveryPrevious:{status:'uncertain',error:'old error'}});
    f.workers=new Workers(f.store,f.router,f.masters as any,f.root,()=>{});
    const interrupted=f.workers.get(op.id)!;assert.match(interrupted.error!,/bridge restarted/);
    f.workers.revoke();f.store.enqueue('wa:restart-deny',f.master,'Recover');
    await f.workers.recover('wa:restart-deny',op.id);approve(f,'deny');await settled(f);
    assert.equal(f.workers.get(op.id)?.error,interrupted.error);
  }finally{f.workers.close();f.approvals.cancel();await settled(f);f.close();}
});

test('restoring access reports completion of recovery without claiming the existing task completed',async()=>{
  const f=fixture();try{
    const op=await f.workers.start(f.request);approve(f);await settled(f);f.workers.revoke();
    const original=f.workers.view(op.id)[0].taskRequestId!;
    f.store.jobState(original,'submitted');
    f.store.enqueue('wa:restored',f.master,'Restore access');
    await f.workers.recover('wa:restored',op.id);approve(f);await settled(f);
    const report=f.store.jobs().find(j=>j.id.startsWith(`report:creation:${op.id}:ready:`));
    assert.ok(report);assert.equal(f.store.get(`report-parent:${report.id}`),'wa:restored');
    assert.match(report.body,/not.*task.*complet/i);assert.equal(f.store.job(original)?.status,'submitted');
    assert.equal(f.workers.pending('wa:restored'),false);
  }finally{f.workers.close();f.approvals.cancel();await settled(f);f.close();}
});


test('restart during native recovery records uncertainty rather than an expired folder approval',async()=>{
  const f=fixture();let finish!:()=>void;try{
    f.masters.provisionWorker=async()=>{throw Error('Native login required');};
    const op=await f.workers.start(f.request);approve(f);await settled(f);f.workers.revoke();
    let started!:()=>void;const entered=new Promise<void>(r=>{started=r;});
    f.masters.recoverWorker=()=>new Promise<void>(r=>{finish=r;started();});
    f.store.enqueue('wa:native-recovery',f.master,'Recover');
    await f.workers.recover('wa:native-recovery',op.id);approve(f);await entered;
    assert.equal(f.workers.get(op.id)?.status,'creating');
    assert.equal(f.workers.get(op.id)?.recoveryPrevious,undefined);
    f.workers.close();finish();await settled(f);
    f.workers=new Workers(f.store,f.router,f.masters as any,f.root,()=>{});
    assert.equal(f.workers.get(op.id)?.status,'uncertain');assert.match(f.workers.get(op.id)?.error??'',/bridge restarted/);
    assert.equal(f.workers.pending('wa:native-recovery'),false);
    assert.equal(f.store.jobs().filter(j=>j.id.startsWith('master:')).length,0);
  }finally{f.workers.close();f.approvals.cancel();finish?.();await settled(f);f.close();}
});


test('closed shared approval origin leaves new projects blocked and recoverable rather than denied',async()=>{
  const f=fixture();try{
    const first=await f.workers.start(f.request);
    f.store.enqueue('wa:joined-project',f.master,'Create a second project');
    const joined=await f.workers.start({...f.request,requestId:'wa:joined-project',eventId:'join'});
    f.store.jobState('wa:create','replaced');approve(f);await settled(f);
    for(const id of [first.id,joined.id]){assert.equal(f.workers.get(id)?.status,'blocked');assert.match(f.workers.get(id)?.error??'',/request.*closed/i);assert.equal(f.workers.view(id)[0].canRecover,true);}
    f.store.enqueue('wa:recover-joined',f.master,'Recover the same new project');
    await f.workers.recover('wa:recover-joined',joined.id);
    for(let i=0;i<30&&!f.approvals.pending.size;i++)await new Promise(r=>setTimeout(r,5));
    approve(f);await settled(f);assert.equal(f.workers.get(joined.id)?.status,'ready');assert.equal(f.counts().creations,1);
  }finally{f.workers.close();f.approvals.cancel();await settled(f);f.close();}
});

test('closing the recovery request during folder approval preserves the healthy existing session',async()=>{
  const f=fixture();try{
    const op=await f.workers.start(f.request);approve(f);await settled(f);f.workers.revoke();
    f.store.enqueue('wa:cancel-recovery',f.master,'Restore access');
    await f.workers.recover('wa:cancel-recovery',op.id);f.store.jobState('wa:cancel-recovery','replaced');approve(f);await settled(f);
    assert.equal(f.workers.get(op.id)?.status,'ready');assert.equal(f.workers.workspace(),null);
    assert.equal(f.store.binding(f.workers.get(op.id)!.bindingId!)?.enabled,0);
    assert.ok((f.store.db.prepare('SELECT body FROM outbox').all() as any[]).some(r=>/request.*closed/i.test(r.body)));
  }finally{f.workers.close();f.approvals.cancel();await settled(f);f.close();}
});
