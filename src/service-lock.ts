import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

/** OS-released SQLite lock: crashes cannot leave a stale PID or race a replacement. */
export function acquireServiceLock(directory:string) {
  const db=new DatabaseSync(join(directory,'service-lock.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER)');
  } catch (error) {
    db.close();
    if ((error as any).errcode===5 || /locked|busy/i.test(String(error)))
      throw new Error('FarFromDesk is already running for this data directory.');
    throw error;
  }
  let released=false;
  return ()=>{if(!released){released=true;db.close();}};
}

/**
 * Waits for the lock instead of throwing. A KeepAlive LaunchAgent started beside the app's own
 * backend otherwise died here every ThrottleInterval, dumping a stack each time, and a copy that
 * simply exited would leave nobody serving once the app quit. The file is closed between tries,
 * so the app's lsof lock check never mistakes this waiter for the owner.
 */
export async function waitForServiceLock(directory:string,poll=15000,log:(line:string)=>void=console.error) {
  for(let logged=false;;await new Promise(r=>setTimeout(r,poll))){
    try{return acquireServiceLock(directory);}catch(error){
      if(!/already running/.test(String(error)))throw error;
      if(!logged){logged=true;log(`${(error as Error).message} Waiting to take over when it exits.`);}
    }
  }
}
