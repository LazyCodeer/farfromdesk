// Loaded only by the no-publish diagnostic workflow. A timestamp written from
// this event loop lets an independent observer distinguish a stalled Node
// loop from a worker that is merely waiting. Never write state or credentials.
import {writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';

const directory=process.env.FFD_DIAGNOSTIC_DIR;
const configured=Number(process.env.FFD_DIAGNOSTIC_HEARTBEAT_MS ?? 5000);
const interval=Math.max(100,Math.min(30000,Number.isFinite(configured)?configured:5000));
let pending=false;
function heartbeat() {
  if(!directory||pending)return;
  pending=true;
  const target=join(directory,'supervisor-heartbeat'),temporary=join(directory,`supervisor-heartbeat.${process.pid}.tmp`);
  void writeFile(temporary,`${process.pid} ${Date.now()}\n`,{mode:0o600})
    .then(()=>rename(temporary,target))
    .catch(()=>unlink(temporary).catch(()=>{}))
    .finally(()=>{pending=false;});
}
heartbeat();
setInterval(heartbeat,interval).unref();
