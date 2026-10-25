import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultStateDirectory,nativeCommand } from '../src/platform.js';
import { exactSession } from '../src/portable-native.js';
import { acquireServiceLock } from '../src/service-lock.js';
import { ClaudeSDKSession } from '../src/claude-sdk-session.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('platform paths preserve the Mac installation and use private per-user locations',()=>{
  assert.equal(defaultStateDirectory('darwin','/Users/test',{}),'/Users/test/Library/Application Support/WhatsApp Session Bridge');
  assert.equal(defaultStateDirectory('win32','C:\\Users\\test',{LOCALAPPDATA:'C:\\Users\\test\\AppData\\Local'}),'C:\\Users\\test\\AppData\\Local\\FarFromDesk');
  assert.equal(defaultStateDirectory('linux','/home/test',{XDG_DATA_HOME:'/tmp/private-data'}),'/tmp/private-data/farfromdesk');
});
test('Windows npm shims run known CLI JavaScript directly, without a command shell',()=>{
  const args=['app-server','value & never a shell'];
  const path='C:\\Users\\Owner Name\\AppData\\Roaming\\npm';
  const script=path+'\\node_modules\\@openai\\codex\\bin\\codex.js';
  const result=nativeCommand('codex',args,'win32',{PATH:path},file=>file===script);
  assert.equal(result.binary,process.execPath);assert.deepEqual(result.args,[script,...args]);
  assert.throws(()=>nativeCommand('claude.cmd',[],'win32',{PATH:path},()=>false),/executable unavailable/);
});
test('Windows native executable discovery preserves paths with spaces',()=>{
  const exe='C:\\Users\\Owner Name\\.local\\bin\\claude.exe';
  assert.deepEqual(nativeCommand(exe,['--version'],'win32',{},p=>p===exe),{binary:exe,args:['--version']});
});
test('desktop launches can find the native Unix CLI without a shell profile',()=>{
  const command=nativeCommand('claude',['--version'],'darwin',{PATH:'/usr/bin:/bin',HOME:'/Users/test'},p=>p==='/Users/test/.local/bin/claude');
  assert.equal(command.binary,'/Users/test/.local/bin/claude');assert.deepEqual(command.args,['--version']);
});
test('exact session verification rejects a substituted identity or project before a turn',()=>{
  const expected={id:'exact',cwd:'/project'};
  exactSession(expected,{id:'exact',cwd:'/project'},p=>p);
  assert.throws(()=>exactSession(expected,{id:'similar',cwd:'/project'},p=>p),/identity|session ID/);
  assert.throws(()=>exactSession(expected,{id:'exact',cwd:'/other'},p=>p),/project changed/);
});
test('a second backend cannot acquire the same live state directory',()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-lock-'));
  try {
    const release=acquireServiceLock(root);
    assert.throws(()=>acquireServiceLock(root),/already running/);
    release();const next=acquireServiceLock(root);next();
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('a crashed backend releases its service lock without stale-PID cleanup',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-crash-lock-'));
  const module=new URL('../src/service-lock.ts',import.meta.url).href;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',
    'const {acquireServiceLock}=await import(process.argv[1]);acquireServiceLock(process.argv[2]);process.stdout.write("locked");setInterval(()=>{},1000);',module,root],
    {cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:['ignore','pipe','pipe']});
  const ended=once(child,'exit');
  try {
    await Promise.race([once(child.stdout,'data'),ended.then(()=>{throw new Error('Child exited before locking');}),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('Child lock timed out')),10000).unref())]);
    assert.throws(()=>acquireServiceLock(root),/already running/);
    child.kill('SIGKILL');await ended;
    const release=acquireServiceLock(root);release();
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}rmSync(root,{recursive:true,force:true});}
});
test('public Claude SDK transport retains exact resume identity and forwards native permission decisions',async()=>{
  const calls:any[]=[];let closed=0;
  const query:any=(input:any)=>{calls.push(input);return {async *[Symbol.asyncIterator](){
    assert.equal((await input.options.canUseTool('Write',{path:'result.txt'})).behavior,'deny');
    yield {type:'result',subtype:'success',is_error:false,session_id:'exact',result:'Ready'};
  },close(){closed++;}};};
  const session=new ClaudeSDKSession(process.execPath,'/project','exact',false,async()=>false,{},query);
  assert.equal(await session.run('First'),'Ready');assert.equal(await session.run('Second'),'Ready');
  assert.equal(calls[0].options.sessionId,'exact');assert.equal(calls[1].options.resume,'exact');
  assert.equal(calls[0].options.permissionMode,'default');assert.equal(calls[0].options.forkSession,false);
  assert.deepEqual(calls[0].options.settingSources,['user','project','local']);assert.equal(closed,2);session.close();
});
test('public Claude SDK stops when the native session identity differs',async()=>{
  let closed=false;
  const query:any=()=>({async *[Symbol.asyncIterator](){yield {type:'system',session_id:'wrong'};},close(){closed=true;}});
  const session=new ClaudeSDKSession(process.execPath,'/project','exact',true,async()=>false,{},query);
  await assert.rejects(session.run('Request'),/different session identity/);assert.equal(closed,true);session.close();
});
