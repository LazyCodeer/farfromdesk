import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EmbeddedDesktopDriver,type DesktopDriver} from '../desktop-driver.js';
import type {Frame,OwnerAction,OwnerBackend} from './session.js';
const exec=promisify(execFile);
const fieldFingerprint=(e:any)=>JSON.stringify([e.role,e.label??'',e.frame??null]);
const blocked=/securityagent|loginwindow|systempreferences|keychain|password|1password|bitwarden/i;
export class NativeOwnerBackend implements OwnerBackend {
  private driver:DesktopDriver;
  private controller=new AbortController();
  private identity?:string;
  private safeFixture=false;
  private readyAt=0;
  lastReadiness={reason:'NOT_CHECKED',accessibility:null as boolean|null,screenRecording:null as boolean|null};
  constructor(private pid:number,private windowId:number,private stateProbe:string,nativeDirectory?:string,driver?:DesktopDriver){this.driver=driver??new EmbeddedDesktopDriver(nativeDirectory);}
  async ready(){
    if(this.controller.signal.aborted)return false;
    // ponytail: a READY result is reused for 1s so live view doesn't re-probe per frame; lock/permission loss shows within ~1s.
    if(Date.now()-this.readyAt<1000)return true;
    try{
      const probe=await exec(this.stateProbe,[],{timeout:2000,signal:this.controller.signal});
      const state=JSON.parse(probe.stdout);
      if(state.unlocked!==true){this.lastReadiness.reason=typeof state.reason==='string'&&/^[A-Z_]+$/.test(state.reason)?state.reason:'SESSION_UNCONFIRMED';return false;}
      const p=await this.driver.call('check_permissions',{},this.controller.signal);
      this.lastReadiness={reason:'PERMISSION_REQUIRED',accessibility:p.accessibility===true,screenRecording:p.screen_recording===true};
      if(!p.accessibility||!p.screen_recording)return false;
      const apps=await this.driver.call('list_apps',{},this.controller.signal);
      const app=apps.apps.find((a:any)=>a.pid===this.pid&&a.running);
      if(!app||blocked.test(app.bundle_id??'')){this.lastReadiness.reason='TARGET_APP_UNAVAILABLE_OR_PROTECTED';return false;}
      this.safeFixture=app.bundle_id==='com.codecy.mac-control-lab.fixture';
      const identity=JSON.stringify([app.pid,app.bundle_id,app.launch_path]);
      if(this.identity&&this.identity!==identity){this.lastReadiness.reason='TARGET_APP_CHANGED';return false;}this.identity=identity;
      const windows=await this.driver.call('list_windows',{pid:this.pid},this.controller.signal);
      const visible=windows.windows.some((w:any)=>w.window_id===this.windowId&&w.is_on_screen&&w.layer===0);
      this.lastReadiness.reason=visible?'READY':'TARGET_WINDOW_NOT_VISIBLE';if(visible)this.readyAt=Date.now();return visible;
    }catch{this.lastReadiness.reason='NATIVE_PREREQUISITE_CHECK_FAILED';return false;}
  }
  private target(){return {pid:this.pid,window_id:this.windowId};}
  private refuse(s:any){
    if((s.elements_complete===false&&!this.safeFixture)||s.truncated||!Array.isArray(s.elements)||s.elements.some((e:any)=>/secure|password|passcode|api key|AXSystemDialog/i.test([e.role,e.subrole,e.label].join(' '))))throw Error('SENSITIVE_OR_INCOMPLETE_WINDOW');
    return s;
  }
  private async inspect(signal:AbortSignal){
    return this.refuse(await this.driver.call('get_window_state',{...this.target(),include_screenshot:false,tree_format:'elements',max_elements:5000},signal));
  }
  async capture(signal:AbortSignal):Promise<Frame>{
    const dir=await mkdtemp(join(tmpdir(),'ffd-owner-frame-')),path=join(dir,'frame.png'),jpeg=join(dir,'frame.jpg');
    try{
      // One read gives the screenshot and the tree it is checked against.
      const s=this.refuse(await this.driver.call('get_window_state',{...this.target(),include_screenshot:true,screenshot_out_file:path,max_image_dimension:0,tree_format:'elements',max_elements:5000},signal));
      if(!s.screenshot_frame_valid||!s.capture_id||typeof s.screenshot_file_path!=='string'||await realpath(s.screenshot_file_path)!==await realpath(path))throw Error('CAPTURE_UNAVAILABLE');
      const png=await readFile(path);
      if(png.length>12*1024*1024||png.length<24||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('INVALID_PNG');
      // Clicks use full-size pixels; the phone only needs a small JPEG of the same image.
      await exec('/usr/bin/sips',['-s','format','jpeg','-s','formatOptions','65','-Z','1400',path,'--out',jpeg],{timeout:5000,signal});
      const fields=s.elements.filter((e:any)=>['AXTextField','AXTextArea'].includes(e.role)&&e.enabled!==false&&e.element_token).map((e:any)=>({id:randomUUID(),label:String(e.label||e.role).slice(0,200),token:e.element_token,fingerprint:fieldFingerprint(e)}));
      return {png:(await readFile(jpeg)).toString('base64'),mime:'image/jpeg',width:png.readUInt32BE(16),height:png.readUInt32BE(20),captureId:s.capture_id,fields,controls:JSON.stringify(s.elements.map((e:any)=>({role:e.role,label:e.label}))).slice(0,16000)};
    }finally{await rm(dir,{recursive:true,force:true});}
  }
  async act(frame:Frame,a:OwnerAction,signal:AbortSignal){
    const current=await this.inspect(signal),w=this.target(),fg={...w,delivery_mode:'foreground'};
    const at=()=>({x:Math.floor(a.x!*frame.width),y:Math.floor(a.y!*frame.height)});
    if(a.kind==='click')await this.driver.call('click',{...fg,capture_id:frame.captureId,...at()},signal);
    else if(a.kind==='double')await this.driver.call('double_click',{...fg,...at()},signal);
    else if(a.kind==='right')await this.driver.call('right_click',{...fg,...at()},signal);
    else if(a.kind==='scroll')await this.driver.call('scroll',{...fg,...at(),direction:a.direction,amount:a.amount},signal);
    else if(a.kind==='key'){
      if(a.modifiers?.length)await this.driver.call('hotkey',{...fg,keys:[...a.modifiers,a.key]},signal);
      else await this.driver.call('press_key',{...fg,key:a.key},signal);
    }else if(a.fieldId===undefined)await this.driver.call('type_text',{...fg,text:a.text},signal);
    else {
      // The owner selects one observed nonsecure field. Never infer an undocumented focus flag.
      const field=frame.fields?.find(f=>f.id===a.fieldId);
      if(!field)throw Error('CHOOSE_OBSERVED_TEXT_FIELD');
      const matches=current.elements.filter((e:any)=>e.element_token&&fieldFingerprint(e)===field.fingerprint);
      if(matches.length!==1)throw Error('TEXT_FIELD_CHANGED_REFRESH_REQUIRED');
      await this.driver.call('type_text',{...fg,element_token:matches[0].element_token,text:a.text},signal);
    }
  }
  stop(){this.controller.abort();this.driver.stop();}
}
