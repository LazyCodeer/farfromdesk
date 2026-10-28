import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EmbeddedDesktopDriver,type DesktopDriver} from '../desktop-driver.js';
import type {DesktopBackend,DesktopFrame,Input} from './protocol.js';
const exec=promisify(execFile),TYPE_CHUNK=40;
/** macOS desktops (Spaces) on the main display, the one the phone sees. Runs in osascript's JavaScript
 * bridge: WindowServer's own desktop list (read-only), and Control+arrow posted at the HID level so
 * macOS's desktop shortcut sees it. The driver's keys go to the front app instead, which ignores them.
 * Prints {count,current}; current is 0 while a full-screen app is showing.
 */
const SPACES=`ObjC.import('CoreGraphics');
ObjC.bindFunction('CGSMainConnectionID',['int',[]]);
ObjC.bindFunction('CGSCopyManagedDisplaySpaces',['id',['int']]);
ObjC.bindFunction('CGSCopyBestManagedDisplayForRect',['id',['int','CGRect']]);
function state(){
  const c=$.CGSMainConnectionID(),bounds=$.CGDisplayBounds($.CGMainDisplayID()),id=ObjC.deepUnwrap($.CGSCopyBestManagedDisplayForRect(c,bounds));
  const m=ObjC.deepUnwrap($.CGSCopyManagedDisplaySpaces(c)).find(m=>m['Display Identifier']===id);
  const all=m?m.Spaces.map(s=>({id:s.ManagedSpaceID,desktop:s.type===0})):[],current=m?m['Current Space'].ManagedSpaceID:0;
  return {bounds,all,current,desktops:all.filter(s=>s.desktop).map(s=>s.id)};
}
function arrow(code){
  for(const down of [true,false]){const e=$.CGEventCreateKeyboardEvent(null,code,down);$.CGEventSetFlags(e,0x40000|0x200000|0x800000);$.CGEventPost($.kCGHIDEventTap,e);delay(.03);}
}
function run(argv){
  let s=state();
  if(argv[0]==='go'){
    const target=s.desktops[Number(argv[1])-1];
    if(!target)throw Error('NO_SUCH_DESKTOP');
    // The shortcut acts on the display under the pointer, so it goes to the middle of the main display first.
    $.CGWarpMouseCursorPosition({x:s.bounds.origin.x+s.bounds.size.width/2,y:s.bounds.origin.y+s.bounds.size.height/2});
    const steps=s.all.findIndex(x=>x.id===target)-s.all.findIndex(x=>x.id===s.current);
    for(let i=0;i<Math.abs(steps);i++){arrow(steps<0?123:124);delay(.35);}
    for(let i=0;i<30&&s.current!==target;i++){delay(.1);s=state();}
    if(s.current!==target)throw Error('DESKTOP_DID_NOT_CHANGE');
  }
  return JSON.stringify({count:s.desktops.length,current:s.desktops.indexOf(s.current)+1});
}`;
const spaces=async(args:string[],signal:AbortSignal)=>JSON.parse((await exec('/usr/bin/osascript',['-l','JavaScript','-e',SPACES,...args],{timeout:10_000,signal})).stdout) as {count:number;current:number};
/** Full primary display. scope:'desktop' without pid sends input to whatever is frontmost, as a person at the Mac would. */
export class NativeDesktopBackend implements DesktopBackend {
  private driver:DesktopDriver;
  private controller=new AbortController();
  private readyAt=0;
  private awake?:ChildProcess;
  constructor(private stateProbe:string,nativeDirectory?:string,driver?:DesktopDriver){
    this.driver=driver??new EmbeddedDesktopDriver(nativeDirectory);
    // While the phone is connected the display stays on, so it doesn't sleep and lock the Mac mid-session.
    if(process.platform==='darwin'){this.awake=spawn('/usr/bin/caffeinate',['-d','-w',String(process.pid)],{stdio:'ignore'});this.awake.on('error',()=>{});this.awake.unref();}
  }
  async ready(fresh=false){
    if(this.controller.signal.aborted)return false;
    // ponytail: a READY result is reused for 1s so live view doesn't re-probe per frame; lock/permission loss shows within ~1s.
    if(!fresh&&Date.now()-this.readyAt<1000)return true;
    try{
      const state=JSON.parse((await exec(this.stateProbe,[],{timeout:2000,signal:this.controller.signal})).stdout);
      // Locked is not lost: the lock screen is captured and typed into like any screen, so the owner unlocks it from the phone.
      // The lock screen turns the display off after about a minute idle even under caffeinate -d; declaring activity keeps the frame from going black.
      if(state.reason==='SESSION_LOCKED'){spawn('/usr/bin/caffeinate',['-u','-t','1'],{stdio:'ignore'}).on('error',()=>{}).unref();return 'locked' as const;}
      if(state.unlocked!==true)return false;
      const p=await this.driver.call('check_permissions',{prompt:false},this.controller.signal);
      if(p.accessibility!==true||p.screen_recording!==true)return false;
      this.readyAt=Date.now();return true;
    }catch{return false;}
  }
  async capture(signal:AbortSignal):Promise<DesktopFrame>{
    const dir=await mkdtemp(join(tmpdir(),'ffd-desktop-frame-')),png=join(dir,'frame.png'),jpg=join(dir,'frame.jpg');
    try{
      const s=await this.driver.call('get_desktop_state',{max_image_dimension:1400,screenshot_out_file:png},signal);
      if(typeof s.capture_id!=='string'||!s.capture_id)throw Error('CAPTURE_UNAVAILABLE');
      const b=await readFile(png);
      if(b.length>12*1024*1024||b.length<24||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('INVALID_PNG');
      // Same pixel size as the PNG: the driver maps x/y read off that image back to the screen.
      await exec('/usr/bin/sips',['-s','format','jpeg','-s','formatOptions','60',png,'--out',jpg],{timeout:5000,signal});
      return {jpeg:new Uint8Array(await readFile(jpg)),width:b.readUInt32BE(16),height:b.readUInt32BE(20),captureId:s.capture_id};
    }finally{await rm(dir,{recursive:true,force:true});}
  }
  async act(frame:DesktopFrame,a:Input,signal:AbortSignal){
    // The owner took over this screen on purpose, so input goes to the foreground like a person at the Mac.
    const d={scope:'desktop',delivery_mode:'foreground'},at=()=>({x:Math.floor(a.x!*frame.width),y:Math.floor(a.y!*frame.height)});
    // No capture_id: the driver consumes one per click, so a second tap on the same frame would be refused.
    // x,y map through the session's latest desktop capture, which is the frame the host just sent.
    if(a.kind==='click')await this.driver.call('click',{...d,...at()},signal);
    // double_click/right_click have no desktop scope; click covers both.
    else if(a.kind==='double')await this.driver.call('click',{...d,...at(),count:2},signal);
    else if(a.kind==='right')await this.driver.call('click',{...d,...at(),button:'right'},signal);
    else if(a.kind==='scroll')await this.driver.call('scroll',{...d,...at(),direction:a.direction,amount:a.amount},signal);
    else if(a.kind==='key'){
      if(a.modifiers?.length)await this.driver.call('hotkey',{...d,keys:[...a.modifiers,a.key]},signal);
      else await this.driver.call('press_key',{...d,key:a.key},signal);
    }else if(a.kind==='overview'){
      // Synthetic Ctrl+arrows reach the front app, not macOS, so Mission Control is opened directly; tapping a desktop there switches to it.
      await exec('/usr/bin/open',['-b','com.apple.exposelauncher'],{timeout:5000,signal});
    }else if(a.kind==='desktop'){
      // Refused rather than failed: a desktop switch that didn't land changes nothing the phone can't see.
      try{await spaces(['go',String(a.index)],signal);}catch(e){throw Error('DESKTOP_NATIVE_REFUSED: '+(String((e as any).stderr??'').trim()||(e as Error).message).slice(-200));}
    }else if(a.kind==='type'){
      // The driver types one character at a time and each call has a 12s limit, so long text goes in short pieces.
      const chars=[...a.text!];
      for(let i=0;i<chars.length;i+=TYPE_CHUNK)await this.driver.call('type_text',{...d,text:chars.slice(i,i+TYPE_CHUNK).join('')},signal);
    }
    else throw Error('INVALID_INPUT');
  }
  desktops(signal:AbortSignal){return spaces([],signal);}
  stop(){this.controller.abort();this.driver.stop();this.awake?.kill();}
}
