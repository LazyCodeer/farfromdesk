import { mkdtempSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { once } from 'node:events';
const app=process.argv[2];
if(!app)throw Error('Usage: node packaged_smoke.mjs /absolute/FarFromDesk-Local.app');
const root=resolve(app,'Contents/Resources/backend');
const meta=JSON.parse(readFileSync(join(root,'build.json'),'utf8'));
if(!meta.buildId?.startsWith('local-'))throw Error('Expected a Local build ID');

const state=mkdtempSync(join(tmpdir(),'ffd-backend-smoke-'));
const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const child=spawn(join(root,'runtime',process.platform==='win32'?'node.exe':'node'),[join(root,'dist','main.js')],{cwd:root,stdio:'ignore',env:{PATH:process.env.PATH,HOME:state,FARFROMDESK_HOME:join(state,'projects'),FFD_ISOLATED_LOCAL:'1',WSB_STATE_DIR:state,WSB_PORT:String(port),FFD_PORTABLE_AGENTS:'1',WSB_CODEX_BIN:join(state,'missing-codex'),WSB_CLAUDE_BIN:join(state,'missing-claude'),CODEX_HOME:join(state,'codex'),CLAUDE_CONFIG_DIR:join(state,'claude')}});
const ended=once(child,'exit');let token;
try {
  let health;
  for(let i=0;i<200;i++) {
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
  assert.equal(health.buildId,meta.buildId);
  const settings=await (await fetch(base+'/api/social/settings',{headers})).json();assert.deepEqual(settings,{imageProvider:'local',metaConfigured:false});
  const social=await fetch(base+'/api/social',{headers});assert.equal(social.status,200);assert.deepEqual((await social.json()).drafts,[]);
  const missing=await fetch(base+'/api/social/dispatch',{method:'POST',headers,body:JSON.stringify({bindingId:'none',eventId:'6f29ffb0-8027-4bd2-80bf-aef40af8dcbc',prompt:'Create an image',platforms:['Instagram'],imageProvider:'local'})});assert.equal(missing.status,400);
  const response=await fetch(base+'/api/shutdown',{method:'POST',headers,body:'{}'});assert.equal(response.status,200);
  await Promise.race([ended,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Backend did not exit')),5000).unref())]);
  console.log('Packaged backend: authenticated loopback API, paused clean install, isolated provider homes, graceful shutdown passed.');
} finally {if(child.exitCode===null)child.kill();await ended.catch(()=>{});rmSync(state,{recursive:true,force:true});}
