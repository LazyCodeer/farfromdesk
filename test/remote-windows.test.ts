import test from 'node:test';
import assert from 'node:assert/strict';
import {RTCPeerConnection} from 'werift';
import {RemotePasswordAccess,type PasswordRecord} from '../src/remote-desktop/access.js';
import {P2PHost} from '../src/remote-p2p/host.js';
import {CONTROL_CHANNEL,FRAME_CHANNEL,FrameAssembler,type Input,type MacMessage} from '../src/remote-p2p/protocol.js';
import {decodeSignal,encodeSignal,sdpToSignal,signalToSdp} from '../src/remote-p2p/signal-codec.js';
import {WindowsDesktopBackend,windowsKey,type WindowsHelper} from '../src/remote-p2p/windows-desktop.js';
import {RemoteControlService,desktopBackend,remoteControlSupported} from '../src/remote-p2p/service.js';
import {NativeDesktopBackend} from '../src/remote-p2p/desktop.js';

// Runs on every OS: the helper (native/remote-windows.ps1) is replaced by a recording fake.
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const JPEG=Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.alloc(30_000,7)]);
function fakeHelper(){
 const h={sent:[] as Record<string,unknown>[],locked:false,refuse:undefined as string|undefined,stops:0,
  async request(body:Record<string,unknown>){
   h.sent.push(body);
   if(body.op==='state')return {ok:true,locked:h.locked};
   if(body.op==='capture')return {ok:true,locked:h.locked,width:1400,height:875,jpeg:JPEG.toString('base64')};
   if(h.locked)throw Error('PC_LOCKED');
   if(h.refuse)throw Error(h.refuse);
   return {ok:true};
  },
  stop(){h.stops++;}};
 return h as typeof h&WindowsHelper;
}
const input=(i:Partial<Input>):Input=>({t:'input',id:'input-0001',frameId:1,kind:'click',...i}) as Input;

test('phone keys map to Windows virtual keys; Mac shortcuts become their Windows ones',()=>{
 assert.deepEqual(windowsKey('return'),{vk:0x0d,modifiers:[]});
 assert.deepEqual(windowsKey('delete'),{vk:0x08,modifiers:[]},'the phone Delete erases backwards, like Backspace');
 assert.deepEqual(windowsKey('a'),{vk:0x41,modifiers:[]});
 assert.deepEqual(windowsKey('7'),{vk:0x37,modifiers:[]});
 assert.deepEqual(windowsKey('pagedown'),{vk:0x22,modifiers:[]});
 assert.deepEqual(windowsKey('c',['cmd']),{vk:0x43,modifiers:[0x11]},'⌘C copies with Ctrl+C');
 assert.deepEqual(windowsKey('z',['cmd','shift']),{vk:0x5a,modifiers:[0x11,0x10]});
 assert.deepEqual(windowsKey('c',['cmd','ctrl']),{vk:0x43,modifiers:[0x11]},'one Ctrl, not two');
 assert.deepEqual(windowsKey('tab',['cmd']),{vk:0x09,modifiers:[0x12]},'⌘Tab switches apps with Alt+Tab');
 assert.deepEqual(windowsKey('q',['cmd']),{vk:0x73,modifiers:[0x12]},'⌘Q quits with Alt+F4');
 assert.deepEqual(windowsKey('space',['cmd']),{vk:0x5b,modifiers:[]},'⌘Space search opens Start');
 assert.deepEqual(windowsKey('x',['option']),{vk:0x58,modifiers:[0x12]});
 assert.throws(()=>windowsKey('f13'),/INVALID_KEY/);
 assert.throws(()=>windowsKey('a',['hyper']),/INVALID_KEY/);
});

test('Windows backend sends each phone input to the helper as one request',async()=>{
 const h=fakeHelper(),b=new WindowsDesktopBackend(h),signal=new AbortController().signal;
 const frame=await b.capture(signal);
 assert.deepEqual([frame.width,frame.height],[1400,875]);
 assert.equal(Buffer.from(frame.jpeg.subarray(0,2)).toString('hex'),'ffd8');
 assert.deepEqual(h.sent[0],{op:'capture',max:1400,quality:60});
 const cases:[Partial<Input>,Record<string,unknown>][]=[
  [{kind:'click',x:.25,y:.75},{op:'mouse',x:.25,y:.75,button:'left',count:1}],
  [{kind:'double',x:.5,y:.5},{op:'mouse',x:.5,y:.5,button:'left',count:2}],
  [{kind:'right',x:.9,y:.1},{op:'mouse',x:.9,y:.1,button:'right',count:1}],
  [{kind:'scroll',x:.5,y:.5,direction:'down',amount:3},{op:'scroll',x:.5,y:.5,direction:'down',amount:3}],
  [{kind:'key',key:'return'},{op:'key',vk:0x0d,modifiers:[]}],
  [{kind:'key',key:'v',modifiers:['cmd']},{op:'key',vk:0x56,modifiers:[0x11]}],
  [{kind:'overview'},{op:'key',vk:0x09,modifiers:[0x5b]}],
  [{kind:'type',text:'héllo ✓'},{op:'text',text:'héllo ✓'}],
 ];
 for(const [i,expected] of cases){h.sent.length=0;await b.act(frame,input(i),signal);assert.deepEqual(h.sent,[expected],String(i.kind));}
 h.sent.length=0;await b.act(frame,input({kind:'type',text:'x'.repeat(450)}),signal);
 assert.deepEqual(h.sent.map(s=>String(s.text).length),[200,200,50],'long text goes in pieces');
 await assert.rejects(b.act(frame,input({kind:'desktop',index:2}),signal),/DESKTOP_NATIVE_REFUSED: DESKTOPS_UNSUPPORTED/);
 assert.equal(b.desktops,undefined,'no desktop list on Windows, so the phone hides that row');
 assert.equal(b.os,'windows');
});

test('locked or blocked input is a refusal, so the session goes on; readiness reports the lock',async()=>{
 const h=fakeHelper(),b=new WindowsDesktopBackend(h),signal=new AbortController().signal,frame=await b.capture(signal);
 assert.equal(await b.ready(true),true);
 h.locked=true;
 assert.equal(await b.ready(),true,'cached for a second, like the Mac backend');
 assert.equal(await b.ready(true),'locked');
 await assert.rejects(b.act(frame,input({kind:'type',text:'secret'}),signal),/DESKTOP_NATIVE_REFUSED: PC_LOCKED/);
 h.locked=false;h.refuse='INPUT_BLOCKED';
 await assert.rejects(b.act(frame,input({kind:'click',x:.1,y:.1}),signal),/DESKTOP_NATIVE_REFUSED: INPUT_BLOCKED/);
 h.refuse='HELPER_TIMEOUT';
 await assert.rejects(b.act(frame,input({kind:'click',x:.1,y:.1}),signal),/^Error: HELPER_TIMEOUT$/,'an unknown outcome is not a refusal');
 b.stop();assert.equal(h.stops,1);assert.equal(await b.ready(true),false,'stopped');
});

test('a capture that is not a JPEG is refused instead of sent to the phone',async()=>{
 const b=new WindowsDesktopBackend({async request(){return {ok:true,width:10,height:10,jpeg:Buffer.from('not a jpeg').toString('base64')};},stop(){}});
 await assert.rejects(b.capture(new AbortController().signal),/INVALID_JPEG/);
});

test('phone screen control is offered on macOS and Windows, with the backend for each',()=>{
 assert.equal(remoteControlSupported('darwin'),true);
 assert.equal(remoteControlSupported('win32'),true);
 assert.equal(remoteControlSupported('linux'),false);
 const win=desktopBackend('win32');assert.ok(win instanceof WindowsDesktopBackend);win.stop();
 assert.ok(desktopBackend('darwin') instanceof NativeDesktopBackend);
});

test('the chat command checks the platform and names the computer in its password prompt',async()=>{
 let record:PasswordRecord|undefined;
 const access=()=>new RemotePasswordAccess({load:()=>record,save:r=>{record=r;}});
 assert.match(await new RemoteControlService(access(),undefined,undefined,undefined,'linux').chat('control my screen')??'',/Mac and Windows/);
 assert.match(await new RemoteControlService(access(),undefined,undefined,undefined,'win32').chat('control my screen')??'',/On your PC, open FarFromDesk/);
 assert.equal(await new RemoteControlService(access(),undefined,undefined,undefined,'win32').chat('hello'),undefined);
});

test('over a real WebRTC loopback the phone learns it is a PC and a locked tap does not end the session',{timeout:20_000},async()=>{
 let record:PasswordRecord|undefined;
 const a=new RemotePasswordAccess({load:()=>record,save:r=>{record=r;}});await a.setPassword('synthetic windows password');a.enable(true);
 const h=fakeHelper(),host=new P2PHost({access:a,backend:()=>new WindowsDesktopBackend(h),stun:[]});
 const offer=await host.createOffer(),o=decodeSignal(offer.code);
 const pc=new RTCPeerConnection({iceServers:[{urls:[]}]} as any);
 const control=pc.createDataChannel(CONTROL_CHANNEL.label,{negotiated:true,id:CONTROL_CHANNEL.id,ordered:true});
 const frames=pc.createDataChannel(FRAME_CHANNEL.label,{negotiated:true,id:FRAME_CHANNEL.id,ordered:true});
 await pc.setRemoteDescription({type:'offer',sdp:signalToSdp(o)});await pc.setLocalDescription(await pc.createAnswer());
 while(pc.iceGatheringState!=='complete')await sleep(20);
 const messages:MacMessage[]=[],shown:unknown[]=[],asm=new FrameAssembler();
 control.onMessage.subscribe(d=>messages.push(JSON.parse(String(d))));frames.onMessage.subscribe(d=>{const f=asm.push(d as Buffer);if(f)shown.push(f);});
 const wait=async(pred:()=>unknown)=>{const end=Date.now()+8000;while(!pred()){if(Date.now()>end)throw Error('timeout');await sleep(20);}};
 try{
  await host.acceptAnswer(encodeSignal(sdpToSignal(pc.localDescription!.sdp,'answer',o.s)));
  await wait(()=>control.readyState==='open');
  control.send(JSON.stringify({t:'auth',password:'synthetic windows password'}));
  await wait(()=>messages.some(m=>m.t==='auth-ok')&&shown.length>0);
  const ok=messages.find(m=>m.t==='auth-ok') as any;
  assert.equal(ok.os,'windows');assert.equal(ok.desktops,undefined);assert.deepEqual([ok.width,ok.height],[1400,875]);
  h.locked=true;
  control.send(JSON.stringify({t:'input',id:'input-0002',frameId:1,kind:'click',x:.5,y:.5}));
  await wait(()=>messages.some(m=>m.t==='ack'));
  assert.deepEqual(messages.find(m=>m.t==='ack'),{t:'ack',id:'input-0002',ok:false,error:'ACTION_REFUSED'});
  await sleep(300);
  assert.equal(host.status.state,'connected','a refused tap leaves the session open');
 }finally{host.stop('STOPPED');await pc.close();}
});
