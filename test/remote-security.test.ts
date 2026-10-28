import test from 'node:test';
import assert from 'node:assert/strict';
import {RemotePasswordAccess,type PasswordRecord} from '../src/remote-desktop/access.js';
import {PhoneRemoteService} from '../src/remote-desktop/phone-service.js';
import {P2PHost} from '../src/remote-p2p/host.js';

// Reproductions from the 0.9.1 release review (16cea6a), inverted: each must now hold.
const pw='synthetic-review-password';
const frame={jpeg:new Uint8Array([1,2,3]),width:100,height:100,captureId:'fixture'};
const delay=()=>new Promise(r=>setTimeout(r,10));
const backend=()=>({ready:async()=>true as boolean|'locked',capture:async()=>frame,act:async(_f?:unknown,_i?:any)=>{},stop(){}});
async function access(){let record:PasswordRecord|undefined;const a=new RemotePasswordAccess({load:()=>record,save:r=>record=r});await a.setPassword(pw);a.enable(true);a.setReady(true);return a;}
function session(b:any,token:string){
 const messages:any[]=[],frames:any[]=[];
 const s:any={id:'fixture',pc:{close:async()=>{}},control:{readyState:'open',send:(raw:string)=>messages.push(JSON.parse(raw))},frames:{bufferedAmount:0,send:(raw:any)=>frames.push(raw)},
  abort:new AbortController(),token,backend:b,authing:false,locked:false,epoch:0,activeAt:Date.now(),attempts:0,misses:0,frameId:1,frame,pulling:false,seen:new Set(),queue:Promise.resolve()};
 return {s,messages,frames};
}

test('a password changed through the local preview ends P2P logins that share the record',{timeout:30_000},async()=>{
 let record:PasswordRecord|undefined;const store={load:()=>record,save:(r:PasswordRecord)=>record=r};
 const local=new PhoneRemoteService(store),p2p=new RemotePasswordAccess(store);
 try{
  await local.command({action:'password',password:pw});p2p.enable(true);p2p.setReady(true);
  const token=await p2p.authenticate(pw);assert.doesNotThrow(()=>p2p.authorize(token));
  await local.command({action:'password',password:'changed-synthetic-password'});
  assert.throws(()=>p2p.authorize(token),/ACCESS_ENDED/);
  // A check already running when the password changes does not hand out a token.
  const pending=p2p.authenticate('changed-synthetic-password');
  record={...record!,hash:Buffer.alloc(64).toString('base64')}; // another instance saves a new password mid-check
  await assert.rejects(pending,/MAC_UNAVAILABLE/);
 }finally{local.stop();p2p.stop();}
});

test('a capture in flight when the phone pauses sends no pixels',{timeout:30_000},async()=>{
 const a=await access();let done!:(f:any)=>void;const b=backend();b.capture=()=>new Promise(r=>done=r);
 const host:any=new P2PHost({access:a,backend:()=>b});const {s,frames}=session(b,await a.authenticate(pw));host.session=s;
 try{
  const pending=host.onControl(s,JSON.stringify({t:'ready',frameId:1}));while(!done)await delay();
  await host.onControl(s,JSON.stringify({t:'pause'}));done(frame);await pending;
  assert.equal(s.paused,true);assert.equal(s.token,undefined);assert.equal(frames.length,0);
 }finally{host.stop('TEST_DONE');}
});

test('a key queued before a pause never runs after the password brings the session back',{timeout:30_000},async()=>{
 const a=await access(),old=backend(),fresh=backend(),acts:any[]=[];fresh.act=async(_f,input)=>{acts.push(input);};
 const host:any=new P2PHost({access:a,backend:()=>fresh});const {s,frames}=session(old,await a.authenticate(pw));host.session=s;
 try{
  let unblock!:()=>void;s.queue=new Promise<void>(r=>unblock=r);
  const pending=host.onControl(s,JSON.stringify({t:'input',id:'old-key-0001',frameId:1,kind:'key',key:'a'}));
  await host.onControl(s,JSON.stringify({t:'pause'}));
  const login=host.onControl(s,JSON.stringify({t:'auth',password:pw}));while(!s.backend)await delay();
  unblock();await Promise.all([pending,login]);
  assert.equal(acts.length,0);
  // The new login itself still delivers its first frame, and a later pull is not stuck.
  assert.ok(frames.length>0);assert.equal(s.pulling,false);
 }finally{host.stop('TEST_DONE');}
});

test('voice is refused unless the Mac answers positively that it is unlocked',{timeout:30_000},async()=>{
 for(const state of [false,'locked'] as const){
  const a=await access(),b=backend();b.ready=async()=>state;let calls=0;
  const host:any=new P2PHost({access:a,backend:()=>b,transcriber:{engine:'cloud',transcribe:async()=>{calls++;return 'fixture';}}});
  const {s,messages}=session(b,await a.authenticate(pw));host.session=s;
  try{
   await host.onControl(s,JSON.stringify({t:'voice',id:'voice1',seq:0,mime:'audio/webm',data:'AAAA',last:true}));
   assert.equal(calls,0,String(state));
   assert.equal(messages.find(m=>m.t==='voice-fail')?.error,state==='locked'?'MAC_LOCKED':'MAC_UNAVAILABLE');
  }finally{host.stop('TEST_DONE');}
 }
});

test('a capture cancelled by a pause ends neither the paused session nor the one the password brings back',{timeout:30_000},async()=>{
 for(const relogin of [false,true]){
  const a=await access(),old=backend();let fail!:(e:Error)=>void;old.capture=()=>new Promise((_r,reject)=>fail=reject);
  const host:any=new P2PHost({access:a,backend:backend});const {s,frames}=session(old,await a.authenticate(pw));host.session=s;
  try{
   const pending=host.onControl(s,JSON.stringify({t:'ready',frameId:1}));while(!fail)await delay();
   await host.onControl(s,JSON.stringify({t:'pause'}));
   // The new login queues behind the old capture, which a real driver rejects once the pause aborts it.
   const login=relogin?host.onControl(s,JSON.stringify({t:'auth',password:pw})):undefined;if(relogin)while(!s.backend)await delay();
   fail(Error('capture cancelled by pause'));await pending;await login;await s.queue;
   assert.equal(host.session,s,String(relogin));assert.equal(host.status.state==='ended',false);
   assert.equal(!!s.token,relogin);assert.equal(frames.length>0,relogin);
  }finally{host.stop('TEST_DONE');}
 }
});

test('a revoked login cannot act or receive a frame before the 2s watch notices',{timeout:30_000},async()=>{
 const a=await access(),b=backend();let acts=0;b.act=async()=>{acts++;};
 const host:any=new P2PHost({access:a,backend:()=>b});const {s,frames,messages}=session(b,await a.authenticate(pw));host.session=s;
 try{
  a.stop();
  await host.onControl(s,JSON.stringify({t:'input',id:'revoked-0001',frameId:1,kind:'key',key:'a'}));
  assert.equal(acts,0);assert.equal(frames.length,0);
  assert.equal(messages.find(m=>m.t==='ended')?.reason,'ACCESS_ENDED');
 }finally{host.stop('TEST_DONE');}
});

test('a login revoked while a capture is running sends no pixels',{timeout:30_000},async()=>{
 const a=await access();let done!:(f:any)=>void;const b=backend();b.capture=()=>new Promise(r=>done=r);
 const host:any=new P2PHost({access:a,backend:()=>b});const {s,frames}=session(b,await a.authenticate(pw));host.session=s;
 try{
  const pending=host.onControl(s,JSON.stringify({t:'ready',frameId:1}));while(!done)await delay();
  a.stop();done(frame);await pending;
  assert.equal(frames.length,0);assert.equal(host.status.reason,'ACCESS_ENDED');
 }finally{host.stop('TEST_DONE');}
});

test('asking for a link to something else is not taken as a screen request',async()=>{
 const {RemoteControlService}=await import('../src/remote-p2p/service.js');
 const svc=new RemoteControlService({status:{passwordSet:false},enable(){}} as any);
 for(const text of ['Send me the remote access details for the prod server','Give me the desktop link for the new build','Give me a computer access link, then rotate the staging keys',
  'give me screen access please ask Codex for an update','send me a remote link now and summarize my tasks','give me remote access i will check the logs'])
  assert.equal(await svc.chat(text),undefined,text);
 for(const text of ['send me the screen link','give me remote access please','give me screen access, thanks','control my screen'])assert.notEqual(await svc.chat(text),undefined,text);
});

test('a new password set in the app lifts a phone lockout from the old one',{timeout:60_000},async()=>{
 let record:PasswordRecord|undefined;const store={load:()=>record,save:(r:PasswordRecord)=>record=r};
 const local=new PhoneRemoteService(store),p2p=new RemotePasswordAccess(store);
 try{
  await local.command({action:'password',password:pw});p2p.enable(true);p2p.setReady(true);
  for(let i=0;i<5;i++)await assert.rejects(p2p.authenticate('wrong-synthetic-password'),/INCORRECT_PASSWORD/);
  await assert.rejects(p2p.authenticate(pw),/WAIT_BEFORE_RETRY/);
  await local.command({action:'password',password:'fresh-synthetic-password'});p2p.enable(true);
  assert.ok(await p2p.authenticate('fresh-synthetic-password'));
 }finally{local.stop();p2p.stop();}
});
