import {spawnSync} from 'node:child_process';

export function smokeFetch(url,options={},timeout=5000) {
  const deadline=AbortSignal.timeout(timeout);
  return fetch(url,{...options,signal:options.signal?AbortSignal.any([options.signal,deadline]):deadline});
}

// The GUI may handle SIGTERM without quitting. Never leave its child handle
// keeping a successful CI smoke process alive indefinitely.
export async function stopSmokeApp(app,grace=1500) {
  if(!app.pid)return;
  if(process.platform==='win32') {
    spawnSync('taskkill',['/pid',String(app.pid),'/T','/F'],{timeout:10000,stdio:'ignore'});
    return;
  }
  const signal=name=>{try{process.kill(-app.pid,name);}catch{app.kill(name);}};
  signal('SIGTERM');
  if(app.exitCode===null&&app.signalCode===null) {
    await new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);app.removeListener('exit',finish);resolve();};
      const timer=setTimeout(finish,grace);
      app.once('exit',finish);
    });
  }
  signal('SIGKILL');
}
