import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
const exec=promisify(execFile);

/** The bundled probe, the same one the phone's remote screen uses. */
export const sessionProbePath=fileURLToPath(new URL('../native/session-state',import.meta.url));

/** true when the Mac is locked, false when it is unlocked, undefined when the probe
 * cannot say. An unknown answer must not unlock anything, and must not block work
 * either, so it is neither. */
export async function sessionLocked(stateProbe:string):Promise<boolean|undefined>{
  try{
    const state=JSON.parse((await exec(stateProbe,[],{timeout:3000})).stdout) as {unlocked?:boolean};
    if(state.unlocked===true)return false;
    if(state.unlocked===false)return true;
    return undefined;
  }catch{return undefined;}
}

/** Actions that mean nothing to the screen, so a locked Mac must not refuse them:
 * stopping clears references, status reports the driver, check_permissions reports
 * the grants. Refusing those would leave the owner unable to diagnose the lock. */
const EXEMPT=new Set(['stop','status','check_permissions']);

/** Refuses a screen action while the Mac is locked, and hands the owner the remote
 * link instead of acting blind.
 *
 * A locked Mac does accept synthetic input, which is exactly the problem: the click
 * or the keystroke arrives at the lock screen, not at the application the request was
 * about, and the most likely landing place for typed text is the Mac password field.
 * So the action stops here and the owner gets the same link the "control my screen"
 * command sends. Unlocking from the phone fixes it for real: the remote session can
 * type the Mac password at the lock screen, and afterwards the Mac is ordinary to
 * every tool here. */
export function screenLockGate(deps:{probe:string;link:()=>Promise<string|undefined>;notify:(text:string)=>void}){
  return async(action:string):Promise<void>=>{
    if(EXEMPT.has(action))return;
    if(await sessionLocked(deps.probe)!==true)return;
    const link=await deps.link().catch(()=>undefined);
    // A failed handshake must not replace the real reason with a delivery error. The
    // refusal below still names the lock, and the coordinator can ask the owner to send
    // "control my screen", which takes the same route without any link from here.
    if(link)try{deps.notify(`Your Mac is locked, so ${action} was not sent to the screen. Unlock it from your phone:\n\n${link}`);}catch{}
    throw new Error('SESSION_LOCKED: the Mac is locked, so a screen action would land on the lock screen instead of your apps. A remote-control link has been sent to this chat; open it on the phone, send back the code it shows, enter your Mac password, then retry.');
  };
}