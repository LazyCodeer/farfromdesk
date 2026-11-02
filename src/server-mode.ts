import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDir } from './config.js';
import type { Store } from './store.js';

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

export type ServerModeView = {
  supported: boolean;
  enabled: boolean;
  helperInstalled: boolean;
  lidSleepDisabled: boolean | null;
  onAcPower: boolean | null;
  heartbeatAgeMs: number | null;
  active: boolean;
  /** How long the reported system state has been unchanged, so a helper that
   * never takes effect can be reported instead of spinning forever. */
  statusAgeMs: number;
  error: string | null;
};

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
};

function commandFailure(file:string,error:Error,stderr:string|Buffer){
  const detail=String(stderr||'').trim()||error.message;
  return new Error(`${file.split('/').pop()??file}: ${detail}`);
}

export function execRun(file:string,args:string[]):Promise<string>{
  return new Promise((resolve,reject)=>{
    execFile(file,args,{timeout:300_000,maxBuffer:1024*1024,encoding:'utf8'},(error,stdout,stderr)=>{
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
    ...overrides,
  };
}

export class ServerMode {
  private deps: ServerModeDeps;
  private timer?: NodeJS.Timeout;
  private lidSleepDisabled: boolean | null = null;
  private onAcPower: boolean | null = null;
  private error: string | null = null;
  private statusChangedAt = 0;

  constructor(private store: Store, overrides:Partial<ServerModeDeps>={}){
    this.deps=systemDeps(overrides);
  }

  get supported(){return this.deps.platform==='darwin';}
  get enabled(){return this.store.get('server-mode')==='true';}

  view():ServerModeView{
    const state=this.readState();
    return {
      supported:this.supported,
      enabled:this.enabled,
      helperInstalled:existsSync(this.deps.helperPath),
      lidSleepDisabled:this.lidSleepDisabled,
      onAcPower:this.onAcPower,
      heartbeatAgeMs:state.heartbeat===null?null:Math.max(0,this.deps.now()-state.heartbeat),
      active:this.enabled&&this.lidSleepDisabled===true&&this.onAcPower===true,
      statusAgeMs:this.statusChangedAt===0?0:Math.max(0,this.deps.now()-this.statusChangedAt),
      error:this.error,
    };
  }

  /** Re-reads the real system state so the view never claims more than it knows. */
  async refresh():Promise<void>{
    if(!this.supported)return;
    try{
      const [settings,battery]=await Promise.all([this.deps.run('/usr/bin/pmset',['-g']),this.deps.run('/usr/bin/pmset',['-g','batt'])]);
      const nextSleep=/SleepDisabled\s+1\b/.test(settings)?true:/SleepDisabled\s+0\b/.test(settings)?false:null;
      if(nextSleep!==this.lidSleepDisabled)this.statusChangedAt=this.deps.now();
      this.lidSleepDisabled=nextSleep;
      const first=battery.split('\n')[0]??'';
      this.onAcPower=/AC Power/.test(first)?true:/Battery Power/.test(first)?false:null;
    }catch(e){
      // A failed probe is a claim of nothing, not a claim of "off".
      this.lidSleepDisabled=null;this.onAcPower=null;this.error=(e as Error).message;
    }
  }

  /** Called once at startup so a stale heartbeat from the last run cannot pin the Mac. */
  async initialize():Promise<void>{
    if(!this.supported)return;
    if(this.enabled){this.writeState();this.startHeartbeat();}
    else this.writeState();
    await this.refresh();
  }

  async setEnabled(enable:boolean):Promise<void>{
    if(enable&&!this.supported)throw new Error('Server mode is available on macOS only.');
    this.statusChangedAt=this.deps.now();
    if(enable){
      this.store.set('server-mode','true');
      this.writeState();
      try{
        if(!existsSync(this.deps.helperPath))await this.install();
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

  close(){this.stopHeartbeat();}

  private startHeartbeat(){
    this.stopHeartbeat();
    this.timer=setInterval(()=>{try{this.writeState();}catch(e){this.error=(e as Error).message;}},this.deps.heartbeatMs);
    this.timer.unref?.();
  }
  private stopHeartbeat(){if(this.timer){clearInterval(this.timer);this.timer=undefined;}}

  private writeState(){
    const state={version:1,enabled:this.enabled,heartbeat:this.deps.now(),pid:process.pid};
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

  private installScript():string{
    const source=this.deps.helperSource();
    if(!source.includes('FarFromDesk server mode helper'))throw new Error('The bundled server mode helper is missing.');
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
      `/bin/launchctl bootstrap system ${quote(this.deps.plistPath)}`,
      '/bin/launchctl enable system/'+SERVER_MODE.label,
      '',
    ].join('\n');
  }

  private async install():Promise<void>{
    await this.deps.approve(this.installScript());
    if(!existsSync(this.deps.helperPath))throw new Error('The system helper did not install. Check that this account can approve administrator actions.');
  }
}
