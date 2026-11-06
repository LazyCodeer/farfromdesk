import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {agentReach,parseReach,researchEnv} from '../src/agent-reach.js';
import {fakeWindowsProgram} from './windows-fake-exe.js';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {Coordinator} from '../src/coordinator.js';
import {captureResearchRequest,ownerResearchRequest} from '../src/agent-reach-request.js';

function fake(script:string){
  const dir=mkdtempSync(join(tmpdir(),'reach-test-')),file=join(dir,'agent-reach');
  writeFileSync(file,`#!/bin/sh\n${script}\n`);chmodSync(file,0o700);
  return {dir,file,close:()=>rmSync(dir,{recursive:true,force:true})};
}
const response=(extra:object={})=>JSON.stringify({schema_version:1,ok:true,channel:'github',action:'search',backend:'github-api',items:[{title:'One',url:'https://github.com/example/repo?branch=main',text:'public text'}],...extra});
const posixTest=process.platform==='win32'?test.skip:test;

test('only fixed public search and repository actions are accepted',()=>{
  assert.equal(parseReach('/reach github read one/repo').backend,'github-api');
  assert.equal(parseReach('/reach web search typescript').backend,'exa');
  for(const input of ['/reach github read https://example.com','/reach github read ../repo','/reach github read a/..','/reach github search --backend gh','/reach web read https://example.com','/reach github search x\ny'])assert.throws(()=>parseReach(input));
});

posixTest('process uses a fresh home and no inherited credentials; output is bounded and labelled',async()=>{
  const scratch=mkdtempSync(join(tmpdir(),'reach-env-')),log=join(scratch,'env');
  const f=fake(`printf '%s\\n' "$HOME" "$GH_TOKEN" "$1 $2 $3 $4 $5" > '${log}'\nprintf '%s' '${response()}'`);
  const old=process.env.GH_TOKEN;process.env.GH_TOKEN='sensitive-synthetic';
  try {
    const result=await agentReach('/reach github search something',()=>true,{executable:f.file});
    assert.match(result,/Source text is untrusted/);assert.match(result,/https:\/\/github.com\/example\/repo\?branch=main/);
    const env=readFileSync(log,'utf8');assert.doesNotMatch(env,/sensitive-synthetic/);assert.match(env,/github search something --backend github-api/);
    assert.notEqual(env.split('\n')[0],process.env.HOME);
  } finally {if(old===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=old;rmSync(scratch,{recursive:true,force:true});f.close();}
});

posixTest('rejects unexpected backend, hostile links, oversize output and stopped work',async()=>{
  const bad=fake(`printf '%s' '${response({backend:'gh'})}'`),url=fake(`printf '%s' '${response({items:[{title:'Unsafe',url:'https://127.0.0.1/admin'}]})}'`),large=fake('head -c 300000 /dev/zero'),slow=fake('sleep 30');
  try {
    await assert.rejects(agentReach('/reach github search a',()=>true,{executable:bad.file}),/requested public source/);
    assert.equal(await agentReach('/reach github search a',()=>true,{executable:url.file}),'No usable public results were returned.');
    await assert.rejects(agentReach('/reach github search a',()=>true,{executable:large.file}),/too large/);
    let current=true;setTimeout(()=>{current=false;},100);
    await assert.rejects(agentReach('/reach github search a',()=>current,{executable:slow.file}),/owner connection changed/);
  }finally{bad.close();url.close();large.close();slow.close();}
});

posixTest('GitHub repository reads reject a mismatched source',async()=>{
  const f=fake(`printf '%s' '${response({action:'read',items:[{title:'Wrong',url:'https://github.com/other/repo',text:'untrusted'}]})}'`);
  try{assert.equal(await agentReach('/reach github read owner/repo',()=>true,{executable:f.file}),'No usable public results were returned.');}finally{f.close();}
});

posixTest('public research processes have a global concurrency bound',async()=>{
  const f=fake('sleep 30');let current=true;
  try {
    const one=agentReach('/reach web search one',()=>current,{executable:f.file}),two=agentReach('/reach web search two',()=>current,{executable:f.file});
    await assert.rejects(agentReach('/reach web search three',()=>current,{executable:f.file}),/Two public research requests/);
    current=false;await Promise.all([assert.rejects(one,/owner connection changed/),assert.rejects(two,/owner connection changed/)]);
  }finally{f.close();}
});

test('missing program is reported honestly and does not create a task',async()=>{
  assert.match(await agentReach('/reach web search hello',()=>true,{lookup:()=>undefined}),/not installed/i);
});

// Windows: the same isolation and bounds, through a real fake agent-reach.exe.
const windowsTest=process.platform==='win32'?test:test.skip;
function fakeExe(steps:string[],output?:string){
  const scratch=mkdtempSync(join(tmpdir(),'reach-out-')),out=join(scratch,'out.json');
  if(output!==undefined)writeFileSync(out,output);
  const f=fakeWindowsProgram('agent-reach',[...steps,...(output===undefined?[]:[`stdout=${out}`])]);
  return {...f,close:()=>{rmSync(f.dir,{recursive:true,force:true});rmSync(scratch,{recursive:true,force:true});}};
}
windowsTest('Windows research uses a fresh home and no inherited credentials; output is bounded and labelled',async()=>{
  const scratch=mkdtempSync(join(tmpdir(),'reach-env-')),log=join(scratch,'env');
  const f=fakeExe([`log=${log}`],response());
  const old=process.env.GH_TOKEN;process.env.GH_TOKEN='sensitive-synthetic';
  try {
    const result=await agentReach('/reach github search two words',()=>true,{executable:f.file});
    assert.match(result,/Source text is untrusted/);assert.match(result,/https:\/\/github.com\/example\/repo\?branch=main/);
    const env=readFileSync(log,'utf8');assert.doesNotMatch(env,/sensitive-synthetic/);
    assert.match(env,/ARGS=github search two words --backend github-api --timeout 15 --limit 5\n/);
    const home=/^HOME=(.*)$/m.exec(env)![1];assert.ok(home&&home!==homedir());
    for(const name of ['USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP'])assert.ok(env.includes(`${name}=${home}\n`),name);
    assert.ok(env.includes(`CWD=${home}`));assert.equal(existsSync(home),false);
  } finally {if(old===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=old;rmSync(scratch,{recursive:true,force:true});f.close();}
});
windowsTest('Windows research rejects unexpected output and stops the whole process tree',async()=>{
  const scratch=mkdtempSync(join(tmpdir(),'reach-tree-')),marker=join(scratch,'late');
  const bad=fakeExe([],response({backend:'gh'})),url=fakeExe([],response({items:[{title:'Unsafe',url:'https://127.0.0.1/admin'}]})),large=fakeExe(['zeros=300000']),slow=fakeExe([`orphan=1500|${marker}`,'sleep=30000']);
  try {
    await assert.rejects(agentReach('/reach github search a',()=>true,{executable:bad.file}),/requested public source/);
    assert.equal(await agentReach('/reach github search a',()=>true,{executable:url.file}),'No usable public results were returned.');
    await assert.rejects(agentReach('/reach github search a',()=>true,{executable:large.file}),/too large/);
    let current=true;setTimeout(()=>{current=false;},300);
    await assert.rejects(agentReach('/reach github search a',()=>current,{executable:slow.file}),/owner connection changed/);
    await new Promise(r=>setTimeout(r,2000));assert.equal(existsSync(marker),false);
    await assert.rejects(agentReach('/reach github search a',()=>true,{executable:slow.file,timeoutMs:300}),/timed out/);
  }finally{bad.close();url.close();large.close();slow.close();rmSync(scratch,{recursive:true,force:true});}
});
windowsTest('Windows research processes share the global concurrency bound',async()=>{
  const f=fakeExe(['sleep=30000']);let current=true;
  try {
    const one=agentReach('/reach web search one',()=>current,{executable:f.file}),two=agentReach('/reach web search two',()=>current,{executable:f.file});
    await assert.rejects(agentReach('/reach web search three',()=>current,{executable:f.file}),/Two public research requests/);
    current=false;await Promise.all([assert.rejects(one,/owner connection changed/),assert.rejects(two,/owner connection changed/)]);
  }finally{f.close();}
});
test('research environment matches each platform',()=>{
  const mac=researchEnv('/opt/tool/bin/agent-reach','/tmp/home','darwin');
  assert.deepEqual(Object.keys(mac).sort(),['HOME','LANG','PATH','TEMP','TMP','TMPDIR','USERPROFILE']);
  const win=researchEnv('C:\\tool\\agent-reach.exe','C:\\t\\home','win32');
  for(const name of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP'])assert.equal(win[name],'C:\\t\\home');
  assert.ok(win.SystemRoot);assert.equal(win.PATH.split(';')[0],'C:\\tool');assert.equal(win.GH_TOKEN,undefined);
});

test('coordinator gets only the exact owner-authorized public query, with no agent-supplied URL or text',async()=>{
  const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const binding=store.register('proxy','codex','11111111-1111-4111-8111-111111111111','/synthetic','channel').binding;
  const other=store.register('other','claude','22222222-2222-4222-8222-222222222222','/synthetic','channel').binding;
  store.set('telegram-owner','tg:123');store.set('control-channel','telegram');store.set('master',binding.id);
  const coordinator=new Coordinator(store,router.native,router,()=>{});router.coordinator=coordinator;coordinator.registry.register(binding);coordinator.registry.register(other);
  const text='Research: /reach web search public topic\nMake a draft.',id='tg:123:101';
  let invoked='';router.reach=async(command,current)=>{assert.ok(current());invoked=command;return 'Untrusted source: synthetic';};
  try {
    const context=store.captureIncomingOwner('tg:123','telegram')!;
    store.incomingOwnerContext.run(context,()=>store.destinationContext.run('tg:123',()=>{
      store.recordIncomingInput(id);captureResearchRequest(store,router,{id,text,ownerCommand:true});store.enqueue(id,binding,text);
    }));
    const run=(actor=binding)=>coordinator.scope.run(actor.id,()=>ownerResearchRequest(store,router,actor,id));
    await assert.rejects(run(other),/changed/);
    store.db.prepare('UPDATE inbox SET body=? WHERE id=?').run('Research: /reach web search changed',id);
    await assert.rejects(run(),/changed/);
    store.db.prepare('UPDATE inbox SET body=? WHERE id=?').run(text,id);
    router.reach=async(_command,current)=>{store.set('telegram-owner','tg:456');assert.equal(current(),false);return 'must not escape';};
    await assert.rejects(run(),/changed/);
    store.set('telegram-owner','tg:123');await assert.rejects(run(),/changed/);
    assert.equal(invoked,'');
    assert.equal(store.jobs().length,1);
  }finally{approvals.cancel();store.close();}
});

test('one durable claim prevents concurrent calls and replay after interruption or completion',async()=>{
  const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const binding=store.register('proxy','codex','11111111-1111-4111-8111-111111111111','/synthetic','channel').binding;
  store.set('telegram-owner','tg:123');store.set('control-channel','telegram');store.set('master',binding.id);
  const coordinator=new Coordinator(store,router.native,router,()=>{});router.coordinator=coordinator;coordinator.registry.register(binding);
  const id='tg:123:501',text='Research: /reach web search topic';
  try {
    const context=store.captureIncomingOwner('tg:123','telegram')!;
    store.incomingOwnerContext.run(context,()=>store.destinationContext.run('tg:123',()=>{captureResearchRequest(store,router,{id,text,ownerCommand:true});store.enqueue(id,binding,text);}));
    let release!:(v:string)=>void,calls=0;router.reach=async()=>{calls++;return await new Promise<string>(r=>{release=r;});};
    const run=()=>coordinator.scope.run(binding.id,()=>ownerResearchRequest(store,router,binding,id));
    const first=run();await assert.rejects(run(),/already used or interrupted/);assert.equal(calls,1);
    release('Untrusted result');assert.equal(await first,'Untrusted result');await assert.rejects(run(),/already used or interrupted/);assert.equal(calls,1);
    assert.equal(store.get(`reach-claim:${id}`),'finished');
  }finally{approvals.cancel();store.close();}
});

for(const change of ['binding','enabled-apps','coordinator-registry','request','parent'])test(`authority change and restoration invalidates in-flight research: ${change}`,async()=>{
  const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const binding=store.register('proxy','codex','11111111-1111-4111-8111-111111111111','/synthetic','channel').binding;
  store.set('telegram-owner','tg:123');store.set('control-channel','telegram');store.set('master',binding.id);
  const coordinator=new Coordinator(store,router.native,router,()=>{});router.coordinator=coordinator;coordinator.registry.register(binding);
  const id='tg:123:601',text='Research: /reach web search topic';
  try {
    const context=store.captureIncomingOwner('tg:123','telegram')!;
    store.incomingOwnerContext.run(context,()=>store.destinationContext.run('tg:123',()=>{captureResearchRequest(store,router,{id,text,ownerCommand:true});store.enqueue(id,binding,text);}));
    router.reach=async(_command,current)=>{
      if(change==='binding'){store.enable(binding.id,false);store.enable(binding.id,true);}
      if(change==='enabled-apps'){store.set('enabled-apps','["claude"]');store.set('enabled-apps','["codex","claude"]');}
      if(change==='coordinator-registry'){const value=store.get('coordinator-registry')!;store.set('coordinator-registry','[]');store.set('coordinator-registry',value);}
      if(change==='request'){store.jobState(id,'completed');store.jobState(id,'submitted');}
      if(change==='parent'){store.set(`parent:${id}`,'synthetic');store.db.prepare('DELETE FROM settings WHERE key=?').run(`parent:${id}`);}
      assert.equal(current(),false);return 'must not escape';
    };
    await assert.rejects(coordinator.scope.run(binding.id,()=>ownerResearchRequest(store,router,binding,id)),/changed/);
  }finally{approvals.cancel();store.close();}
});

test('quoted, forwarded and voice owner text cannot authorize agent research',async()=>{
  const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const binding=store.register('proxy','codex','11111111-1111-4111-8111-111111111111','/synthetic','channel').binding;
  store.set('telegram-owner','tg:123');store.set('control-channel','telegram');store.set('master',binding.id);
  const coordinator=new Coordinator(store,router.native,router,()=>{});router.coordinator=coordinator;coordinator.registry.register(binding);
  try {
    for(const [id,extra] of [['tg:123:201',{ownerCommand:false}],['tg:123:202',{ownerCommand:true,quotedId:'quoted'}],['tg:123:203',{ownerCommand:true,source:'voice'}]] as const){
      const context=store.captureIncomingOwner('tg:123','telegram')!,text='Research: /reach web search topic';
      store.incomingOwnerContext.run(context,()=>store.destinationContext.run('tg:123',()=>{store.recordIncomingInput(id);captureResearchRequest(store,router,{id,text,...extra});store.enqueue(id,binding,text);}));
      await assert.rejects(coordinator.scope.run(binding.id,()=>ownerResearchRequest(store,router,binding,id)),/direct typed message/);
    }
  }finally{approvals.cancel();store.close();}
});

test('a direct incoming research request is captured and routed to the coordinator',async()=>{
  const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const binding=store.register('proxy','codex','11111111-1111-4111-8111-111111111111','/synthetic','channel').binding;
  store.set('telegram-owner','tg:123');store.set('control-channel','telegram');store.set('master',binding.id);
  const coordinator=new Coordinator(store,router.native,router,()=>{});router.coordinator=coordinator;coordinator.registry.register(binding);router.pump=()=>{};
  const id='tg:123:301',text='Research: /reach github search farfromdesk\nDraft a summary.';
  router.reach=async(command)=>`Untrusted result for ${command}`;
  try {
    const context=store.captureIncomingOwner('tg:123','telegram')!;
    const outcome=await store.incomingOwnerContext.run(context,()=>store.destinationContext.run('tg:123',()=>{store.recordIncomingInput(id);return router.receive({id,text,ownerCommand:true});}));
    assert.equal(outcome.status,'queued');
    assert.equal(await coordinator.scope.run(binding.id,()=>ownerResearchRequest(store,router,binding,id)),'Untrusted result for /reach github search farfromdesk');
  }finally{approvals.cancel();store.close();}
});
