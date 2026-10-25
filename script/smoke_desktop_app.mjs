// Start the actual packaged native entry point against disposable account state.
import {mkdtempSync,readFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const state=realpathSync(mkdtempSync(join(tmpdir(),'ffd-native-smoke-')));
const stage=resolve('build/desktop-release/stage');
const binary=process.platform==='darwin'?join(stage,'FarFromDesk.app/Contents/MacOS/FarFromDesk'):
  join(stage,'FarFromDesk',process.platform==='win32'?'farfromdesk.exe':'farfromdesk');
assert.ok(existsSync(binary),'Packaged native executable must exist');
const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
const port=socket.address().port;await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`;
const app=spawn(binary,[],{stdio:'inherit',env:{...process.env,WSB_STATE_DIR:state,WSB_PORT:String(port),FFD_SMOKE_TEST:'1',
  WSB_CODEX_BIN:join(state,'missing-codex'),WSB_CLAUDE_BIN:join(state,'missing-claude'),
  CODEX_HOME:join(state,'codex'),CLAUDE_CONFIG_DIR:join(state,'claude')}});
let headers;
try {
  let health;
  for(let i=0;i<180;i++) {
    await new Promise(r=>setTimeout(r,500));
    if(app.exitCode!==null)throw new Error(`Native app exited early: ${app.exitCode}`);
    if(!existsSync(join(state,'admin-token')))continue;
    headers={Authorization:`Bearer ${readFileSync(join(state,'admin-token'),'utf8').trim()}`,'Content-Type':'application/json'};
    try {const r=await fetch(base+'/api/health',{headers,signal:AbortSignal.timeout(2000)});if(r.ok){health=await r.json();if(existsSync(join(state,'smoke-ui-ready')))break;}}catch{}
  }
  assert.ok(existsSync(join(state,'smoke-ui-ready')),'Native UI must finish startup, read login registration and render Home');
  assert.equal(health?.app,'FarFromDesk');assert.equal(health.protocol,1);
  assert.equal((await fetch(base+'/api/status')).status,401);
  const status=await (await fetch(base+'/api/status',{headers})).json();
  assert.equal(status.preferences.backgroundEnabled,false);
  assert.equal(status.master,null);assert.equal(status.voice.ready,true);assert.equal(status.voice.bundled,true);
  let roles;
  for(let i=0;i<30;i++){roles=await (await fetch(base+'/api/agents',{headers})).json();if(roles.sync?.state!=='pending')break;await new Promise(r=>setTimeout(r,500));}
  assert.equal(roles.sync?.state,'complete');
  assert.deepEqual(roles.agents.map(a=>a.name).sort(),['farfromdesk-coordinator','farfromdesk-worker']);
  assert.ok(roles.installation.every(a=>a.installation.length===2&&a.installation.every(p=>p.status==='installed'&&p.path.startsWith(state))));
  for(const a of roles.installation)for(const p of a.installation){assert.ok(existsSync(p.path));assert.match(readFileSync(p.path,'utf8'),/Start routine replies with one purposeful emoji/);}
  // A fresh launch creates these instructions without pairing, a request or a manual sync command.
  assert.equal(status.master,null);
  assert.equal((await fetch(base+'/api/shutdown',{method:'POST',headers,body:'{}'})).status,200);
  console.log('Native UI rendered, startup registration read, bundled backend/voice, both native agent catalogs, isolated paused state and authenticated shutdown passed.');
} finally {
  if(headers)await fetch(base+'/api/shutdown',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(2000)}).catch(()=>{});
  app.kill();
  await new Promise(r=>setTimeout(r,1500));
  rmSync(state,{recursive:true,force:true,maxRetries:5,retryDelay:500});
}
