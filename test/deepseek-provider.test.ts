import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const dir=mkdtempSync(join(tmpdir(),'ffd-deepseek-provider-'));
process.env.WSB_STATE_DIR=join(dir,'state');
process.env.FARFROMDESK_HOME=join(dir,'home');
process.env.DSH_HOME=join(dir,'dsh');
process.env.DSH_BIN=process.execPath;
const credentialsPath=join(dir,'dsh','.credentials.yaml');
const home=()=>process.env.DSH_HOME!;
/** A stand-in for `dsh --profile headless --json -` that prints the real NDJSON events. */
function runStub(name:string,session:string,text:string) {
  const path=join(dir,name),log=join(dir,`${name}.args`);
  writeFileSync(path,`#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(log)}
echo '{"type":"session","sessionId":"${session}","cwd":"${dir}"}'
echo '{"type":"final","text":${JSON.stringify(text)}}'
`);
  chmodSync(path,0o755);
  return {path,log};
}
/** One on-disk transcript, of which only the first zstd frame is the session header. */
function transcript(header:any) {return zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`));}
function writeSession(id:string,header:any) {
  const project=join(home(),'sessions','--project-slug--',id);
  mkdirSync(project,{recursive:true,mode:0o700});
  writeFileSync(join(project,'session.v1.jsonl.zstd'),transcript({type:'session',id,cwd:dir,createdAt:'2026-01-01T00:00:00.000Z',...header}));
}

const { Store }=await import('../src/store.js');
const { Router }=await import('../src/router.js');
const { Approvals }=await import('../src/approvals.js');
const { NativeAgents }=await import('../src/native.js');
const { Connections,connectionProfile,probeDeepseekAccount }=await import('../src/connections.js');
const { Masters }=await import('../src/masters.js');
const { WorkspaceScanner }=await import('../src/workspace-scanner.js');
const { projectWorkspace }=await import('../src/project-workspace.js');
test.after(()=>rmSync(dir,{recursive:true,force:true}));

test('DeepSeek has one CLI profile whose route is managed and cannot become a native session',async()=>{
  const store=new Store(':memory:');
  try {
    const connections=new Connections(store,async()=>({state:'verified',label:'DeepSeek Harness CLI · local credential',accountKey:'deepseek-key'}));
    const b=store.register('deepseek-target','deepseek','11111111-1111-4111-a111-111111111111',dir,'channel').binding;
    assert.notEqual(connectionProfile('deepseek','cli'),connectionProfile('codex','cli'));
    assert.notEqual(connectionProfile('deepseek','cli'),connectionProfile('claude','cli'));
    assert.notEqual(connectionProfile('deepseek','cli'),connectionProfile('muse','cli'));
    const route=await connections.prepare(b,'cli',true);
    assert.equal(route.transport,'managed-cli');assert.equal(route.provider,'deepseek');assert.equal(route.executionMode,'cli');
    assert.equal(route.profileId,connectionProfile('deepseek','cli'));
    connections.save(b,route);await connections.assert(b);
    await assert.rejects(()=>connections.prepare(b,'desktop',true),/CLI connection/);
    connections.save(b,{...route,transport:'native-session'});
    await assert.rejects(()=>connections.assert(b),/no app session/);
  }finally{store.close();}
});

test('the DeepSeek profile is its local credential file, with no account identity and no secret exposed',async()=>{
  mkdirSync(home(),{recursive:true,mode:0o700});
  try{rmSync(credentialsPath);}catch{}
  assert.equal((await probeDeepseekAccount(dir)).state,'signed-out','no credential is not a usable CLI');
  writeFileSync(credentialsPath,'deepseek:\n  token: private-provider-secret\n',{mode:0o600});
  const verified=await probeDeepseekAccount(dir);
  assert.equal(verified.state,'verified');assert.equal(verified.label,'DeepSeek Harness CLI · local credential');
  assert.ok(verified.accountKey);assert.doesNotMatch(JSON.stringify(verified),/private-provider-secret/);
  assert.equal((await probeDeepseekAccount(dir)).accountKey,verified.accountKey,'a stable credential keeps its profile');
  const previous=home();
  process.env.DSH_HOME=join(dir,'other-dsh');mkdirSync(home(),{recursive:true,mode:0o700});
  try {
    assert.equal((await probeDeepseekAccount(dir)).state,'signed-out','another home is a different profile');
  }finally{process.env.DSH_HOME=previous;}
});

test('the DeepSeek catalog lists adoptable sessions and skips a subagent transcript',async()=>{
  const store=new Store(':memory:');
  const approvals=new Approvals(store);
  const native=new NativeAgents(store,approvals);
  const previous=home();
  process.env.DSH_HOME=join(dir,'catalog-dsh');
  try {
    const adoptable='11111111-1111-4111-a111-111111111111';
    writeSession(adoptable,{origin:'owner'});
    writeSession('22222222-2222-4222-a222-222222222222',{origin:'subagent',parentSession:adoptable});
    writeSession('33333333-3333-4333-a333-333333333333',{parentSession:adoptable});
    const page=await native.catalog('deepseek',undefined,{fresh:true});
    assert.deepEqual(page.sessions.map(s=>s.id),[adoptable],'only the session the owner can adopt is listed');
    assert.equal(page.sessions[0].provider,'deepseek');
    assert.equal(page.sessions[0].executionMode,'cli');
    assert.equal(page.sessions[0].available,true);
    assert.equal(page.sessions[0].cwd,dir);
    assert.equal(page.cursor,null);
  }finally{process.env.DSH_HOME=previous;store.close();}
});

test('a DeepSeek binding runs headless, keeps one session and continues it on the next request',async()=>{
  const store=new Store(':memory:');store.set('whatsapp-owner','123@s.whatsapp.net');
  const approvals=new Approvals(store);
  const native={run:async()=>{},stop:()=>{},catalog:async()=>({sessions:[],cursor:null}),validate:async()=>{}};
  const router=new Router(store,native as any,approvals);
  const masters=new Masters(store,router);
  masters.workspaceScanner=new WorkspaceScanner(async paths=>new Map(paths.flatMap(path=>{try{const sessionCwd=path;return [[path,{sessionCwd,cwd:projectWorkspace(sessionCwd)}]] as const;}catch{return [];}})));
  masters.connections=new Connections(store,async()=>({state:'verified',label:'DeepSeek Harness CLI · local credential',accountKey:'deepseek-key'}));
  const sessionId='01a1972a-c63d-7351-8e3e-810ecfd91ea9',first=runStub('deepseek-first',sessionId,'DeepSeek answered the first request.');
  const second=runStub('deepseek-second',sessionId,'DeepSeek continued the same session.');
  process.env.DSH_BIN=first.path;
  try {
    const opId='99999999-9999-4999-a999-999999999999';
    await masters.discover();
    assert.equal(masters.platforms.filter(p=>p.provider==='deepseek').length,1,'DeepSeek publishes exactly one CLI platform');
    assert.equal(masters.platforms.find(p=>p.provider==='deepseek')!.available,true,'the stub binary is detected');
    await masters.create('deepseek',opId);
    for(let i=0;i<200&&masters.operation()?.status==='creating';i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(masters.operation().status,'ready','setup completes without inventing a session');
    const b=store.binding(masters.operation().bindingId)!;
    assert.equal(b.provider,'deepseek');assert.equal(b.mode,'channel');assert.equal(store.get(`execution-mode:${b.id}`),'cli');
    assert.equal(store.get(`deepseek-session:${b.id}`),undefined,'the first turn creates the session');
    assert.match(readFileSync(join(b.cwd,'AGENTS.md'),'utf8'),/FarFromDesk coordinator workspace/);
    assert.match(readFileSync(join(b.cwd,'.agents/skills/whatsapp-master/SKILL.md'),'utf8'),/delivers that answer to the owner/);

    store.enqueue('wa:deepseek-one',b,'first request');await masters.run(b,'first request','wa:deepseek-one');
    assert.equal(store.job('wa:deepseek-one')!.status,'completed','only a finished run closes the request');
    assert.match(store.outbound().body,/DeepSeek answered the first request/);
    assert.equal(store.get(`deepseek-session:${b.id}`),sessionId);
    assert.ok(!readFileSync(first.log,'utf8').includes('--session-id'),'the first turn starts a session');
    const usage=store.db.prepare("SELECT details FROM request_events WHERE request_id=? AND event='provider_usage'").all('wa:deepseek-one') as any[];
    assert.equal(usage.length,0,'this profile reports no usage, so none is invented');

    process.env.DSH_BIN=second.path;
    store.enqueue('wa:deepseek-two',b,'second request');await masters.run(b,'second request','wa:deepseek-two');
    const latest=store.db.prepare("SELECT body FROM outbox WHERE binding_id=? ORDER BY rowid DESC LIMIT 1").get(b.id) as any;
    assert.match(latest.body,/DeepSeek continued the same session/,'the second answer is its own reply');
    assert.match(readFileSync(second.log,'utf8'),new RegExp('--session-id\\n'+sessionId),'the second turn resumes the stored session');
  }finally{masters.close();approvals.cancel();store.close();}
});

test('a DeepSeek binding without its managed route is refused before any native helper is used',async()=>{
  const store=new Store(':memory:');
  const approvals=new Approvals(store);
  const native=new NativeAgents(store,approvals);
  try {
    const b=store.register('deepseek-legacy','deepseek','22222222-2222-4222-a222-222222222222',dir).binding;
    store.enqueue('local:deepseek',b,'hello');
    await assert.rejects(()=>native.run(b,'hello','local:deepseek'),/managed CLI connection/);
  }finally{store.close();}
});