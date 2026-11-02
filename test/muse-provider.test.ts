import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'ffd-muse-provider-'));
process.env.WSB_STATE_DIR=join(dir,'state');
process.env.FARFROMDESK_HOME=join(dir,'home');
process.env.MUSE_CONFIG_DIR=join(dir,'muse-config');
process.env.MUSE_BIN=process.execPath;
const authPath=join(dir,'muse-config','auth.json');
const credential=(providers:Record<string,unknown>)=>writeFileSync(authPath,JSON.stringify({schema_version:1,providers}),{mode:0o600});
/** A stand-in for `muse exec` that records its arguments and prints the real JSONL records. */
function stub(name:string,session:string,text:string) {
  const path=join(dir,name),log=join(dir,`${name}.args`);
  writeFileSync(path,`#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(log)}
echo '{"schema_version":1,"stream":{"kind":"session","id":"${session}"},"payload_type":"run.usage","payload":{"kind":"run_usage","models":[{"model":"muse-spark-1.3","input_tokens":9,"output_tokens":4}]}}'
echo '{"schema_version":1,"stream":{"kind":"session","id":"${session}"},"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"completed","text":${JSON.stringify(text)},"reason":null}}'
`);
  chmodSync(path,0o755);
  return {path,log};
}

const { Store }=await import('../src/store.js');
const { Router }=await import('../src/router.js');
const { Approvals }=await import('../src/approvals.js');
const { NativeAgents }=await import('../src/native.js');
const { Connections,connectionProfile,probeMuseAccount }=await import('../src/connections.js');
const { Masters }=await import('../src/masters.js');
const { WorkspaceScanner }=await import('../src/workspace-scanner.js');
const { projectWorkspace }=await import('../src/project-workspace.js');
test.after(()=>rmSync(dir,{recursive:true,force:true}));

test('Muse has one CLI profile whose route is managed and cannot become a native session',async()=>{
  const store=new Store(':memory:');
  try {
    const connections=new Connections(store,async()=>({state:'verified',label:'Muse Code CLI · local credential',accountKey:'muse-key'}));
    const b=store.register('muse-target','muse','11111111-1111-4111-a111-111111111111',dir,'channel').binding;
    assert.notEqual(connectionProfile('muse','cli'),connectionProfile('codex','cli'));
    assert.notEqual(connectionProfile('muse','cli'),connectionProfile('claude','cli'));
    const route=await connections.prepare(b,'cli',true);
    assert.equal(route.transport,'managed-cli');assert.equal(route.provider,'muse');assert.equal(route.executionMode,'cli');
    assert.equal(route.profileId,connectionProfile('muse','cli'));
    connections.save(b,route);await connections.assert(b);
    await assert.rejects(()=>connections.prepare(b,'desktop',true),/CLI connection/);
    connections.save(b,{...route,transport:'native-session'});
    await assert.rejects(()=>connections.assert(b),/no app session/);
  }finally{store.close();}
});

test('the Muse profile is its local credential file, with no account identity and no secret exposed',async()=>{
  mkdirSync(process.env.MUSE_CONFIG_DIR!,{recursive:true});
  try{rmSync(authPath);}catch{}
  assert.equal((await probeMuseAccount(dir)).state,'signed-out','no credential is not a usable CLI');
  credential({meta:{token:'private-provider-secret'}});
  const verified=await probeMuseAccount(dir);
  assert.equal(verified.state,'verified');assert.equal(verified.label,'Muse Code CLI · local credential');
  assert.ok(verified.accountKey);assert.doesNotMatch(JSON.stringify(verified),/private-provider-secret/);
  assert.equal((await probeMuseAccount(dir)).accountKey,verified.accountKey,'a stable credential keeps its profile');
  credential({meta:{},echo:{}});
  assert.notEqual((await probeMuseAccount(dir)).accountKey,verified.accountKey,'a different credential set is a different profile');
  writeFileSync(authPath,'not json',{mode:0o600});
  assert.equal((await probeMuseAccount(dir)).state,'unknown','an unreadable credential is never verified');
});

test('a Muse binding runs headless, keeps one session and continues it on the next request',async()=>{
  const store=new Store(':memory:');store.set('whatsapp-owner','123@s.whatsapp.net');
  const approvals=new Approvals(store);
  const native={run:async()=>{},stop:()=>{},catalog:async()=>({sessions:[],cursor:null}),validate:async()=>{}};
  const router=new Router(store,native as any,approvals);
  const masters=new Masters(store,router);
  masters.workspaceScanner=new WorkspaceScanner(async paths=>new Map(paths.flatMap(path=>{try{const sessionCwd=path;return [[path,{sessionCwd,cwd:projectWorkspace(sessionCwd)}]] as const;}catch{return [];}})));
  masters.connections=new Connections(store,async()=>({state:'verified',label:'Muse Code CLI · local credential',accountKey:'muse-key'}));
  credential({meta:{}});
  const sessionId='01a1972a-c63d-7351-8e3e-810ecfd91ea9',first=stub('muse-first',sessionId,'Muse answered the first request.');
  const second=stub('muse-second',sessionId,'Muse continued the same session.');
  process.env.MUSE_BIN=first.path;
  try {
    const opId='99999999-9999-4999-a999-999999999999';
    await masters.discover();
    assert.equal(masters.platforms.filter(p=>p.provider==='muse').length,1,'Muse publishes exactly one CLI platform');
    assert.equal(masters.platforms.find(p=>p.provider==='muse')!.available,true,'the stub binary is detected');
    await masters.create('muse',opId);
    for(let i=0;i<200&&masters.operation()?.status==='creating';i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(masters.operation().status,'ready','setup completes without inventing a session');
    const b=store.binding(masters.operation().bindingId)!;
    assert.equal(b.provider,'muse');assert.equal(b.mode,'channel');assert.equal(store.get(`execution-mode:${b.id}`),'cli');
    assert.equal(store.get(`muse-session:${b.id}`),undefined,'the first turn creates the session');
    assert.match(readFileSync(join(b.cwd,'AGENTS.md'),'utf8'),/FarFromDesk coordinator workspace/);
    assert.match(readFileSync(join(b.cwd,'.agents/skills/whatsapp-master/SKILL.md'),'utf8'),/delivers that answer to the owner/);

    store.enqueue('wa:muse-one',b,'first request');await masters.run(b,'first request','wa:muse-one');
    assert.equal(store.job('wa:muse-one')!.status,'completed','only a finished run closes the request');
    assert.match(store.outbound().body,/Muse answered the first request/);
    assert.equal(store.get(`muse-session:${b.id}`),sessionId);
    const usage=store.db.prepare("SELECT details FROM request_events WHERE request_id=? AND event='provider_usage'").all('wa:muse-one') as any[];
    assert.equal(usage.length,1);assert.match(usage[0].details,/muse/);
    assert.ok(!readFileSync(first.log,'utf8').includes('--session-id'),'the first turn starts a session');

    process.env.MUSE_BIN=second.path;
    store.enqueue('wa:muse-two',b,'second request');await masters.run(b,'second request','wa:muse-two');
    const latest=store.db.prepare("SELECT body FROM outbox WHERE binding_id=? ORDER BY rowid DESC LIMIT 1").get(b.id) as any;
    assert.match(latest.body,/Muse continued the same session/,'the second answer is its own reply');
    assert.match(readFileSync(second.log,'utf8'),new RegExp('--session-id\\n'+sessionId),'the second turn resumes the stored session');
    assert.match(readFileSync(second.log,'utf8'),/--approval-mode\nnever/);
    assert.ok(!readFileSync(second.log,'utf8').includes('--yolo'));
  }finally{masters.close();approvals.cancel();store.close();}
});

test('a Muse binding without its managed route is refused before any native helper is used',async()=>{
  const store=new Store(':memory:');
  const approvals=new Approvals(store);
  const native=new NativeAgents(store,approvals);
  try {
    const b=store.register('muse-legacy','muse','22222222-2222-4222-a222-222222222222',dir).binding;
    store.enqueue('local:muse',b,'hello');
    await assert.rejects(()=>native.run(b,'hello','local:muse'),/managed CLI connection/);
  }finally{store.close();}
});
