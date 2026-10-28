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
