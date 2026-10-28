import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the page's real onChunk with a deferred decoder (release review of 16cea6a).
test('a frame still decoding when the phone pauses is not drawn',async()=>{
 const src=fs.readFileSync('remote-page/remote.js','utf8');
 const fn=src.slice(src.indexOf('async function onChunk('),src.indexOf('// ---- Zoom and pan.'));
 let release!:(b:unknown)=>void,draws=0,closed=0;
 const context=vm.createContext({
  assembler:{push:()=>({jpeg:new Uint8Array([1]),frameId:2})},ended:false,paused:false,epoch:0,
  createImageBitmap:()=>new Promise(r=>release=r),Blob,canvas:{width:100,height:100,getContext:()=>({drawImage(){draws++;}})},
  layout(){},shown:1,pull(){},liveStatus(){}
 });
 vm.runInContext(fn,context);
 const pending=vm.runInContext('onChunk(new ArrayBuffer(1))',context);
 while(!release)await new Promise(r=>setTimeout(r,1));
 context.paused=true;context.epoch++;
 release({width:100,height:100,close(){closed++;}});await pending;
 assert.equal(draws,0);assert.equal(closed,1);
});

const page=(from:string,to:string)=>{const src=fs.readFileSync('remote-page/remote.js','utf8');return src.slice(src.indexOf(from),src.indexOf(to));};

test('a login that finishes while the phone is hidden pauses straight away',()=>{
 let paused=0;
 const context=vm.createContext({document:{hidden:true},authed:false,paused:false,live:false,canList:false,idleMs:0,
  store:{drop(){},set(){}},PAUSED:'paused',KEEP:'keep',$:()=>({hidden:true,classList:{remove(){}}}),setVoice(){},showLocked(){},
  goLive(){context.live=true;},pause(){paused++;}});
 vm.runInContext(page('function onMessage(','// ---- Live view.'),context);
 vm.runInContext('onMessage(JSON.stringify({t:"auth-ok",resume:"fixture",idle:75000}))',context);
 assert.equal(paused,1);
});

function micPage(getUserMedia:()=>Promise<any>,blob:()=>Promise<ArrayBuffer>){
 const mic:any={},sent:any[]=[],toasts:string[]=[];let recorder:any;
 class Recorder{mimeType='audio/webm';ondataavailable:any;onstop:any;static isTypeSupported(){return true;}constructor(){recorder=this;}start(){}stop(){}}
 const context=vm.createContext({$:()=>mic,rec:null,macLocked:false,paused:false,ended:false,epoch:0,discard:false,voiceTimer:null,VOICE_MAX_MS:120000,PIECE:1000,voiceId:'',
  navigator:{mediaDevices:{getUserMedia}},MediaRecorder:Recorder,Blob:class{arrayBuffer=blob;},crypto:{randomUUID:()=>'v'},btoa,
  setTimeout:()=>0,clearTimeout(){},stopVoice(){},toast:(t:string)=>toasts.push(t),micState(){},send:(m:any)=>sent.push(m)});
 vm.runInContext(page("$('mic').onclick=async()=>{","function heard("),context);
 return {context,mic,sent,toasts,recorder:()=>recorder};
}
const pauseIn=(c:any)=>{c.paused=true;c.epoch++;};

test('a microphone grant that lands after a pause never records',async()=>{
 let grant!:(s:any)=>void,stopped=0;
 const p=micPage(()=>new Promise(r=>grant=r),async()=>new ArrayBuffer(1));
 const pending=p.mic.onclick();pauseIn(p.context);
 grant({getTracks:()=>[{stop(){stopped++;}}]});await pending;
 assert.equal(p.recorder(),undefined);assert.equal(stopped,1);
});

test('a microphone refusal that lands after a pause shows nothing',async()=>{
 let deny!:(e:Error)=>void;
 const p=micPage(()=>new Promise((_r,j)=>deny=j),async()=>new ArrayBuffer(1));
 const pending=p.mic.onclick();pauseIn(p.context);deny(Error('NotAllowedError'));await pending;
 assert.deepEqual(p.toasts,[]);
});

test('a clip still being read when the phone pauses is not uploaded after the password',async()=>{
 let read!:(b:ArrayBuffer)=>void;
 const p=micPage(async()=>({getTracks:()=>[{stop(){}}]}),()=>new Promise(r=>read=r));
 await p.mic.onclick();const r=p.recorder();r.ondataavailable({data:{size:1}});
 const stopped=r.onstop();pauseIn(p.context);p.context.paused=false; // the password brought the session back
 read(new Uint8Array([1,2,3]).buffer);await stopped;
 assert.deepEqual(p.sent,[]);
});

// Phone page review on 135a47f.
const el=()=>({hidden:false,textContent:'',classList:{add(){},remove(){}},replaceChildren(){this.cleared=true;},focus(){},cleared:false} as any);
function pageStore(){const data=new Map<string,unknown>([['keep',{secret:'s'}],['paused',{at:1}]]);return {data,get:(k:string)=>data.get(k),set:(k:string,v:unknown)=>data.set(k,v),drop:(k:string)=>data.delete(k)};}

test('an idle close or End on the notice forgets the reconnect secret',()=>{
 const store=pageStore(),els=new Map<string,any>(),context=vm.createContext({ended:false,live:true,waiting:new Map(),store,KEEP:'keep',PAUSED:'paused',
  aliveTimer:0,idleTimer:0,wake:null,pc:null,$:(id:string)=>els.get(id)??els.set(id,el()).get(id),finish(){},clearInterval(){}});
 vm.runInContext(page('function end(','function readOffer('),context);
 vm.runInContext("end('closed','ended')",context);
 assert.equal(store.data.size,0);
});

test('a pause during transcription frees the mic and removes desktop previews',()=>{
 const els=new Map<string,any>(),mic:any[]=[];
 const context=vm.createContext({paused:false,authed:true,epoch:0,shown:1,waiting:new Map(),store:pageStore(),KEEP:'keep',PAUSED:'paused',send(){},
  canvas:{width:1,height:1,getContext:()=>({clearRect(){}})},previews:new Map(),$:(id:string)=>els.get(id)??els.set(id,el()).get(id),
  stopVoice(){},voiceId:'clip-1',micState:(...a:unknown[])=>mic.push(a),idleTimer:0,clearInterval(){},wake:null,parked:null,liveStatus(){}});
 vm.runInContext(page('function pause(){',"$('resumeform')"),context);
 vm.runInContext('pause()',context);
 assert.equal(context.voiceId,'');assert.deepEqual(mic,[[false,false]]);assert.equal(els.get('desklist').cleared,true);
});

test('a screen wake lock granted after a pause is released',async()=>{
 let released=0;
 const context=vm.createContext({paused:false,ended:false,wake:null,navigator:{wakeLock:{request:async()=>{context.paused=true;return {release:async()=>{released++;}};}}}});
 vm.runInContext(page('async function keepAwake(','function goLive('),context);
 await vm.runInContext('keepAwake()',context);
 assert.equal(released,1);assert.equal(context.wake,null);
});
