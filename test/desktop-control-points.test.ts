import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DesktopControl } from '../src/desktop-control.js';

/**
 * A window that publishes no accessible controls, which is what Flutter, WebGL and
 * other canvas surfaces do. The point of these tests is that such a window is still
 * addressable and still tells the caller what to do next.
 */
function fixture(){
  const prefs=new Map([['mac-control-enabled','true']]),calls:Array<{name:string;args:any}>=[];
  const win={window_id:8,pid:7,layer:0,title:'Canvas',bounds:{x:0,y:0,width:800,height:600}};
  const driver={call:async(name:string,args:any)=>{
    calls.push({name,args});
    if(name==='list_apps')return {apps:[{name:'Canvas App',bundle_id:'com.example.canvas',pid:7,running:true}]};
    if(name==='list_windows')return {windows:[{...win,pid:args.pid}]};
    if(name==='check_permissions')return {accessibility:true,screen_recording:false,source:'daemon'};
    if(name==='get_window_state')return {elements:[],truncated:false,degraded_reason:'ax_window_unresolved',
      screenshot_png_b64:'iVBORw0KGgo=',screenshot_width:1366,screenshot_height:966,screenshot_scale:2,
      screenshot_mime_type:'image/png',screenshot_frame_valid:true,window_bounds:win.bounds};
    return {effect:'unverifiable'};
  },stop:()=>{}};
  const service=new DesktopControl({get:k=>prefs.get(k),set:(k,v)=>{prefs.set(k,v);}},driver,async()=>({}),'darwin');
  return {service,prefs,calls};
}
async function pickWindow(f:ReturnType<typeof fixture>){
  const a=await f.service.run('owner',{action:'list_apps'});
  const w=await f.service.run('owner',{action:'list_windows',appRef:a.apps[0].appRef});
  return w.windows[0].windowRef as string;
}
const last=(f:ReturnType<typeof fixture>,name:string)=>f.calls.filter(c=>c.name===name).at(-1)!;

test('a canvas window with no controls is still addressable by pixel, in the background',async()=>{
  const f=fixture(),windowRef=await pickWindow(f);
  const r=await f.service.run('owner',{action:'click',windowRef,x:120,y:64,actionId:randomUUID()});
  assert.match(r.addressedBy,/window-local screenshot pixels/);
  // Background is the driver's own default and does not steal focus. The wrapper must
  // not quietly escalate to foreground; the caller decides that.
  assert.equal(r.deliveryMode,'background');
  assert.equal(last(f,'click').args.delivery_mode,'background');
  assert.equal(last(f,'click').args.x,120);
  assert.equal(last(f,'click').args.y,64);
  assert.equal(last(f,'click').args.window_id,8);
  assert.equal('element_token' in last(f,'click').args,false);
});

test('foreground is used only when the caller asks for it',async()=>{
  const f=fixture(),windowRef=await pickWindow(f);
  await f.service.run('owner',{action:'click',windowRef,x:1,y:2,actionId:randomUUID(),deliveryMode:'foreground'});
  assert.equal(last(f,'click').args.delivery_mode,'foreground');
});

test('coordinates and a control cannot both address one action',async()=>{
  const f=fixture(),windowRef=await pickWindow(f),read=await f.service.run('owner',{action:'read_window',windowRef});
  await assert.rejects(
    f.service.run('owner',{action:'click',windowRef,x:1,y:2,snapshotId:read.snapshotId,controlId:randomUUID(),actionId:randomUUID()}),
    /ADDRESS_AMBIGUOUS/);
  assert.equal(f.calls.filter(c=>c.name==='click').length,0);
});

test('a half-given point is refused rather than guessed',async()=>{
  const f=fixture(),windowRef=await pickWindow(f);
  await assert.rejects(f.service.run('owner',{action:'click',windowRef,x:5,actionId:randomUUID()}),/POINT_INCOMPLETE/);
  await assert.rejects(f.service.run('owner',{action:'click',windowRef,actionId:randomUUID()}),/CONTROL_STALE/);
});

test('drag and scroll send the field names the driver actually accepts',async()=>{
  const f=fixture(),windowRef=await pickWindow(f);
  await f.service.run('owner',{action:'drag',windowRef,x:10,y:20,toX:300,toY:400,actionId:randomUUID()});
  const drag=last(f,'drag').args;
  assert.deepEqual([drag.from_x,drag.from_y,drag.to_x,drag.to_y],[10,20,300,400]);
  assert.equal('x' in drag,false);
  await f.service.run('owner',{action:'scroll',windowRef,x:400,y:300,direction:'down',amount:5,actionId:randomUUID()});
  const scroll=last(f,'scroll').args;
  assert.equal(scroll.direction,'down');assert.equal(scroll.amount,5);
  await assert.rejects(f.service.run('owner',{action:'drag',windowRef,x:1,y:2,actionId:randomUUID()}),/DRAG_DESTINATION_REQUIRED/);
  await assert.rejects(f.service.run('owner',{action:'scroll',windowRef,x:1,y:2,actionId:randomUUID()}),/SCROLL_DIRECTION_REQUIRED/);
});

test('modifiers and button reach the driver',async()=>{
  const f=fixture(),windowRef=await pickWindow(f);
  await f.service.run('owner',{action:'right_click',windowRef,x:9,y:9,modifier:['cmd','shift'],button:'right',actionId:randomUUID()});
  const args=last(f,'right_click').args;
  assert.deepEqual(args.modifier,['cmd','shift']);assert.equal(args.button,'right');
});

test('an empty tree says why and points at pixels, instead of looking empty',async()=>{
  const f=fixture(),windowRef=await pickWindow(f);
  const read=await f.service.run('owner',{action:'read_window',windowRef});
  assert.deepEqual(read.controls,[]);
  assert.equal(read.elementsEmpty,true);
  assert.equal(read.axDegradedReason,'ax_window_unresolved');
  assert.match(read.next,/screenshot:true/);
  assert.match(read.next,/coordinates/);
  // The screenshot stays opt-in: a read without it must not carry an image.
  assert.equal('screenshot' in read,false);
});

test('screenshot:true returns the image and the space its pixels are in',async()=>{
  const f=fixture(),windowRef=await pickWindow(f);
  const read=await f.service.run('owner',{action:'read_window',windowRef,screenshot:true});
  assert.equal(read.screenshot.pngBase64,'iVBORw0KGgo=');
  assert.equal(read.screenshot.mimeType,'image/png');
  assert.deepEqual([read.screenshot.width,read.screenshot.height],[1366,966]);
  assert.equal(read.screenshot.frameValid,true);
  assert.deepEqual(read.windowBounds,{x:0,y:0,width:800,height:600});
  assert.match(read.pixelSpace,/window-local/);
  assert.equal(last(f,'get_window_state').args.include_screenshot,true);
});

test('check_permissions reports the driver grant, not the helper',async()=>{
  const f=fixture();
  const r=await f.service.run('owner',{action:'check_permissions'});
  assert.equal(r.accessibility,true);
  assert.equal(r.screenRecording,false);
  assert.equal(r.source,'daemon');
  assert.match(r.note,/driver/);
});

test('status caches the driver grant so the pane can show the right one',async()=>{
  const f=fixture();
  const view=await f.service.run('owner',{action:'status'});
  assert.equal(view.permission.accessibility,true);
  assert.equal(view.permission.screenRecording,false);
  assert.equal(view.permission.source,'daemon');
});

test('a permission probe that fails leaves the pane honest rather than optimistic',async()=>{
  const f=fixture();
  const broken=new DesktopControl({get:k=>f.prefs.get(k),set:()=>{}},
    {call:async()=>{throw new Error('no daemon');},stop:()=>{}},async()=>({}),'darwin');
  const r=await broken.run('owner',{action:'check_permissions'});
  assert.equal(r.accessibility,false);
  assert.equal(r.screenRecording,false);
});