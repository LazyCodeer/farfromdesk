import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {SocialAssistant} from '../src/social-assistant.js';

function fixture(handler:(url:string,init:RequestInit)=>Promise<Response>) {
 const root=mkdtempSync(join(tmpdir(),'ffd-social-test-')),db=new DatabaseSync(join(root,'test.sqlite'));
 const service=new SocialAssistant(db,()=> 'synthetic-model-key',handler);
 return {service,db,root,close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}
const answer=(text:string,citations:any[]=[],search=true)=>Response.json({status:'completed',output:[...(search?[{type:'web_search_call',status:'completed'}]:[]),{type:'message',content:[{type:'output_text',text,annotations:citations}]}]});

test('mock research records citations and persists; stale results cannot overwrite edits',async()=>{
 let resolve!:(r:Response)=>void;let calls=0;
 const f=fixture(async()=>{calls++;if(calls===1)return answer('Sample findings',[{type:'url_citation',url:'https://example.org/a',title:'Sample source'},{type:'url_citation',url:'javascript:bad',title:'bad'}]);return new Promise(r=>{resolve=r;});});
 try{const d=f.service.create('synthetic topic');const r=await f.service.research(d.id,d.revision);assert.deepEqual(r.research?.sources,[{title:'Sample source',url:'https://example.org/a'}]);assert.equal(r.research?.searched,true);
 const reopenedDb=new DatabaseSync(join(f.root,'test.sqlite'));const reopened=new SocialAssistant(reopenedDb,()=>undefined,async()=>{throw new Error('no network');});assert.equal(reopened.get(d.id).research?.text,'Sample findings');reopenedDb.close();
 const pending=f.service.research(d.id,r.revision);const edited=f.service.update(d.id,r.revision,{caption:'Owner edit'});resolve(answer('Stale'));await assert.rejects(pending,/outcome is unknown/);assert.equal(f.service.get(d.id).caption,'Owner edit');assert.equal(f.service.get(d.id).revision,edited.revision);assert.equal((f.service.get(d.id).operation as any).status,'uncertain');
 }finally{f.close();}
});

test('no overlapping paid calls, and unknown outcomes require acknowledgement across restart',async()=>{
 let resolve!:(r:Response)=>void;let calls=0;const f=fixture(async()=>{calls++;return new Promise(r=>{resolve=r;});});
 try{let d=f.service.create('topic');d=f.service.update(d.id,d.revision,{imagePrompt:'synthetic'});const pending=f.service.image(d.id,d.revision);await assert.rejects(f.service.image(d.id,d.revision),/already running/);assert.equal(calls,1);resolve(Response.json({error:'synthetic'},{status:503}));await assert.rejects(pending,/retry may be billed/);
 const reopenedDb=new DatabaseSync(join(f.root,'test.sqlite'));const reopened=new SocialAssistant(reopenedDb,()=> 'fake',async()=>{throw new Error('must not reach network');});assert.equal((reopened.get(d.id).operation as any).status,'uncertain');await assert.rejects(reopened.image(d.id,d.revision),/acknowledge/);reopened.acknowledge(d.id,(reopened.get(d.id).operation as any).operationId);assert.equal(reopened.get(d.id).operation,null);reopenedDb.close();
 f.db.prepare("INSERT INTO social_operations (draft_id,kind,status) VALUES (?,?,'running')").run(d.id,'image');const restartDb=new DatabaseSync(join(f.root,'test.sqlite'));const restarted=new SocialAssistant(restartDb,()=> 'fake',async()=>{throw new Error('must not reach network');});assert.equal((restarted.get(d.id).operation as any).status,'running');assert.throws(()=>restarted.acknowledge(d.id,'synthetic'),/No uncertain/);await assert.rejects(restarted.image(d.id,d.revision),/already running/);restartDb.close();
 }finally{f.close();}
});

test('all drafts are pageable without returning image bodies, and deletion is revision checked',()=>{
 const f=fixture(async()=>{throw new Error('no network');});try{
 const ids:string[]=[];for(let i=0;i<105;i++)ids.push(f.service.create(`topic ${i}`).id);
 const large=f.service.get(ids[104]);large.image={base64:'A'.repeat(8_000_000),sha256:'synthetic'};f.db.prepare('UPDATE social_drafts SET json=? WHERE id=?').run(JSON.stringify(large),large.id);
 const all:string[]=[];let cursor:string|null=null;do{const page=f.service.list(cursor);assert.ok(JSON.stringify(page).length<20_000);all.push(...page.drafts.map(d=>d.id));cursor=page.nextCursor;}while(cursor);
 assert.equal(all.length,105);assert.equal(new Set(all).size,105);assert.equal(all[104],ids[0]);assert.throws(()=>f.service.delete(ids[0],999),/changed/);assert.equal(f.service.get(ids[0]).brief,'topic 0');f.service.delete(ids[0],1);assert.throws(()=>f.service.get(ids[0]),/not found/);
 }finally{f.close();}
});

test('mock image is persisted with a byte hash and invalidated when its prompt changes',async()=>{
 const bytes=Buffer.from([0xff,0xd8,0xff,0xd9]);const f=fixture(async(url,init)=>{assert.equal(url,'https://api.meta.ai/v1/images/generations');assert.equal(JSON.parse(String(init.body)).model,'muse-image-1.0');return Response.json({output_format:'jpeg',data:[{b64_json:bytes.toString('base64')}]});});
 try{let d=f.service.create('topic');d=f.service.update(d.id,d.revision,{imagePrompt:'scene'});d=await f.service.image(d.id,d.revision);assert.equal(d.image?.sha256,createHash('sha256').update(bytes).digest('hex'));d=f.service.update(d.id,d.revision,{imagePrompt:'new scene'});assert.equal(d.image,undefined);}finally{f.close();}
});

test('research without an actual search is visibly ungrounded',async()=>{const f=fixture(async()=>answer('No sources',[],false));try{const d=f.service.create('topic');const r=await f.service.research(d.id,d.revision);assert.equal(r.research?.searched,false);assert.deepEqual(r.research?.sources,[]);}finally{f.close();}});


test('two instances cannot recover or replace a live reservation or delete its draft',async()=>{
 let resolve!:(r:Response)=>void;let calls=0;const f=fixture(async()=>{calls++;return new Promise(r=>{resolve=r;});});
 try{let d=f.service.create('topic');d=f.service.update(d.id,d.revision,{imagePrompt:'scene'});const pending=f.service.image(d.id,d.revision);
 const otherDb=new DatabaseSync(join(f.root,'test.sqlite'));const other=new SocialAssistant(otherDb,()=> 'fake',async()=>{calls++;throw new Error('should not run');});
 assert.equal((other.get(d.id).operation as any).status,'running');assert.throws(()=>other.acknowledge(d.id,'synthetic'),/No uncertain/);assert.throws(()=>other.delete(d.id,d.revision),/pending/);await assert.rejects(other.image(d.id,d.revision),/already running/);assert.equal(calls,1);
 resolve(Response.json({output_format:'jpeg',data:[{b64_json:Buffer.from([255,216,255,217]).toString('base64')}]}));await pending;assert.equal(other.get(d.id).operation,null);otherDb.close();
 const deleted=f.service.create('deleted');f.service.delete(deleted.id,deleted.revision);await assert.rejects(f.service.research(deleted.id,deleted.revision),/not found/);assert.equal(calls,1);
 }finally{f.close();}
});

test('native reservations store results once, recover unknown work, and fence late completions',()=>{
 const f=fixture(async()=>{throw new Error('backend must not call a provider');});
 try{
  let d=f.service.create('Synthetic topic');const r=f.service.begin(d.id,d.revision,'draft');
  assert.equal(r.input.brief,'Synthetic topic');assert.throws(()=>f.service.begin(d.id,d.revision,'draft'),/already running/);
  const saved=f.service.complete(d.id,r.operationId,{text:'A synthetic caption'});assert.equal(saved.caption,'A synthetic caption');assert.equal(f.service.receipt(d.id,r.operationId).status,'completed');assert.throws(()=>f.service.complete(d.id,r.operationId,{text:'duplicate'}),/already resolved/);
  const lost=f.service.begin(d.id,saved.revision,'research');assert.equal((f.service.get(d.id).operation as any).status,'running');
  assert.equal((f.service.recover(d.id,saved.revision,lost.operationId).operation as any).status,'uncertain');assert.throws(()=>f.service.complete(d.id,lost.operationId,{text:'late',sources:[],searched:false}),/already resolved/);f.service.acknowledge(d.id,lost.operationId);
  const next=f.service.begin(d.id,saved.revision,'research');assert.notEqual(next.operationId,lost.operationId);assert.throws(()=>f.service.complete(d.id,lost.operationId,{text:'late',sources:[],searched:false}),/already resolved/);f.service.fail(d.id,next.operationId);
  assert.equal((f.service.get(d.id).operation as any).status,'uncertain');
 }finally{f.close();}
});

test('native image result rejects malformed and oversized JPEGs before storage',()=>{
 const f=fixture(async()=>{throw new Error('no network');});
 const valid=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z','base64');
 try{let d=f.service.create('topic');d=f.service.update(d.id,d.revision,{imagePrompt:'synthetic'});const r=f.service.begin(d.id,d.revision,'image');assert.throws(()=>f.service.complete(d.id,r.operationId,{base64:Buffer.from([255,216,255,217]).toString('base64')}),/invalid or oversized/i);const huge=Buffer.from(valid);const at=huge.indexOf(Buffer.from([0xff,0xc0]));assert.ok(at>0);huge[at+5]=0x23;huge[at+6]=0x28;assert.throws(()=>f.service.complete(d.id,r.operationId,{base64:huge.toString('base64')}),/invalid or oversized/i);const saved=f.service.complete(d.id,r.operationId,{base64:valid.toString('base64')});assert.equal(saved.image?.base64,valid.toString('base64'));}finally{f.close();}
});


test('stale recovery and acknowledgement cannot alter a later reservation',()=>{
 const f=fixture(async()=>{throw new Error('no network');});try{const d=f.service.create('topic');const first=f.service.begin(d.id,d.revision,'research');f.service.recover(d.id,d.revision,first.operationId);f.service.acknowledge(d.id,first.operationId);const second=f.service.begin(d.id,d.revision,'research');assert.throws(()=>f.service.recover(d.id,d.revision,first.operationId),/changed/);assert.equal((f.service.get(d.id).operation as any).operationId,second.operationId);f.service.recover(d.id,d.revision,second.operationId);assert.throws(()=>f.service.acknowledge(d.id,first.operationId),/No uncertain/);assert.equal((f.service.get(d.id).operation as any).operationId,second.operationId);f.service.acknowledge(d.id,second.operationId);}finally{f.close();}
});
