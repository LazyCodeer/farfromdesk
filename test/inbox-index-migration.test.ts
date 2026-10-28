import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { inboxSessions, inboxThread } from '../src/inbox-view.js';

const indexNames = ['inbox_binding_created','outbox_request_created'];
function indexes(store: Store) {
  return new Set((store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN (?,?)").all(...indexNames) as {name:string}[]).map(row=>row.name));
}

test('legacy database missing outbox request_id is migrated before Inbox indexes are created',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-index-legacy-')),file=join(dir,'bridge.sqlite');
  try {
    const db=new DatabaseSync(file);
    db.exec(`CREATE TABLE bindings(id TEXT PRIMARY KEY, alias TEXT UNIQUE NOT NULL, provider TEXT NOT NULL, native_id TEXT NOT NULL, cwd TEXT NOT NULL, mode TEXT NOT NULL, token_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, UNIQUE(provider,native_id));
      CREATE TABLE inbox(id TEXT PRIMARY KEY,binding_id TEXT NOT NULL REFERENCES bindings(id),body TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,error TEXT);
      CREATE TABLE outbox(id TEXT PRIMARY KEY,binding_id TEXT REFERENCES bindings(id),body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',source TEXT UNIQUE NOT NULL,wa_id TEXT UNIQUE NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,error TEXT);
      INSERT INTO bindings VALUES('binding','old-session','claude','00000000-0000-4000-8000-000000000000','/tmp','desktop','synthetic-hash',1,1);
      INSERT INTO inbox VALUES('legacy-request','binding','historic message','completed',10,NULL);
      INSERT INTO outbox VALUES('legacy-reply','binding','historic reply','sent','old-source','old-id',0,0,11,NULL);`);
    db.close();
    for(let attempt=0;attempt<2;attempt++) {
      const store=new Store(file);
      try {
        assert.deepEqual(indexes(store),new Set(indexNames));
        assert.equal(store.job('legacy-request')?.body,'historic message');
        const old=store.db.prepare("SELECT body,request_id FROM outbox WHERE id='legacy-reply'").get() as {body:string;request_id:null};
        assert.equal(old.body,'historic reply');assert.equal(old.request_id,null);
        assert.equal(inboxSessions(store).sessions[0].requestCount,1);
      } finally {store.close();}
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('adding indexes to an existing database preserves linked conversation and uses indexed join',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-index-existing-')),file=join(dir,'bridge.sqlite');
  try {
    const before=new Store(file);before.set('whatsapp-owner','synthetic-owner');
    const binding=before.register('index-session','claude',randomUUID(),'/tmp').binding;
    before.enqueue('wa:request',binding,'historic request');
    before.output(binding,'historic response','index-response','synthetic-owner',{requestId:'wa:request',kind:'final'});
    const expected=inboxThread(before,binding.id).messages.map(m=>({kind:m.kind,text:m.text}));
    before.db.exec('DROP INDEX inbox_binding_created; DROP INDEX outbox_request_created');before.close();
    for(let attempt=0;attempt<2;attempt++) {
      const after=new Store(file);
      try {
        assert.deepEqual(indexes(after),new Set(indexNames));
        assert.deepEqual(inboxThread(after,binding.id).messages.map(m=>({kind:m.kind,text:m.text})),expected);
        // Capture the exact query used by inboxSessions, including all UNION
        // branches, rather than benchmarking a rewritten approximation.
        let previewSql='';
        const prepare=after.db.prepare.bind(after.db);
        after.db.prepare=((sql:string)=>{
          if(sql.includes('SELECT body,created_at FROM ('))previewSql=sql;
          return prepare(sql);
        }) as typeof after.db.prepare;
        try {inboxSessions(after);} finally {after.db.prepare=prepare;}
        assert.ok(previewSql,'inboxSessions must execute its preview query');
        const plan=prepare('EXPLAIN QUERY PLAN '+previewSql).all(binding.id,binding.id,binding.id) as {detail:string}[];
        assert.ok(plan.some(row=>row.detail.includes('inbox_binding_created')),JSON.stringify(plan));
        assert.ok(plan.some(row=>row.detail.includes('outbox_request_created')),JSON.stringify(plan));
      } finally {after.close();}
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
