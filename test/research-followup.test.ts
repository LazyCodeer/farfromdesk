import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,hash} from '../src/store.js';
import {Router,type Incoming} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {bindSessionSpecialty} from '../src/session-specialty.js';
import {researchSpecialty} from '../src/research-agent.js';
import {researchFollowup,proposedPublicResearchQuery,researchFollowupBody,captureResearchFollowup,researchFollowupCurrent} from '../src/research-followup.js';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'ffd-research-followup-')),s=new Store(':memory:'),a=new Approvals(s),owner='tg:123';
 s.set('control-channel','telegram');s.set('telegram-owner',owner);
 const r=new Router(s,{stop:()=>{},warmDesktop:()=>{},run:async(b:any,_body:string,id:string)=>{
  s.output(b,'What region should I focus on?',`fake-question:${id}`,owner,{requestId:id,kind:'final',origin:'agent',turnId:id});
 }} as any,a);r.pump=()=>{};
 const b=s.register('selected','codex',randomUUID(),root).binding;s.set('active',b.id);
 const send=(id:string,text:string)=>s.destinationContext.run(owner,()=>r.receive({id:`${owner}:${id}`,text,ownerCommand:true,ownerIntent:true}));
 const dispatch=async()=>{Router.prototype.pump.call(r);await new Promise<void>(resolve=>setImmediate(resolve));s.db.prepare("UPDATE outbox SET status='sent',wa_id='research-question' WHERE source LIKE 'fake-question:%'").run();};
 const withOwner=<T>(fn:()=>T)=>{const context=s.captureIncomingOwner(owner,'telegram')!;return s.incomingOwnerContext.run(context,()=>s.destinationContext.run(owner,fn));};
 const detail=(text:string,quoted=true):Incoming=>({id:'tg:123:3',text,...(quoted?{quotedId:'research-question',ownerCommand:false,ownerChoice:true}:{ownerCommand:true}),ownerIntent:true});
 return {root,s,a,r,b,owner,send,dispatch,withOwner,detail,close(){a.cancel();s.close();rmSync(root,{recursive:true,force:true});}};
}
async function ready(){const f=fixture();await f.send('1','/research');await f.send('2','Splice AI in FMCG');await f.dispatch();return f;}

test('recognises delivered research question and proposes owner region without a search',async()=>{const f=await ready();try{
 const m=f.detail('India');const q=f.withOwner(()=>researchFollowup(f.r,m));assert.ok(q);
 let called=0;f.r.reach=async()=>{called++;return '';};
 assert.equal(proposedPublicResearchQuery(f.s,m,q),'/reach web search Splice AI in FMCG India');assert.equal(called,0);
 const unquoted=f.detail('India',false);assert.ok(f.withOwner(()=>researchFollowup(f.r,unquoted)));
 }finally{f.close();}});
test('private or unknown answers are not classified as public geographic terms',async()=>{const f=await ready();try{
 for(const value of ['John Smith','HIV Positive','my resume','api key: fake-private-value','New Atlantis']){
  const m=f.detail(value),q=f.withOwner(()=>researchFollowup(f.r,m));assert.ok(q);assert.equal(proposedPublicResearchQuery(f.s,m,q),undefined);
 }
 }finally{f.close();}});
test('without a confirmed public query, capture preserves only the original query',async()=>{const f=await ready();try{
 const m=f.detail('India'),q=f.withOwner(()=>researchFollowup(f.r,m));assert.ok(q);
 const body=researchFollowupBody(f.r,m,q);
 f.withOwner(()=>{const b=captureResearchFollowup(f.r,m,q,body);f.r.queue(m.id,b,body);bindSessionSpecialty(f.s,m.id,b,'research',researchSpecialty());});
 assert.equal(JSON.parse(f.s.get(`reach-owner-request:${m.id}`)!).command,'/reach web search Splice AI in FMCG');
 assert.equal(researchFollowupCurrent(f.s,m.id),true);
 }finally{f.close();}});
test('capture accepts only the exact proposed query and consumes the question once',async()=>{const f=await ready();try{
 const m=f.detail('India'),q=f.withOwner(()=>researchFollowup(f.r,m));assert.ok(q);const body=researchFollowupBody(f.r,m,q);
 const query=proposedPublicResearchQuery(f.s,m,q);assert.ok(query);
 f.s.db.exec('SAVEPOINT no_consent');assert.throws(()=>f.withOwner(()=>captureResearchFollowup(f.r,m,q,body,query)),/confirmation/);f.s.db.exec('ROLLBACK TO no_consent; RELEASE no_consent');
 f.withOwner(()=>{const c=f.s.incomingOwnerContext.getStore();f.s.recordIncomingInput('tg:123:4');f.s.set(`research-public-query-consent:${m.id}`,JSON.stringify({detailId:m.id,questionId:q.id,query,yesId:'tg:123:4',context:JSON.stringify(c),bodyHash:hash(body),expires:Date.now()+60_000}));});
 f.s.db.exec('SAVEPOINT preview');assert.throws(()=>f.withOwner(()=>captureResearchFollowup(f.r,m,q,body,query+' another')),/changed/);f.s.db.exec('ROLLBACK TO preview; RELEASE preview');
 f.withOwner(()=>{const b=captureResearchFollowup(f.r,m,q,body,query);f.r.queue(m.id,b,body);bindSessionSpecialty(f.s,m.id,b,'research',researchSpecialty());});
 assert.equal(JSON.parse(f.s.get(`reach-owner-request:${m.id}`)!).command,query);
 assert.equal(f.s.get(`research-public-query-consent:${m.id}`),undefined);
 assert.throws(()=>f.withOwner(()=>captureResearchFollowup(f.r,m,q,body,query)),/already answered/);
 assert.throws(()=>f.withOwner(()=>researchFollowup(f.r,f.detail('HIV Positive',false))),/already answered/);
 f.s.db.prepare("UPDATE outbox SET body='changed?' WHERE wa_id='research-question'").run();
 assert.equal(researchFollowupCurrent(f.s,m.id),false);
 }finally{f.close();}});
test('selection changes and stale questions invalidate recognition',async()=>{const f=await ready();try{
 const m=f.detail('India');f.s.db.prepare("UPDATE outbox SET sent_at=? WHERE wa_id='research-question'").run(Date.now()-11*60_000);
 assert.throws(()=>f.withOwner(()=>researchFollowup(f.r,m)),/expired/);
 assert.throws(()=>f.withOwner(()=>researchFollowup(f.r,f.detail('John Smith',false))),/expired/);
 f.s.db.prepare("UPDATE outbox SET sent_at=? WHERE wa_id='research-question'").run(Date.now());
 f.s.set('active','different');assert.throws(()=>f.withOwner(()=>researchFollowup(f.r,m)),/changed/);
 }finally{f.close();}});
test('expired, altered and unrecorded consent never authorize a public query',async()=>{
 for(const invalid of ['expired','changed-body','unrecorded-yes']){const f=await ready();try{
  const m=f.detail('India'),q=f.withOwner(()=>researchFollowup(f.r,m));assert.ok(q);const body=researchFollowupBody(f.r,m,q),query=proposedPublicResearchQuery(f.s,m,q);assert.ok(query);
  f.withOwner(()=>{const c=f.s.incomingOwnerContext.getStore();if(invalid!=='unrecorded-yes')f.s.recordIncomingInput('tg:123:4');f.s.set(`research-public-query-consent:${m.id}`,JSON.stringify({detailId:m.id,questionId:q.id,query,yesId:'tg:123:4',context:JSON.stringify(c),bodyHash:invalid==='changed-body'?'wrong':hash(body),expires:invalid==='expired'?Date.now()-1:Date.now()+60_000}));});
  f.s.db.exec('SAVEPOINT consent_test');assert.throws(()=>f.withOwner(()=>captureResearchFollowup(f.r,m,q,body,query)),/confirmation/);f.s.db.exec('ROLLBACK TO consent_test; RELEASE consent_test');
 }finally{f.close();}}
});
