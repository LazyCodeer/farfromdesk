import test from 'node:test';
import assert from 'node:assert/strict';
import {RTCPeerConnection} from 'werift';
import {RemotePasswordAccess,type PasswordRecord} from '../src/remote-desktop/access.js';
import {P2PHost} from '../src/remote-p2p/host.js';
import {CONTROL_CHANNEL,FRAME_CHANNEL,FrameAssembler,MAC_IDLE_MS,OFFER_TTL_MS,PAGE_URL,PAUSE_MS,type DesktopBackend,type Input,type MacMessage} from '../src/remote-p2p/protocol.js';
import {decodeSignal,encodeSignal,sdpToSignal,signalToSdp} from '../src/remote-p2p/signal-codec.js';

const PASSWORD='synthetic p2p test password';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function access(){
 let record:PasswordRecord|undefined;
 const a=new RemotePasswordAccess({load:()=>record,save:r=>{record=r;}});await a.setPassword(PASSWORD);a.enable(true);return a;
}
function fakeBackend(){
 const jpeg=Uint8Array.from({length:40_000},(_,i)=>i%251);
 const b={acts:[] as Input[],stops:0,captures:0,throwOnAct:false as false|string,failCaptures:0,
  ready:async()=>true,capture:async()=>{b.captures++;if(b.failCaptures>0){b.failCaptures--;throw Error('CAPTURE_UNAVAILABLE');}return {jpeg,width:1440,height:900,captureId:'c'+b.captures};},
  act:async(_f:unknown,input:Input)=>{if(b.throwOnAct)throw Error(b.throwOnAct);b.acts.push(input);},stop:()=>{b.stops++;}};
 return b as typeof b&DesktopBackend;
}
/** The phone: a plain RTCPeerConnection that only sees the offer code. */
async function phone(code:string){
 const offer=decodeSignal(code),pc=new RTCPeerConnection({iceServers:[{urls:[]}]} as any);
 const control=pc.createDataChannel(CONTROL_CHANNEL.label,{negotiated:true,id:CONTROL_CHANNEL.id,ordered:true});
 const frames=pc.createDataChannel(FRAME_CHANNEL.label,{negotiated:true,id:FRAME_CHANNEL.id,ordered:true});
 await pc.setRemoteDescription({type:'offer',sdp:signalToSdp(offer)});
 await pc.setLocalDescription(await pc.createAnswer());
 while(pc.iceGatheringState!=='complete')await sleep(20);
 const messages:MacMessage[]=[],shown:{frameId:number;width:number;height:number;jpeg:Uint8Array}[]=[],assembler=new FrameAssembler();
 control.onMessage.subscribe(d=>messages.push(JSON.parse(String(d))));
 frames.onMessage.subscribe(d=>{const f=assembler.push(d as Buffer);if(f)shown.push(f);});
 const wait=async(pred:()=>unknown,ms=8000)=>{const end=Date.now()+ms;while(!pred()){if(Date.now()>end)throw Error('timeout');await sleep(20);}};
 const opened=()=>wait(()=>control.readyState==='open');
 const send=(m:unknown)=>control.send(JSON.stringify(m));
 return {pc,control,messages,shown,wait,opened,send,answer:encodeSignal(sdpToSignal(pc.localDescription!.sdp,'answer',offer.s))};
}

test('signal codec roundtrip, SDP shape and strict validation',()=>{
 const sdp=['v=0','a=ice-ufrag:abcd','a=ice-pwd:0123456789abcdefghijkl','a=fingerprint:sha-256 '+Array(32).fill('ab').join(':'),
  'a=candidate:c1072fffb510748794b924869 1 udp 2116026367 192.168.1.5 5000 typ host generation 0 ufrag abcd','a=candidate:2 1 TCP 1 192.168.1.5 9 typ host tcptype active',
  'a=candidate:3 1 UDP 1677729535 1.2.3.4 6000 typ srflx raddr 0.0.0.0 rport 0','a=candidate:4 1 udp 2 0b5e1c2a-1111-2222-3333-444455556666.local 7000 typ host'].join('\r\n');
 const s=sdpToSignal(sdp,'offer','abcdefghijklmnop',123);
 assert.deepEqual(s.c,['1 1 udp 2116026367 192.168.1.5 5000 typ host','2 1 udp 1677729535 1.2.3.4 6000 typ srflx','3 1 udp 2 0b5e1c2a-1111-2222-3333-444455556666.local 7000 typ host']);
 assert.equal(s.f,Array(32).fill('AB').join(':'));
 const code=encodeSignal(s);assert.match(code,/^[A-Za-z0-9_-]+$/);assert.ok(code.length<600,String(code.length));
 assert.deepEqual(decodeSignal(code),s);
 const out=signalToSdp(s);assert.match(out,/a=setup:actpass/);assert.match(out,/a=end-of-candidates\r\n$/);assert.doesNotMatch(out,/tcp|ice-options/i);
 assert.match(signalToSdp({...s,r:'answer',e:undefined}),/a=setup:active/);
 for(const bad of [{...s,v:2},{...s,s:'short'},{...s,c:[]},{...s,c:['1 1 udp 1 1.2.3.4 5 typ host\r\na=evil']},{...s,f:'ab'},{...s,e:undefined},{...s,r:'answer'},{...s,x:1},{...s,p:'short'}])
  assert.throws(()=>decodeSignal(encodeSignal(bad as any)),/INVALID_SIGNAL/);
 assert.throws(()=>decodeSignal('not base64!'),/INVALID_SIGNAL/);assert.throws(()=>decodeSignal('e30'),/INVALID_SIGNAL/);
});

test('real werift loopback: password, frames, input rules, stop',{timeout:20_000},async()=>{
 const a=await access(),backend=fakeBackend();let backends=0;
 const host=new P2PHost({access:a,backend:()=>{backends++;return backend;},stun:[]});
 const offer=await host.createOffer();
 assert.equal(offer.link,PAGE_URL+'#'+offer.code);assert.equal(host.status.state,'offered');assert.equal(a.status.ready,true);
 const p=await phone(offer.code);
 await assert.rejects(host.acceptAnswer(encodeSignal({...decodeSignal(p.answer),s:'zzzzzzzzzzzzzzzz'})),/ANSWER_REFUSED/);
 await host.acceptAnswer(p.answer);
 await assert.rejects(host.acceptAnswer(p.answer),/ANSWER_REFUSED/); // once per offer
 try{
  await p.opened();await p.wait(()=>host.status.state==='connected');
  p.send({t:'auth',password:'wrong password'});
  await p.wait(()=>p.messages.length===1);assert.deepEqual(p.messages[0],{t:'auth-fail',error:'INCORRECT_PASSWORD'});
  assert.equal(p.control.readyState,'open');assert.equal(backends,0);
  p.send({t:'auth',password:PASSWORD});
  await p.wait(()=>p.shown.length===1);
  const ok=p.messages[1] as any;assert.equal(ok.t,'auth-ok');assert.equal(ok.width,1440);assert.match(ok.resume,/^[A-Za-z0-9_-]{32}$/);
  assert.equal(p.shown[0].frameId,1);assert.equal(p.shown[0].jpeg.length,40_000);assert.equal(p.shown[0].jpeg[1000],1000%251);
  p.send({t:'ready',frameId:1});await p.wait(()=>p.shown.length===2);assert.equal(p.shown[1].frameId,2);
  const acks=(id:string)=>p.messages.filter((m:any)=>m.t==='ack'&&m.id===id);
  const click={t:'input',id:'click-0001',frameId:2,kind:'click',x:.25,y:.5};
  p.send(click);await p.wait(()=>acks('click-0001').length===1);
  assert.deepEqual(acks('click-0001')[0],{t:'ack',id:'click-0001',ok:true});
  assert.equal(backend.acts.length,1);assert.deepEqual(backend.acts[0],click);
  p.send(click);await p.wait(()=>acks('click-0001').length===2);
  assert.deepEqual(acks('click-0001')[1],{t:'ack',id:'click-0001',ok:false,error:'DUPLICATE_INPUT'});
  // The frame just before the newest is still accepted (the phone shows it while the next is in flight).
  p.send({...click,id:'click-0002',frameId:1});await p.wait(()=>acks('click-0002').length);
  assert.deepEqual(acks('click-0002')[0],{t:'ack',id:'click-0002',ok:true});
  p.send({...click,id:'click-0004',frameId:0});await p.wait(()=>acks('click-0004').length);
  assert.deepEqual(acks('click-0004')[0],{t:'ack',id:'click-0004',ok:false,error:'STALE_FRAME'});
  p.send({...click,id:'click-0003',x:2});await p.wait(()=>acks('click-0003').length);
  assert.equal((acks('click-0003')[0] as any).error,'INVALID_COORDINATES');
  assert.equal(backend.acts.length,2);
  p.send({t:'stop'});
  await p.wait(()=>p.messages.some(m=>m.t==='ended'));
  assert.deepEqual(host.status,{state:'ended',session:undefined,reason:'STOPPED_BY_PHONE',resumable:false});
  assert.equal(backend.stops,1);assert.equal(a.status.connected,false);
 }finally{host.stop('TEST_DONE');await p.pc.close();}
});

test('backend act throwing ends the session instead of retrying',{timeout:20_000},async()=>{
 const a=await access(),backend=fakeBackend();backend.throwOnAct='boom';
 const host=new P2PHost({access:a,backend:()=>backend,stun:[]});
 const p=await phone((await host.createOffer()).code);await host.acceptAnswer(p.answer);
 try{
  await p.opened();p.send({t:'auth',password:PASSWORD});await p.wait(()=>p.shown.length===1);
  p.send({t:'input',id:'key-00001',frameId:1,kind:'key',key:'return'});
  await p.wait(()=>p.messages.some(m=>m.t==='ended'));
  assert.ok(p.messages.some(m=>m.t==='ack'&&!m.ok&&m.error==='ACTION_FAILED'));
  assert.equal(host.status.reason,'ACTION_FAILED');assert.equal(backend.stops,1);assert.equal(a.status.connected,false);
 }finally{host.stop('TEST_DONE');await p.pc.close();}
});

test('expired offer is refused; new offer replaces and stop ends it',{timeout:20_000},async()=>{
 let now=1_000_000;const a=await access();
 const host=new P2PHost({access:a,backend:fakeBackend,stun:[],now:()=>now});
 const first=await host.createOffer();
 const p=await phone(first.code);
 now+=OFFER_TTL_MS+1;
 await assert.rejects(host.acceptAnswer(p.answer),/OFFER_EXPIRED/);
 assert.equal(host.status.reason,'OFFER_EXPIRED');
 const second=await host.createOffer();assert.notEqual(second.session,first.session);
 await assert.rejects(host.acceptAnswer(p.answer),/ANSWER_REFUSED/);
 host.stop('OWNER_STOPPED');assert.deepEqual(host.status,{state:'ended',session:undefined,reason:'OWNER_STOPPED',resumable:false});
 await p.pc.close();
});

test('a refused action keeps the session and a brief capture failure is retried',{timeout:20_000},async()=>{
 const a=await access(),backend=fakeBackend();backend.failCaptures=2;
 const host=new P2PHost({access:a,backend:()=>backend,stun:[]});
 const p=await phone((await host.createOffer()).code);await host.acceptAnswer(p.answer);
 try{
  await p.opened();p.send({t:'auth',password:PASSWORD});await p.wait(()=>p.shown.length===1);
  assert.equal(backend.captures,3);
  backend.throwOnAct='DESKTOP_NATIVE_REFUSED: nothing was sent';
  p.send({t:'input',id:'scroll-0001',frameId:1,kind:'scroll',x:.5,y:.5,direction:'down',amount:2});
  await p.wait(()=>p.messages.some(m=>m.t==='ack'));
  assert.ok(p.messages.some(m=>m.t==='ack'&&!m.ok&&m.error==='ACTION_REFUSED'));
  assert.equal(host.status.state,'connected');assert.equal(p.messages.some(m=>m.t==='ended'),false);
 }finally{host.stop('TEST_DONE');await p.pc.close();}
});

test('the readiness probe never runs while an input is in flight',{timeout:20_000},async()=>{
 const a=await access(),backend=fakeBackend();let busy=false,overlaps=0,probes=0;
 backend.ready=async()=>{probes++;if(busy)overlaps++;return true;};
 backend.act=async(_f:unknown,input:Input)=>{busy=true;await sleep(2500);busy=false;backend.acts.push(input);};
 const host=new P2PHost({access:a,backend:()=>backend,stun:[]});
 const p=await phone((await host.createOffer()).code);await host.acceptAnswer(p.answer);
 try{
  await p.opened();p.send({t:'auth',password:PASSWORD});await p.wait(()=>p.shown.length===1);
  const before=probes;
  p.send({t:'input',id:'click-slow1',frameId:1,kind:'click',x:.5,y:.5});
  await p.wait(()=>p.messages.some(m=>m.t==='ack'),6000);await p.wait(()=>probes>before,4000);
  assert.equal(overlaps,0);assert.equal(backend.acts.length,1);
 }finally{host.stop('TEST_DONE');await p.pc.close();}
});

test('a dropped phone gets a new link and resumes without the password, once',{timeout:30_000},async()=>{
 const a=await access(),links:string[]=[];
 const host=new P2PHost({access:a,backend:fakeBackend,stun:[],onReconnect:l=>links.push(l)});
 const first=await phone((await host.createOffer()).code);await host.acceptAnswer(first.answer);
 let second:Awaited<ReturnType<typeof phone>>|undefined,third:Awaited<ReturnType<typeof phone>>|undefined;
 try{
  await first.opened();first.send({t:'auth',password:PASSWORD});await first.wait(()=>first.shown.length===1);
  const secret=(first.messages.find(m=>m.t==='auth-ok') as any).resume;
  await first.pc.close();
  await first.wait(()=>links.length===1,15_000);
  assert.equal(host.status.state,'offered');assert.equal(host.status.resumable,true);
  second=await phone(links[0].split('#')[1]);await host.acceptAnswer(second.answer);await second.opened();
  second.send({t:'resume',secret});await second.wait(()=>second!.shown.length===1);
  const renewed=(second.messages.find(m=>m.t==='auth-ok') as any).resume;assert.notEqual(renewed,secret);
  // The old secret is single use; stopping on purpose forgets the kept login.
  host.stop('STOPPED');assert.equal(host.status.resumable,false);
  third=await phone((await host.createOffer()).code);await host.acceptAnswer(third.answer);await third.opened();
  third.send({t:'resume',secret:renewed});await third.wait(()=>third!.messages.some(m=>m.t==='resume-fail'));
  assert.equal(third.shown.length,0);
 }finally{host.stop('TEST_DONE');await first.pc.close();await second?.pc.close();await third?.pc.close();}
});

test('desktops: the phone can list and switch the main display desktops',{timeout:20_000},async()=>{
 const a=await access(),backend=fakeBackend() as ReturnType<typeof fakeBackend>&{desktops:()=>Promise<{count:number;current:number}>};
 backend.desktops=async()=>({count:2,current:1});
 const host=new P2PHost({access:a,backend:()=>backend,stun:[]});
 const p=await phone((await host.createOffer()).code);await host.acceptAnswer(p.answer);
 try{
  await p.opened();p.send({t:'auth',password:PASSWORD});await p.wait(()=>p.shown.length===1);
  assert.equal((p.messages.find(m=>m.t==='auth-ok') as any).desktops,true);
  p.send({t:'desktops'});await p.wait(()=>p.messages.some(m=>m.t==='desktops'));
  assert.deepEqual(p.messages.find(m=>m.t==='desktops'),{t:'desktops',count:2,current:1});
  p.send({t:'input',id:'desk-00001',frameId:1,kind:'desktop',index:2});await p.wait(()=>p.messages.some(m=>m.t==='ack'));
  assert.deepEqual(backend.acts.at(-1),{t:'input',id:'desk-00001',frameId:1,kind:'desktop',index:2});
  for(const index of [0,17,1.5,'2'])p.send({t:'input',id:'desk-bad-'+String(index).replace('.','p').padEnd(2,'x'),frameId:1,kind:'desktop',index});
  await p.wait(()=>p.messages.filter(m=>m.t==='ack'&&!m.ok&&m.error==='INVALID_DESKTOP').length===4);
  assert.equal(backend.acts.length,1);assert.equal(host.status.state,'connected');
 }finally{host.stop('TEST_DONE');await p.pc.close();}
});

test('a locked Mac keeps the session, input still goes through, and the phone hears lock and unlock',{timeout:30_000},async()=>{
 const a=await access(),backend=fakeBackend();let state:boolean|'locked'=true;
 backend.ready=async()=>state;
 const host=new P2PHost({access:a,backend:()=>backend,stun:[]});
 const p=await phone((await host.createOffer()).code);await host.acceptAnswer(p.answer);
 try{
  await p.opened();p.send({t:'auth',password:PASSWORD});await p.wait(()=>p.shown.length===1);
  state='locked';await p.wait(()=>p.messages.some(m=>m.t==='locked'&&m.locked),5000);
  await sleep(7000);assert.equal(host.status.state,'connected');assert.ok(!p.messages.some(m=>m.t==='ended'));
  p.send({t:'input',id:'type-locked1',frameId:1,kind:'type',text:'x'});
  await p.wait(()=>p.messages.some(m=>m.t==='ack'&&(m as any).id==='type-locked1'));assert.equal(backend.acts.at(-1)?.kind,'type');
  state=true;await p.wait(()=>p.messages.some(m=>m.t==='locked'&&!m.locked),5000);
  assert.equal(p.messages.filter(m=>m.t==='locked').length,2);
 }finally{host.stop('TEST_DONE');await p.pc.close();}
});

test('voice: pieces are joined and transcribed, and nothing reaches the transcriber while the Mac is locked',{timeout:30_000},async()=>{
 const a=await access(),backend=fakeBackend();let state:boolean|'locked'=true;const heard:{bytes:number;mime:string}[]=[];
 backend.ready=async()=>state;
 const transcriber={engine:'cloud' as const,transcribe:async(audio:Buffer,mime:string)=>{heard.push({bytes:audio.length,mime});return 'hello from voice';}};
 const host=new P2PHost({access:a,backend:()=>backend,stun:[],transcriber});
 const p=await phone((await host.createOffer()).code);await host.acceptAnswer(p.answer);
 const audio=Buffer.from(Array.from({length:15000},(_,i)=>i%256)),b64=audio.toString('base64'),pieces:string[]=[];
 for(let i=0;i<b64.length;i+=8000)pieces.push(b64.slice(i,i+8000));
 const say=(id:string)=>pieces.forEach((data,seq)=>p.send({t:'voice',id,seq,mime:'audio/webm',data,last:seq===pieces.length-1}));
 const reply=(id:string)=>p.wait(()=>p.messages.find(m=>(m.t==='voice-text'||m.t==='voice-fail')&&(m as any).id===id)).then(()=>p.messages.find(m=>(m as any).id===id) as any);
 try{
  await p.opened();p.send({t:'auth',password:PASSWORD});await p.wait(()=>p.shown.length===1);
  assert.equal((p.messages.find(m=>m.t==='auth-ok') as any).voice,'cloud');
  say('v1');const ok=await reply('v1');assert.equal(ok.t,'voice-text');assert.equal(ok.text,'hello from voice');assert.deepEqual(heard,[{bytes:15000,mime:'audio/webm'}]);
  // Locked before the phone sends: refused on the first piece.
  state='locked';await p.wait(()=>p.messages.some(m=>m.t==='locked'&&m.locked),5000);
  say('v2');const no=await reply('v2');assert.equal(no.t,'voice-fail');assert.equal(no.error,'MAC_LOCKED');
  // Locked while recording, before the 2s probe noticed: the fresh check at the end refuses it.
  state=true;await p.wait(()=>p.messages.some(m=>m.t==='locked'&&!m.locked),5000);
  pieces.slice(0,-1).forEach((data,seq)=>p.send({t:'voice',id:'v3',seq,mime:'audio/webm',data,last:false}));
  await sleep(200);state='locked';p.send({t:'voice',id:'v3',seq:pieces.length-1,mime:'audio/webm',data:pieces.at(-1),last:true});
  const late=await reply('v3');assert.equal(late.error,'MAC_LOCKED');
  assert.equal(heard.length,1);
  // Bad pieces are refused without ending the session.
  state=true;p.send({t:'voice',id:'v4',seq:0,mime:'video/mp4',data:'AAAA',last:true});assert.equal((await reply('v4')).error,'INVALID_VOICE');
  assert.equal(host.status.state,'connected');
 }finally{host.stop('TEST_DONE');await p.pc.close();}
});

test('voice: a host without a transcriber says nothing about voice',{timeout:20_000},async()=>{
 const a=await access(),host=new P2PHost({access:a,backend:()=>fakeBackend(),stun:[]});
 const p=await phone((await host.createOffer()).code);await host.acceptAnswer(p.answer);
 try{await p.opened();p.send({t:'auth',password:PASSWORD});await p.wait(()=>p.messages.some(m=>m.t==='auth-ok'));assert.equal((p.messages.find(m=>m.t==='auth-ok') as any).voice,undefined);}
 finally{host.stop('TEST_DONE');await p.pc.close();}
});

test('idle: the Mac closes an untouched session, activity keeps it, and an idle drop needs the password again',{timeout:40_000},async()=>{
 const a=await access(),links:string[]=[];let clock=Date.now();
 const host=new P2PHost({access:a,backend:fakeBackend,stun:[],now:()=>clock,onReconnect:l=>links.push(l)});
 const login=async(code:string)=>{const p=await phone(code);await host.acceptAnswer(p.answer);await p.opened();return p;};
 const ps:Awaited<ReturnType<typeof phone>>[]=[];
 try{
  const p=await login((await host.createOffer()).code);ps.push(p);p.send({t:'auth',password:PASSWORD});await p.wait(()=>p.shown.length===1);
  assert.equal((p.messages.find(m=>m.t==='auth-ok') as any).idle,MAC_IDLE_MS);
  // 'active' and input both count; just under the limit after each, the session stays.
  clock+=MAC_IDLE_MS-10_000;p.send({t:'active'});await sleep(2500);assert.equal(host.status.state,'connected');
  clock+=MAC_IDLE_MS-10_000;p.send({t:'input',id:'key-idle1',frameId:1,kind:'key',key:'a'});await sleep(2500);assert.equal(host.status.state,'connected');
  clock+=MAC_IDLE_MS+1000;await p.wait(()=>p.messages.some(m=>m.t==='ended'),5000);
  assert.equal((p.messages.find(m=>m.t==='ended') as any).reason,'IDLE_TIMEOUT');assert.equal(host.status.resumable,false);
  // The phone's own countdown ending is reported as idle too.
  const q=await login((await host.createOffer()).code);ps.push(q);q.send({t:'auth',password:PASSWORD});await q.wait(()=>q.shown.length===1);
  q.send({t:'stop',idle:true});await q.wait(()=>q.messages.some(m=>m.t==='ended'));assert.equal((q.messages.find(m=>m.t==='ended') as any).reason,'IDLE_TIMEOUT');
  // Dropped after sitting untouched: the kept login can't be resumed once the idle limit has passed.
  const r=await login((await host.createOffer()).code);ps.push(r);r.send({t:'auth',password:PASSWORD});await r.wait(()=>r.shown.length===1);
  const secret=(r.messages.find(m=>m.t==='auth-ok') as any).resume;
  // Untouched for most of the limit, then dropped; the new link is still fresh when it's opened.
  clock+=MAC_IDLE_MS-60_000;await r.pc.close();await r.wait(()=>links.length===1,15_000);
  clock+=120_000;
  const back=await login(links[0].split('#')[1]);ps.push(back);back.send({t:'resume',secret});
  await back.wait(()=>back.messages.some(m=>m.t==='resume-fail'));assert.equal(back.shown.length,0);
 }finally{host.stop('TEST_DONE');for(const x of ps)await x.pc.close();}
});

test('pause: screen off logs the phone out on the same connection, the password brings it back',{timeout:40_000},async()=>{
 const a=await access(),links:{link:string;password:boolean}[]=[];let clock=Date.now(),stops=0;
 const backend=()=>{const b=fakeBackend();const stop=b.stop;b.stop=()=>{stops++;stop();};return b;};
 const host=new P2PHost({access:a,backend,stun:[],now:()=>clock,onReconnect:(link,password)=>links.push({link,password})});
 const login=async(code:string)=>{const p=await phone(code);await host.acceptAnswer(p.answer);await p.opened();p.send({t:'auth',password:PASSWORD});await p.wait(()=>p.shown.length===1);return p;};
 const ps:Awaited<ReturnType<typeof phone>>[]=[];
 try{
  const p=await login((await host.createOffer()).code);ps.push(p);const secret=(p.messages.find(m=>m.t==='auth-ok') as any).resume;
  p.send({t:'pause'});await p.wait(()=>stops===1);
  assert.equal(host.status.state,'connected');assert.equal(host.status.resumable,false);
  // Late frames and taps from before the pause are dropped, not executed, and don't end the session; the old secret is dead.
  p.send({t:'ready',frameId:1});p.send({t:'input',id:'key-paused1',frameId:1,kind:'key',key:'a'});p.send({t:'resume',secret});
  await p.wait(()=>p.messages.some(m=>m.t==='resume-fail'));assert.equal(p.messages.some(m=>m.t==='ack'),false);
  p.send({t:'auth',password:'wrong'});await p.wait(()=>p.messages.some(m=>m.t==='auth-fail'));
  // Still waiting well past the 2-minute login limit; the right password carries on with a fresh frame.
  clock+=5*60_000;await sleep(2500);assert.equal(host.status.state,'connected');
  p.send({t:'auth',password:PASSWORD});await p.wait(()=>p.shown.length===2);
  assert.equal(p.messages.filter(m=>m.t==='auth-ok').length,2);
  // A pause nobody comes back to ends as idle.
  p.send({t:'pause'});await p.wait(()=>stops===2);clock+=PAUSE_MS+1000;
  await p.wait(()=>p.messages.some(m=>m.t==='ended'),5000);assert.equal((p.messages.find(m=>m.t==='ended') as any).reason,'IDLE_TIMEOUT');
  // Dropped while paused: a new link, and it says the password is needed.
  const q=await login((await host.createOffer()).code);ps.push(q);q.send({t:'pause'});await q.wait(()=>stops===3);
  await q.pc.close();await q.wait(()=>links.length===1,15_000);assert.equal(links[0].password,true);assert.equal(host.status.resumable,false);
 }finally{host.stop('TEST_DONE');for(const x of ps)await x.pc.close();}
});

test('review fixes: one login per connection, a login deadline, one transcription at a time, lock state at login',{timeout:40_000},async()=>{
 const a=await access();let clock=Date.now(),release:()=>void=()=>{};
 const transcriber={engine:'local' as const,transcribe:()=>new Promise<string>(r=>{release=()=>r('done');})};
 const backend=fakeBackend();backend.ready=async()=>'locked';
 const host=new P2PHost({access:a,backend:()=>backend,stun:[],now:()=>clock,transcriber});
 const ps:Awaited<ReturnType<typeof phone>>[]=[];
 const connect=async()=>{const p=await phone((await host.createOffer()).code);ps.push(p);await host.acceptAnswer(p.answer);await p.opened();return p;};
 try{
  // Locked at login: the phone hears it in auth-ok, before any 2s probe.
  const p=await connect();p.send({t:'auth',password:PASSWORD});p.send({t:'resume',secret:'anything-at-all'});
  await p.wait(()=>p.shown.length===1);
  assert.equal(p.messages.filter(m=>m.t==='auth-ok').length,1);assert.equal((p.messages.find(m=>m.t==='auth-ok') as any).locked,true);
  // Never logs in: closed after the deadline.
  const q=await connect();clock+=2*60_000+1000;await q.wait(()=>q.messages.some(m=>m.t==='ended'),5000);
  assert.equal((q.messages.find(m=>m.t==='ended') as any).reason,'LOGIN_TIMEOUT');
  // A second recording while the first is still transcribing is refused.
  backend.ready=async()=>true;
  const v=await connect();v.send({t:'auth',password:PASSWORD});await v.wait(()=>v.shown.length===1);
  await sleep(2500); // let the 2s probe see the Mac unlocked
  v.send({t:'voice',id:'a1',seq:0,mime:'audio/webm',data:'AAAA',last:true});await sleep(300);
  v.send({t:'voice',id:'a2',seq:0,mime:'audio/webm',data:'AAAA',last:true});
  await v.wait(()=>v.messages.some(m=>m.t==='voice-fail'&&(m as any).id==='a2'));
  assert.equal((v.messages.find(m=>(m as any).id==='a2') as any).error,'VOICE_BUSY');
  release();await v.wait(()=>v.messages.some(m=>m.t==='voice-text'&&(m as any).id==='a1'));
 }finally{host.stop('TEST_DONE');for(const x of ps)await x.pc.close();}
});
