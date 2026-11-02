import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
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
test('an unquoted location requires explicit confirmation before any public query',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();let calls=0;f.r.reach=async(command:string)=>{calls++;return `Public research from Exa web search.\n\nSource\nhttps://example.com/\n${command}`;};
 assert.equal((await f.send('3','Bangalore')).status,'handled');assert.equal(f.s.job('tg:123:3'),undefined);assert.equal(calls,0);
 const row=f.s.db.prepare("SELECT body FROM outbox WHERE source='jobs-public:tg:123:3:0'").get() as {body:string};assert.match(row.body,/Ai engineer in yc startups Bangalore/);
 f.s.db.prepare("UPDATE outbox SET status='sent',wa_id='confirm-question' WHERE source='jobs-public:tg:123:3:0'").run();
 assert.equal((await f.send('4','yes')).status,'blocked');assert.equal(calls,0);
 const accepted=await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:'tg:123:5',text:'yes',quotedId:'confirm-question',ownerChoice:true,ownerCommand:false,ownerIntent:true}));
 assert.equal(accepted.status,'queued');const result=await sessionResearchRequest(f.s,f.r,f.b,'tg:123:3',sessionSpecialty);assert.match(result,/Ai engineer in yc startups Bangalore/);assert.equal(calls,1);
 }finally{f.close();}});
for(const privateAnswer of ['HIV Positive','John Smith'])test(`${privateAnswer} stays out of the public query even after yes`,async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();
 assert.equal((await f.send('3',privateAnswer)).status,'queued');assert.equal(f.s.get('jobs-public-query-confirm:tg:123'),undefined);
 await f.send('4','yes');let query='';f.r.reach=async(command:string)=>{query=command;return 'No usable public results were returned.';};
 await sessionResearchRequest(f.s,f.r,f.b,'tg:123:3',sessionSpecialty);assert.equal(query,'/reach web search Ai engineer in yc startups');
 }finally{f.close();}});
test('no cancels a proposed public location query',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();await f.send('3','Bangalore');let calls=0;f.r.reach=async()=>{calls++;return '';};
 f.s.db.prepare("UPDATE outbox SET status='sent',wa_id='confirm-question' WHERE source='jobs-public:tg:123:3:0'").run();const cancelled=await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:'tg:123:4',text:'no',quotedId:'confirm-question',ownerChoice:true,ownerCommand:false,ownerIntent:true}));assert.equal(cancelled.status,'handled');assert.equal(calls,0);assert.equal(f.s.job('tg:123:3'),undefined);
 }finally{f.close();}});
test('confirmation cannot be accepted before delivery or after session changes',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();await f.send('3','Bangalore');
 const answer=(id:string)=>f.s.destinationContext.run(f.owner,()=>f.r.receive({id:`tg:123:${id}`,text:'yes',quotedId:'confirm-question',ownerChoice:true,ownerCommand:false,ownerIntent:true}));
 f.s.db.prepare("UPDATE outbox SET wa_id='confirm-question' WHERE source='jobs-public:tg:123:3:0'").run();assert.equal((await answer('4')).status,'blocked');assert.equal(f.s.job('tg:123:3'),undefined);
 f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source='jobs-public:tg:123:3:0'").run();
 const other=f.s.register('other','codex',randomUUID(),f.root).binding;f.s.set('active',other.id);
 assert.equal((await answer('5')).status,'blocked');assert.equal(f.s.job('tg:123:3'),undefined);
 }finally{f.close();}});
test('confirmed location retains the F3 review guard and query',async()=>{const f=fixture(true);try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();await f.send('3','ok');await f.dispatch();
 assert.equal((await f.send('4','Bangalore')).status,'handled');f.s.db.prepare("UPDATE outbox SET status='sent',wa_id='confirm-question' WHERE source='jobs-public:tg:123:4:0'").run();
 const answer=await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:'tg:123:5',text:'yes',quotedId:'confirm-question',ownerChoice:true,ownerCommand:false,ownerIntent:true}));assert.equal(answer.status,'handled');assert.equal(f.s.job('tg:123:4'),undefined);
 f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();assert.equal((await f.send('6','ok')).status,'queued');let query='';f.r.reach=async(command:string)=>{query=command;return 'No usable public results were returned.';};
 await sessionResearchRequest(f.s,f.r,f.b,'tg:123:6',sessionSpecialty);assert.match(query,/Ai engineer in yc startups Bangalore/);
 }finally{f.close();}});
for(const state of ['expired','answered'])test(`an ${state} jobs question cannot fall through to a sensitive new search`,async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();
 if(state==='expired')f.s.db.prepare("UPDATE outbox SET sent_at=? WHERE source LIKE 'fake-reply:%'").run(Date.now()-11*60_000);
 else assert.equal((await f.send('3','unspecified')).status,'queued');
 const id=state==='expired'?'3':'4',answer=await f.send(id,'HIV Positive');let query='';f.r.reach=async(command:string)=>{query=command;return 'No usable public results were returned.';};
 if(answer.status==='queued')await sessionResearchRequest(f.s,f.r,f.b,`tg:123:${id}`,sessionSpecialty);
 assert.doesNotMatch(query,/HIV Positive/i,`A private answer became a new search: ${query}`);
 assert.equal((await f.send('6','/jobs software engineer in Pune')).status,'queued');
 }finally{f.close();}});
test('switching away and back invalidates the pending public query',async()=>{const f=fixture();try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');await f.dispatch();await f.send('3','Bangalore');
 f.s.db.prepare("UPDATE outbox SET status='sent',wa_id='confirm-question' WHERE source='jobs-public:tg:123:3:0'").run();
 const other=f.s.register('other','codex',randomUUID(),f.root).binding;f.s.set('active',other.id);f.s.set('active',f.b.id);
 const yes=await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:'tg:123:4',text:'yes',quotedId:'confirm-question',ownerChoice:true,ownerCommand:false,ownerIntent:true}));assert.equal(yes.status,'blocked');assert.equal(f.s.job('tg:123:3'),undefined);
 }finally{f.close();}});
test('Jobs question expiring while F3 review is pending cannot queue',async()=>{const f=fixture(true);try{
 await f.send('1','/jobs');await f.send('2','Ai engineer in yc startups');f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();await f.send('3','ok');await f.dispatch();
 await f.send('4','Bangalore');f.s.db.prepare("UPDATE outbox SET status='sent',wa_id='confirm-question' WHERE source='jobs-public:tg:123:4:0'").run();
 assert.equal((await f.s.destinationContext.run(f.owner,()=>f.r.receive({id:'tg:123:5',text:'yes',quotedId:'confirm-question',ownerChoice:true,ownerCommand:false,ownerIntent:true}))).status,'handled');
 f.s.db.prepare("UPDATE outbox SET sent_at=? WHERE source LIKE 'fake-reply:%'").run(Date.now()-11*60_000);f.s.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
 assert.equal((await f.send('6','ok')).status,'blocked');assert.equal(f.s.job('tg:123:6'),undefined);
 }finally{f.close();}});
