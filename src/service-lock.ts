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
