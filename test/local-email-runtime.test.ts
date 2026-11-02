import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {once} from 'node:events';

test('isolated backend starts the real broker and exposes email status without using a mailbox',async()=>{
 if(process.platform!=='darwin')return;
 const root=mkdtempSync(join(tmpdir(),'ffd-email-runtime-')),state=join(root,'state'),profile=join(root,'profile'),helper=join(root,'keychain-broker'),approval=join(root,'approval');mkdirSync(state);mkdirSync(profile);
 execFileSync('/usr/bin/swiftc',['native/local-mail-keychain.swift','-o',helper],{stdio:'ignore'});execFileSync('/usr/bin/swiftc',['native/local-mail-approval.swift','-o',approval],{stdio:'ignore'});
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));
 const child=spawn(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),'src/main.ts'],{cwd:resolve('.'),env:{...process.env,WSB_STATE_DIR:state,WSB_PORT:String(port),FARFROMDESK_HOME:join(root,'projects'),CODEX_HOME:profile,CLAUDE_CONFIG_DIR:join(root,'claude'),FFD_SELECTED_CODEX_HOME:profile,FFD_ISOLATED_LOCAL:'1',FFD_PORTABLE_AGENTS:'1',FFD_MAIL_KEYCHAIN_HELPER:helper,FFD_MAIL_APPROVAL_HELPER:approval},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
 try{
  const started=Date.now();while(!log.includes('FarFromDesk listening')&&child.exitCode===null&&Date.now()-started<20000)await new Promise(r=>setTimeout(r,100));
  assert.match(log,/FarFromDesk listening/);const token=readFileSync(join(state,'admin-token'),'utf8').trim();const response=await fetch(`http://127.0.0.1:${port}/api/local-email`,{headers:{authorization:`Bearer ${token}`}});assert.equal(response.status,200);const result=await response.json() as any;
  assert.equal(result.available,true);assert.equal(result.state,'not_configured');assert.deepEqual(result.accounts,[]);assert.equal(result.cloudConsent,false);
 }finally{const alive=()=>child.exitCode===null&&child.signalCode===null;if(alive()){const exited=once(child,'exit');child.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,4000))]);if(alive()){child.kill('SIGKILL');await exited;}}rmSync(root,{recursive:true,force:true});}
});
