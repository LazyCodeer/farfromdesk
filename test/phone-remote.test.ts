import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:https';
import {checkServerIdentity} from 'node:tls';
import {randomUUID} from 'node:crypto';
import {RemotePasswordAccess,type PasswordRecord} from '../src/remote-desktop/access.js';
import {phoneServer} from '../src/remote-desktop/phone-server.js';
import {localPhoneCertificate,privateIPv4} from '../src/remote-desktop/phone-service.js';
import type {OwnerBackend} from '../src/owner-view/session.js';

test('phone listener accepts private IPv4 only for network selection',()=>{
 for(const a of ['10.1.2.3','172.16.0.1','172.31.255.255','192.168.1.5','100.64.0.1','100.101.2.3','100.127.255.254'])assert.ok(privateIPv4(a));
 for(const a of ['127.0.0.1','0.0.0.0','8.8.8.8','172.32.1.1','100.63.0.1','100.128.0.1','192.168.1.999','192.168.1.5\ninject'])assert.equal(privateIPv4(a),false);
});

test('real HTTPS phone route: authentication, selected frame, control, reauthentication and Stop', {skip:process.platform==='win32'}, async()=>{
 const tls=await localPhoneCertificate('127.0.0.1');
 let record:PasswordRecord|undefined,actions=0,stops=0,available=true;
 const access=new RemotePasswordAccess({load:()=>record,save:r=>{record=r;}});
 await access.setPassword('synthetic phone test password');access.enable(true);access.setReady(true);
 const backend=():OwnerBackend=>({ready:async()=>available,capture:async()=>({png:'synthetic',width:200,height:100,captureId:'capture',controls:'Scratch',fields:[{id:'note',label:'Scratch note',token:'native-only'}]}),act:async()=>{actions++;},stop:()=>{stops++;}});
 const viewer=phoneServer({tls,address:'127.0.0.1',access,backend,onStop:()=>viewer.stop()});
 const origin=await viewer.listen();
 const call=(path:string,data?:unknown,headers:Record<string,string>={})=>new Promise<{status:number;data:any;cookie?:string}>((resolve,reject)=>{
  const req=request(origin+path,{ca:tls.cert,checkServerIdentity:(_host,cert)=>checkServerIdentity('127.0.0.1',cert),method:data===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers}},res=>{
   let text='';res.on('data',c=>{text+=c;});res.on('end',()=>{let value:any=text;try{value=JSON.parse(text);}catch{}resolve({status:res.statusCode!,data:value,cookie:res.headers['set-cookie']?.[0]});});
  });req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
 });
 try{
  assert.equal((await call('/')).status,200);
  assert.equal((await call('/api/status')).status,404);
  assert.equal((await call('/frame',{})).status,409);
  assert.equal((await call('/login',{password:'wrong'})).data.error,'INCORRECT_PASSWORD');
  assert.equal((await call('/login',{password:'synthetic phone test password'},{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await call('/',undefined,{Host:'evil.invalid'})).status,403);
  const login=await call('/login',{password:'synthetic phone test password'});
  assert.equal(login.status,200);assert.match(login.cookie!,/Secure; HttpOnly; SameSite=Strict/);
  const headers={Cookie:login.cookie!.split(';')[0]};
  const frame=(await call('/frame',{},headers)).data;
  assert.deepEqual(frame.fields,[{id:'note',label:'Scratch note'}]);assert.equal(frame.expiresAt,null);
  const action={id:randomUUID(),frameId:frame.frameId,kind:'click',x:.25,y:.75};
  assert.equal((await call('/action',action,headers)).data.dispatched,true);
  assert.equal((await call('/action',action,headers)).status,409);assert.equal(actions,1);
  const next=(await call('/frame',{},headers)).data;
  assert.equal((await call('/action',{id:randomUUID(),frameId:next.frameId,kind:'type',text:'phone scratch',fieldId:'note'},headers)).status,200);
  assert.equal(actions,2);
  const second=await call('/login',{password:'synthetic phone test password'});
  assert.equal((await call('/frame',{},headers)).status,409);
  const secondHeaders={Cookie:second.cookie!.split(';')[0]};
  available=false;
  assert.equal((await call('/frame',{},secondHeaders)).data.error,'DESKTOP_UNAVAILABLE_OR_PERMISSION_REVOKED');
  available=true;
  const third=await call('/login',{password:'synthetic phone test password'});
  const thirdHeaders={Cookie:third.cookie!.split(';')[0]};
  assert.equal((await call('/stop',{},thirdHeaders)).status,200);
  assert.equal(access.status.ready,false);assert.ok(stops>=3);
 }finally{viewer.stop();}
});

test('Stop while a password check is pending cannot create a late phone session',{skip:process.platform==='win32'},async()=>{
 const tls=await localPhoneCertificate('127.0.0.1');let record:PasswordRecord|undefined,created=0;
 const access=new RemotePasswordAccess({load:()=>record,save:r=>{record=r;}});
 await access.setPassword('synthetic phone password');access.enable(true);access.setReady(true);
 let release!:()=>void;const held=new Promise<void>(r=>{release=r;});let reached!:()=>void;const ready=new Promise<void>(r=>{reached=r;});
 const authenticate=access.authenticate.bind(access);access.authenticate=async p=>{reached();await held;return authenticate(p);};
 const viewer=phoneServer({tls,address:'127.0.0.1',access,backend:()=>{created++;throw Error('must not create');},onStop:()=>{}});
 const origin=await viewer.listen();
 const pending=new Promise<void>(resolve=>{const req=request(origin+'/login',{method:'POST',ca:tls.cert,headers:{Origin:origin,'Content-Type':'application/json'}},r=>{r.resume();r.on('end',resolve);});req.on('error',()=>resolve());req.end(JSON.stringify({password:'synthetic phone password'}));});
 await ready;viewer.stop();release();await pending;await new Promise(r=>setTimeout(r,30));assert.equal(created,0);assert.equal(access.status.connected,false);
});
