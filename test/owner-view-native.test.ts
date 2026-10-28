import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,access,realpath} from 'node:fs/promises';
import {deflateSync,crc32} from 'node:zlib';
// A real 400x200 grey PNG, so the JPEG conversion for the phone has something to read.
const chunk=(type:string,data:Buffer)=>{const t=Buffer.from(type),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);};
const header=Buffer.alloc(13);header.writeUInt32BE(400,0);header.writeUInt32BE(200,4);header[8]=8;header[9]=0;
const realPng=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(200*401,128).map((v,i)=>i%401?v:0))),chunk('IEND',Buffer.alloc(0))]);
import {NativeOwnerBackend} from '../src/owner-view/native.js';
import type {DesktopDriver} from '../src/desktop-driver.js';

test('native adapter maps image coordinates independently of negative desktop coordinates and cleans captures',async()=>{
  let file='',sensitive=false,revision=0,duplicate=false,moved=false;const calls:{name:string;args:any}[]=[];
  const driver:DesktopDriver={stop(){},async call(name,args){
    calls.push({name,args});
    if(name==='get_window_state'){
      revision++;const elements=[{role:sensitive?'AXSecureTextField':'AXTextField',label:'Scratch note',enabled:true,element_token:'opaque-'+revision,frame:{x:moved?-1600:-1700,y:20,w:100,h:30}}];
      if(duplicate)elements.push({...elements[0],element_token:'other-'+revision});
      if(args.include_screenshot){
        file=args.screenshot_out_file as string;await writeFile(file,realPng);
        return {elements,capture_id:'capture',screenshot_frame_valid:true,screenshot_file_path:await realpath(file)};
      }return {elements};
    }return {};
  }};
  const backend=new NativeOwnerBackend(123,456,'unused',undefined,driver),signal=new AbortController().signal;
  const frame=await backend.capture(signal);await assert.rejects(access(file));
  await backend.act(frame,{id:'a',frameId:'f',kind:'click',x:.25,y:.75},signal);
  const click=calls.find(c=>c.name==='click')!;
  assert.deepEqual(click.args,{pid:123,window_id:456,capture_id:'capture',x:100,y:150,delivery_mode:'foreground'});
  await backend.act(frame,{id:'b',frameId:'f',kind:'type',text:'Fixture',fieldId:frame.fields![0].id},signal);
  assert.equal(calls.find(c=>c.name==='type_text')!.args.element_token,'opaque-'+revision);
  duplicate=true;await assert.rejects(backend.act(frame,{id:'c',frameId:'f',kind:'type',text:'No',fieldId:frame.fields![0].id},signal),/TEXT_FIELD_CHANGED/);
  duplicate=false;moved=true;await assert.rejects(backend.act(frame,{id:'d',frameId:'f',kind:'type',text:'No',fieldId:frame.fields![0].id},signal),/TEXT_FIELD_CHANGED/);
  assert.equal(calls.filter(c=>c.name==='type_text').length,1);
  assert.equal(frame.mime,'image/jpeg');assert.equal(Buffer.from(frame.png,'base64').subarray(0,2).toString('hex'),'ffd8');
  await backend.act(frame,{id:'e',frameId:'f',kind:'scroll',x:.5,y:.5,direction:'down',amount:3},signal);
  assert.deepEqual(calls.find(c=>c.name==='scroll')!.args,{pid:123,window_id:456,delivery_mode:'foreground',x:200,y:100,direction:'down',amount:3});
  await backend.act(frame,{id:'g',frameId:'f',kind:'key',key:'c',modifiers:['cmd']},signal);
  assert.deepEqual(calls.find(c=>c.name==='hotkey')!.args.keys,['cmd','c']);
  await backend.act(frame,{id:'h',frameId:'f',kind:'type',text:'focused'},signal);
  assert.equal(calls.filter(c=>c.name==='type_text').at(-1)!.args.element_token,undefined);
  sensitive=true;await assert.rejects(backend.capture(signal),/SENSITIVE/);
});
