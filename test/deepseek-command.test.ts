import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Approvals } from '../src/approvals.js';
import { WhatsApp } from '../src/whatsapp.js';
import { GuardedSocket } from '../src/wa-guard.js';
import { isOwnerCommand } from '../src/owner-commands.js';

const owner='123@s.whatsapp.net';

/** `/deepseek` is advertised by /help, so the owner chat must route it to the DeepSeek runner. */
function fixture(workspace:string) {
  const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const binding=store.register('codex-master','codex','11111111-1111-4111-8111-111111111111','/synthetic','channel').binding;
  store.set('whatsapp-owner',owner);store.set('active',binding.id);store.set('master',binding.id);store.set('deepseek-workspace',workspace);
  const sends:any[]=[];
  const sock=new GuardedSocket({sendMessage:async(jid:string,content:any)=>{sends.push({jid,content});return {message:{conversation:content.text}};},relayMessage:async(jid:string,message:any)=>{sends.push({jid,message});},end:()=>{}} as any,{owners:()=>[owner],ownedGroup:()=>false});
  const wa=new WhatsApp(store,router);wa.sock=sock;wa.status='connected';wa.selfJid=owner;wa.owners=[owner];
  const msg=(id:string,text:string)=>({key:{id,fromMe:true,remoteJid:owner},message:{conversation:text}});
  const replies=()=>(store.db.prepare('SELECT body FROM outbox ORDER BY rowid').all() as {body:string}[]).map(r=>r.body);
  return {store,router,wa,sends,msg,replies,close:()=>{wa.close();approvals.cancel();store.close();}};
}

/** A stand-in for the real CLI: it keeps the prompt, then emits one session event and one answer. */
function fakeDsh(dir:string,text:string) {
  const file=join(dir,'dsh');
  writeFileSync(file,`#!/bin/sh
cat > "${dir}/prompt.txt"
echo '{"type":"session","sessionId":"fake-dsh-session-1","cwd":"${dir}"}'
echo '{"type":"final","text":${JSON.stringify(text)}}'
`);
  chmodSync(file,0o755);
  return file;
}

test('the owner command gate accepts /deepseek, which /help advertises',()=>{
  assert.equal(isOwnerCommand('/deepseek'),true);
  assert.equal(isOwnerCommand('/deepseek fix the failing test'),true);
});

test('bare /deepseek answers with the DeepSeek prompt instead of the unknown-command guidance',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'deepseek-cmd-'));
  const f=fixture(dir);try{
    await f.wa.receiveMessage(f.msg('D1','/deepseek'));
    const bodies=f.replies();
    assert.equal(bodies.some(b=>b.includes('Tell me what you need in ordinary words')),false);
    assert.match(bodies.at(-1)!,new RegExp(`^DeepSeek Harness is ready in ${basename(dir)}\\.`));
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});

test('/deepseek with a task runs DeepSeek in the chosen folder and keeps its session id',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'deepseek-cmd-'));
  const previous=process.env.DSH_BIN;
  process.env.DSH_BIN=fakeDsh(dir,'Hello from the fake DeepSeek.');
  const f=fixture(dir);try{
    await f.wa.receiveMessage(f.msg('D2','/deepseek Say hello'));
    const last=f.replies().at(-1)!;
    assert.match(last,/Hello from the fake DeepSeek\./);
    assert.equal((f.store.get(`deepseek-session:${dir}:default`)),'fake-dsh-session-1');
  }finally{
    f.close();
    if(previous===undefined)delete process.env.DSH_BIN;else process.env.DSH_BIN=previous;
    rmSync(dir,{recursive:true,force:true});
  }
});
/** A stand-in for a run that never finishes: the prompt is consumed, then the process fails. */
function failingDsh(dir:string) {
  const file=join(dir,'dsh-fail');
  writeFileSync(file,`#!/bin/sh
cat > "${dir}/failed-prompt.txt"
echo '{"type":"error","message":"the provider refused"}' >&2
exit 1
`);
  chmodSync(file,0o755);
  return file;
}

const promptFile=(dir:string,name='prompt.txt')=>{try{return readFileSync(join(dir,name),'utf8');}catch{return '';}};

test('/deepseek new opens a separate labelled conversation, and /deepseek list shows it',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'deepseek-label-'));
  const previous=process.env.DSH_BIN;
  process.env.DSH_BIN=fakeDsh(dir,'Answer one.');
  const f=fixture(dir);try{
    await f.wa.receiveMessage(f.msg('L1','/deepseek Say hello'));
    assert.equal(f.store.get(`deepseek-session:${dir}:default`),'fake-dsh-session-1','the default conversation kept its id');
    await f.wa.receiveMessage(f.msg('L2','/deepseek new notes'));
    assert.match(f.replies().at(-1)!,/fresh DeepSeek session in `notes`/);
    assert.equal(f.store.get(`deepseek-session:${dir}:notes`),'','the new label starts with no session');
    await f.wa.receiveMessage(f.msg('L3','/deepseek list'));
    const list=f.replies().at(-1)!;
    assert.match(list,/`default`/);
    assert.match(list,/`notes`/);
    assert.match(list,/▶ `notes`/,'the active label is marked');
    assert.equal(f.store.get(`deepseek-active-label:${dir}`),'notes');
  }finally{
    f.close();
    if(previous===undefined)delete process.env.DSH_BIN;else process.env.DSH_BIN=previous;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('a message sent to another session is carried into that session next turn, never twice',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'deepseek-send-'));
  const state=mkdtempSync(join(tmpdir(),'deepseek-state-'));
  const previousBin=process.env.DSH_BIN,previousState=process.env.WSB_STATE_DIR;
  process.env.DSH_BIN=fakeDsh(dir,'Noted.');
  process.env.WSB_STATE_DIR=state;
  const f=fixture(dir);try{
    await f.wa.receiveMessage(f.msg('S1','/deepseek send notes Please check the build 2399.'));
    const queued=f.replies().at(-1)!;
    assert.match(queued,/Queued for `notes` as `deepseek-/);
    assert.match(queued,/local write, not delivery/,'the reply does not claim the other session read it');
    await f.wa.receiveMessage(f.msg('S2','/deepseek use notes'));
    await f.wa.receiveMessage(f.msg('S3','/deepseek Look at the queue'));
    const carried=promptFile(dir);
    assert.match(carried,/Message from the owner \(deepseek-[a-z0-9-]+\):/);
    assert.match(carried,/Please check the build 2399\./);
    assert.match(carried,/Please check the build 2399\.[\s\S]*Look at the queue\n\n\[FarFromDesk\]/,'the task follows the message');
    await f.wa.receiveMessage(f.msg('S4','/deepseek inbox'));
    assert.match(f.replies().at(-1)!,/received · deepseek-/,'a finished turn settles the message as received');
    await f.wa.receiveMessage(f.msg('S5','/deepseek Second task.'));
    assert.doesNotMatch(promptFile(dir),/Message from the owner/,'a settled message is never carried again');
  }finally{
    f.close();
    if(previousBin===undefined)delete process.env.DSH_BIN;else process.env.DSH_BIN=previousBin;
    if(previousState===undefined)delete process.env.WSB_STATE_DIR;else process.env.WSB_STATE_DIR=previousState;
    rmSync(dir,{recursive:true,force:true});rmSync(state,{recursive:true,force:true});
  }
});

test('a turn that fails leaves the carried message unknown, and says so',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'deepseek-unknown-'));
  const state=mkdtempSync(join(tmpdir(),'deepseek-state-'));
  const previousBin=process.env.DSH_BIN,previousState=process.env.WSB_STATE_DIR;
  process.env.DSH_BIN=failingDsh(dir);
  process.env.WSB_STATE_DIR=state;
  const f=fixture(dir);try{
    await f.wa.receiveMessage(f.msg('U1','/deepseek send notes The build is red.'));
    await f.wa.receiveMessage(f.msg('U2','/deepseek use notes'));
    await f.wa.receiveMessage(f.msg('U3','/deepseek Check it'));
    const failed=f.replies().at(-1)!;
    assert.match(failed,/DeepSeek Harness exited with code 1/,'a failed turn is reported, not answered');
    assert.match(failed,/provider refused/,'the measured reason reaches the owner');
    await f.wa.receiveMessage(f.msg('U4','/deepseek inbox'));
    const inbox=f.replies().at(-1)!;
    assert.match(inbox,/unknown · deepseek-/,'an uncertain delivery is reported as unknown');
    assert.match(promptFile(dir,'failed-prompt.txt'),/The build is red\./,'the turn that failed still carried it');
  }finally{
    f.close();
    if(previousBin===undefined)delete process.env.DSH_BIN;else process.env.DSH_BIN=previousBin;
    if(previousState===undefined)delete process.env.WSB_STATE_DIR;else process.env.WSB_STATE_DIR=previousState;
    rmSync(dir,{recursive:true,force:true});rmSync(state,{recursive:true,force:true});
  }
});

test('WhatsApp sends a file and a screenshot the owner asked for as real media, not just the caption',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-wa-media-'));const f=fixture(dir);
  try{
    assert.equal(f.store.outputFile(owner,'direct-file:t',Buffer.from('hello'),'note.txt','Your file'),true);
    assert.equal(f.store.outputPhoto(owner,'direct-shot:t',await (await import('sharp')).default({create:{width:4,height:4,channels:3,background:'#fff'}}).png().toBuffer(),'Screenshot'),true);
    for(let i=0;i<3;i++)await f.wa.flush();
    assert.equal(f.sends.find(s=>s.content?.document)?.content.fileName,'note.txt');
    assert.equal(f.sends.find(s=>s.content?.image)?.content.caption,'Screenshot');
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});
