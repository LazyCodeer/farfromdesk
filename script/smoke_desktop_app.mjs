// Start the actual packaged native entry point against disposable account state.
import {mkdtempSync,readFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {smokeFetch,stopSmokeApp} from './smoke_runtime.mjs';
import {once} from 'node:events';
import assert from 'node:assert/strict';
let phase='preparing isolated state';
const report=message=>{if(process.connected)process.send?.(message,()=>{});};
const stageLog=name=>{phase=name;console.log(`Native smoke: ${name}`);report({type:'phase',name});};
let state,app,headers,watchdog,base,health;
try {
  stageLog(phase);
  state=realpathSync(mkdtempSync(join(tmpdir(),'ffd-native-smoke-')));
const stage=resolve('build/desktop-release/stage');
const binary=process.platform==='darwin'?join(stage,'FarFromDesk.app/Contents/MacOS/FarFromDesk'):
  join(stage,'FarFromDesk',process.platform==='win32'?'farfromdesk.exe':'farfromdesk');
assert.ok(existsSync(binary),'Packaged native executable must exist');
stageLog('reserving local port');
const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
const port=socket.address().port;await new Promise(r=>socket.close(r));
base=`http://127.0.0.1:${port}`;
report({type:'backend-info',state,port});
stageLog('starting packaged app');
app=spawn(binary,[],{stdio:'inherit',detached:process.platform!=='win32',env:{...process.env,WSB_STATE_DIR:state,WSB_PORT:String(port),FFD_SMOKE_TEST:'1',
  WSB_CODEX_BIN:join(state,'missing-codex'),WSB_CLAUDE_BIN:join(state,'missing-claude'),
  CODEX_HOME:join(state,'codex'),CLAUDE_CONFIG_DIR:join(state,'claude')}});
if(app.pid)report({type:'app-started',pid:app.pid});
app.on('exit',()=>report({type:'app-exited',pid:app.pid}));
app.on('error', error => { console.error('Native executable failed to start:', error.message); });
watchdog=setTimeout(()=>{
  console.error(`Native smoke exceeded 180 seconds during ${phase}`);
  if(process.platform==='win32'&&app.pid)spawnSync('taskkill',['/pid',String(app.pid),'/T','/F'],{timeout:10000});
  else if(app.pid){try{process.kill(-app.pid,'SIGKILL');}catch{app.kill('SIGKILL');}}
  process.exit(1);
},180000);
const request=(path,options={})=>smokeFetch(base+path,options);
  stageLog('waiting for UI and backend health');
  const startupDeadline=Date.now()+90000;
  for(let i=0;i<180&&Date.now()<startupDeadline;i++) {
    await new Promise(r=>setTimeout(r,500));
    if(app.exitCode!==null)throw new Error(`Native app exited early: ${app.exitCode}`);
    if(!existsSync(join(state,'admin-token')))continue;
    headers={Authorization:`Bearer ${readFileSync(join(state,'admin-token'),'utf8').trim()}`,'Content-Type':'application/json'};
    try {const r=await smokeFetch(base+'/api/health',{headers},2000);if(r.ok){health=await r.json();if(Number.isSafeInteger(health?.pid)&&health.pid>0)report({type:'backend-pid',pid:health.pid});if(existsSync(join(state,'smoke-ui-ready')))break;}}catch{}
  }
  stageLog('validating startup state');
  console.log(`Native smoke startup: token=${existsSync(join(state,'admin-token'))}, backendHealthy=${!!health}, uiReady=${existsSync(join(state,'smoke-ui-ready'))}`);
  assert.ok(existsSync(join(state,'smoke-ui-ready')),'Native UI must finish startup, read login registration and render Home');
  assert.equal(health?.app,'FarFromDesk');assert.equal(health.protocol,1);
  assert.equal((await request('/api/status')).status,401);
  const status=await (await request('/api/status',{headers})).json();
  assert.equal(status.preferences.backgroundEnabled,false);
  assert.equal(status.master,null);assert.equal(status.voice.ready,false);assert.equal(status.voice.download.state,'needed');
  stageLog('checking installed agent instructions');
  let roles;
  for(let i=0;i<30;i++){roles=await (await request('/api/agents',{headers})).json();if(roles.sync?.state!=='pending')break;await new Promise(r=>setTimeout(r,500));}
  assert.equal(roles.sync?.state,'complete');
  assert.deepEqual(roles.agents.map(a=>a.name).sort(),['farfromdesk-coordinator','farfromdesk-worker']);
  assert.ok(roles.installation.every(a=>a.installation.length===2&&a.installation.every(p=>p.status==='installed'&&p.path.startsWith(state))));
  for(const a of roles.installation)for(const p of a.installation){assert.ok(existsSync(p.path));assert.match(readFileSync(p.path,'utf8'),/First line: one emoji and a short native \*bold\* heading/);}
  // A fresh launch creates these instructions without pairing, a request or a manual sync command.
  assert.equal(status.master,null);
  stageLog('authenticated shutdown');
  // Re-read the live instance immediately before shutdown; startup health may
  // refer to an earlier process if a backend restarted during the smoke run.
  const latestHealth=await request('/api/health',{headers});assert.equal(latestHealth.status,200);
  health=await latestHealth.json();assert.equal(health?.app,'FarFromDesk');assert.equal(health.protocol,1);
  if(Number.isSafeInteger(health.pid)&&health.pid>0)report({type:'backend-pid',pid:health.pid});
  assert.equal((await request('/api/shutdown',{method:'POST',headers,body:'{}'})).status,200);
  stageLog('checking isolated backend exited');
  assert.ok(Number.isSafeInteger(health.pid)&&health.pid>0,'Native backend must provide its exact process ID');
  const exitDeadline=Date.now()+6000;let backendExited=false;
  do {
    try {process.kill(health.pid,0);}catch(error){if(error?.code==='ESRCH'){backendExited=true;break;}throw error;}
    await new Promise(r=>setTimeout(r,100));
  } while(Date.now()<exitDeadline);
  assert.ok(backendExited,'Isolated native backend must exit after authenticated shutdown');
  report({type:'backend-exited',pid:health.pid});
  console.log('Native UI rendered, startup registration read, bundled backend/voice, both native agent catalogs, isolated paused state and authenticated shutdown passed.');
} finally {
  stageLog('cleanup: authenticated backend shutdown');
  if(headers&&base)await smokeFetch(base+'/api/shutdown',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(2000)}).catch(()=>{});
  stageLog('cleanup: stopping packaged app');
  if(app)await stopSmokeApp(app);
  stageLog('cleanup: removing isolated state');
  if(state)rmSync(state,{recursive:true,force:true,maxRetries:5,retryDelay:500});
  if(watchdog)clearTimeout(watchdog);
}
