import { mkdtempSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { once } from 'node:events';
const root=resolve(import.meta.dirname,'..','build','desktop-backend');
const state=mkdtempSync(join(tmpdir(),'ffd-backend-smoke-'));
const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const child=spawn(join(root,'runtime',process.platform==='win32'?'node.exe':'node'),[join(root,'dist','main.js')],{cwd:root,stdio:'ignore',env:{...process.env,WSB_STATE_DIR:state,WSB_PORT:String(port),FFD_PORTABLE_AGENTS:'1',WSB_CODEX_BIN:join(state,'missing-codex'),WSB_CLAUDE_BIN:join(state,'missing-claude'),CODEX_HOME:join(state,'codex'),CLAUDE_CONFIG_DIR:join(state,'claude')}});
const ended=once(child,'exit');let token;
try {
  let health;
  for(let i=0;i<100;i++) {
    await new Promise(r=>setTimeout(r,100));
    if(existsSync(join(state,'admin-token')))token=readFileSync(join(state,'admin-token'),'utf8').trim();
    try {const response=await fetch(`http://127.0.0.1:${port}/api/health`,{headers:{Authorization:`Bearer ${token}`}});if(response.ok){health=await response.json();break;}}catch{}
  }
  assert.equal(health?.app,'FarFromDesk');assert.equal(health.protocol,1);
  const base=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(base+'/api/status')).status,401);
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const status=await (await fetch(base+'/api/status',{headers})).json();
  assert.equal(status.preferences.backgroundEnabled,false);
  assert.equal(status.master,null);
  const response=await fetch(base+'/api/shutdown',{method:'POST',headers,body:'{}'});assert.equal(response.status,200);
  await Promise.race([ended,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Backend did not exit')),5000).unref())]);
  console.log('Packaged backend: authenticated loopback API, paused clean install, isolated provider homes, graceful shutdown passed.');
} finally {if(child.exitCode===null)child.kill();await ended.catch(()=>{});rmSync(state,{recursive:true,force:true});}
