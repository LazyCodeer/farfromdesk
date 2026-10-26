import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,symlinkSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DesktopStarts,readStartReceipt } from '../src/desktop-start.js';
import { claudeDesktopHistory } from '../src/session-catalog.js';
import { desktopOwnedPids,executionMode } from '../src/desktop-claude.js';
const parent='11111111-1111-4111-a111-111111111111',child='22222222-2222-4222-a222-222222222222';
function fixture() {
  const cwd=realpathSync(mkdtempSync(join(tmpdir(),'tether-desktop-test-'))),store=new Store(':memory:');
  const binding=store.register('new-desktop','claude','33333333-3333-4333-a333-333333333333',cwd).binding;
  let sends=0;
  const native={catalog:async()=>({sessions:[{id:parent,cwd,executionMode:'desktop',available:true,detached:true},{id:child,cwd,executionMode:'desktop',available:true,detached:true}]}),sendDesktopCreation:async(_id:string,file:string)=>{
    sends++;assert.equal(_id,parent);const text=readFileSync(file,'utf8');assert.match(text,/mcp__ccd_session__start_session/);assert.doesNotMatch(text,/"initiation":"user_asked"/);assert.match(text,/detach_session/);assert.match(text,/"use_worktree":false/);assert.doesNotMatch(text,/"permission_mode"/);
  }};
  const starts=new DesktopStarts(store,native as any,0);
  const receipts=(ready=true,id=child)=>{const op=starts.get(binding.id)!;writeFileSync(join(cwd,'.tether-desktop-created.json'),JSON.stringify({nonce:op.nonce,sessionId:id,detached:true}));if(ready)writeFileSync(join(cwd,'.tether-desktop-ready.json'),JSON.stringify({nonce:op.nonce,ready:true}));};
  return {cwd,store,binding,native,starts,receipts,sends:()=>sends,close:()=>{starts.close();store.close();rmSync(cwd,{recursive:true,force:true});}};
}
test('desktop classification requires app ancestry; bundled executable in terminal is not Desktop',()=>{
  const rows='10 1 /Applications/Claude.app/Contents/MacOS/Claude\n20 10 /bundle/claude\n21 20 /child\n30 1 /bin/zsh\n40 30 /bundle/claude\n50 51 /loop\n51 50 /loop';
  assert.deepEqual([...desktopOwnedPids(rows)],[10,20,21]);
  assert.equal(executionMode('claude','desktop'),'desktop');assert.equal(executionMode('claude',undefined),'cli');
  assert.equal(executionMode('codex','desktop'),'desktop');assert.throws(()=>executionMode('claude','other'));
});
test('submission alone stays uncertain; later exact child acknowledgment recovers without resend',async()=>{
  const f=fixture();try {
    await assert.rejects(f.starts.create(f.binding,parent,'Test','No project work.'),/acknowledgment/);
    assert.equal(f.starts.get(f.binding.id)?.status,'uncertain');assert.equal(f.sends(),1);
    f.receipts(false);await assert.rejects(f.starts.confirm(f.binding),/acknowledgment/);
    await assert.rejects(f.starts.create(f.binding,parent,'Test','No work'),/already/);
    f.receipts();await f.starts.confirm(f.binding);assert.equal(f.store.binding(f.binding.id)?.native_id,child);assert.equal(f.sends(),1);assert.equal(f.starts.get(f.binding.id)?.status,'ready');
  }finally{f.close();}
});
test('CLI session, missing launcher and wrong child folder cannot satisfy desktop creation',async()=>{
  const f=fixture();try {
    await assert.rejects(f.starts.parent(undefined),/No owner-connected/);
    f.native.catalog=async()=>({sessions:[{id:parent,cwd:f.cwd,executionMode:'cli',available:true}]});
    await assert.rejects(f.starts.create(f.binding,parent,'Test','No work'),/reachable/);assert.equal(f.sends(),0);
    f.native.catalog=async()=>({sessions:[{id:parent,cwd:f.cwd,executionMode:'desktop',available:true,detached:true},{id:child,cwd:'/',executionMode:'desktop',available:true,detached:true}]});
    await assert.rejects(f.starts.create(f.binding,parent,'Test','No work'),/acknowledgment/);f.receipts();await assert.rejects(f.starts.confirm(f.binding),/different project/);
  }finally{f.close();}
});
test('a mismatched ready acknowledgment cannot trigger a detach recovery message',async()=>{
  const f=fixture();try {
    await assert.rejects(f.starts.create(f.binding,parent,'Test','No work'),/acknowledgment/);
    f.receipts();
    writeFileSync(join(f.cwd,'.tether-desktop-ready.json'),JSON.stringify({nonce:f.starts.get(f.binding.id)!.nonce,ready:true,sessionId:parent}));
    f.native.catalog=async()=>({sessions:[{id:child,cwd:f.cwd,executionMode:'desktop',available:true,detached:false}]});
    await assert.rejects(f.starts.confirm(f.binding,true),/different session/);
    assert.equal(f.sends(),1);assert.equal(f.starts.get(f.binding.id)?.detachSubmitted,undefined);
  }finally{f.close();}
});
test('nonce substitution, own parent ID, proposal IDs and receipt symlinks are rejected',async()=>{
  for(const id of [parent,'task_abcd1234']) {
    const f=fixture();try{await assert.rejects(f.starts.create(f.binding,parent,'Test','No work'));f.receipts(true,id);await assert.rejects(f.starts.confirm(f.binding),/exact session/);}finally{f.close();}
  }
  const f=fixture();try {
    await assert.rejects(f.starts.create(f.binding,parent,'Test','No work'));
    const receipt=join(f.cwd,'.tether-desktop-created.json');writeFileSync(receipt,JSON.stringify({nonce:'wrong',sessionId:child}));
    await assert.rejects(f.starts.confirm(f.binding),/different operation/);
    const alias=join(f.cwd,'alias');symlinkSync(receipt,alias);assert.throws(()=>readStartReceipt(alias),/regular local file/);
    writeFileSync(receipt,'a'.repeat(4097));assert.throws(()=>readStartReceipt(receipt),/invalid/);
  }finally{f.close();}
});
test('native refusal, stopped service and abandoned setup never start another child',async()=>{
  const f=fixture();try {
    await assert.rejects(f.starts.create(f.binding,parent,'Test','No work'));
    writeFileSync(join(f.cwd,'.tether-desktop-created.json'),JSON.stringify({nonce:f.starts.get(f.binding.id)!.nonce,error:'Needs native permission'}));
    await assert.rejects(f.starts.confirm(f.binding),/folder-access/);assert.equal(f.sends(),1);
    f.receipts();f.store.set(`desktop-abandoned:${f.binding.id}`,'true');await assert.rejects(f.starts.confirm(f.binding),/paused/);assert.notEqual(f.store.binding(f.binding.id)?.native_id,child);
    f.starts.close();await assert.rejects(f.starts.confirm(f.binding),/paused/);
  }finally{f.close();}
});

test('saved Desktop catalog spans accounts and projects, preserves unavailable rows and excludes private payloads',async()=>{
  const f=fixture();try {
    const root=join(f.cwd,'history'),one=join(root,'account','org'),two=join(root,'other','org');mkdirSync(one,{recursive:true});mkdirSync(two,{recursive:true});
    const appId='local_11111111-1111-4111-a111-111111111111';
    const file=join(one,appId+'.json');writeFileSync(file,JSON.stringify({sessionId:appId,cliSessionId:child,cwd:f.cwd,title:'Design work',lastActivityAt:1792000000000,remoteMcpServersConfig:[{token:'PRIVATE'}],pendingSystemReminder:'PRIVATE'}));
    const otherId='local_22222222-2222-4222-a222-222222222222';writeFileSync(join(two,otherId+'.json'),JSON.stringify({sessionId:otherId,cwd:'/another/project',title:'Old task',isArchived:true,lastActivityAt:1791000000000}));
    symlinkSync(file,join(two,'local_33333333-3333-4333-a333-333333333333.json'));
    let rows=await claudeDesktopHistory(root);assert.equal(rows.length,2);assert.equal(rows[0].id,child);assert.equal(rows[0].desktopId,appId);assert.equal(rows[0].available,false);assert.match(rows[1].status,/Archived/);assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|remoteMcp|pendingSystem/);
    rows[0].name='tampered';assert.equal((await claudeDesktopHistory(root))[0].name,'Design work');
    writeFileSync(file,JSON.stringify({sessionId:appId,cliSessionId:child,cwd:f.cwd,title:'Renamed project',lastActivityAt:1793000000000}));assert.equal((await claudeDesktopHistory(root))[0].name,'Renamed project');
  }finally{f.close();}
});
test('native Desktop local_ identity resolves to its separate messaging UUID before binding',async()=>{
  const f=fixture();try {
    const desktopId='local_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    f.native.catalog=async()=>({sessions:[{id:parent,cwd:f.cwd,executionMode:'desktop',available:true,detached:true},{id:child,desktopId,cwd:f.cwd,executionMode:'desktop',available:true,detached:true}]});
    await assert.rejects(f.starts.create(f.binding,parent,'Test','No work'),/acknowledgment/);
    f.receipts(true,desktopId);await f.starts.confirm(f.binding);assert.equal(f.store.binding(f.binding.id)?.native_id,child);
  }finally{f.close();}
});


test('new Desktop sessions reuse only owner-connected launchers and stop for account ambiguity',async()=>{
 const f=fixture();try {
  const launcher=f.store.register('launcher','claude',parent,f.cwd).binding;
  f.store.set(`execution-mode:${launcher.id}`,'desktop');f.store.set('selected',JSON.stringify([launcher.id]));
  assert.equal((await f.starts.parent(undefined)).id,parent);
  f.store.enable(launcher.id,false);await assert.rejects(f.starts.parent(undefined),/No owner-connected/);
  f.store.enable(launcher.id,true);
  const second=f.store.register('second','claude',child,f.cwd).binding;f.store.set(`execution-mode:${second.id}`,'desktop');f.store.set('selected',JSON.stringify([launcher.id,second.id]));
  f.native.catalog=async()=>({sessions:[{id:parent,cwd:f.cwd,executionMode:'desktop',available:true,detached:true,accountScope:'a'},{id:child,cwd:f.cwd,executionMode:'desktop',available:true,detached:true,accountScope:'b'}]}) as any;
  await assert.rejects(f.starts.parent(undefined),/different accounts/);assert.equal(f.sends(),0);
 }finally{f.close();}
});


test('launcher account is checked before activating a saved Desktop chat',async()=>{
 const f=fixture();try {
  let opens=0;(f.native as any).activation={ready:async(s:any)=>{opens++;return s;}};
  f.native.catalog=async()=>({sessions:[{id:parent,cwd:f.cwd,executionMode:'desktop',available:true,detached:true,accountScope:'other',activation:'desktop-open'}]}) as any;
  await assert.rejects(f.starts.parent(parent,'owner'),/account changed/);assert.equal(opens,0);assert.equal(f.sends(),0);
 }finally{f.close();}
});


test('Desktop runtime detection does not claim new-session readiness without a launcher',async()=>{
 const f=fixture();try {
  const rows=(await f.native.catalog()).sessions as any;
  assert.equal(f.starts.readiness(rows).state,'needs-launcher');
  assert.equal(f.starts.readiness(rows,parent).state,'ready');
  rows[0].activation='desktop-open';assert.equal(f.starts.readiness(rows,parent).state,'needs-opening');
 }finally{f.close();}
});

test('created child waits for verified native detachment and never repeats creation',async()=>{
 const f=fixture();try {
  await assert.rejects(f.starts.create(f.binding,parent,'Test','Initialize only'),/acknowledgment/);
  f.receipts();
  f.native.catalog=async()=>({sessions:[{id:parent,cwd:f.cwd,executionMode:'desktop',available:true,detached:true},{id:child,cwd:f.cwd,executionMode:'desktop',available:true,detached:false}]});
  await assert.rejects(f.starts.confirm(f.binding),/detachment/);
  assert.notEqual(f.store.binding(f.binding.id)?.native_id,child);assert.equal(f.sends(),1);
  let scans=0;f.native.catalog=async()=>(scans++,{sessions:[{id:parent,cwd:f.cwd,executionMode:'desktop',available:true,detached:true},{id:child,cwd:f.cwd,executionMode:'desktop',available:true,detached:true}]});
  await f.starts.confirm(f.binding);assert.equal(f.store.binding(f.binding.id)?.native_id,child);assert.equal(f.sends(),1);
  assert.equal(scans,1,'Child verification reuses its catalog scan for account and folder checks');
 }finally{f.close();}
});

test('detach recovery submits only an exact-child detach instruction once',async()=>{
 const f=fixture();try {
  await assert.rejects(f.starts.create(f.binding,parent,'Test','Initialize only'),/acknowledgment/);f.receipts();
  f.native.catalog=async()=>({sessions:[{id:parent,cwd:f.cwd,executionMode:'desktop',available:true,detached:true},{id:child,cwd:f.cwd,executionMode:'desktop',available:true,detached:false}]});
  let detaches=0;
  f.native.sendDesktopCreation=async(id,file)=>{detaches++;assert.equal(id,parent);const prompt=readFileSync(file,'utf8');assert.match(prompt,/Do not create any session/);assert.ok(prompt.includes(child));assert.doesNotMatch(prompt,/mcp__ccd_session__start_session/);};
  await assert.rejects(f.starts.confirm(f.binding,true),/detachment/);
  await assert.rejects(f.starts.confirm(f.binding,true),/detachment/);
  assert.equal(detaches,1);assert.equal(f.sends(),1);
 }finally{f.close();}
});

test('native proposal is durable needs-action; owner-started child resumes without recreating',async()=>{
 const f=fixture();try {
  await assert.rejects(f.starts.create(f.binding,parent,'Test','Initialize only'),/acknowledgment/);
  const op=f.starts.get(f.binding.id)!;
  writeFileSync(join(f.cwd,'.tether-desktop-created.json'),JSON.stringify({nonce:op.nonce,proposalId:'task_probe',needsOwnerAction:true}));
  await assert.rejects(f.starts.confirm(f.binding),/needs owner action/);
  assert.equal(f.starts.get(f.binding.id)?.status,'needs_action');assert.equal(f.starts.get(f.binding.id)?.proposalId,'task_probe');
  await assert.rejects(f.starts.create(f.binding,parent,'Test','Again'),/already/);assert.equal(f.sends(),1);
  writeFileSync(join(f.cwd,'.tether-desktop-ready.json'),JSON.stringify({nonce:op.nonce,ready:true,sessionId:child}));
  await f.starts.confirm(f.binding,true);assert.equal(f.store.binding(f.binding.id)?.native_id,child);assert.equal(f.sends(),1);
 }finally{f.close();}
});


test('workspace receipt files are isolated per operation and recovery never resends creation',async()=>{
  const f=fixture();try {
    const support=join(f.cwd,'.farfromdesk','coordinators','attempt');mkdirSync(support,{recursive:true});
    f.store.set(`master-support:${f.binding.id}`,support);
    writeFileSync(join(f.cwd,'.tether-desktop-created.json'),JSON.stringify({nonce:'old',sessionId:parent}));
    await assert.rejects(f.starts.create(f.binding,parent,'Workspace coordinator','No task.'),/acknowledgment/);
    const op=f.starts.get(f.binding.id)!;
    assert.equal(op.supportDir,support);
    const prompt=readFileSync(join(support,'.tether-desktop-start.txt'),'utf8');
    assert.match(prompt,/Respect existing project instructions/);assert.doesNotMatch(prompt,/newly created empty/);
    writeFileSync(join(support,'.tether-desktop-created.json'),JSON.stringify({nonce:op.nonce,sessionId:child,detached:true}));
    writeFileSync(join(support,'.tether-desktop-ready.json'),JSON.stringify({nonce:op.nonce,ready:true,sessionId:child}));
    await f.starts.confirm(f.binding,true);assert.equal(f.sends(),1);assert.equal(f.starts.get(f.binding.id)?.status,'ready');
  }finally{f.close();}
});

test('native cross-workspace refusal is surfaced immediately without retrying',async()=>{
  const f=fixture();try {
    await assert.rejects(f.starts.create(f.binding,parent,'Test','No task.'),/acknowledgment/);
    const op=f.starts.get(f.binding.id)!;
    writeFileSync(join(f.cwd,'.tether-desktop-created.json'),JSON.stringify({nonce:op.nonce,error:'user_asked starts cannot be requested by another session message outside this project'}));
    await assert.rejects(f.starts.confirm(f.binding),/native rules require a direct owner request/);assert.equal(f.sends(),1);
  }finally{f.close();}
});


test('workspace launcher lookup includes later catalog pages',async()=>{
  const f=fixture();try {
    f.native.catalog=(async(_provider:any,cursor:any)=>cursor?{sessions:[{id:parent,cwd:f.cwd,executionMode:'desktop',available:true}]}:{sessions:[],cursor:'page-two'}) as any;
    assert.equal((await f.starts.parent(parent)).id,parent);
  }finally{f.close();}
});


test('creation rechecks the saved workspace account before sending',async()=>{
  const f=fixture();try {
    f.store.set(`session-route:${f.binding.id}`,JSON.stringify({accountScope:'original'}));
    f.native.catalog=async()=>({sessions:[{id:parent,cwd:f.cwd,executionMode:'desktop',available:true,accountScope:'changed'}]}) as any;
    await assert.rejects(f.starts.create(f.binding,parent,'Test','No task.'),/account changed/);
    assert.equal(f.sends(),0);assert.equal(f.starts.get(f.binding.id),null);
  }finally{f.close();}
});
