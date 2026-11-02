import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const base='../src/';
const {Store}=await import(base+'store.js');
const {Router}=await import(base+'router.js');
const {Approvals}=await import(base+'approvals.js');
const {turnEnvelope}=await import(base+'roles.js');
const {sessionSpecialty}=await import(base+'session-specialty.js');
const {sessionResearchRequest}=await import(base+'session-research.js');
const {TaskContracts}=await import(base+'task-contracts.js');
const {MetaSecret,DEFAULT_BRAIN,saveBrainConfig}=await import(base+'meta-brain-config.js');

function fixture(review=false){
 const root=mkdtempSync(join(tmpdir(),'ffd-installed-review-')),s=new Store(':memory:'),a=new Approvals(s),envelopes:string[]=[];
 const owner='tg:123';s.set('control-channel','telegram');s.set('telegram-owner',owner);
 let r:any;const native={stop:()=>{},warmDesktop:()=>{},run:async(b:any,body:string,id:string)=>{
  envelopes.push(turnEnvelope(s,b,body,id,{},[],root,true).body);
  s.output(b,'What location, work authorization and experience level? You can say unspecified.',`fake-reply:${id}`,owner,{requestId:id,kind:'final',origin:'agent',turnId:id});
 }};
 r=new Router(s,native as any,a);r.pump=()=>{};
 const b=s.register('selected','codex',randomUUID(),root).binding;s.set('active',b.id);
 if(review){const secret=new MetaSecret(root);secret.save('synthetic-key-not-a-real-secret');saveBrainConfig(s,secret,{policy:{...DEFAULT_BRAIN,enabled:true,taskContracts:true}});r.contracts=new TaskContracts(s,secret,async()=>({kind:'contract',goal:'Find jobs',exclusions:['Do not apply'],checks:['Show sources','List relevant roles'],question:''}));}
 const send=(id:string,text:string,quotedId?:string)=>s.destinationContext.run(owner,()=>r.receive({id:`${owner}:${id}`,text,ownerCommand:true,ownerIntent:true,...(quotedId?{quotedId}: {})}));
 const dispatch=async()=>{Router.prototype.pump.call(r);await new Promise<void>(resolve=>setImmediate(resolve));s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'fake-reply:%'").run();};
 const close=()=>{a.cancel();s.close();rmSync(root,{recursive:true,force:true});};return {s,r,b,root,owner,envelopes,send,dispatch,close};
}
test('installed Local defers missing-criteria questions to native agent',async()=>{const f=fixture();try{
 await f.send('1','/jobs');assert.equal((await f.send('2','Ai engineer in yc startups')).status,'queued');
 assert.equal(f.s.jobs().length,1);await f.dispatch();assert.match(readFileSync(/^Instructions: (.+)$/m.exec(f.envelopes[0])![1],'utf8'),/If location, work authorization, sponsorship, experience level/);
 const reply=f.s.db.prepare("SELECT body FROM outbox WHERE source LIKE 'fake-reply:%'").get() as any;assert.match(reply.body,/location.*authorization.*experience/);
 }finally{f.close();}});
test('unquoted unspecified follow-up retains original query',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();
 assert.equal((await f.send('3','unspecified')).status,'queued');const id='tg:123:3';let query='';
 f.r.reach=async(command:string)=>{query=command;return 'No usable public results were returned.';};
 await sessionResearchRequest(f.s,f.r,f.b,id,sessionSpecialty);
 assert.equal(query,'/reach web search Ai engineer in yc startups');
 }finally{f.close();}});
test('approved F3 also hands the question decision to the native agent',async()=>{const f=fixture(true);try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');assert.equal(f.s.jobs().length,0);
 f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();assert.equal((await f.send('3','ok')).status,'queued');await f.dispatch();
 assert.match(readFileSync(/^Instructions: (.+)$/m.exec(f.envelopes[0])![1],'utf8'),/If location, work authorization, sponsorship, experience level/);assert.match(f.envelopes[0],/Owner-approved task contract/);
 }finally{f.close();}});
test('quoted follow-up routes to prior session with request-bound research capture',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();
 f.s.db.prepare("UPDATE outbox SET wa_id='quoted-question' WHERE source LIKE 'fake-reply:%'").run();
 const result=await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:'tg:123:3',text:'unspecified',quotedId:'quoted-question',ownerCommand:false,ownerChoice:true,ownerIntent:true}));
 assert.equal(result.status,'queued');assert.equal(f.s.job('tg:123:3')?.binding_id,f.b.id);assert.equal(sessionSpecialty(f.s,'tg:123:3')?.kind,'jobs');
 assert.equal(JSON.parse(f.s.get('reach-owner-request:tg:123:3')).command,'/reach web search Ai engineer in yc startups');
 }finally{f.close();}});
test('with F3 enabled, unquoted follow-up retains the original contract and query',async()=>{const f=fixture(true);try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
 await f.send('3','ok');await f.dispatch();await f.send('4','unspecified');
 const pending=f.s.db.prepare("SELECT original FROM task_contracts WHERE state='pending'").get() as any;
 assert.equal(pending,undefined);assert.ok(f.s.job('tg:123:4'));assert.ok(f.r.contracts.hasGuard('tg:123:4'));
 let query='';f.r.reach=async(command:string)=>{query=command;return 'No usable public results were returned.';};
 await f.s.destinationContext.run(f.owner,()=>sessionResearchRequest(f.s,f.r,f.b,'tg:123:4',sessionSpecialty));
 assert.equal(query,'/reach web search Ai engineer in yc startups');
 }finally{f.close();}});
test('completed original F3 task can accept one quoted answer and dispatch once',async()=>{const f=fixture(true);try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
 await f.send('3','ok');await f.dispatch();f.s.db.prepare("UPDATE inbox SET status='completed' WHERE id='tg:123:3'").run();
 f.s.db.prepare("UPDATE outbox SET wa_id='quoted-question' WHERE source LIKE 'fake-reply:%'").run();
 const send=(id:string)=>f.s.destinationContext.run(f.owner,()=>f.r.receive({id,text:'unspecified',quotedId:'quoted-question',ownerCommand:false,ownerChoice:true}));
 assert.equal((await send('tg:123:4')).status,'queued');assert.equal((await send('tg:123:5')).status,'blocked');
 assert.equal(f.s.job('tg:123:5'),undefined);await f.dispatch();assert.equal(f.envelopes.length,2);
 assert.match(f.envelopes[1],/Ai engineer in yc startups/);assert.match(f.envelopes[1],/unspecified/);assert.match(f.envelopes[1],/Owner-approved task contract/);
 }finally{f.close();}});
test('question is not inferred from an answer without a question mark',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();
 f.s.db.prepare("UPDATE outbox SET body='Here is the shortlist.' WHERE source LIKE 'fake-reply:%'").run();
 await f.send('3','Show other roles');
 assert.equal(JSON.parse(f.s.get('reach-owner-request:tg:123:3')).command,'/reach web search Show other roles');
 }finally{f.close();}});
test('quoted question after session identity changes fails closed',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();
 f.s.db.prepare("UPDATE outbox SET wa_id='quoted-question' WHERE source LIKE 'fake-reply:%'").run();
 const other=f.s.register('other','codex',randomUUID(),f.root).binding;f.s.set('active',other.id);
 const result=await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:'tg:123:3',text:'unspecified',quotedId:'quoted-question',ownerCommand:false,ownerChoice:true}));
 assert.equal(result.status,'blocked');assert.equal(f.s.job('tg:123:3'),undefined);
 }finally{f.close();}});
test('a delivered native hook question also binds the answer',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();
 f.s.db.prepare("UPDATE reply_receipts SET origin='hook',kind='hook' WHERE source LIKE 'fake-reply:%'").run();
 assert.equal((await f.send('3','unspecified')).status,'queued');
 assert.equal(JSON.parse(f.s.get('reach-owner-request:tg:123:3')).command,'/reach web search Ai engineer in yc startups');
 }finally{f.close();}});
test('expired quoted question fails closed',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();
 f.s.db.prepare("UPDATE outbox SET wa_id='old-question',created_at=? WHERE source LIKE 'fake-reply:%'").run(Date.now()-11*60_000);
 const result=await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:'tg:123:3',text:'unspecified',quotedId:'old-question',ownerCommand:false,ownerChoice:true}));
 assert.equal(result.status,'blocked');assert.equal(f.s.job('tg:123:3'),undefined);
 }finally{f.close();}});
test('a URL query parameter does not fabricate a question',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();
 f.s.db.prepare("UPDATE outbox SET body='Here is a listing: https://example.com/job?role=engineer' WHERE source LIKE 'fake-reply:%'").run();
 await f.send('3','Show other roles');
 assert.equal(JSON.parse(f.s.get('reach-owner-request:tg:123:3')).command,'/reach web search Show other roles');
 }finally{f.close();}});
test('a quoted slash-prefixed answer is data, not a command',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();
 f.s.db.prepare("UPDATE outbox SET wa_id='quoted-question' WHERE source LIKE 'fake-reply:%'").run();
 const result=await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:'tg:123:3',text:'/Users/example/resume.pdf',quotedId:'quoted-question',ownerCommand:false,ownerChoice:true}));
 assert.equal(result.status,'queued');assert.match(f.s.job('tg:123:3').body,/\/Users\/example\/resume.pdf/);
 }finally{f.close();}});
test('reviewed, replaced and auto-closed jobs cannot be revived',async()=>{
 for(const status of ['reviewed','replaced','auto_closed']){const f=fixture(true);try{
  await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  await f.send('3','ok');await f.dispatch();f.s.jobState('tg:123:3',status);
  f.s.db.prepare("UPDATE outbox SET wa_id='closed-question' WHERE source LIKE 'fake-reply:%'").run();
  const result=await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:'tg:123:4',text:'unspecified',quotedId:'closed-question',ownerCommand:false,ownerChoice:true}));
  assert.equal(result.status,'blocked');assert.equal(f.s.job('tg:123:4'),undefined);
 }finally{f.close();}}
});
test('explicit blocked F3 outcome asks owner to restart instead of reusing approval',async()=>{const f=fixture(true);try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
 await f.send('3','ok');await f.dispatch();f.s.jobState('tg:123:3','completed',null,'blocked');
 const result=await f.send('4','unspecified');assert.equal(result.status,'blocked');assert.equal(f.s.job('tg:123:4'),undefined);
 const response=f.s.db.prepare("SELECT body FROM outbox WHERE source LIKE 'command-error:tg:123:4:%'").get() as any;assert.match(response.body,/start a new \/jobs request and include your answer/i);
 }finally{f.close();}});
test('a continuation is revoked if its parent closes before dispatch or research',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();
 assert.equal((await f.send('3','unspecified')).status,'queued');f.s.jobState('tg:123:2','reviewed');
 let calls=0;f.r.reach=async()=>{calls++;return 'No usable public results were returned.';};
 await assert.rejects(sessionResearchRequest(f.s,f.r,f.b,'tg:123:3',sessionSpecialty),/changed/);assert.equal(calls,0);
 await f.dispatch();assert.equal(f.s.job('tg:123:3').status,'failed');assert.equal(f.envelopes.length,1);
 }finally{f.close();}});
test('a later answer is revoked if an ancestor is closed',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();
 await f.send('3','remote');await f.dispatch();assert.equal(f.envelopes.length,2);
 f.s.jobState('tg:123:2','reviewed');const result=await f.send('4','unspecified');
 assert.equal(result.status,'blocked');assert.equal(f.s.job('tg:123:4'),undefined);
 }finally{f.close();}});
test('an obvious new task gets F3 review rather than the original Jobs approval',async()=>{const f=fixture(true);try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
 await f.send('3','ok');await f.dispatch();await f.send('4','Instead, create a marketing website');
 const pending=f.s.db.prepare("SELECT original FROM task_contracts WHERE state='pending'").get() as any;
 assert.equal(pending?.original,'Instead, create a marketing website');assert.equal(f.s.job('tg:123:4'),undefined);
 }finally{f.close();}});
test('free-form answer is reviewed with original request and question, then searches the original query',async()=>{const f=fixture(true);try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
 await f.send('3','ok');await f.dispatch();
 assert.equal((await f.send('4','I live in Bangalore and prefer remote')).status,'handled');
 const pending=f.s.db.prepare("SELECT original,review_text FROM task_contracts WHERE state='pending'").get() as any;
 assert.equal(pending.original,'I live in Bangalore and prefer remote');assert.match(pending.review_text,/Ai engineer in yc startups/);assert.match(pending.review_text,/What location/);assert.match(pending.review_text,/Do not apply/);
 f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
 assert.equal((await f.send('5','ok')).status,'queued');const job=f.s.job('tg:123:5');assert.match(job.body,/I live in Bangalore/);
 let query='';f.r.reach=async(command:string)=>{query=command;return 'No usable public results were returned.';};
 await f.s.destinationContext.run(f.owner,()=>sessionResearchRequest(f.s,f.r,f.b,'tg:123:5',sessionSpecialty));assert.equal(query,'/reach web search Ai engineer in yc startups');
 }finally{f.close();}});
test('free-form quoted instructions receive new F3 review with prior context',async()=>{const f=fixture(true);try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
 await f.send('3','ok');await f.dispatch();f.s.db.prepare("UPDATE outbox SET wa_id='quoted-question' WHERE source LIKE 'fake-reply:%'").run();
 const result=await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:'tg:123:4',text:'Yes, run tests',quotedId:'quoted-question',ownerCommand:false,ownerChoice:true}));
 assert.equal(result.status,'handled');assert.equal(f.s.job('tg:123:4'),undefined);
 const pending=f.s.db.prepare("SELECT original,review_text FROM task_contracts WHERE state='pending'").get() as any;assert.equal(pending.original,'Yes, run tests');assert.match(pending.review_text,/Ai engineer in yc startups/);
 }finally{f.close();}});
test('cancelling a follow-up review releases the question for a new answer',async()=>{const f=fixture(true);try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
 await f.send('3','ok');await f.dispatch();await f.send('4','I live in Bangalore and prefer remote');
 f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();await f.send('5','cancel');
 assert.equal((await f.send('6','unspecified')).status,'queued');assert.ok(f.s.job('tg:123:6'));
 }finally{f.close();}});
test('a labeled instruction is reviewed instead of inheriting the old contract',async()=>{const f=fixture(true);try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
 await f.send('3','ok');await f.dispatch();await f.send('4','location: London. Run tests');
 const pending=f.s.db.prepare("SELECT original,review_text FROM task_contracts WHERE state='pending'").get() as any;
 assert.equal(pending.original,'location: London. Run tests');assert.match(pending.review_text,/Ai engineer in yc startups/);assert.equal(f.s.job('tg:123:4'),undefined);
 }finally{f.close();}});
test('an orphaned pending review reservation is released after restart',async()=>{const f=fixture(true);try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();await f.send('3','ok');await f.dispatch();
 const q=f.s.db.prepare("SELECT id FROM outbox WHERE source LIKE 'fake-reply:%'").get() as any;
 f.s.set(`jobs-followup-question:${q.id}`,'pending:tg:123:orphan');f.s.set('jobs-followup-await:tg:123:orphan','{}');
 assert.equal((await f.send('4','unspecified')).status,'queued');assert.ok(f.s.job('tg:123:4'));
 }finally{f.close();}});
test('concurrent follow-up cannot steal an in-flight review reservation',async()=>{const f=fixture(true);let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();await f.send('3','ok');await f.dispatch();
 f.r.contracts.interpret=async()=>{started();await gate;return {kind:'contract',goal:'Find jobs',exclusions:['Do not apply'],checks:['Show sources','List relevant roles'],question:''};};
 const first=f.send('4','I live in Bangalore and prefer remote');await ready;
 assert.equal((await f.send('5','unspecified')).status,'blocked');assert.equal(f.s.job('tg:123:5'),undefined);
 release();assert.equal((await first).status,'handled');assert.ok(f.s.db.prepare("SELECT 1 FROM task_contracts WHERE state='pending'").get());
 }finally{release();f.close();}});
