import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {once} from 'node:events';

const root=mkdtempSync(join(tmpdir(),'ffd-specialty-http-'));
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));
process.env.WSB_STATE_DIR=root;process.env.WSB_PORT=String(port);process.env.CODEX_HOME=join(root,'codex');process.env.CLAUDE_CONFIG_DIR=join(root,'claude');
const [{serve},{Store},{Router},{Approvals},{MetaSecret,DEFAULT_BRAIN,saveBrainConfig},{TaskContracts},{ensureFfd,runFfd},{turnEnvelope}]=await Promise.all([import('../src/server.js'),import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js'),import('../src/meta-brain-config.js'),import('../src/task-contracts.js'),import('../src/ffd.js'),import('../src/roles.js')]);

test('session API performs owner-bound Research and Jobs searches without accepting arbitrary queries',async()=>{
 const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{},warmDesktop:()=>{}} as any,approvals);
 const owner='tg:123';store.set('control-channel','telegram');store.set('telegram-owner',owner);
 const selected=store.register('selected','codex',randomUUID(),root),other=store.register('other','codex',randomUUID(),root);store.set('active',selected.binding.id);router.pump=()=>{};
 const secret=new MetaSecret(root);secret.save('synthetic-key-not-a-real-secret');saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,taskContracts:true}});
 router.contracts=new TaskContracts(store,secret,async()=>({kind:'contract',goal:'Research the request',exclusions:['Do not submit'],checks:['Include sources','State uncertainty'],question:''}));
 let calls=0;router.reach=async(command,current)=>{calls++;assert.ok(current());return `Public research from Exa web search.\n\nSynthetic source\nhttps://example.com/source\n${command}`;};
 const server=serve(store,router,{} as any,'synthetic-admin');await once(server,'listening');
 const send=(id:string,text:string)=>store.destinationContext.run(owner,()=>router.receive({id:`${owner}:${id}`,text,ownerCommand:true,ownerIntent:true}));
 const call=(binding:typeof selected,data:unknown)=>fetch(`http://127.0.0.1:${port}/api/session/research`,{method:'POST',headers:{Authorization:`Bearer ${binding.token}`,'X-Binding-Id':binding.binding.id,'Content-Type':'application/json'},body:JSON.stringify(data)});
 try{
  for(const [n,prompt,query] of [['1','/research Spliceai in fmcg','Spliceai in fmcg'],['3','/jobs Ai engineer in yc startups','Ai engineer in yc startups']] as const){
   await send(n,prompt);store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
   const approval=String(Number(n)+1);assert.equal((await send(approval,'ok')).status,'queued');const requestId=`${owner}:${approval}`;
   assert.equal((await call(other,{requestId})).status,400);assert.equal((await call(selected,{requestId,query:'unapproved query'})).status,400);
   const response=await call(selected,{requestId});assert.equal(response.status,200);const data=await response.json() as any;
   assert.match(data.result,/https:\/\/example.com\/source/);assert.ok(data.result.includes(`/reach web search ${query}`));
   assert.equal((await call(other,{requestId,focus:'reddit'})).status,400);
   assert.equal((await call(selected,{requestId,focus:'https://private.example/'})).status,400);
   assert.equal((await call(selected,{requestId,focus:'reddit',sourceIndex:1})).status,400);
   const focused=await call(selected,{requestId,focus:'official'});assert.equal(focused.status,200);const focusResult=await focused.json() as any;assert.ok(focusResult.result.includes(`/reach web search ${query} official sources`));
   assert.equal((await call(selected,{requestId})).status,400);
  }
  assert.equal(calls,4);
 }finally{await new Promise<void>(r=>server.close(()=>r()));approvals.cancel();store.close();rmSync(root,{recursive:true,force:true});}
});

test('Codex and Claude desktop roles receive the working scoped FFD research command',async()=>{
 const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{},warmDesktop:()=>{}} as any,approvals);
 const owner='tg:123';store.set('control-channel','telegram');store.set('telegram-owner',owner);router.pump=()=>{};
 router.reach=async(command,current)=>{assert.ok(current());return `Public research from Exa web search.\n\nSynthetic source\nhttps://example.com/source\n${command}`;};
 const server=serve(store,router,{} as any,'synthetic-admin');await once(server,'listening');
 try{
  for(const [n,provider,prompt] of [['1','codex','/research Spliceai in fmcg'],['2','claude','/jobs Ai engineer in yc startups']] as const){
   const selected=store.register(`selected-${n}`,provider,randomUUID(),root);store.set('active',selected.binding.id);
   assert.equal((await store.destinationContext.run(owner,()=>router.receive({id:`${owner}:${n}`,text:prompt,ownerCommand:true,ownerIntent:true}))).status,'queued');
   const id=`${owner}:${n}`,generated=ensureFfd(root,root,selected.binding.alias,'synthetic-bridge',[],true);
   const skill=(await import('node:fs')).readFileSync(generated.skill,'utf8');assert.match(skill,/FFD research REQ/);
   assert.match(turnEnvelope(store,selected.binding,prompt,id,{skill:generated.skill,ffd:generated.ffd},[],root).body,/Use the farfromdesk skill/);
   const call=async(path:string,data?:unknown)=>{const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:`Bearer ${selected.token}`,'X-Binding-Id':selected.binding.id,'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(response.status,200);return response.json();};
   assert.match(await runFfd(['research',id],{id:selected.binding.id},call,()=>''),/https:\/\/example.com\/source/);
   assert.match(await runFfd(['research',id,'search','official'],{id:selected.binding.id},call,()=>''),/official sources/);
   await assert.rejects(runFfd(['research',id,'search','arbitrary query'],{id:selected.binding.id},call,()=>''),/Use ffd research/);
  }
 }finally{await new Promise<void>(r=>server.close(()=>r()));approvals.cancel();store.close();rmSync(root,{recursive:true,force:true});}
});
