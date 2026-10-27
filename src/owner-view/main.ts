import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {EmbeddedDesktopDriver} from '../desktop-driver.js';
import {OwnerViewSession} from './session.js';
import {NativeOwnerBackend} from './native.js';
import {ownerViewServer} from './http.js';

// Deliberately separate from the bridge and agent routes: starting this is local owner opt-in.
async function main(){
  const [pid,windowId,probe,nativeDirectory,helperBundle]=process.argv.slice(2);
  if(!/^\d+$/.test(pid??'')||!/^\d+$/.test(windowId??'')||!probe)throw Error('Usage: node dist/owner-view/main.js PID WINDOW_ID /absolute/path/to/session-state');
  const backend=new NativeOwnerBackend(Number(pid),Number(windowId),resolve(probe),nativeDirectory?resolve(nativeDirectory)+'/':undefined,helperBundle&&nativeDirectory?new EmbeddedDesktopDriver(resolve(nativeDirectory)+'/',helperBundle,true):undefined);
  if(!await backend.ready()){backend.stop();throw Error('Owner view not started: '+JSON.stringify(backend.lastReadiness));}
  const session=new OwnerViewSession(backend);
  const meta=process.env.FFD_META_ENDPOINT&&process.env.FFD_META_MODEL&&process.env.FFD_META_KEY?{endpoint:process.env.FFD_META_ENDPOINT,model:process.env.FFD_META_MODEL,key:process.env.FFD_META_KEY}:undefined;
  const view=ownerViewServer(session,meta),origin=await view.listen();
  // Local owner setup only. Never put the pairing secret in a URL or application audit log.
  process.stdout.write(`Local owner view: ${origin}\nOne-time pairing code (expires in 5 minutes): ${session.pairingCode}\nKeep this terminal private. Ctrl-C stops this session.\n`);
  if(process.env.FFD_OWNER_OPEN_BROWSER==='1')execFile('/usr/bin/open',[origin],error=>{if(error)console.error('Open the local owner view address above in your browser.');});
  const stop=()=>{session.stop();view.server.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void main().catch(e=>{console.error((e as Error).message);process.exitCode=1;});
