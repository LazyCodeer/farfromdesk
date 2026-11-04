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
 * stopping clears references, status reports the driver, check_permissions reports the
 * grants. Refusing those would leave the owner unable to diagnose the lock. */
const EXEMPT=new Set(['stop','status','check_permissions']);

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
export function screenLockGate(deps:{probe:string;link:()=>Promise<string|undefined>;notify:(text:string)=>void;now?:()=>number;cooldownMs?:number}){
  const now=deps.now??Date.now, cooldown=deps.cooldownMs??LINK_COOLDOWN_MS;
  let lastLinkAt=0;
  return async(action:string):Promise<void>=>{
    if(EXEMPT.has(action))return;
    if(await sessionLocked(deps.probe)!==true)return;
    let claim='Send "control my screen" in this chat to get a link.';
    if(now()-lastLinkAt>=cooldown){
      const link=await deps.link().catch(()=>undefined);
      // The service answers a refusal or a missing password with prose, not a link.
      if(link&&/https?:\/\//.test(link)){
        // Minting a link invalidates the previous one, so the cooldown starts here even
        // if delivery then fails: a pile of dead links would be worse than one lost.
        lastLinkAt=now();
        let delivered=false;
        try{deps.notify(`Your Mac is locked, so ${action} was not sent to the screen. Unlock it from your phone:\n\n${link}`);delivered=true;}catch{}
        claim=delivered?'A remote-control link has been sent to this chat; open it on the phone, send back the code it shows, then enter your Mac password.':'A remote-control link was created but could not be delivered here; ask the owner to send "control my screen".';
      }
    }else claim='A remote-control link was sent to this chat in the last minute and is still current; use that one rather than asking for another.';
    throw new Error(`SESSION_LOCKED: the Mac is locked, so a screen action would land on the lock screen instead of your apps. ${claim} Then retry.`);
  };
}