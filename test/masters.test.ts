import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Approvals } from '../src/approvals.js';

const dir=mkdtempSync(join(tmpdir(),'bridge-native-test-')),fake=join(dir,'fake-codex');
const nativeId='44444444-4444-4444-a444-444444444444';
writeFileSync(fake,`#!${process.execPath}
if(process.argv.includes('--version')){console.log('fake native CLI');process.exit(0);}
const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'${nativeId}',cwd:process.cwd()}}});
else if(m.method==='thread/read')send({id:m.id,result:{thread:{id:'${nativeId}',cwd:process.cwd()}}});
else {send({id:m.id,result:{}});if(m.method==='turn/start'){send({method:'item/completed',params:{threadId:'${nativeId}',item:{type:'agentMessage',text:m.params.input?.[0]?.text==='pending-empty'?'':'I can help with that. The selected task is complete.',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId:'${nativeId}',turn:{status:'completed'}}});}}
});`,{mode:0o700});
process.env.WSB_STATE_DIR=join(dir,'state');process.env.WSB_CODEX_BIN=fake;process.env.WSB_CLAUDE_BIN=join(dir,'missing-claude');
const { Masters,codexDesktopInstalled,masterName }=await import('../src/masters.js');
const { Coordinator }=await import('../src/coordinator.js');
const { CodexSession }=await import('../src/codex-session.js');
test.after(()=>rmSync(dir,{recursive:true,force:true}));

const cleanups:Array<()=>void>=[];
test.afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();});
function fixture(){
  const store=new Store(':memory:');store.set('whatsapp-owner','123@s.whatsapp.net');
  const approvals=new Approvals(store);
  const native={run:async()=>{},stop:()=>{},catalog:async()=>({sessions:[],cursor:null}),validate:async()=>{}};
  const router=new Router(store,native as any,approvals),coordinator=new Coordinator(store,native as any,router);router.coordinator=coordinator;
  const masters=new Masters(store,router);
  let closed=false;const close=()=>{if(closed)return;closed=true;masters.close();approvals.cancel();store.close();};
  cleanups.push(close);return {store,router,masters,approvals,close};
}
async function settled(f:ReturnType<typeof fixture>){for(let i=0;i<100&&f.masters.operation()?.status==='creating';i++)await new Promise(r=>setTimeout(r,10));}

test('native creation persists exact identity, scoped tools and friendly instructions without replacing early',async()=>{
  const f=fixture();const old=f.store.register('old-master','codex','11111111-1111-4111-a111-111111111111','/tmp').binding;f.store.set('master',old.id);
  await f.masters.discover();assert.equal(f.masters.platforms.find(p=>p.provider==='claude').available,false);
  const id='22222222-2222-4222-a222-222222222222';await f.masters.create('codex',id);
  assert.equal(f.store.get('master'),old.id);await f.masters.create('codex',id);await settled(f);
  assert.equal(f.masters.operation().status,'ready');const b=f.store.binding(f.store.get('master')!)!;
  assert.equal(b.native_id,nativeId);assert.equal(f.store.binding(old.id)!.enabled,0);assert.equal(f.store.bindings().length,2);
  assert.match(readFileSync(join(b.cwd,'AGENTS.md'),'utf8'),/friendly WhatsApp coordinator/);
  assert.match(readFileSync(join(b.cwd,'.agents/skills/whatsapp-master/SKILL.md'),'utf8'),/session_bridge MCP tools/);
  f.store.enqueue('wa:hello',b,'hello');await f.masters.run(b,'hello','wa:hello');
  assert.equal(f.store.job('wa:hello')!.status,'completed');assert.match(f.store.outbound().body,/I can help/);f.close();
});
test('replacement closes the old master queue and descendants only after creation succeeds',async()=>{
  const f=fixture(),b=f.store.register('old-master','codex','11111111-1111-4111-a111-111111111111','/tmp').binding;
  const worker=f.store.register('worker','claude','99999999-9999-4999-a999-999999999999','/tmp').binding;
  f.store.set('master',b.id);
  for(const [id,status] of [['wa:busy','submitted'],['wa:queued','queued'],['wa:running','dispatched'],['wa:done','completed']]){f.store.enqueue(id,b,'work');f.store.jobState(id,status);}
  f.store.enqueue('delegated',worker,'work');f.store.set('parent:delegated','wa:done');
  f.store.enqueue('unrelated',worker,'other work');
  f.router.busy.add(b.id);
  await f.masters.discover();await f.masters.create('codex','33333333-3333-4333-a333-333333333333');
  assert.equal(f.store.job('wa:queued')?.status,'queued');assert.equal(f.store.get('master'),b.id);
  await settled(f);assert.equal(f.masters.operation().status,'ready');
  for(const id of ['wa:busy','wa:queued','wa:running','delegated'])assert.equal(f.store.job(id)?.status,'replaced');
  assert.equal(f.store.job('wa:done')?.status,'completed');assert.equal(f.store.job('unrelated')?.status,'queued');
  assert.equal(f.masters.operation().closedRequests,4);assert.equal(f.store.binding(b.id)?.enabled,0);
  assert.throws(()=>f.router.channelReply(worker,'late','final','delegated'),/replaced/);
  f.router.coordinator!.workerReply(worker,'late','delegated');assert.equal(f.store.job('report:delegated'),undefined);
  f.close();
});
test('Claude trust failure preserves old requests, hides command text, and retries the same setup',async()=>{
  const f=fixture(),old=f.store.register('old-master','codex','11111111-1111-4111-a111-111111111111','/tmp').binding;
  f.store.set('master',old.id);f.store.enqueue('wa:waiting',old,'work');
  f.masters.platforms=[{provider:'claude',available:true}];
  let attempts=0;
  f.masters.provisionClaude=async()=>{attempts++;throw new Error('Command failed --append-system-prompt PRIVATE Workspace not trusted.');};
  await f.masters.create('claude','77777777-7777-4777-a777-777777777777');await settled(f);
  const op=f.masters.operation();assert.equal(op.status,'uncertain');assert.equal(op.needsTrust,true);
  assert.equal(f.store.get('master'),old.id);assert.equal(f.store.job('wa:waiting')?.status,'queued');
  assert.doesNotMatch(f.masters.options().operation.error,/PRIVATE|append-system/);assert.match(f.masters.options().operation.error,/trust/);
  f.masters.provisionClaude=async()=>{attempts++;};
  await f.masters.recover();await settled(f);
  assert.equal(f.masters.operation().status,'ready');assert.equal(f.masters.operation().bindingId,op.bindingId);
  assert.equal(f.masters.operation().nativeId,op.nativeId);assert.equal(f.store.bindings().length,2);assert.equal(attempts,2);
  assert.equal(f.store.job('wa:waiting')?.status,'replaced');f.close();
});
test('activation rollback preserves the previous master and queue',()=>{
  const f=fixture(),old=f.store.register('old-master','codex','11111111-1111-4111-a111-111111111111','/tmp').binding;
  const next=f.store.register('new-master','codex',nativeId,'/tmp').binding;
  f.store.enable(next.id,false);f.store.set('master',old.id);f.store.enqueue('wa:waiting',old,'work');
  f.store.db.exec("CREATE TRIGGER reject_switch BEFORE UPDATE ON settings WHEN NEW.key='master' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(()=>f.masters.activate(next),/test failure/);
  assert.equal(f.store.job('wa:waiting')?.status,'queued');assert.equal(f.store.binding(old.id)?.enabled,1);assert.equal(f.store.binding(next.id)?.enabled,0);f.close();
});
test('native approvals require matching thread and a real single-use owner answer',async()=>{
  const f=fixture(),b=f.store.register('master','codex',nativeId,'/tmp').binding;
  await assert.rejects(f.masters.approval(b,'item/commandExecution/requestApproval',{threadId:'wrong'}),/belong/);
  const answer=f.masters.approval(b,'item/commandExecution/requestApproval',{threadId:nativeId,command:'git status'});
  const code=[...f.approvals.pending.keys()][0];f.approvals.answer(code,'deny','approval');
  assert.deepEqual(await answer,{decision:'decline'});f.close();
});
test('native handshake uses structured stdio without creating a session',async()=>{
  const runtime=new CodexSession(fake,dir,async()=>{throw new Error('deny');});await runtime.initialize();assert.equal(runtime.alive,true);runtime.close();
});
test('an exact unconfirmed master can be recovered and resumed without creating another',async()=>{
  const f=fixture();await f.masters.discover();
  await f.masters.create('codex','55555555-5555-4555-a555-555555555555');await settled(f);
  const op=f.masters.operation(),b=f.store.binding(op.bindingId)!;
  f.store.enable(b.id,false);f.store.set('master-operation',JSON.stringify({...op,status:'uncertain',error:'lost final acknowledgement'}));
  await f.masters.recover();await settled(f);assert.equal(f.store.bindings().length,1);assert.equal(f.masters.operation().status,'ready');
  f.store.enqueue('wa:recovered',b,'hello');await f.masters.run(b,'hello','wa:recovered');assert.equal(f.store.job('wa:recovered')?.status,'completed');f.close();
});
test('paused background operation rejects new native approvals',async()=>{
  const f=fixture(),b=f.store.register('master','codex',nativeId,'/tmp').binding;f.router.stopped=true;
  await assert.rejects(f.masters.approval(b,'item/commandExecution/requestApproval',{threadId:nativeId}),/paused/);
  assert.equal(f.approvals.pending.size,0);f.close();
});

test('a master waiting for phone creation approval may end quietly without closing the owner request',async()=>{
  const f=fixture();await f.masters.discover();await f.masters.create('codex','88888888-8888-4888-a888-888888888888');await settled(f);
  const b=f.store.binding(f.store.get('master')!)!;f.store.enqueue('wa:pending',b,'Create a project');f.store.jobState('wa:pending','dispatched');
  f.router.hasPendingCreation=id=>id==='wa:pending';await f.masters.run(b,'pending-empty','wa:pending');
  assert.equal(f.store.job('wa:pending')?.status,'dispatched');assert.equal(f.store.outbound(),undefined);f.close();
});

test('explicit Desktop creation never calls CLI and preserves execution choice across retries',async()=>{
  const f=fixture();let desktopCalls=0,cliCalls=0;
  f.masters.platforms=[{provider:'claude',executionMode:'cli',available:true},{provider:'claude',executionMode:'desktop',available:true}];
  f.masters.desktop.parent=async()=>({id:'11111111-1111-4111-a111-111111111111'} as any);
  f.masters.desktop.create=async b=>{desktopCalls++;f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(nativeId,b.id);};
  f.masters.provisionClaude=async()=>{cliCalls++;};
  const opId='99999999-9999-4999-a999-999999999999';
  await f.masters.create('claude',opId,'desktop','11111111-1111-4111-a111-111111111111');await settled(f);
  assert.equal(f.masters.operation().status,'ready');assert.equal(desktopCalls,1);assert.equal(cliCalls,0);
  assert.equal(f.store.get('claude-execution-mode'),'desktop');assert.equal(f.store.get('claude-desktop-parent'),nativeId);
  await assert.rejects(f.masters.create('claude',opId,'cli'),/cannot change/);
  await f.masters.create('claude',opId,'desktop','11111111-1111-4111-a111-111111111111');assert.equal(desktopCalls,1);
});
test('Desktop setup without an early native ID can recover the original binding',async()=>{
  const f=fixture();const b=f.store.register('desktop-pending','claude',nativeId,dir).binding;
  f.store.set(`execution-mode:${b.id}`,'desktop');f.store.set('master-operation',JSON.stringify({id:'pending-desktop',bindingId:b.id,executionMode:'desktop',status:'uncertain'}));
  let checks=0;f.masters.desktop.confirm=async()=>{checks++;};
  await f.masters.recover();await settled(f);assert.equal(checks,1);assert.equal(f.store.get('master'),b.id);assert.equal(f.masters.operation().status,'ready');
});

test('owner can select an existing Desktop coordinator without creating a replacement native chat',async()=>{
  const f=fixture();let created=0;
  f.masters.desktop.parent=async id=>{assert.equal(id,nativeId);return {id:nativeId,name:'Chosen desktop project',cwd:dir} as any;};
  f.masters.desktop.create=async()=>{created++;};
  const opId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  await f.masters.useDesktop(nativeId,opId);
  const b=f.store.binding(f.store.get('master')!)!;
  assert.equal(b.native_id,nativeId);assert.equal(f.store.get(`name:${b.id}`),'Chosen desktop project');assert.equal(f.store.get(`execution-mode:${b.id}`),'desktop');assert.equal(created,0);
  await f.masters.useDesktop(nativeId,opId);assert.equal(f.store.bindings().length,1);
  await assert.rejects(f.masters.useDesktop('different',opId),/cannot change/);
});
test('unavailable Desktop selection cannot activate or create a binding',async()=>{
  const f=fixture();f.masters.desktop.parent=async()=>{throw new Error('No reachable inbox');};
  await assert.rejects(f.masters.useDesktop(nativeId,'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'),/reachable/);
  assert.equal(f.store.bindings().length,0);assert.equal(f.store.get('master'),undefined);
});

test('overlapping app refreshes publish each execution mode only once',async()=>{
 const f=fixture();let reads=0;
 f.router.native.catalog=async()=>{reads++;await new Promise(r=>setTimeout(r,10));return {sessions:[{id:nativeId,name:'Desktop',cwd:dir,provider:'claude',executionMode:'desktop',available:true,status:'idle'}],cursor:null};};
 await Promise.all([f.masters.discover(),f.masters.discover(),f.masters.discover()]);
 assert.equal(reads,2);assert.equal(f.masters.platforms.length,4);assert.equal(new Set(f.masters.platforms.map(p=>p.provider+':'+p.executionMode)).size,4);
});

test('failed setup is set aside automatically; stable old ID never creates again',async()=>{
 const f=fixture();f.masters.platforms=[{provider:'claude',available:true},{provider:'codex',available:true}];
 f.masters.provisionClaude=async()=>{throw new Error('Workspace not trusted');};
 const first='abababab-abab-4bab-abab-abababababab',next='cdcdcdcd-cdcd-4dcd-adcd-cdcdcdcdcdcd';
 await f.masters.create('claude',first);await settled(f);const failed=f.masters.operation();
 await f.masters.create('codex',next);await settled(f);
 assert.equal(f.masters.operation().status,'ready');assert.equal(f.masters.operation(first).status,'set-aside');
 assert.equal(f.masters.options().attempts[0].id,first);assert.match(f.masters.options().attempts[0].error,/trust/);
 const count=f.store.bindings().length;await f.masters.create('claude',first);assert.equal(f.store.bindings().length,count);assert.equal(f.masters.operation().id,next);
 f.masters.provisionClaude=async()=>{};await f.masters.recover(first);await settled(f);
 assert.equal(f.store.get('master'),failed.bindingId);assert.equal(f.masters.operation().status,'ready');
});
test('abandon targets only the earlier failed attempt and keeps current master',async()=>{
 const f=fixture();f.masters.platforms=[{provider:'claude',available:true},{provider:'codex',available:true}];
 f.masters.provisionClaude=async()=>{throw new Error('Workspace not trusted');};
 const first='12121212-1212-4212-a212-121212121212';
 await f.masters.create('claude',first);await settled(f);await f.masters.create('codex','13131313-1313-4313-a313-131313131313');await settled(f);
 const current=f.store.get('master');f.masters.abandon(first);
 assert.equal(f.masters.operation(first).status,'abandoned');assert.equal(f.store.get('master'),current);assert.equal(f.store.binding(current!)?.enabled,1);
 await assert.rejects(f.masters.recover(first),/No exact/);assert.equal(f.masters.options().attempts.length,0);
});
test('all four modes select existing sessions without creating new chats or losing workers',async()=>{
 for(const provider of ['codex','claude'] as const)for(const mode of ['desktop','cli'] as const){
  const f=fixture();const session={id:nativeId,name:'Selected',cwd:dir,provider,executionMode:mode,available:true};
  f.router.native.catalog=async()=>({sessions:[session],cursor:null});f.masters.desktop.parent=async()=>session;
  const worker=f.store.register('preserved','codex','16161616-1616-4616-a616-161616161616',dir).binding;f.store.set('selected',JSON.stringify([worker.id]));
  let creates=0;f.masters.provision=async()=>{creates++;};
  const id='15151515-1515-4515-a515-151515151515';await f.masters.useSession(provider,mode,nativeId,id);
  const b=f.store.binding(f.store.get('master')!)!;
  assert.equal(b.provider,provider);assert.equal(b.native_id,nativeId);assert.equal(f.store.get(`execution-mode:${b.id}`),mode);assert.equal(creates,0);
  assert.deepEqual(JSON.parse(f.store.get('selected')!),[worker.id]);
  await f.masters.useSession(provider,mode,nativeId,id);assert.equal(f.store.bindings().length,2);
  await assert.rejects(f.masters.useSession(provider,mode==='desktop'?'cli':'desktop',nativeId,id),/cannot change/);
 }
});
test('unreachable CLI selection is rejected and Codex catalogs include later pages',async()=>{
 const f=fixture();f.router.native.catalog=async(provider,cursor)=>provider==='claude'?{sessions:[{id:nativeId,cwd:dir,name:'offline',provider,available:false}],cursor:null}:{sessions:[{id:cursor?nativeId:'first',cwd:dir,name:'saved',provider,available:true}],cursor:cursor?null:'50'};
 await assert.rejects(f.masters.useSession('claude','cli',nativeId,'17171717-1717-4717-a717-171717171717'),/not reachable/);
 await f.masters.useSession('codex','desktop',nativeId,'18181818-1818-4818-a818-181818181818');assert.equal(f.store.binding(f.store.get('master')!)?.native_id,nativeId);
});
test('Codex Desktop creates in shared native history, without Claude launcher or managed CLI delivery',async()=>{
 const f=fixture();f.masters.platforms=[{provider:'codex',executionMode:'desktop',available:true}];
 f.masters.desktop.parent=async()=>{throw new Error('Must not use Claude launcher');};
 await f.masters.create('codex','19191919-1919-4919-a919-191919191919','desktop');await settled(f);
 const op=f.masters.operation();assert.equal(op.status,'ready');assert.equal(f.store.get(`execution-mode:${op.bindingId}`),'desktop');assert.equal(f.store.get(`managed-codex:${op.bindingId}`),undefined);assert.equal(f.masters.runtimes.size,0);
});
test('recovery holds setup lock and stale activation cannot replace current master',async()=>{
 const f=fixture(),b=f.store.register('pending','claude',nativeId,dir).binding;
 f.store.set('master-operation',JSON.stringify({id:'pending',provider:'claude',executionMode:'desktop',bindingId:b.id,status:'uncertain'}));
 let release!:()=>void;f.masters.desktop.confirm=async()=>new Promise<void>(r=>{release=r;});
 const recovery=f.masters.recover();await assert.rejects(f.masters.create('codex','20202020-2020-4020-a020-202020202020'),/in progress/);
 release();await recovery;await settled(f);assert.throws(()=>f.masters.activate(b,'older-operation'),/superseded/);
});

test('Codex Desktop discovery supports the ChatGPT bundle and user Applications without accepting legacy ChatGPT alone',()=>{
 assert.equal(codexDesktopInstalled('/sample',p=>p==='/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework'),true);
 assert.equal(codexDesktopInstalled('/sample',p=>p==='/sample/Applications/Codex.app'),true);
 assert.equal(codexDesktopInstalled('/sample',p=>p==='/Applications/ChatGPT.app'),false);
});

test('custom and automatic names persist into setup, native creation and recovery',async()=>{
 const f=fixture();f.masters.platforms=[{provider:'codex',executionMode:'cli',available:true},{provider:'claude',executionMode:'desktop',available:true}];
 const id='30303030-3030-4030-a030-303030303030';
 await f.masters.create('codex',id,'cli',undefined,'  Release helper  ');await settled(f);
 const op=f.masters.operation();assert.equal(op.name,'Release helper');assert.equal(f.store.get(`name:${op.bindingId}`),'Release helper');
 await assert.rejects(f.masters.create('codex',id,'cli',undefined,'Other name'),/cannot change/);
 f.store.set('master-operation',JSON.stringify({...op,status:'uncertain'}));await f.masters.recover(id);await settled(f);assert.equal(f.store.get(`name:${op.bindingId}`),'Release helper');
 f.masters.desktop.parent=async()=>({id:nativeId,cwd:dir,available:true} as any);
 let title='';f.masters.desktop.create=async(b,parent,name)=>{title=name;};
 await f.masters.create('claude','31313131-3131-4131-a131-313131313131','desktop',nativeId);await settled(f);
 assert.equal(title,'FarFromDesk · Claude Desktop');assert.equal(f.masters.operation().name,title);
});
test('session name validation rejects nontext, oversized and hidden controls before provisioning',async()=>{
 assert.equal(masterName('codex','desktop',undefined),'FarFromDesk · Codex Desktop');
 assert.equal(masterName('claude','cli','  Team helper  '),'Team helper');
 const f=fixture();f.masters.platforms=[{provider:'codex',available:true}];
 for(const name of [42,'x'.repeat(81),'bad\nname','bad\u202ename'])await assert.rejects(f.masters.create('codex','32323232-3232-4232-a232-323232323232','cli',undefined,name),/name/);
 assert.equal(f.store.bindings().length,0);assert.equal(f.masters.operation(),null);
});
