import { spawn,type ChildProcess } from 'node:child_process';
import type { Store } from './store.js';
import type { Router } from './router.js';
import type { Telegram } from './telegram.js';
import type { WhatsApp } from './whatsapp.js';
import type { ServerMode } from './server-mode.js';
import { join } from 'node:path';

/** Windows PowerShell 5.1, which every supported Windows ships; never a PATH lookup. */
export function windowsPowerShell(){return join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');}

export function spawnPowerAssertion(pid:number):ChildProcess {
  if(process.platform==='darwin')return spawn('/usr/bin/caffeinate',['-i','-w',String(pid)],{stdio:'ignore'});
  if(process.platform==='win32') {
    const source='$ErrorActionPreference="Stop"; Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class FFDPower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }\'; if ([FFDPower]::SetThreadExecutionState(2147483649) -eq 0) { exit 1 }; [Console]::In.ReadToEnd() | Out-Null';
    return spawn(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{stdio:['pipe','ignore','ignore'],windowsHide:true});
  }
  return spawn('systemd-inhibit',['--what=sleep','--mode=block','--who=FarFromDesk','--why=Owner enabled background forwarding',process.execPath,'-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore']});
}

export class PowerPolicy {
  child?:ChildProcess;
  error?:string;
  constructor(private store:Store,private router:Router,private wa:WhatsApp,private spawnAssertion:(pid:number)=>ChildProcess=spawnPowerAssertion,private telegram?:Telegram,private serverMode?:ServerMode) {
    // Preserve earlier explicit background-use consent; fresh installs default off.
    if(store.get('background-enabled')===undefined)store.set('background-enabled',store.get('whatsapp-owner')?'true':'false');
    router.stopped=!this.enabled;
  }
  get enabled(){return this.store.get('background-enabled')==='true';}
  get lidClosedEnabled(){return this.serverMode?.enabled===true;}
  view(){return {backgroundEnabled:this.enabled,keepAwake:this.store.get('keep-awake')==='true',assertionActive:!!this.child,error:this.error,serverMode:this.serverMode?.view()??null};}
  async update(backgroundEnabled:boolean,keepAwake:boolean,serverMode?:boolean) {
    if(!backgroundEnabled&&this.serverMode?.enabled)await this.serverMode.setEnabled(false);
    const wantServer=serverMode===true||(serverMode===undefined&&this.lidClosedEnabled);
    if(wantServer&&!backgroundEnabled)throw new Error('Allow background operation before enabling server mode.');
    if(serverMode!==undefined&&serverMode!==this.lidClosedEnabled)await this.serverMode?.setEnabled(serverMode);
    // Server mode is a stronger promise than keep-awake, so it implies it.
    const effectiveKeepAwake=backgroundEnabled&&(keepAwake||wantServer);
    // Explicit pause revokes in-flight errands; ordinary service shutdown is
    // different and retains safely queued messages for restart recovery.
    if(!backgroundEnabled&&!this.router.stopped)this.router.errands.invalidateAuthority();
    this.store.set('background-enabled',String(backgroundEnabled));
    this.store.set('keep-awake',String(effectiveKeepAwake));
    this.router.stopped=!backgroundEnabled;
    this.apply();
    if(!backgroundEnabled){this.router.approvals.cancel();this.wa.close();this.wa.status='paused';this.telegram?.close();if(this.telegram)this.telegram.status='paused';}
    else {if(this.wa.closed){this.wa.closed=false;if(this.store.controlChannel()==='whatsapp'&&this.store.get('whatsapp-owner'))await this.wa.connect().catch(e=>{this.wa.error=(e as Error).message;});}if(this.store.controlChannel()==='telegram')await this.telegram?.resume().catch(()=>{});}
  }
  apply() {
    const wanted=this.enabled&&this.store.get('keep-awake')==='true';
    if(!wanted){this.child?.kill();this.child=undefined;this.error=undefined;return;}
    if(this.child)return;
    // -i prevents idle system sleep; display sleep and lid safety remain with macOS.
    const child=this.spawnAssertion(process.pid);
    this.child=child;this.error=undefined;
    child.on('error',()=>{if(this.child===child){this.child=undefined;this.error='The operating system could not enable idle-sleep prevention.';}});
    child.on('exit',()=>{if(this.child===child){this.child=undefined;this.error='Keep-awake stopped. Retrying within a minute while enabled.';}});
  }
  close(){this.child?.kill();this.child=undefined;this.serverMode?.close();}
  refreshServerMode(){return this.serverMode?.refresh();}
  removeServerHelper(){return this.serverMode?.removeHelper();}
}
