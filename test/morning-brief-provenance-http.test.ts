import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';

const root=mkdtempSync(join(tmpdir(),'ffd-brief-http-'));process.env.WSB_STATE_DIR=root;
const probe=createNetServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as any).port;
await new Promise<void>(resolve=>probe.close(()=>resolve()));process.env.WSB_PORT=String(port);
const {Store}=await import('../src/store.js');const {Router}=await import('../src/router.js');const {Approvals}=await import('../src/approvals.js');
const {Coordinator}=await import('../src/coordinator.js');const {serve}=await import('../src/server.js');
const store=new Store(':memory:'),approvals=new Approvals(store),native={run:async()=>{},stop:()=>{},catalog:async()=>({sessions:[]}),close:()=>{}};
const router=new Router(store,native as any,approvals),coordinator=new Coordinator(store,native as any,router,()=>{});router.coordinator=coordinator;router.pump=()=>{};
const owner='owner@s.whatsapp.net';store.set('whatsapp-owner',owner);
const proxy=store.register('proxy','codex',randomUUID(),'/tmp');coordinator.registry.register(proxy.binding);store.set('master',proxy.binding.id);
const server=serve(store,router,{} as any,'synthetic-admin-token');await new Promise<void>(resolve=>server.once('listening',resolve));
const post=async(data:unknown)=>{const r=await fetch(`http://127.0.0.1:${port}/api/master/items`,{method:'POST',headers:{Authorization:`Bearer ${proxy.token}`,'X-Binding-Id':proxy.binding.id,'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:r.status,body:await r.json() as any};};
test.after(async()=>{approvals.cancel();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(root,{recursive:true,force:true});});

test('request-bound item add records authenticated owner provenance atomically and supports idempotent retry',async()=>{
  store.recordOwnerOrigin('wa:request',owner,owner);store.enqueue('wa:request',proxy.binding,'owner request',owner);
  const data={op:'add',title:'Create invoice view',note:'Check the export',eventId:'event-owner-1',requestId:'wa:request'};
  const first=await post(data);assert.equal(first.status,200);const id=first.body.item.id;
  assert.ok(store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=? AND destination=? AND owner=?').get(id,owner,owner));
  assert.ok(store.db.prepare('SELECT 1 FROM brain_item_routes WHERE item_id=? AND destination=?').get(id,owner));
  const worker=store.register('worker','codex',randomUUID(),'/tmp').binding;coordinator.items().setSession(id,worker.id);
  const second=await post(data);assert.equal(second.status,200);assert.equal(second.body.item.id,id);
  assert.equal(Number((store.db.prepare("SELECT COUNT(*) n FROM item_notes WHERE item_id=? AND note='Check the export'").get(id) as any).n),1);
  assert.ok(store.db.prepare("SELECT 1 FROM item_notes n JOIN item_note_origins o ON o.note_id=n.id WHERE n.item_id=? AND n.note='Check the export' AND o.destination=? AND o.owner=?").get(id,owner,owner));
  const note=await post({op:'set',id,note:'https://github.com/Owner/Repo/pull/42',eventId:'note1',requestId:'wa:request'});assert.equal(note.status,200);
  assert.ok(store.db.prepare("SELECT 1 FROM item_notes n JOIN item_note_origins o ON o.note_id=n.id WHERE n.item_id=? AND n.note LIKE 'https://github.com/%' AND o.destination=? AND o.owner=?").get(id,owner,owner));
  const changed=await post({...data,title:'Different task'});assert.equal(changed.status,400);
});
test('unverified legacy event IDs and another owner request cannot be relinked',async()=>{
  const legacy=coordinator.items().add('Legacy item',undefined,undefined,'legacy-event');
  const response=await post({op:'add',title:'Legacy item',eventId:'legacy-event',requestId:'wa:request'});
  assert.equal(response.status,400);assert.equal(store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=?').get(legacy.id),undefined);
  store.set('whatsapp-owner','other-owner@s.whatsapp.net');
  const switched=await post({op:'add',title:'Must not be created',eventId:'new-event',requestId:'wa:request'});
  assert.equal(switched.status,400);assert.equal(store.db.prepare("SELECT 1 FROM items WHERE event_id='new-event'").get(),undefined);
});
test('request-less legacy item adds remain compatible without inventing ownership',async()=>{
  const response=await post({op:'add',title:'Legacy compatible',eventId:'legacy-compatible'});
  assert.equal(response.status,200);assert.equal(store.db.prepare('SELECT 1 FROM item_owner_origins WHERE item_id=?').get(response.body.item.id),undefined);
});
