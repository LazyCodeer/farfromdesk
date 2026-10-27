import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,access,realpath} from 'node:fs/promises';
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
        file=args.screenshot_out_file as string;const png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(400,16);png.writeUInt32BE(200,20);await writeFile(file,png);
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
  sensitive=true;await assert.rejects(backend.capture(signal),/SENSITIVE/);
});
