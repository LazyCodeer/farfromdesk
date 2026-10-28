import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,access,mkdtemp,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {deflateSync,crc32} from 'node:zlib';
import {NativeDesktopBackend} from '../src/remote-p2p/desktop.js';
import type {DesktopDriver} from '../src/desktop-driver.js';
// A real 400x200 grey PNG, so sips has something to convert.
const chunk=(type:string,data:Buffer)=>{const t=Buffer.from(type),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);};
const header=Buffer.alloc(13);header.writeUInt32BE(400,0);header.writeUInt32BE(200,4);header[8]=8;header[9]=0;
const realPng=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(200*401,128).map((v,i)=>i%401?v:0))),chunk('IEND',Buffer.alloc(0))]);

test('desktop backend captures a same-size JPEG, cleans up, and sends desktop-scope input',async()=>{
  let file='';const calls:{name:string;args:any}[]=[];
  const driver:DesktopDriver={stop(){},async call(name,args){
    calls.push({name,args});
    if(name==='get_desktop_state'){file=args.screenshot_out_file as string;await writeFile(file,realPng);return {capture_id:'cap-1'};}
    return {};
  }};
  const b=new NativeDesktopBackend('unused',undefined,driver),signal=new AbortController().signal;
  const frame=await b.capture(signal);
  assert.deepEqual(calls[0],{name:'get_desktop_state',args:{max_image_dimension:1400,screenshot_out_file:file}});
  await assert.rejects(access(dirname(file)));
  assert.equal(Buffer.from(frame.jpeg.subarray(0,2)).toString('hex'),'ffd8');
  assert.deepEqual([frame.width,frame.height,frame.captureId],[400,200,'cap-1']);
  const base={t:'input' as const,id:'input-0001',frameId:1};
  const cases:[any,string,any][]=[
    [{kind:'click',x:.25,y:.75},'click',{scope:'desktop',delivery_mode:'foreground',x:100,y:150}],
    [{kind:'double',x:.5,y:.5},'click',{scope:'desktop',delivery_mode:'foreground',x:200,y:100,count:2}],
    [{kind:'right',x:.999,y:.001},'click',{scope:'desktop',delivery_mode:'foreground',x:399,y:0,button:'right'}],
    [{kind:'scroll',x:.5,y:.5,direction:'down',amount:3},'scroll',{scope:'desktop',delivery_mode:'foreground',x:200,y:100,direction:'down',amount:3}],
    [{kind:'key',key:'return'},'press_key',{scope:'desktop',delivery_mode:'foreground',key:'return'}],
    [{kind:'key',key:'c',modifiers:['cmd','shift']},'hotkey',{scope:'desktop',delivery_mode:'foreground',keys:['cmd','shift','c']}],
    [{kind:'type',text:'hello'},'type_text',{scope:'desktop',delivery_mode:'foreground',text:'hello'}],
  ];
  for(const [input,name,args] of cases){
    calls.length=0;await b.act(frame,{...base,...input},signal);
    assert.deepEqual(calls,[{name,args}],input.kind);
  }
  // Long text goes in short pieces so no single driver call runs past its time limit; emoji stay whole.
  calls.length=0;const long='😀'+'a'.repeat(84);await b.act(frame,{...base,kind:'type',text:long},signal);
  assert.deepEqual(calls.map(c=>[...c.args.text].length),[40,40,5]);assert.equal(calls.map(c=>c.args.text).join(''),long);
  b.stop();
});

test('desktop backend refuses a non-PNG capture and still cleans up',async()=>{
  let file='';
  const driver:DesktopDriver={stop(){},async call(_n,args){file=args.screenshot_out_file as string;await writeFile(file,'nope');return {capture_id:'c'};}};
  await assert.rejects(new NativeDesktopBackend('unused',undefined,driver).capture(new AbortController().signal),/INVALID_PNG/);
  await assert.rejects(access(dirname(file)));
});

test('ready() needs an unlocked session and both permissions, and caches only success',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ffd-probe-test-')),probe=join(dir,'probe');
  const setProbe=async(unlocked:boolean)=>{await writeFile(probe,`#!/bin/sh\necho '{"unlocked":${unlocked}}'\n`);await chmod(probe,0o755);};
  let perms={accessibility:true,screen_recording:true};const calls:any[]=[];
  const driver:DesktopDriver={stop(){},async call(name,args){calls.push({name,args});return perms;}};
  await setProbe(false);assert.equal(await new NativeDesktopBackend(probe,undefined,driver).ready(),false);assert.equal(calls.length,0);
  await setProbe(true);perms={accessibility:true,screen_recording:false};
  assert.equal(await new NativeDesktopBackend(probe,undefined,driver).ready(),false);
  perms={accessibility:false,screen_recording:true};
  assert.equal(await new NativeDesktopBackend(probe,undefined,driver).ready(),false);
  perms={accessibility:true,screen_recording:true};
  const b=new NativeDesktopBackend(probe,undefined,driver);
  assert.equal(await b.ready(),true);assert.deepEqual(calls.at(-1),{name:'check_permissions',args:{prompt:false}});
  const n=calls.length;assert.equal(await b.ready(),true);assert.equal(calls.length,n);
  // fresh skips the 1s cache: the checks that guard the Mac password always probe.
  assert.equal(await b.ready(true),true);assert.equal(calls.length,n+1);
  b.stop();assert.equal(await b.ready(),false);
  // A locked screen is its own state, reported before any permission call.
  await writeFile(probe,`#!/bin/sh\necho '{"unlocked":false,"reason":"SESSION_LOCKED"}'\n`);calls.length=0;
  const l=new NativeDesktopBackend(probe,undefined,driver);assert.equal(await l.ready(),'locked');assert.equal(calls.length,0);l.stop();
});
