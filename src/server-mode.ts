import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDir } from './config.js';
import type { Store } from './store.js';
import { windowsPowerShell } from './power.js';

// One-time privileged helper that decides whether system sleep may stay disabled
// while the owner works with the lid closed. See native/server-mode/helper.sh for
// the decision rules; this module only installs it, asks for consent and keeps a
// heartbeat. The helper never runs anything the app sends it.
export const SERVER_MODE = {
  label: 'com.codecylabs.farfromdesk.servermode',
  support: '/Library/Application Support/FarFromDesk/server-mode',
  log: '/var/log/farfromdesk-servermode.log',
} as const;

export const SERVER_MODE_PLIST = `/Library/LaunchDaemons/${SERVER_MODE.label}.plist`;
export const SERVER_MODE_HELPER = `${SERVER_MODE.support}/helper.sh`;
/** Must match FFD_HELPER_VERSION in native/server-mode/helper.sh. */
export const SERVER_MODE_HELPER_VERSION = 5;
const HELPER_VERSION = /^FFD_HELPER_VERSION=(\d+)$/m;

export type ServerModeView = {
  supported: boolean;
  enabled: boolean;
  helperInstalled: boolean;
  lidSleepDisabled: boolean | null;
  onAcPower: boolean | null;
  batteryPercent?: number | null;
  batteryFloor?: number;
  allowBattery?: boolean;
  lowBatteryNeedsConfirm?: boolean;
  heartbeatAgeMs: number | null;
  /** How much of the window is left in which the helper holds sleep off although
   * the app is not heartbeating. Null when there is no heartbeat to measure. */
  graceRemainingMs: number | null;
  active: boolean;
  /** How long the reported system state has been unchanged, so a helper that
   * never takes effect can be reported instead of spinning forever. */
  statusAgeMs: number;
  error: string | null;
  /** A step only the owner can take, such as the Windows lid-close action. */
  guidance: string | null;
};

/**
 * Linux: hold a logind block lock on sleep and on the lid switch for as long as this
 * process lives. logind always honours a handle-lid-switch block lock, whatever
 * LidSwitchIgnoreInhibited says, and the lock dies with the process, so a crash can
 * never pin the machine awake.
 */
export function spawnLidInhibitor():ChildProcess{
  return spawn('systemd-inhibit',['--what=sleep:handle-lid-switch','--mode=block','--who=FarFromDesk','--why=Server mode keeps tasks running with the lid closed',process.execPath,'-e','process.stdin.resume()'],{stdio:['pipe','ignore','pipe']});
}

/** powercfg prints the AC index, then the DC index. Its labels are localized, the hex values are not. */
export function windowsLidAction(output:string):{ac:number;dc:number}|null{
  const values=[...output.matchAll(/0x([0-9a-f]{8})/gi)].map(m=>parseInt(m[1]!,16));
  return values.length>=2?{ac:values.at(-2)!,dc:values.at(-1)!}:null;
}

/**
 * Reads the lid-close action. Many OEM power plans mark LIDACTION hidden, and
 * `/query` then prints only the scheme line, so the action was never known and the
 * "set it to Do nothing" guidance never showed. `/qh` includes hidden settings;
 * `/query` stays as the fallback for a powercfg that refuses `/qh`.
 */
export async function readWindowsLidAction(run:Run,powercfg:string):Promise<{ac:number;dc:number}|null>{
  for(const flag of ['/qh','/query']){
    try{const parsed=windowsLidAction(await run(powercfg,[flag,'SCHEME_CURRENT','SUB_BUTTONS','LIDACTION']));if(parsed)return parsed;}catch{}
  }
  return null;
}

/** Mains online, or no battery at all (a desktop). Null when it cannot be read. */
export function linuxOnAcPower(dir:string):boolean|null{
  try{
    let battery=false;
    for(const name of readdirSync(dir)){
      const type=readFileSync(join(dir,name,'type'),'utf8').trim();
      if(type==='Mains')return readFileSync(join(dir,name,'online'),'utf8').trim()==='1';
      if(type==='Battery')battery=true;
    }
    return battery?null:true;
  }catch{return null;}
}

export const WINDOWS_LID_GUIDANCE='Windows still sleeps when the lid closes. Open Control Panel > Power Options > Choose what closing the lid does, and set Plugged in to Do nothing. Or run: powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0, then powercfg /setactive SCHEME_CURRENT.';

type Run=(file:string,args:string[])=>Promise<string>;
export type ServerModeDeps = {
  platform: NodeJS.Platform;
  run: Run;
  approve: (script: string) => Promise<void>;
  helperSource: () => string;
  stateFile: string;
  helperPath: string;
  plistPath: string;
  now: () => number;
  heartbeatMs: number;
  heartbeatMaxAgeSeconds: number;
  graceMaxAgeSeconds: number;
  inhibit: () => ChildProcess;
  powerSupplyDir: string;
};

function commandFailure(file:string,error:Error,stderr:string|Buffer){
  const detail=String(stderr||'').trim()||error.message;
  return new Error(`${file.split('/').pop()??file}: ${detail}`);
}

export function execRun(file:string,args:string[]):Promise<string>{
  return new Promise((resolve,reject)=>{
    execFile(file,args,{timeout:300_000,maxBuffer:1024*1024,encoding:'utf8',windowsHide:true},(error,stdout,stderr)=>{
      if(error)reject(commandFailure(file,error,stderr));else resolve(String(stdout));
    });
  });
}

/** Runs one shell script with administrator approval, then deletes it. */
export async function runWithAdmin(script:string,run:Run=execRun):Promise<void>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-server-mode-'));
  const file=join(dir,'admin.sh');
  writeFileSync(file,script,{mode:0o700});
  try{
    await run('/usr/bin/osascript',['-e',`do shell script ${JSON.stringify(`/bin/sh ${file}`)} with administrator privileges`]);
  }catch(e){
    const message=(e as Error).message;
    if(/\(-128\)|user cancel/i.test(message))throw new Error('Administrator approval was cancelled. Nothing was changed.');
    throw new Error(`The system helper could not be installed: ${message}`);
  }finally{ rmSync(dir,{recursive:true,force:true}); }
}

function xml(value:string){return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');}

export function systemDeps(overrides:Partial<ServerModeDeps>={}):ServerModeDeps{
  return {
    platform:process.platform,
    run:execRun,
    approve:script=>runWithAdmin(script),
    helperSource:()=>readFileSync(new URL('../native/server-mode/helper.sh',import.meta.url),'utf8'),
    stateFile:join(stateDir,'server-mode.json'),
    helperPath:SERVER_MODE_HELPER,
    plistPath:SERVER_MODE_PLIST,
    now:()=>Date.now(),
    heartbeatMs:20_000,
    heartbeatMaxAgeSeconds:300,
    graceMaxAgeSeconds:7200,
    inhibit:spawnLidInhibitor,
    powerSupplyDir:'/sys/class/power_supply',
    ...overrides,
  };
}

export class ServerMode {
  private deps: ServerModeDeps;
  private timer?: NodeJS.Timeout;
  private lidSleepDisabled: boolean | null = null;
  private onAcPower: boolean | null = null;
  private batteryPercent: number | null = null;
  private lowWarned = false;
  /** Called once each time the Mac drops below the battery floor while server mode holds it awake. */
  onLowBattery?: (percent:number,floor:number)=>void;
  private error: string | null = null;
  private statusChangedAt = 0;
  private guidance: string | null = null;
  /** Linux only: the systemd-inhibit lock that is server mode there. */
  private hold?: ChildProcess;

  constructor(private store: Store, overrides:Partial<ServerModeDeps>={}){
    this.deps=systemDeps(overrides);
  }

  get supported(){return ['darwin','win32','linux'].includes(this.deps.platform);}
  private get mac(){return this.deps.platform==='darwin';}
  get enabled(){return this.store.get('server-mode')==='true';}
  /** Battery use is on by default: the owner asked for the lid-closed Mac to keep working unplugged. */
  get allowBattery(){return this.store.get('server-mode-battery')!=='false';}
  get batteryFloor(){const n=Number(this.store.get('server-mode-battery-floor'));return Number.isInteger(n)&&n>=5&&n<=95?n:15;}
  get lowBatteryOk(){return this.store.get('server-mode-low-battery-ok')==='true';}
  private get lowBattery(){return this.enabled&&this.allowBattery&&this.onAcPower===false&&this.batteryPercent!==null&&this.batteryPercent<this.batteryFloor;}

  /** The owner's answer to the low battery question. Kept until the Mac is back on power. */
  async setLowBatteryOk(ok:boolean):Promise<string>{
    this.store.set('server-mode-low-battery-ok',ok?'true':'false');
    if(this.enabled)this.writeState();
    await this.refresh();
    const pct=this.batteryPercent===null?'':` (battery ${this.batteryPercent}%)`;
    return ok?`Keeping the Mac awake with the lid closed until 5% battery${pct}.`:`Normal sleep will return on battery${pct}. Plug in to keep working with the lid closed.`;
  }

  view():ServerModeView{
    const state=this.readState();
    const age=state.heartbeat===null?null:Math.max(0,this.deps.now()-state.heartbeat);
    const grace=this.deps.graceMaxAgeSeconds*1000;
    return {
      supported:this.supported,
      enabled:this.enabled,
      helperInstalled:this.mac&&existsSync(this.deps.helperPath),
      lidSleepDisabled:this.lidSleepDisabled,
      onAcPower:this.onAcPower,
      heartbeatAgeMs:age,
      graceRemainingMs:age===null?null:Math.max(0,grace-age),
      batteryPercent:this.batteryPercent,
      batteryFloor:this.batteryFloor,
      allowBattery:this.allowBattery,
      lowBatteryNeedsConfirm:this.lowBattery&&!this.lowBatteryOk,
      active:this.enabled&&this.lidSleepDisabled===true&&(this.onAcPower===true||this.onAcPower===false&&this.allowBattery&&this.batteryPercent!==null&&this.batteryPercent>=5&&(this.batteryPercent>=this.batteryFloor||this.lowBatteryOk)),
      statusAgeMs:this.statusChangedAt===0?0:Math.max(0,this.deps.now()-this.statusChangedAt),
      error:this.error,
      guidance:this.enabled?this.guidance:null,
    };
  }

  /** Re-reads the real system state so the view never claims more than it knows. */
  async refresh():Promise<void>{
    if(!this.supported)return;
    if(!this.mac)return this.refreshPortable();
    try{
      const [settings,battery]=await Promise.all([this.deps.run('/usr/bin/pmset',['-g']),this.deps.run('/usr/bin/pmset',['-g','batt'])]);
      const nextSleep=/SleepDisabled\s+1\b/.test(settings)?true:/SleepDisabled\s+0\b/.test(settings)?false:null;
      if(nextSleep!==this.lidSleepDisabled)this.statusChangedAt=this.deps.now();
      this.lidSleepDisabled=nextSleep;
      const first=battery.split('\n')[0]??'';
      this.onAcPower=/AC Power/.test(first)?true:/Battery Power/.test(first)?false:null;
      const pct=/(\d{1,3})%/.exec(battery);this.batteryPercent=pct?Number(pct[1]):null;
      // Back on power: forget the low battery answer, so the next drop asks again.
      if(this.onAcPower===true&&this.lowBatteryOk){this.store.set('server-mode-low-battery-ok','false');if(this.enabled)this.writeState();}
      if(!this.lowBattery)this.lowWarned=false;
      else if(!this.lowWarned&&!this.lowBatteryOk){this.lowWarned=true;try{this.onLowBattery?.(this.batteryPercent!,this.batteryFloor);}catch{}}
    }catch(e){
      // A failed probe is a claim of nothing, not a claim of "off".
      this.lidSleepDisabled=null;this.onAcPower=null;this.error=(e as Error).message;
    }
  }

  /**
   * Windows and Linux need no privileged helper. Linux holds a logind lock from this
   * process. Windows already holds idle sleep off through the keep-awake assertion that
   * server mode implies (power.ts); the lid-close action is a power-plan setting the
   * owner changes once, so it is read back and named, never claimed.
   */
  private async refreshPortable():Promise<void>{
    let lid:boolean|null=null,ac:boolean|null=null,guidance:string|null=null;
    if(this.deps.platform==='linux'){
      lid=this.enabled?!!this.hold&&this.hold.exitCode===null&&this.hold.signalCode===null:false;
      ac=linuxOnAcPower(this.deps.powerSupplyDir);
    }else{
      const root=process.env.SystemRoot??'C:\\Windows';
      const [action,line]=await Promise.allSettled([
        readWindowsLidAction(this.deps.run,join(root,'System32','powercfg.exe')),
        this.deps.run(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus']),
      ]);
      const parsed=action.status==='fulfilled'?action.value:null;
      lid=parsed?parsed.ac===0:null;
      if(lid===false)guidance=WINDOWS_LID_GUIDANCE;
      if(line.status==='fulfilled')ac=/Online/.test(line.value)?true:/Offline/.test(line.value)?false:null;
    }
    if(lid!==this.lidSleepDisabled)this.statusChangedAt=this.deps.now();
    this.lidSleepDisabled=lid;this.onAcPower=ac;this.guidance=guidance;
  }

  /** Linux: take the lock and wait briefly, so a polkit refusal is reported instead of a dead switch. */
  private async takeHold():Promise<void>{
    if(this.deps.platform!=='linux'||(this.hold&&this.hold.exitCode===null))return;
    const child=this.deps.inhibit();this.hold=child;
    let said='';child.stderr?.on('data',d=>{said+=String(d);});
    child.on('exit',()=>{if(this.hold===child&&this.enabled)this.error=`Server mode stopped holding sleep off: ${said.trim()||'systemd-inhibit exited'}. Turn it off and on again.`;});
    const failed=await new Promise<string|null>(resolve=>{
      const timer=setTimeout(()=>resolve(null),750);
      child.once('error',e=>{clearTimeout(timer);resolve(`systemd-inhibit could not start (${e.message}). Server mode needs systemd-logind.`);});
      child.once('exit',()=>{clearTimeout(timer);resolve(said.trim()||'systemd-inhibit exited at once.');});
    });
    if(failed){this.hold=undefined;throw new Error(`The system refused to hold sleep off: ${failed}`);}
  }
  private dropHold(){this.hold?.kill();this.hold=undefined;}

  /** Called once at startup so a stale heartbeat from the last run cannot pin the Mac. */
  async initialize():Promise<void>{
    if(!this.supported)return;
    if(!this.mac){if(this.enabled)await this.takeHold().catch(e=>{this.error=(e as Error).message;});return this.refresh();}
    if(this.enabled){this.writeState();this.startHeartbeat();}
    else this.writeState();
    await this.refresh();
  }

  async setEnabled(enable:boolean):Promise<void>{
    if(enable&&!this.supported)throw new Error('Server mode is available on macOS, Windows and Linux only.');
    this.statusChangedAt=this.deps.now();
    if(!this.mac){
      if(enable){
        try{await this.takeHold();}
        catch(e){this.store.set('server-mode','false');this.error=(e as Error).message;await this.refresh();throw e;}
        this.store.set('server-mode','true');this.error=null;
      }else{this.store.set('server-mode','false');this.dropHold();this.error=null;}
      return this.refresh();
    }
    if(enable){
      this.store.set('server-mode','true');
      this.writeState();
      try{
        if(!this.helperCurrent()||!await this.daemonLoaded())await this.install();
      }catch(e){
        this.store.set('server-mode','false');this.writeState();
        this.stopHeartbeat();
        this.error=(e as Error).message;
        await this.refresh();
        throw e;
      }
      this.error=null;
      this.startHeartbeat();
    }else{
      this.store.set('server-mode','false');
      this.stopHeartbeat();
      // The helper restores normal sleep on its next check, so disabling never
      // needs an administrator approval of its own.
      this.writeState();
    }
    await this.refresh();
  }

  /** Removes the helper entirely. Only offered while server mode is off. */
  async removeHelper():Promise<void>{
    if(this.enabled)throw new Error('Turn server mode off before removing its helper.');
    if(!this.mac)return;
    if(!existsSync(this.deps.plistPath)&&!existsSync(this.deps.helperPath))return;
    await this.deps.approve([
      'set -eu',
      `/bin/launchctl bootout system/${SERVER_MODE.label} 2>/dev/null || true`,
      `/bin/rm -f '${SERVER_MODE_PLIST.replaceAll("'","'\\''")}'`,
      `/bin/rm -rf '${SERVER_MODE.support.replaceAll("'","'\\''")}'`,
      '/usr/bin/pmset -a disablesleep 0 >/dev/null 2>&1 || true',
    ].join('\n')+'\n');
    this.error=null;
    await this.refresh();
  }

  /** Stops the heartbeat but keeps `enabled=true` in the state file. A clean
   * shutdown must not release the hold: the backend is a KeepAlive agent and a
   * restart is routine, so releasing here would open a window in which a
   * lid-closed Mac could sleep. Only turning the setting off releases it. */
  close(){this.stopHeartbeat();this.dropHold();}

  private startHeartbeat(){
    this.stopHeartbeat();
    this.timer=setInterval(()=>{try{this.writeState();}catch(e){this.error=(e as Error).message;}},this.deps.heartbeatMs);
    this.timer.unref?.();
  }
  private stopHeartbeat(){if(this.timer){clearInterval(this.timer);this.timer=undefined;}}

  private writeState(){
    const state={version:1,enabled:this.enabled,heartbeat:this.deps.now(),pid:process.pid,allowBattery:this.allowBattery,batteryFloor:this.batteryFloor,lowBatteryOk:this.lowBatteryOk};
    writeFileSync(this.deps.stateFile,JSON.stringify(state),{mode:0o600});
  }

  private readState():{enabled:boolean;heartbeat:number|null}{
    try{
      const parsed=JSON.parse(readFileSync(this.deps.stateFile,'utf8')) as {enabled?:unknown;heartbeat?:unknown};
      return {enabled:parsed.enabled===true,heartbeat:typeof parsed.heartbeat==='number'?parsed.heartbeat:null};
    }catch{
      const mtime=this.fileMtime();
      return {enabled:false,heartbeat:mtime};
    }
  }

  private fileMtime():number|null{
    try{return statSync(this.deps.stateFile).mtimeMs;}catch{return null;}
  }

  /** The bundled source and the installed copy must agree. Without this an
   * installed helper is never replaced, so every machine that already had one
   * would keep the old decision rules forever. */
  private helperCurrent():boolean{
    try{
      const want=HELPER_VERSION.exec(this.deps.helperSource())?.[1];
      const have=HELPER_VERSION.exec(readFileSync(this.deps.helperPath,'utf8'))?.[1];
      return want!==undefined&&have===want;
    }catch{return false;}
  }

  /** A file on disk is not a running daemon. Server mode must not report itself
   * on while nothing is left to hold sleep off, so a missing job reinstalls. */
  private async daemonLoaded():Promise<boolean>{
    try{await this.deps.run('/bin/launchctl',['print',`system/${SERVER_MODE.label}`]);return true;}
    catch{return false;}
  }

  private installScript():string{
    const source=this.deps.helperSource();
    if(!source.includes('FarFromDesk server mode helper'))throw new Error('The bundled server mode helper is missing.');
    if(HELPER_VERSION.exec(source)?.[1]!==String(SERVER_MODE_HELPER_VERSION))throw new Error('The bundled server mode helper is not the expected version.');
    const uid=process.getuid?.();
    if(uid===undefined)throw new Error('Server mode needs a signed-in owner account.');
    const plist=[
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      `<key>Label</key><string>${SERVER_MODE.label}</string>`,
      `<key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(this.deps.helperPath)}</string></array>`,
      '<key>EnvironmentVariables</key><dict>',
      `<key>FFD_STATE_FILE</key><string>${xml(this.deps.stateFile)}</string>`,
      `<key>FFD_STATE_UID</key><string>${uid}</string>`,
      `<key>FFD_HEARTBEAT_MAX_AGE</key><string>${this.deps.heartbeatMaxAgeSeconds}</string>`,
      `<key>FFD_GRACE_MAX_AGE</key><string>${this.deps.graceMaxAgeSeconds}</string>`,
      '</dict>',
      '<key>RunAtLoad</key><true/>',
      '<key>KeepAlive</key><true/>',
      '<key>ThrottleInterval</key><integer>10</integer>',
      '<key>ProcessType</key><string>Background</string>',
      `<key>StandardOutPath</key><string>${xml(SERVER_MODE.log)}</string>`,
      `<key>StandardErrorPath</key><string>${xml(SERVER_MODE.log)}</string>`,
      '</dict></plist>','',
    ].join('\n');
    const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
    return [
      'set -eu',
      `/usr/bin/install -d -m 755 -o root -g wheel ${quote(SERVER_MODE.support)}`,
      `cat > ${quote(this.deps.helperPath)} <<'FFD_HELPER_EOF'`,
      source,
      'FFD_HELPER_EOF',
      `/bin/chmod 755 ${quote(this.deps.helperPath)}`,
      `/usr/sbin/chown root:wheel ${quote(this.deps.helperPath)}`,
      `cat > ${quote(this.deps.plistPath)} <<'FFD_PLIST_EOF'`,
      plist,
      'FFD_PLIST_EOF',
      `/bin/chmod 644 ${quote(this.deps.plistPath)}`,
      `/usr/sbin/chown root:wheel ${quote(this.deps.plistPath)}`,
      `/bin/launchctl bootout system/${SERVER_MODE.label} 2>/dev/null || true`,
      // bootout is asynchronous. Bootstrapping the same label while the old job is
      // still going away fails with "Bootstrap failed: 5: Input/output error", which
      // 2377 did on this machine: the helper and plist were written and nothing was
      // loaded, leaving server mode switched on with no daemon behind it. So wait for
      // the old job to disappear, retry once, and then fail loudly rather than claim
      // an install that did not load.
      `w=0; while [ "$w" -lt 20 ] && /bin/launchctl print system/${SERVER_MODE.label} >/dev/null 2>&1; do w=$((w+1)); sleep 0.5; done`,
      `if ! /bin/launchctl bootstrap system ${quote(this.deps.plistPath)} 2>/dev/null; then sleep 2; /bin/launchctl bootstrap system ${quote(this.deps.plistPath)}; fi`,
      '/bin/launchctl enable system/'+SERVER_MODE.label,
      `/bin/launchctl print system/${SERVER_MODE.label} >/dev/null`,
      '',
    ].join('\n');
  }

  private async install():Promise<void>{
    await this.deps.approve(this.installScript());
    if(!existsSync(this.deps.helperPath))throw new Error('The system helper did not install. Check that this account can approve administrator actions.');
  }
}