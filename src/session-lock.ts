import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {computerName} from './platform.js';
import {windowsPowerShell} from './power.js';
const exec=promisify(execFile);

/** The bundled probe, the same one the phone's remote screen uses. */
export const sessionProbePath=fileURLToPath(new URL('../native/session-state',import.meta.url));

/** A probe binary that prints {"unlocked":bool}, or a function that answers directly. */
export type LockProbe=string|(()=>Promise<boolean|undefined>);

/** true when the computer is locked, false when it is unlocked, undefined when the probe
 * cannot say. An unknown answer must not unlock anything, and must not block work
 * either, so it is neither. */
export async function sessionLocked(stateProbe:LockProbe):Promise<boolean|undefined>{
  if(typeof stateProbe==='function'){try{const locked=await stateProbe();return typeof locked==='boolean'?locked:undefined;}catch{return undefined;}}
  try{
    const state=JSON.parse((await exec(stateProbe,[],{timeout:3000})).stdout) as {unlocked?:boolean};
    if(state.unlocked===true)return false;
    if(state.unlocked===false)return true;
    return undefined;
  }catch{return undefined;}
}

/**
 * Windows has no session-state binary: the input desktop says it instead, the same check the
 * phone's remote screen uses (native/remote-windows.ps1 Locked()). While the lock screen, the
 * sign-in screen or a UAC prompt is up, the input desktop is "Winlogon" (or cannot be opened at
 * all from the user's session); on an unlocked PC it is "Default". ASCII and C# 5 only, for
 * Windows PowerShell 5.1.
 */
export const WINDOWS_LOCK_SCRIPT=String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FFDLock {
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);
  public static string InputDesktop() {
    IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
    if (desktop == IntPtr.Zero) return "";
    try {
      StringBuilder name = new StringBuilder(256); int needed;
      if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed)) return "";
      return name.ToString();
    } finally { CloseDesktop(desktop); }
  }
}
'@
$name = [FFDLock]::InputDesktop()
[Console]::Out.Write((@{ locked = -not [string]::Equals($name, 'Default', [StringComparison]::OrdinalIgnoreCase); desktop = $name } | ConvertTo-Json -Compress))
`;

export type LockRunner=(file:string,args:string[],options:{timeout:number;windowsHide:true})=>Promise<{stdout:string}>;
/** Whether this Windows PC is locked: true, false, or undefined when PowerShell cannot say. */
export async function windowsSessionLocked(run:LockRunner=(file,args,options)=>exec(file,args,options).then(r=>({stdout:String(r.stdout)}))):Promise<boolean|undefined>{
  try{
    const state=JSON.parse((await run(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(WINDOWS_LOCK_SCRIPT,'utf16le').toString('base64')],{timeout:15000,windowsHide:true})).stdout) as {locked?:unknown};
    return typeof state.locked==='boolean'?state.locked:undefined;
  }catch{return undefined;}
}

/** The lock probe for this platform: the bundled binary on macOS, the input desktop on Windows. */
export const sessionProbe:LockProbe=process.platform==='win32'?()=>windowsSessionLocked():sessionProbePath;

/** Actions that mean nothing to the screen, so a locked Mac must not refuse them:
 * stopping clears references, status reports the driver, check_permissions reports the
 * grants. Refusing those would leave the owner unable to diagnose the lock. */
const EXEMPT=new Set(['stop','status','check_permissions']);
/**
 * On Windows these send no input to the screen: app tools go through Outlook and OneNote over
 * COM, the file system and the media controls, and the listings and reads are UI Automation
 * queries. Blocking them on a locked PC refused "what is on my calendar" for no reason (live,
 * 6 Nov 2026). Anything that clicks, types, opens or brings a window forward is still refused.
 * A read that cannot work while locked (a screenshot) fails on its own with its own reason.
 */
const WINDOWS_OFF_SCREEN=new Set(['app_tools','app_tool','list_apps','list_windows','read_window','list_browsers','list_tabs','read_tab']);

/** How long one link stands before another is minted. Every call makes a fresh one and
 * invalidates the last, so a model retrying a blocked action would otherwise send the
 * owner a pile of links, all dead but the newest. */
export const LINK_COOLDOWN_MS=60_000;

/** Refuses a screen action while the Mac is locked, and hands the owner the remote
 * link instead of acting blind.
 *
 * A locked Mac does accept synthetic input, which is exactly the problem: the click
 * or the keystroke arrives at the lock screen, not at the application the request was
 * about, and the most likely landing place for typed text is the Mac password field.
 * So the action stops here and the owner gets the same link and code the "control my
 * screen" command sends. Unlocking from the phone fixes it for real: the remote session
 * can type the Mac password at the lock screen, and afterwards the Mac is ordinary to
 * every tool here.
 *
 * The refusal is thrown in every case. A missing probe, an unset remote password, a host
 * that will not start, a failed delivery: none of them is permission to act on a locked
 * screen, and the message says which of them happened so the coordinator can ask for the
 * right next step rather than inventing one. */
export function screenLockGate(deps:{probe:LockProbe;link:()=>Promise<string|undefined>;notify:(text:string)=>void;now?:()=>number;cooldownMs?:number;platform?:NodeJS.Platform;
  /** Windows: the Screen Helper service is running, so the phone can show and type on the lock screen. */
  lockScreenUnlockable?:()=>Promise<boolean>}){
  const now=deps.now??Date.now, cooldown=deps.cooldownMs??LINK_COOLDOWN_MS, platform=deps.platform??process.platform;
  let lastLinkAt=0;
  return async(action:string):Promise<void>=>{
    if(EXEMPT.has(action))return;
    if(platform==='win32'&&WINDOWS_OFF_SCREEN.has(action))return;
    if(await sessionLocked(deps.probe)!==true)return;
    // Windows keeps the lock screen on a secure desktop that no input from the user's session
    // reaches. With the Screen Helper service the phone can still unlock it, so the owner gets
    // the same link as on a Mac; without it a link would be a promise it cannot keep, so the
    // owner is told the honest next step.
    if(platform==='win32'&&!await deps.lockScreenUnlockable?.().catch(()=>false)){
      if(now()-lastLinkAt>=cooldown){lastLinkAt=now();try{deps.notify(`Your PC is locked, so ${action} was not sent to the screen. Windows does not let remote input reach the lock screen, so it has to be unlocked at the PC itself. Ask again once it is unlocked.`);}catch{}}
      throw new Error('SESSION_LOCKED: the PC is locked, so a screen action would land on the Windows lock screen instead of your apps. Windows does not accept remote input there, so the owner has to unlock it at the PC; do not send a remote-control link. Then retry.');
    }
    const pc=computerName(platform);
    let claim='Send "control my screen" in this chat to get a link.';
    if(now()-lastLinkAt>=cooldown){
      const link=await deps.link().catch(()=>undefined);
      // The service answers a refusal or a missing password with prose, not a link.
      if(link&&/https?:\/\//.test(link)){
        // Minting a link invalidates the previous one, so the cooldown starts here even
        // if delivery then fails: a pile of dead links would be worse than one lost.
        lastLinkAt=now();
        let delivered=false;
        try{deps.notify(`Your ${pc} is locked, so ${action} was not sent to the screen. Unlock it from your phone:\n\n${link}`);delivered=true;}catch{}
        claim=delivered?`A remote-control link has been sent to this chat; open it on the phone, send back the code it shows, then enter your ${pc} password.`:'A remote-control link was created but could not be delivered here; ask the owner to send "control my screen".';
      }
    }else claim='A remote-control link was sent to this chat in the last minute and is still current; use that one rather than asking for another.';
    throw new Error(`SESSION_LOCKED: the ${pc} is locked, so a screen action would land on the lock screen instead of your apps. ${claim} Then retry.`);
  };
}