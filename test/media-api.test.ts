import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, openSync, ftruncateSync, closeSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Approvals } from '../src/approvals.js';
import { Attachments } from '../src/attachments.js';

const dir=mkdtempSync(join(tmpdir(),'ffd-media-api-'));
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));
process.env.WSB_STATE_DIR=dir;process.env.WSB_PORT=String(port);
const { serve }=await import('../src/server.js');
test.after(()=>rmSync(dir,{recursive:true,force:true}));

test('authenticated APIs expose only scoped attachments, preserve local preparation authority and persist per-session styles',async()=>{
  const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  router.attachments=new Attachments(store,dir);
  const a=store.register('a','codex','11111111-1111-4111-a111-111111111111',dir),b=store.register('b','claude','22222222-2222-4222-a222-222222222222',dir);
  store.set('whatsapp-owner','123@s.whatsapp.net');store.enqueue('wa:a',a.binding,'owner task');store.enqueue('wa:b',b.binding,'other');
  const data=Buffer.from('Private notes');router.attachments.stage(a.binding,'wa:a',{filename:'notes.txt',kind:'document',data,sha256:createHash('sha256').update(data).digest('hex')});
  const server=serve(store,router,{} as any,'test-admin');await once(server,'listening');
  const address=server.address() as {port:number};
  async function request(path:string,actor:'a'|'b'|'admin',body?:unknown){
    const scoped=actor==='a'?a:b;
    const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${actor==='admin'?'test-admin':scoped.token}`,...(actor==='admin'?{}:{'X-Binding-Id':scoped.binding.id}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json() as any};
  }
  try {
    const cap=await request('/api/media/capabilities','admin');assert.equal(cap.data.maxOutgoingDocumentBytes,2000*1024*1024);assert.equal(cap.data.liveLargeFileDeliveryVerified,false);
    const raw=Buffer.from('PK\x03\x04archive'),reservationInput={bindingId:a.binding.id,requestId:'wa:a',filename:'release.zip',bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')};
    assert.equal((await request('/api/artifacts/reserve','a',reservationInput)).status,403);
    const reserve=await request('/api/artifacts/reserve','admin',reservationInput);assert.equal(reserve.status,200);
    const rawUrl=`http://127.0.0.1:${address.port}/api/artifacts/upload/${reserve.data.uploadId}`;
    assert.equal((await fetch(rawUrl,{method:'PUT',headers:{Authorization:`Bearer ${a.token}`,'X-Binding-Id':a.binding.id,'Content-Type':'application/octet-stream'},body:raw})).status,403);
    assert.equal((await fetch(rawUrl,{method:'PUT',headers:{Authorization:'Bearer test-admin','Content-Type':'application/json'},body:raw})).status,400);
    const uploaded=await fetch(rawUrl,{method:'PUT',headers:{Authorization:'Bearer test-admin','Content-Type':'application/octet-stream'},body:raw});assert.equal(uploaded.status,200);
    const staged=await uploaded.json() as any;assert.equal(staged.sha256,reservationInput.sha256);assert.equal(staged.mime,'application/zip');
    assert.equal((await request('/api/artifacts/upload-status?id='+reserve.data.uploadId,'a')).status,403);
    const recovered=await request('/api/artifacts/upload-status?id='+reserve.data.uploadId,'admin');assert.equal(recovered.data.artifactId,staged.artifactId);assert.equal(recovered.data.state,'prepared');
    assert.equal((await request('/api/artifacts/reserve','admin',reservationInput)).data.artifactId,staged.artifactId);
    assert.equal((await fetch(rawUrl,{method:'PUT',headers:{Authorization:'Bearer test-admin','Content-Type':'application/octet-stream'},body:raw})).status,400);
    // Exercise the exact desktop helper process: no base64, no session credential file,
    // and a document larger than both former desktop and JSON file limits.
    const local=join(realpathSync(dir),'desktop-large.bin');const fd=openSync(local,'wx');ftruncateSync(fd,26*1024*1024);closeSync(fd);
    writeFileSync(join(dir,'admin-token'),'test-admin',{mode:0o600});
    const child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','src/cli.ts','prepare-desktop-file'],{cwd:process.cwd(),env:{...process.env,WSB_STATE_DIR:dir,WSB_PORT:String(address.port)},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
    child.stdin.end(JSON.stringify({bindingId:a.binding.id,requestId:'wa:a',path:local}));
    const [code]=await once(child,'exit');assert.equal(code,0,stderr);const desktopPrepared=JSON.parse(stdout);
    assert.equal(desktopPrepared.bytes,26*1024*1024);assert.equal(store.db.prepare('SELECT length(data) n FROM artifacts WHERE id=?').get(desktopPrepared.artifactId)?.n,0);
    const desktopQueued=await request('/api/desktop/document','admin',{bindingId:a.binding.id,requestId:'wa:a',artifactId:desktopPrepared.artifactId,confirmed:true,caption:'Reviewed build'});
    assert.equal(desktopQueued.status,200);assert.equal(desktopQueued.data.status,'queued');
    const own=await request('/api/session/attachments?requestId=wa%3Aa','a');assert.equal(own.status,200);assert.equal(own.data.attachments[0].filename,'notes.txt');
    assert.equal((await request('/api/session/attachments?requestId=wa%3Aa','b')).status,400);
    assert.equal((await request('/api/roles','a',{bindingId:a.binding.id,style:'cheerful'})).status,403);
    assert.equal((await request('/api/roles','admin',{bindingId:a.binding.id,style:'cheerful'})).status,200);
    const roles=await request('/api/roles','admin');assert.equal(roles.data.sessions.find((r:any)=>r.bindingId===a.binding.id).style,'cheerful');assert.equal(roles.data.sessions.find((r:any)=>r.bindingId===b.binding.id).style,'friendly');
    assert.equal((await request('/api/roles','admin',{bindingId:a.binding.id,style:'unrestricted'})).status,400);
    const payload={bindingId:a.binding.id,requestId:'wa:a',filename:'app.bin',base64:Buffer.from([0,255,1]).toString('base64')};
    assert.equal((await request('/api/artifacts/prepare','a',payload)).status,403);
    const prepared=await request('/api/artifacts/prepare','admin',payload);assert.equal(prepared.status,200);assert.equal(prepared.data.mime,'application/octet-stream');
    assert.equal((await request('/api/session/document','b',{requestId:'wa:b',artifactId:prepared.data.artifactId})).status,400);
    const sent=await request('/api/session/document','a',{requestId:'wa:a',artifactId:prepared.data.artifactId,caption:'Build'});assert.equal(sent.status,200);
    const outbox=store.db.prepare('SELECT request_id,reply_kind,destination FROM outbox WHERE id=?').get(sent.data.id);
    assert.equal(outbox?.request_id,'wa:a');assert.equal(outbox?.reply_kind,'progress');assert.equal(outbox?.destination,'123@s.whatsapp.net');
    assert.equal((await request('/api/artifacts/cancel','a',{bindingId:a.binding.id,artifactId:prepared.data.artifactId})).status,403);
    assert.equal((await request('/api/artifacts/cancel','admin',{bindingId:a.binding.id,artifactId:prepared.data.artifactId})).status,200);
    assert.equal((await request('/api/session/delivery?id='+sent.data.id,'a')).data.status,'failed');
    assert.equal((await request('/api/session/document','a',{requestId:'wa:a',artifactId:prepared.data.artifactId,caption:'Build'})).status,400);
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));approvals.cancel();store.close();}
});
