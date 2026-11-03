import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** A stand-in for the real CLI: one session event, then a finished run with text. */
function fakeDsh(dir:string,text:string) {
  const file=join(dir,'dsh');
  writeFileSync(file,`#!/bin/sh
cat >/dev/null
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
    assert.equal((f.store.get(`deepseek-session:${dir}`)),'fake-dsh-session-1');
  }finally{
    f.close();
    if(previous===undefined)delete process.env.DSH_BIN;else process.env.DSH_BIN=previous;
    rmSync(dir,{recursive:true,force:true});
  }
});