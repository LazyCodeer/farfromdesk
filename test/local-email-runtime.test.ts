import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import { reservePort } from './test-port.js';
import {pathToFileURL} from 'node:url';

test('isolated backend starts the real broker and exposes email status without using a mailbox',async()=>{
 const windows=process.platform==='win32';if(process.platform!=='darwin'&&!windows)return;
 const root=mkdtempSync(join(tmpdir(),'ffd-email-runtime-')),state=join(root,'state'),profile=join(root,'profile');mkdirSync(state);mkdirSync(profile);
 // Windows ships the Credential Manager broker and the approval prompt as PowerShell scripts.
 const helper=windows?resolve('native/local-mail-credentials.ps1'):join(root,'keychain-broker'),approval=windows?resolve('native/local-mail-approval.ps1'):join(root,'approval');
 if(!windows){execFileSync('/usr/bin/swiftc',['native/local-mail-keychain.swift','-o',helper],{stdio:'ignore'});execFileSync('/usr/bin/swiftc',['native/local-mail-approval.swift','-o',approval],{stdio:'ignore'});}
 const port=await reservePort();
 const child=spawn(process.execPath,['--import',pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,'src/main.ts'],{cwd:resolve('.'),env:{...process.env,WSB_STATE_DIR:state,WSB_PORT:String(port),FARFROMDESK_HOME:join(root,'projects'),CODEX_HOME:profile,CLAUDE_CONFIG_DIR:join(root,'claude'),FFD_SELECTED_CODEX_HOME:profile,FFD_ISOLATED_LOCAL:'1',FFD_PORTABLE_AGENTS:'1',FFD_MAIL_KEYCHAIN_HELPER:helper,FFD_MAIL_APPROVAL_HELPER:approval},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
 try{
  const started=Date.now();while(!log.includes('FarFromDesk listening')&&child.exitCode===null&&Date.now()-started<20000)await new Promise(r=>setTimeout(r,100));
  assert.match(log,/FarFromDesk listening/);const token=readFileSync(join(state,'admin-token'),'utf8').trim();
  // The port answers before the mail runtime attaches: the broker talks to a macOS
  // keychain helper, and while it ran first a slow keychain made the whole backend
  // look dead. So this waits for the attach instead of assuming it is already done.
  const email=async()=>{const r=await fetch(`http://127.0.0.1:${port}/api/local-email`,{headers:{authorization:`Bearer ${token}`}});assert.equal(r.status,200);return await r.json() as any;};
  let result=await email();const attachStarted=Date.now();
  while(result.available!==true&&Date.now()-attachStarted<15000)await new Promise(r=>setTimeout(r,200)),result=await email();
  assert.equal(result.available,true);assert.equal(result.credentialStorage,windows?'windows-credential-manager':'macos-keychain');assert.equal(result.state,'not_configured');assert.deepEqual(result.accounts,[]);assert.equal(result.cloudConsent,false);
 }finally{const alive=()=>child.exitCode===null&&child.signalCode===null;if(alive()){const exited=once(child,'exit');child.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,4000))]);if(alive()){child.kill('SIGKILL');await exited;}}rmSync(root,{recursive:true,force:true});}
});
