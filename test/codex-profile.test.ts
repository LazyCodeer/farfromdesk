import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync,realpathSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {codexProfileEnvironment,codexProfileHome} from '../src/codex-profile.js';
import {agentRoots,syncNamedAgents} from '../src/named-agents.js';
import {connectionProfile,Connections} from '../src/connections.js';
import {CodexSession} from '../src/codex-session.js';
import {Store} from '../src/store.js';

test('Local selects one native Codex home without changing agent installation roots',()=>{
 const base=mkdtempSync(join(tmpdir(),'ffd-codex-profile-'));
 try {
  const state=join(base,'local'),profile=join(base,'owner'),isolated=join(state,'home','.codex');mkdirSync(isolated,{recursive:true});mkdirSync(profile);
  const env={...process.env,FFD_ISOLATED_LOCAL:'1',FFD_SELECTED_CODEX_HOME:profile,WSB_STATE_DIR:state,CODEX_HOME:isolated};
  assert.equal(codexProfileHome(env),realpathSync(profile));
  assert.equal(codexProfileEnvironment(env).CODEX_HOME,realpathSync(profile));
  assert.notEqual(connectionProfile('codex','cli',env),connectionProfile('codex','cli',{...env,FFD_ISOLATED_LOCAL:'0'}));
  const old=process.env.CODEX_HOME;process.env.CODEX_HOME=isolated;
  try{assert.equal(agentRoots().codex,join(realpathSync(isolated),'agents'));}finally{if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;}
 }finally{rmSync(base,{recursive:true,force:true});}
});
test('Local startup agent sync writes only isolated synthetic provider homes',()=>{
 const base=mkdtempSync(join(tmpdir(),'ffd-codex-profile-sync-'));
 const names=['FFD_ISOLATED_LOCAL','FFD_SELECTED_CODEX_HOME','WSB_STATE_DIR','CODEX_HOME','CLAUDE_CONFIG_DIR'] as const;
 const old=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 const store=new Store(':memory:');
 try {
  const state=join(base,'local'),profile=join(base,'owner'),isolated=join(state,'home','.codex');
  mkdirSync(isolated,{recursive:true});mkdirSync(profile);mkdirSync(join(state,'home','.claude'));
  Object.assign(process.env,{FFD_ISOLATED_LOCAL:'1',FFD_SELECTED_CODEX_HOME:profile,WSB_STATE_DIR:state,CODEX_HOME:isolated,CLAUDE_CONFIG_DIR:join(state,'home','.claude')});
  const result=syncNamedAgents(store);assert.ok(result.every(a=>a.installation.every(i=>i.status==='installed')));
  assert.ok(readdirSync(join(isolated,'agents')).length>0);assert.deepEqual(readdirSync(profile),[]);
 } finally {
  store.close();for(const name of names){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];}
  rmSync(base,{recursive:true,force:true});
 }
});
test('Codex app-server child gets selected profile but Local backend retains isolated home',async()=>{
 const base=mkdtempSync(join(tmpdir(),'ffd-codex-profile-spawn-'));
 const names=['FFD_ISOLATED_LOCAL','FFD_SELECTED_CODEX_HOME','WSB_STATE_DIR','CODEX_HOME','HOME'] as const;
 const old=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 let runtime:CodexSession|undefined;
 try {
  const state=join(base,'local'),profile=join(base,'owner'),isolated=join(state,'home','.codex'),binary=join(base,'fake-codex');
  mkdirSync(isolated,{recursive:true});mkdirSync(profile);
  writeFileSync(binary,`#!${process.execPath}\nconst readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{codex:process.env.CODEX_HOME,home:process.env.HOME}})+'\\n');});\n`,{mode:0o700});
  Object.assign(process.env,{FFD_ISOLATED_LOCAL:'1',FFD_SELECTED_CODEX_HOME:profile,WSB_STATE_DIR:state,CODEX_HOME:isolated,HOME:join(state,'home')});
  runtime=new CodexSession(binary,base,async()=>{});
  assert.deepEqual(await runtime.request('synthetic/read',{}),{codex:realpathSync(profile),home:join(state,'home')});
  assert.equal(process.env.CODEX_HOME,isolated);assert.equal(agentRoots().codex,join(realpathSync(isolated),'agents'));
 } finally {
  runtime?.close();for(const name of names){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];}
  rmSync(base,{recursive:true,force:true});
 }
});
test('background Local discovery does not probe the selected Codex profile',async()=>{
 const base=mkdtempSync(join(tmpdir(),'ffd-codex-profile-discovery-'));
 const names=['FFD_ISOLATED_LOCAL','FFD_SELECTED_CODEX_HOME','WSB_STATE_DIR','CODEX_HOME'] as const;
 const old=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 try {
  const state=join(base,'local'),profile=join(base,'owner');mkdirSync(state);mkdirSync(profile);
  Object.assign(process.env,{FFD_ISOLATED_LOCAL:'1',FFD_SELECTED_CODEX_HOME:profile,WSB_STATE_DIR:state,CODEX_HOME:join(state,'codex')});
  let probes=0;const connections=new Connections({} as any,async()=>{probes++;return {state:'verified',label:'Synthetic account',accountKey:'synthetic'};});
  assert.equal((await connections.read('codex','cli',false,base)).state,'unknown');assert.equal(probes,0);
  assert.equal((await connections.read('codex','cli',true,base)).state,'verified');assert.equal(probes,1);
  assert.equal((await connections.read('codex','cli',false,base)).state,'verified');assert.equal(probes,1);
 } finally {
  for(const name of names){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];}
  rmSync(base,{recursive:true,force:true});
 }
});
test('Local rejects missing, linked or overlapping selected profiles',()=>{
 const base=mkdtempSync(join(tmpdir(),'ffd-codex-profile-'));
 try {
  const state=join(base,'local'),profile=join(base,'owner'),link=join(base,'link');mkdirSync(state);mkdirSync(profile);symlinkSync(profile,link);
  const env={FFD_ISOLATED_LOCAL:'1',WSB_STATE_DIR:state,CODEX_HOME:join(state,'codex')};
  for(const selected of ['', 'relative',link,state,base,join(base,'missing')])assert.throws(()=>codexProfileHome({...env,FFD_SELECTED_CODEX_HOME:selected}));
  const ancestorLink=join(base,'alias');symlinkSync(state,ancestorLink);
  mkdirSync(join(state,'nested'));assert.throws(()=>codexProfileHome({...env,FFD_SELECTED_CODEX_HOME:join(ancestorLink,'nested')}));
 }finally{rmSync(base,{recursive:true,force:true});}
});
