import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {proto} from '@whiskeysockets/baileys';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {WhatsApp} from '../src/whatsapp.js';
import {GuardedSocket} from '../src/wa-guard.js';
import {ErrandWorkflow,parseGreenhouseRequest} from '../src/errand-workflow.js';
import {greenhouseBoardReader} from '../src/errand-greenhouse.js';
import {errandBindingIdentity} from '../src/errand-missions.js';
import {MetaBrain} from '../src/meta-brain.js';
import {DEFAULT_BRAIN,MetaSecret,saveBrainConfig} from '../src/meta-brain-config.js';
import {TaskContracts} from '../src/task-contracts.js';
import {PowerPolicy} from '../src/power.js';
import type {Listing} from '../src/errand-missions.js';

const owner='123@s.whatsapp.net';
function fixture(path=':memory:'){
  const store=new Store(path),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  router.pump=()=>{};store.set('whatsapp-owner',owner);
  const binding=store.register('jobs-test','codex',randomUUID(),'/tmp').binding;store.set('active',binding.id);
  const calls:unknown[]=[];
  const listing:Listing={sourceUrl:'https://boards-api.greenhouse.io/v1/boards/example/jobs/12345',url:'https://job-boards.greenhouse.io/example/jobs/12345',title:'Flutter Engineer',excerpt:'Flutter Engineer',observedAt:Date.now(),sourceHash:'a'.repeat(64),workplace:'unknown',verification:'public-listing-published',applicationDeadline:Date.now()+60000};
  router.errands=new ErrandWorkflow(router,async(scope,request)=>{calls.push({scope,request});return [listing];},async rows=>rows.map(x=>x.id));
  const sent:any[]=[];const sock=new GuardedSocket({sendMessage:async(jid:string,content:any)=>{sent.push({jid,content});return {message:{conversation:content.text}};},end:()=>{}} as any,{owners:()=>[owner],ownedGroup:()=>false});
  const wa=new WhatsApp(store,router);wa.sock=sock;wa.status='connected';wa.selfJid=owner;wa.owners=[owner];
  const msg=(id:string,text:string)=>({key:{id,fromMe:true,remoteJid:owner},message:{conversation:text}});
  return {store,router,wa,binding,sent,calls,msg,close:()=>{wa.close();approvals.cancel();store.close();}};
}
const request='greenhouse jobs; board=example; role=Flutter; location=Bangalore';
test('owner request searches exact board and queues a labelled shortlist and owner-only draft',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('root',request+'; skills=Flutter, Dart'));assert.equal(f.calls.length,1);
    const query=(f.calls[0] as any).request;assert.deepEqual(query,{board:'example',role:'Flutter',location:'Bangalore'});
    await f.wa.flush();assert.equal(f.sent.length,1);assert.match(f.sent[0].content.text,/page identity, application availability, salary and eligibility are unverified/i);
    assert.equal(f.store.job('wa:root')?.status,'completed');
    // A crash between sent() and lifecycle finalization is reconciled locally.
    f.store.jobState('wa:root','submitted');f.router.errands.recover();assert.equal(f.store.job('wa:root')?.status,'completed');
    const o=f.store.db.prepare("SELECT wa_id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {wa_id:string};
    assert.equal(f.wa.receiveMessageUpdate({id:o.wa_id,remoteJid:owner,fromMe:true},proto.WebMessageInfo.Status.DELIVERY_ACK),true);
    await f.wa.receiveMessage(f.msg('choice','draft 1'));await f.wa.flush();
    assert.equal(f.sent.length,2);assert.match(f.sent[1].content.text,/Draft for Flutter Engineer/);assert.match(f.sent[1].content.text,/Review the listing and draft yourself/);
    assert.match(f.sent[1].content.text,/complete the brackets before using/i);
    assert.match(f.sent[1].content.text,/Resume prompts:/);
    assert.match(f.sent[1].content.text,/Choose one responsibility from the listing/);
    assert.doesNotMatch(f.sent[1].content.text,/Listing location|Bangalore|Dart/);
    assert.doesNotMatch(f.sent[1].content.text,/I (?:have|built|developed|worked)|years of experience|degree/i);
    assert.equal(f.store.job('wa:choice')?.status,'completed');assert.equal(f.store.pendingJobs().some(x=>x.id==='wa:root'||x.id==='wa:choice'),false);
    assert.ok(f.sent.every(x=>x.jid===owner));assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM errand_draft_claims').get()?.n,1);
  }finally{f.close();}
});
test('a synthetic published listing without a deadline flows through search, delivery and draft',async()=>{
  const f=fixture();try{
    const page='<!DOCTYPE html><html><head><title>Job Application for Flutter Engineer at Example</title><meta property="og:url" content="https://job-boards.greenhouse.io/example/jobs/12345?gh_jid=12345"/></head><body><h1 class="section-header">Flutter Engineer</h1><form id="application-form"></form></body></html>';
    const job={id:12345,title:'Flutter Engineer',location:{name:'Bangalore'},absolute_url:'https://job-boards.greenhouse.io/example/jobs/12345'};
    const transport={resolve:async()=>['8.8.8.8'],request:async(host:string,path:string)=>({status:200,contentType:host==='boards-api.greenhouse.io'?'application/json':'text/html',body:host==='boards-api.greenhouse.io'?JSON.stringify(path.endsWith('/jobs')?{jobs:[job]}:job):page})};
    f.router.errands=new ErrandWorkflow(f.router,greenhouseBoardReader(()=>true,()=>Date.now(),transport),async rows=>rows.map(x=>x.id));
    let privateReads=0;f.router.brain.owner.read=()=>{privateReads++;throw new Error('Private profile access is forbidden in this test.');};
    await f.wa.receiveMessage(f.msg('root',request+'; skills=SyntheticPrivateSkill'));await f.wa.flush();
    assert.equal(f.sent.length,1);assert.match(f.sent[0].content.text,/Deadline not provided/);assert.match(f.sent[0].content.text,/application availability.*unverified/i);assert.match(f.sent[0].content.text,/Mentions Bangalore/);
    const shortlist=f.store.db.prepare("SELECT wa_id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {wa_id:string};
    f.wa.receiveMessageUpdate({id:shortlist.wa_id,remoteJid:owner,fromMe:true},proto.WebMessageInfo.Status.DELIVERY_ACK);
    await f.wa.receiveMessage(f.msg('choice','draft 1'));await f.wa.flush();
    assert.match(f.sent[1].content.text,/Draft for Flutter Engineer/);
    assert.match(f.sent[1].content.text,/Listing employer \(source metadata; unverified\): Example/);
    assert.match(f.sent[1].content.text,/Listing location \(source metadata; eligibility unverified\): Bangalore/);
    assert.match(f.sent[1].content.text,/Choose one responsibility from the listing/);
    assert.doesNotMatch(f.sent[1].content.text,/SyntheticPrivateSkill|I (?:have|built|developed|worked)|years of experience|degree/i);
    const claim=f.store.db.prepare('SELECT draft_json FROM errand_draft_claims WHERE request_id=?').get('wa:choice') as {draft_json:string};
    assert.doesNotMatch(claim.draft_json,/SyntheticPrivateSkill/);assert.equal(privateReads,0);
    f.store.db.prepare('UPDATE errand_candidates SET observed_at=?').run(Date.now()-3600001);
    await f.wa.receiveMessage(f.msg('expired','draft 1'));await f.wa.flush();
    assert.ok(f.sent.some(x=>/That shortlist is no longer available/.test(x.content.text)));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM errand_draft_claims').get()?.n,1);
  }finally{f.close();}
});
test('a queued draft is invalidated when its listing context changes or has no snapshot binding',async()=>{
  for(const mode of ['location','employer','excerpt','legacy'] as const){
    const f=fixture();try{
      await f.wa.receiveMessage(f.msg('root',request));await f.wa.flush();
      const shortlist=f.store.db.prepare("SELECT wa_id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {wa_id:string};
      f.wa.receiveMessageUpdate({id:shortlist.wa_id,remoteJid:owner,fromMe:true},proto.WebMessageInfo.Status.DELIVERY_ACK);
      await f.wa.receiveMessage(f.msg('choice','draft 1'));
      if(mode==='location')f.store.db.prepare("UPDATE errand_candidates SET listing_location='Changed'").run();
      if(mode==='employer')f.store.db.prepare("UPDATE errand_candidates SET listing_employer='Changed'").run();
      if(mode==='excerpt')f.store.db.prepare("UPDATE errand_candidates SET excerpt='Changed'").run();
      if(mode==='legacy')f.store.db.prepare('UPDATE errand_draft_claims SET candidate_hash=NULL').run();
      await f.wa.flush();
      assert.ok(f.sent.every(x=>!/Draft for Flutter Engineer/.test(x.content.text)),mode);
      assert.equal((f.store.db.prepare("SELECT status FROM outbox WHERE source='errand-draft:wa:choice:0'").get() as {status:string}).status,'cancelled',mode);
    }finally{f.close();}
  }
});
test('group searches and draft choices are stopped before review or search',async()=>{
  const f=fixture(),group='owner-group@g.us';try{
    f.store.set('destination-jid',group);f.store.set(`owned-group:${group}`,'Owner group');
    f.wa.verifyGroup=async()=>{};
    let reviews=0;
    f.router.contracts=new TaskContracts(f.store,f.router.brain.secret,async()=>{reviews++;return {kind:'pass',goal:'',exclusions:[],checks:[],question:''};});
    f.store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,taskContracts:true}));
    const message=(id:string,text:string)=>({key:{id,fromMe:true,remoteJid:group},message:{conversation:text}});
    await f.wa.receiveMessage(message('group-search',request+'; skills=Flutter'));
    await f.wa.receiveMessage(message('group-draft','draft 1'));
    assert.equal(reviews,0);assert.equal(f.calls.length,0);assert.equal(f.store.jobs().length,0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM errand_missions').get()?.n,0);
    const notices=f.store.db.prepare("SELECT body FROM outbox WHERE source LIKE 'errand-%'").all() as {body:string}[];
    assert.equal(notices.length,2);assert.ok(notices.every(x=>/direct WhatsApp owner chat/.test(x.body)));
    assert.ok(notices.every(x=>!x.body.includes('Flutter')));
  }finally{f.close();}
});
test('delayed or misaddressed draft choices cannot select a newer shortlist',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('first',request));await f.wa.flush();
    const first=f.store.db.prepare("SELECT id,wa_id FROM outbox WHERE source LIKE 'errand-shortlist:%' ORDER BY rowid DESC LIMIT 1").get() as {id:string;wa_id:string};
    const firstCode=/Reply draft NUMBER ([0-9a-f]{8})/.exec(f.sent[0].content.text)![1];
    f.wa.receiveMessageUpdate({id:first.wa_id,remoteJid:owner,fromMe:true},proto.WebMessageInfo.Status.DELIVERY_ACK);
    f.store.db.prepare('UPDATE outbox SET delivered_at=? WHERE id=?').run(Date.now()-1000,first.id);
    await f.wa.receiveMessage(f.msg('second',request));await f.wa.flush();
    const second=f.store.db.prepare("SELECT wa_id FROM outbox WHERE source LIKE 'errand-shortlist:%' ORDER BY rowid DESC LIMIT 1").get() as {wa_id:string};
    const secondCode=/Reply draft NUMBER ([0-9a-f]{8})/.exec(f.sent[1].content.text)![1];
    assert.notEqual(firstCode,secondCode);
    f.wa.receiveMessageUpdate({id:second.wa_id,remoteJid:owner,fromMe:true},proto.WebMessageInfo.Status.DELIVERY_ACK);
    await f.wa.receiveMessage(f.msg('delayed','draft 1'));
    await f.wa.receiveMessage(f.msg('old-code',`draft 1 ${firstCode}`));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM errand_draft_claims').get()?.n,0);
    await f.wa.receiveMessage(f.msg('correct',`draft 1 ${secondCode}`));await f.wa.flush();
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM errand_draft_claims').get()?.n,1);
    assert.ok(f.sent.some(x=>/More than one shortlist has arrived/.test(x.content.text)));
    assert.ok(f.sent.some(x=>/That shortlist code is unavailable/.test(x.content.text)));
    assert.ok(f.sent.some(x=>/Draft for Flutter Engineer/.test(x.content.text)));
  }finally{f.close();}
});
test('an errand request accepts only exact owner-supplied criteria',()=>{
  assert.deepEqual(parseGreenhouseRequest(request),{board:'example',contract:{role:'Flutter',location:'Bangalore'}});
  assert.deepEqual(parseGreenhouseRequest(request+'; skills=Dart, C++')?.contract.skills,['Dart','C++']);
  for(const bad of ['Dart,dart','Dart,','a,b,c,d,e,f','password=secret','https://example.com','A'.repeat(41)])assert.throws(()=>parseGreenhouseRequest(request+'; skills='+bad));
  assert.throws(()=>parseGreenhouseRequest(request+'; board=other'),/Use greenhouse/);
  assert.throws(()=>parseGreenhouseRequest(request+'; send applications=yes'),/Use greenhouse/);
});

test('explicit owner skills annotate title mentions locally without changing order or sharing profile fields',async()=>{
  const f=fixture();try{
    const sentToSource:unknown[]=[],sentToRanker:unknown[]=[];
    const listing=(id:string,title:string,excerpt:string):Listing=>({sourceUrl:`https://boards-api.greenhouse.io/v1/boards/example/jobs/${id}`,url:`https://job-boards.greenhouse.io/example/jobs/${id}`,title,excerpt,observedAt:Date.now(),sourceHash:'a'.repeat(64),workplace:'unknown',verification:'public-listing-published',applicationDeadline:Date.now()+60000});
    f.router.errands=new ErrandWorkflow(f.router,async(_scope,query)=>{sentToSource.push(query);return [listing('100','No Dart or C++ required','C++'),listing('200','Experience with Dart.','Dart'),listing('300','Dartboard and C+++','Dart and C++')];},async rows=>{sentToRanker.push(rows);return ['No Dart or C++ required','Experience with Dart.','Dartboard and C+++'].map(title=>rows.find(row=>row.title===title)!.id);});
    await f.wa.receiveMessage(f.msg('profile',request+'; skills=Dart, C++'));await f.wa.flush();
    assert.equal(f.sent.length,1);const text=f.sent[0].content.text as string;
    assert.ok(text.indexOf('/jobs/100')<text.indexOf('/jobs/200'));assert.ok(text.indexOf('/jobs/200')<text.indexOf('/jobs/300'));
    assert.match(text,/Title includes your stated skill terms: Dart, C\+\+/);
    assert.match(text,/Title includes your stated skill terms: Dart/);
    assert.doesNotMatch(text.slice(text.indexOf('/jobs/300')),/Title includes your stated skill terms/);
    assert.doesNotMatch(JSON.stringify(sentToSource),/Dart|C\+\+/);
    assert.doesNotMatch(JSON.stringify(sentToRanker),/"skills"/);
    assert.match(text,/eligibility.*unverified/i);
  }finally{f.close();}
});

test('a profile-aware shortlist is not delivered after owner authority changes',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('profile',request+'; skills=Flutter'));
    f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',owner);await f.wa.flush();
    assert.equal(f.sent.length,0);
    assert.equal((f.store.db.prepare("SELECT status FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {status:string}).status,'cancelled');
  }finally{f.close();}
});
test('session and route changes away and back invalidate queued owner output',async()=>{
  for(const change of ['route','mode','native','binding-mode'] as const){
    const f=fixture();try{
      f.store.set(`session-route:${f.binding.id}`,'route-a');
      f.store.set(`execution-mode:${f.binding.id}`,'cli');
      await f.wa.receiveMessage(f.msg('root',request+'; skills=Flutter'));
      if(change==='route'){
        f.store.set(`session-route:${f.binding.id}`,'route-b');f.store.set(`session-route:${f.binding.id}`,'route-a');
      }else if(change==='mode'){
        f.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run('desktop',`execution-mode:${f.binding.id}`);
        f.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run('cli',`execution-mode:${f.binding.id}`);
      }else{
        const column=change==='native'?'native_id':'mode',original=change==='native'?f.binding.native_id:f.binding.mode;
        f.store.db.prepare(`UPDATE bindings SET ${column}=? WHERE id=?`).run('temporary',f.binding.id);
        f.store.db.prepare(`UPDATE bindings SET ${column}=? WHERE id=?`).run(original,f.binding.id);
      }
      await f.wa.flush();
      assert.ok(f.sent.every(x=>!String(x.content.text).includes('Job shortlist')));
      assert.equal((f.store.db.prepare("SELECT status FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {status:string}).status,'cancelled');
    }finally{f.close();}
  }
});
test('quoted, forwarded and voice job searches receive guarded instructions instead of disappearing',async()=>{
  for(const kind of ['quoted','forwarded','voice'] as const){
    const f=fixture();try{
      if(kind==='voice')await f.store.destinationContext.run(owner,()=>f.router.receive({id:'wa:voice',text:request,source:'voice',ownerCommand:false,ownerIntent:true}));
      else await f.wa.receiveMessage({key:{id:kind,fromMe:true,remoteJid:owner},message:{extendedTextMessage:{text:request,contextInfo:kind==='quoted'?{stanzaId:'previous'}:{isForwarded:true}}}});
      assert.equal(f.calls.length,0);assert.equal(f.store.jobs().length,0);
      assert.ok(f.store.db.prepare('SELECT 1 FROM errand_notice_guards').get());
      await f.wa.flush();assert.equal(f.sent.length,1);assert.match(f.sent[0].content.text,/new text message/);
    }finally{f.close();}
  }
});
test('unsupported-input notice is cancelled if owner authority changes before delivery',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage({key:{id:'quoted',fromMe:true,remoteJid:owner},message:{extendedTextMessage:{text:request,contextInfo:{stanzaId:'previous'}}}});
    f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',owner);await f.wa.flush();
    assert.equal(f.sent.length,0);assert.equal((f.store.db.prepare("SELECT status FROM outbox WHERE source='errand-input:wa:quoted:0'").get() as {status:string}).status,'cancelled');
  }finally{f.close();}
});
test('unsupported search input is explained before a new task contract is requested',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'ffd-f6-input-contract-'));
  try{
    const secret=new MetaSecret(dir);secret.save('synthetic-key-not-a-real-secret');
    saveBrainConfig(f.store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],failure:'block'}});
    let classified=0;f.router.contracts=new TaskContracts(f.store,secret,async()=>{classified++;return {kind:'pass',goal:'',exclusions:[],checks:[],question:''};});
    await f.wa.receiveMessage({key:{id:'quoted',fromMe:true,remoteJid:owner},message:{extendedTextMessage:{text:request,contextInfo:{stanzaId:'previous'}}}});
    await f.wa.flush();assert.equal(classified,0);assert.equal(f.sent.length,1);assert.match(f.sent[0].content.text,/new text message/);
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});
test('a failed notice guard cannot leave an unguarded queued message',()=>{
  const f=fixture();try{
    f.store.db.exec("CREATE TEMP TRIGGER reject_errand_notice BEFORE INSERT ON errand_notice_guards BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    assert.throws(()=>(f.router.errands as any).notice(owner,owner,f.store.get('errand-authority-generation')??'','synthetic-notice','A fixed notice.'));
    assert.equal(f.store.db.prepare("SELECT 1 FROM outbox WHERE source='synthetic-notice:0'").get(),undefined);
  }finally{f.close();}
});
test('invalid errand input and an idle cancellation are kept out of normal routing',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('bad',request+'; send applications=yes'));await f.wa.receiveMessage(f.msg('cancel','cancel job search'));
    assert.equal(f.store.job('wa:bad'),undefined);assert.equal(f.store.job('wa:cancel'),undefined);
    assert.ok(f.store.db.prepare("SELECT 1 FROM errand_notice_guards g JOIN outbox o ON o.id=g.outbox_id WHERE o.source='errand-start-error:wa:bad:0'").get());
    assert.ok(f.store.db.prepare("SELECT 1 FROM errand_notice_guards g JOIN outbox o ON o.id=g.outbox_id WHERE o.source='errand-cancel:wa:cancel:0'").get());
    f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',owner);await f.wa.flush();assert.equal(f.sent.length,0);
  }finally{f.close();}
});
test('F3-approved root preserves owner scope and blocks delivery after owner changes',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'ffd-f6-contract-'));
  try{
    const secret=new MetaSecret(dir);secret.save('synthetic-key-not-a-real-secret');
    f.router.brain=new MetaBrain(f.store,secret,{interpret:async()=>{throw new Error('unused');}} as any);
    saveBrainConfig(f.store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],failure:'block'}});
    f.router.contracts=new TaskContracts(f.store,secret,async()=>({kind:'contract',goal:'Find the requested jobs',exclusions:['Do not submit'],checks:['Use the exact board','Show published listings'],question:''}));
    await f.wa.receiveMessage(f.msg('root',request));assert.equal(f.calls.length,0);
    f.store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
    await f.wa.receiveMessage(f.msg('approve','ok'));assert.equal(f.calls.length,1);
    const shortlist=f.store.db.prepare("SELECT id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {id:string};assert.ok(shortlist);
    f.store.set('whatsapp-owner','other@s.whatsapp.net');await f.wa.flush();
    assert.equal((f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(shortlist.id) as {status:string}).status,'cancelled');
    assert.equal(f.store.job('wa:approve')?.status,'failed');
    assert.equal(f.sent.length,0);
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});
test('profile criteria require the same F3 approval and fail closed if that approval changes',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'ffd-f6-profile-contract-'));
  try{
    const secret=new MetaSecret(dir);secret.save('synthetic-key-not-a-real-secret');
    f.router.brain=new MetaBrain(f.store,secret,{interpret:async()=>{throw new Error('unused');}} as any);
    saveBrainConfig(f.store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],failure:'block'}});
    f.router.contracts=new TaskContracts(f.store,secret,async()=>({kind:'contract',goal:'Find the requested jobs',exclusions:['Do not submit'],checks:['Use the exact board','Show published listings'],question:''}));
    await f.wa.receiveMessage(f.msg('root',request+'; skills=Flutter, Dart'));assert.equal(f.calls.length,0);
    f.store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
    await f.wa.receiveMessage(f.msg('approve','ok'));assert.equal(f.calls.length,1);
    const contract=f.store.db.prepare('SELECT contract_json FROM errand_missions').get() as {contract_json:string};
    assert.deepEqual(JSON.parse(contract.contract_json).skills,['Flutter','Dart']);
    f.store.db.prepare("UPDATE task_contracts SET review_text=replace(review_text,'Dart','Other') WHERE dispatch_id='wa:approve'").run();
    await f.wa.flush();assert.ok(f.sent.every(message=>!String(message.content.text).includes('Job shortlist.')));
    assert.equal((f.store.db.prepare("SELECT status FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {status:string}).status,'cancelled');
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});
test('F3 Meta interpretation receives the explicitly typed skill terms before any search',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'ffd-f6-profile-disclosure-')),originalFetch=globalThis.fetch;
  try{
    const secret=new MetaSecret(dir);secret.save('synthetic-key-not-a-real-secret');
    f.router.brain=new MetaBrain(f.store,secret,{interpret:async()=>{throw new Error('unused');}} as any);
    saveBrainConfig(f.store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],failure:'block'}});
    f.router.contracts=new TaskContracts(f.store,secret);
    const calls:string[]=[];
    globalThis.fetch=async(_url,init)=>{calls.push(String(init?.body??''));return new Response(JSON.stringify({id:'synthetic',created:0,model:'muse-wonder-1.0',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'decide',arguments:JSON.stringify({kind:'contract',goal:'Find the requested jobs',exclusions:['Do not submit'],checks:['Use the exact board','Show published listings'],question:''})}}]}}]}),{headers:{'content-type':'application/json'}});};
    await f.wa.receiveMessage(f.msg('root',request+'; skills=SyntheticDart, SyntheticFlutter'));
    assert.equal(calls.length,1);assert.match(calls[0],/skills=SyntheticDart, SyntheticFlutter/);
    assert.doesNotMatch(calls[0],/synthetic-key-not-a-real-secret/);assert.equal(f.calls.length,0);
    f.store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
    await f.wa.receiveMessage(f.msg('approve','ok'));assert.equal(f.calls.length,1);
  }finally{globalThis.fetch=originalFetch;f.close();rmSync(dir,{recursive:true,force:true});}
});
test('F3 approval delivers the bound shortlist and the selected draft',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'ffd-f6-contract-'));
  try{
    const secret=new MetaSecret(dir);secret.save('synthetic-key-not-a-real-secret');
    f.router.brain=new MetaBrain(f.store,secret,{interpret:async()=>{throw new Error('unused');}} as any);
    saveBrainConfig(f.store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],failure:'block'}});
    f.router.contracts=new TaskContracts(f.store,secret,async()=>({kind:'contract',goal:'Find the requested jobs',exclusions:['Do not submit'],checks:['Use the exact board','Show published listings'],question:''}));
    await f.wa.receiveMessage(f.msg('root',request));f.store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
    await f.wa.receiveMessage(f.msg('approve','ok'));assert.equal(f.calls.length,1);await f.wa.flush();assert.equal(f.sent.length,1);
    const shortlist=f.store.db.prepare("SELECT wa_id,binding_id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {wa_id:string;binding_id:string};
    assert.equal(shortlist.binding_id,f.binding.id);
    f.wa.receiveReceipt({id:shortlist.wa_id,remoteJid:owner,fromMe:true},proto.WebMessageInfo.Status.DELIVERY_ACK,true);
    await f.wa.receiveMessage(f.msg('choice','draft 1'));await f.wa.flush();assert.equal(f.sent.length,2);
    assert.match(f.sent[1].content.text,/Draft for Flutter Engineer/);assert.equal(f.store.job('wa:approve')?.status,'completed');assert.equal(f.store.job('wa:choice')?.status,'completed');
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});
test('choosing before shortlist delivery is not routed to a coding session',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('root',request));await f.wa.receiveMessage(f.msg('early','draft 1'));
    assert.equal(f.store.job('wa:early'),undefined);
    assert.match((f.store.db.prepare("SELECT body FROM outbox WHERE source='errand-draft-error:wa:early:0'").get() as {body:string}).body,/Wait for the shortlist/);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM errand_draft_claims').get() as {n:number}).n,0);
  }finally{f.close();}
});
test('a draft error is not sent after the owner changes and changes back',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('root',request));await f.wa.receiveMessage(f.msg('early','draft 1'));
    f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',owner);await f.wa.flush();
    assert.equal(f.sent.length,0);
    const notice=f.store.db.prepare("SELECT status FROM outbox WHERE source='errand-draft-error:wa:early:0'").get() as {status:string};assert.equal(notice.status,'cancelled');
  }finally{f.close();}
});
test('choosing an expired or empty delivered shortlist does not dispatch a coding task',async()=>{
  for(const mode of ['expired','empty'] as const){
    const f=fixture();try{
      await f.wa.receiveMessage(f.msg('root',request));await f.wa.flush();
      const outbox=f.store.db.prepare("SELECT wa_id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {wa_id:string};
      f.wa.receiveReceipt({id:outbox.wa_id,remoteJid:owner,fromMe:true},proto.WebMessageInfo.Status.DELIVERY_ACK,true);
      if(mode==='expired')f.store.db.prepare('UPDATE errand_candidates SET application_deadline=1').run();
      else f.store.db.prepare('UPDATE errand_candidates SET position=NULL').run();
      await f.wa.receiveMessage(f.msg('choice','draft 1'));
      assert.equal(f.store.job('wa:choice'),undefined);
      const notice=f.store.db.prepare("SELECT body FROM outbox WHERE source='errand-draft-error:wa:choice:0'").get() as {body:string};
      assert.match(notice.body,/Start a new errand/);
    }finally{f.close();}
  }
});
test('a queued shortlist with changed content is never sent',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('root',request));
    const row=f.store.db.prepare("SELECT id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {id:string};
    f.store.db.prepare('UPDATE outbox SET body=? WHERE id=?').run('changed',row.id);
    await f.wa.flush();assert.equal(f.sent.length,1);assert.match(f.sent[0].content.text,/was not delivered/);
    assert.equal((f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(row.id) as {status:string}).status,'cancelled');
    assert.equal(f.store.job('wa:root')?.status,'failed');
  }finally{f.close();}
});
test('expired queued shortlist is settled and its owner receives one scoped notice',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('root',request));
    const out=f.store.db.prepare("SELECT id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {id:string};
    f.store.db.prepare('UPDATE errand_candidates SET application_deadline=1').run();await f.wa.flush();
    assert.equal((f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(out.id) as {status:string}).status,'cancelled');
    assert.equal(f.store.job('wa:root')?.status,'failed');assert.equal(f.sent.length,1);assert.match(f.sent[0].content.text,/was not delivered/);
    f.router.errands.recover();await f.wa.flush();assert.equal(f.sent.length,1);
  }finally{f.close();}
});
test('invalid errand output is settled even if its optional notice cannot be guarded',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('root',request));
    const out=f.store.db.prepare("SELECT id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {id:string};
    f.store.db.prepare('UPDATE outbox SET body=? WHERE id=?').run('changed',out.id);
    f.store.db.exec("CREATE TEMP TRIGGER fail_invalid_notice BEFORE INSERT ON errand_notice_guards BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    await f.wa.flush();f.router.errands.recover();
    assert.equal((f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(out.id) as {status:string}).status,'cancelled');
    assert.equal(f.store.job('wa:root')?.status,'failed');assert.equal(f.sent.length,0);
    assert.equal(f.store.db.prepare("SELECT 1 FROM outbox WHERE source LIKE 'errand-delivery-notice:%'").get(),undefined);
  }finally{f.close();}
});
test('a choice after a cancelled shortlist is not routed as a coding task',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('root',request));f.store.db.prepare('UPDATE errand_candidates SET application_deadline=1').run();await f.wa.flush();
    await f.wa.receiveMessage(f.msg('choice','draft 1'));
    assert.equal(f.store.job('wa:choice'),undefined);
    assert.match((f.store.db.prepare("SELECT body FROM outbox WHERE source='errand-draft-error:wa:choice:0'").get() as {body:string}).body,/Start a new errand/);
  }finally{f.close();}
});
test('invalidated draft is settled and notice is cancelled if owner changes',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('root',request));await f.wa.flush();
    const shortlist=f.store.db.prepare("SELECT wa_id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {wa_id:string};
    f.wa.receiveReceipt({id:shortlist.wa_id,remoteJid:owner,fromMe:true},proto.WebMessageInfo.Status.DELIVERY_ACK,true);
    await f.wa.receiveMessage(f.msg('choice','draft 1'));
    const draft=f.store.db.prepare("SELECT id FROM outbox WHERE source LIKE 'errand-draft:%'").get() as {id:string};
    f.store.db.prepare('UPDATE outbox SET status=? WHERE id=?').run('cancelled',draft.id);
    f.router.errands.recover();assert.equal(f.store.job('wa:choice')?.status,'failed');
    const notice=f.store.db.prepare('SELECT outbox_id FROM errand_notice_guards WHERE owner=?').get(owner) as {outbox_id:string};assert.ok(notice);
    f.store.set('whatsapp-owner','other@s.whatsapp.net');await f.wa.flush();
    assert.equal((f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(notice.outbox_id) as {status:string}).status,'cancelled');assert.equal(f.sent.length,1);
  }finally{f.close();}
});
test('pausing a session cancels a queued shortlist or draft, even after it is resumed before the next flush',async()=>{
  for(const kind of ['shortlist','draft'] as const)for(const resumedBeforeFlush of [false,true]){
    const f=fixture();try{
      await f.wa.receiveMessage(f.msg('root',request));
      if(kind==='draft'){
        await f.wa.flush();const list=f.store.db.prepare("SELECT wa_id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {wa_id:string};
        f.wa.receiveReceipt({id:list.wa_id,remoteJid:owner,fromMe:true},proto.WebMessageInfo.Status.DELIVERY_ACK,true);
        await f.wa.receiveMessage(f.msg('choice','draft 1'));
      }
      const output=f.store.db.prepare('SELECT id FROM outbox WHERE source LIKE ?').get(`errand-${kind}:%`) as {id:string};
      f.store.enable(f.binding.id,false);if(resumedBeforeFlush)f.store.enable(f.binding.id,true);await f.wa.flush();
      assert.equal((f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(output.id) as {status:string}).status,'cancelled');
      assert.equal(f.store.job(kind==='draft'?'wa:choice':'wa:root')?.status,'failed');
      const sent=f.sent.length;f.store.enable(f.binding.id,true);await f.wa.flush();assert.equal(f.sent.length,sent);
    }finally{f.close();}
  }
});
test('an interrupted guarded send is uncertain, reported once and never automatically replayed',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('root',request));let attempts=0;const delivered:string[]=[];
    f.wa.sock=new GuardedSocket({sendMessage:async(_jid:string,content:any)=>{attempts++;if(attempts===1)throw new Error('synthetic timeout');delivered.push(content.text);return {message:{conversation:content.text}};},end:()=>{}} as any,{owners:()=>[owner],ownedGroup:()=>false});
    await f.wa.flush();const out=f.store.db.prepare("SELECT id,status FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {id:string;status:string};
    assert.equal(out.status,'uncertain');assert.equal(f.store.job('wa:root')?.status,'uncertain');
    f.router.errands.recover();await f.wa.flush();await f.wa.flush();
    assert.equal(attempts,2);assert.equal(delivered.length,1);assert.match(delivered[0],/could not be confirmed/);
    assert.equal((f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(out.id) as {status:string}).status,'uncertain');
  }finally{f.close();}
});
test('restart settles an interrupted search and sends one scoped notice without replaying it',async()=>{
  const f=fixture();try{
    f.store.recordOwnerOrigin('wa:root',owner,owner);f.store.enqueue('wa:root',f.binding,request,owner);f.store.jobState('wa:root','submitted');
    const scope={requestId:'wa:root',owner,destination:owner,bindingId:f.binding.id,bindingIdentity:errandBindingIdentity(f.store,f.binding)};
    f.router.errands.ledger.begin(scope,{role:'Flutter',location:'Bangalore'});
    f.store.db.prepare('INSERT INTO errand_search_guards VALUES(?,?)').run('wa:root',f.store.get('errand-authority-generation')??'');
    f.router.errands.recover();f.router.errands.recover();await f.wa.flush();
    assert.equal(f.store.job('wa:root')?.status,'failed');assert.equal(f.calls.length,0);
    assert.equal(f.sent.length,1);assert.match(f.sent[0].content.text,/interrupted.*restarted/);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source LIKE 'errand-restart:%'").get() as {n:number}).n,1);
  }finally{f.close();}
});
test('ordinary shutdown preserves queued shortlists and interrupted-search notices across a real database restart',async()=>{
  for(const mode of ['shortlist','searching'] as const){
    const dir=mkdtempSync(join(tmpdir(),'ffd-errand-restart-')),path=join(dir,'bridge.sqlite'),f=fixture(path);let store:Store|undefined,approvals:Approvals|undefined,wa:WhatsApp|undefined;
    try{
      f.store.set('background-enabled','true');
      if(mode==='shortlist')await f.wa.receiveMessage(f.msg('root',request));
      else{
        f.store.recordOwnerOrigin('wa:root',owner,owner);f.store.enqueue('wa:root',f.binding,request,owner);f.store.jobState('wa:root','submitted');
        const scope={requestId:'wa:root',owner,destination:owner,bindingId:f.binding.id,bindingIdentity:errandBindingIdentity(f.store,f.binding)};
        f.router.errands.ledger.begin(scope,{role:'Flutter',location:'Bangalore'});
        f.store.db.prepare('INSERT INTO errand_search_guards VALUES(?,?)').run('wa:root',f.store.get('errand-authority-generation')??'');
      }
      f.router.stopped=true;f.close();
      store=new Store(path);approvals=new Approvals(store);const router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);router.pump=()=>{};
      const sent:string[]=[];wa=new WhatsApp(store,router);wa.status='connected';wa.selfJid=owner;wa.owners=[owner];
      wa.sock=new GuardedSocket({sendMessage:async(_jid:string,content:any)=>{sent.push(content.text);return {message:{conversation:content.text}};},end:()=>{}} as any,{owners:()=>[owner],ownedGroup:()=>false});
      const power=new PowerPolicy(store,router,wa);store.recover();router.errands.recover();await wa.flush();power.close();
      assert.equal(sent.length,1,mode);
      if(mode==='shortlist'){assert.match(sent[0],/Flutter Engineer/);assert.equal(store.job('wa:root')?.status,'completed');}
      else{assert.match(sent[0],/interrupted.*restarted/);assert.equal(store.job('wa:root')?.status,'failed');}
    }finally{wa?.close();approvals?.cancel();store?.close();rmSync(dir,{recursive:true,force:true});}
  }
});
test('restart settles an interrupted search even if its optional notice cannot be guarded',()=>{
  const f=fixture();try{
    f.store.recordOwnerOrigin('wa:root',owner,owner);f.store.enqueue('wa:root',f.binding,request,owner);f.store.jobState('wa:root','submitted');
    const scope={requestId:'wa:root',owner,destination:owner,bindingId:f.binding.id,bindingIdentity:errandBindingIdentity(f.store,f.binding)};
    f.router.errands.ledger.begin(scope,{role:'Flutter',location:'Bangalore'});
    f.store.db.prepare('INSERT INTO errand_search_guards VALUES(?,?)').run('wa:root',f.store.get('errand-authority-generation')??'');
    f.store.db.exec("CREATE TEMP TRIGGER fail_restart_notice BEFORE INSERT ON errand_notice_guards BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    f.router.errands.recover();f.router.errands.recover();
    assert.equal(f.store.job('wa:root')?.status,'failed');assert.equal(f.calls.length,0);
    assert.equal(f.store.db.prepare("SELECT 1 FROM outbox WHERE source='errand-restart:wa:root:0'").get(),undefined);
  }finally{f.close();}
});
test('a restart notice is not delivered to a replacement owner',async()=>{
  const f=fixture();try{
    f.store.recordOwnerOrigin('wa:root',owner,owner);f.store.enqueue('wa:root',f.binding,request,owner);f.store.jobState('wa:root','submitted');
    const scope={requestId:'wa:root',owner,destination:owner,bindingId:f.binding.id,bindingIdentity:errandBindingIdentity(f.store,f.binding)};
    f.router.errands.ledger.begin(scope,{role:'Flutter',location:'Bangalore'});f.store.db.prepare('INSERT INTO errand_search_guards VALUES(?,?)').run('wa:root',f.store.get('errand-authority-generation')??'');f.router.errands.recover();
    f.store.set('whatsapp-owner','other@s.whatsapp.net');await f.wa.flush();
    const notice=f.store.db.prepare("SELECT status FROM outbox WHERE source='errand-restart:wa:root:0'").get() as {status:string};
    assert.equal(notice.status,'cancelled');assert.equal(f.sent.length,0);
  }finally{f.close();}
});
test('an in-flight job search is protected from review and can be explicitly cancelled',async()=>{
  const f=fixture();try{
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
    f.router.errands=new ErrandWorkflow(f.router,async()=>{await waiting;return [];},async rows=>rows.map(x=>x.id));
    const pending=f.wa.receiveMessage(f.msg('root',request));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.router.requestProtected('wa:root',f.binding.id),true);
    assert.throws(()=>f.router.reviewRequest('wa:root','submitted'),/still delivering/);
    await f.wa.receiveMessage(f.msg('cancel','cancel job search'));release();await pending;
    assert.equal(f.store.job('wa:root')?.status,'completed');assert.equal(f.store.job('wa:root')?.outcome,'cancelled');
    assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {n:number}).n,0);
  }finally{f.close();}
});
test('a failed search sends one guarded notice only while its original owner authority remains current',async()=>{
  for(const change of ['none','before-flush','away-and-back'] as const){const f=fixture();try{
    f.router.errands=new ErrandWorkflow(f.router,async()=>{throw new Error('synthetic failure');},async rows=>rows.map(x=>x.id));
    await f.wa.receiveMessage(f.msg('root',request));
    if(change!=='none'){f.store.set('whatsapp-owner','other@s.whatsapp.net');if(change==='away-and-back')f.store.set('whatsapp-owner',owner);}
    await f.wa.flush();assert.equal(f.sent.length,change==='none'?1:0);
    if(change==='none')assert.match(f.sent[0].content.text,/Could not prepare/);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source='command-error:wa:root:0'").get() as {n:number}).n,0);
  }finally{f.close();}}
});
test('empty and unverifiable searches give actionable fixed notices without forwarding source errors',async()=>{
  for(const mode of ['empty','unsupported','unverified','source-error'] as const){
    const f=fixture();try{
      const listing:Listing={sourceUrl:'https://jobs.example.com/board',url:'https://jobs.example.com/job',title:'Flutter Engineer',excerpt:'Flutter Engineer',observedAt:Date.now(),sourceHash:'a'.repeat(64),workplace:'unknown',verification:'public-listing-published',applicationDeadline:Date.now()+60000};
      let ranks=0;
      f.router.errands=new ErrandWorkflow(f.router,async()=>{
        if(mode==='source-error')throw new Error('private source diagnostic should never be shown');
        return mode==='empty'?[]:[listing];
      },async rows=>{ranks++;return rows.map(x=>x.id);});
      const suffix=mode==='unsupported'?'; avoid=night shifts':mode==='unverified'?'; avoid=onsite':'';
      await f.wa.receiveMessage(f.msg('root',request+suffix));await f.wa.flush();
      assert.equal(f.sent.length,1);assert.equal(f.store.job('wa:root')?.status,'failed');assert.equal(ranks,0);
      const text=f.sent[0].content.text as string;
      if(mode==='empty')assert.match(text,/No shortlist was found in the checked candidates/);
      if(mode==='unsupported')assert.match(text,/exclusion is not supported/);
      if(mode==='unverified')assert.match(text,/enough evidence to verify your exclusion/);
      if(mode==='source-error')assert.match(text,/Could not prepare a shortlist/);
      assert.doesNotMatch(text,/private source diagnostic/);
      assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source LIKE 'errand-shortlist:%'").get()?.n,0);
    }finally{f.close();}
  }
});
test('an actionable empty-search notice is withheld after owner changes and returns',async()=>{
  const f=fixture();try{
    f.router.errands=new ErrandWorkflow(f.router,async()=>[],async rows=>rows.map(x=>x.id));
    await f.wa.receiveMessage(f.msg('root',request));f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',owner);
    await f.wa.flush();assert.equal(f.sent.length,0);
    assert.equal((f.store.db.prepare("SELECT status FROM outbox WHERE source='errand-search-error:wa:root:0'").get() as {status:string}).status,'cancelled');
  }finally{f.close();}
});
test('ranking failures report a fixed recovery step without relaying provider details',async()=>{
  for(const code of ['authentication_required','provider_unavailable','unknown'] as const){
    const f=fixture();try{
      const listing:Listing={sourceUrl:'https://jobs.example.com/board',url:'https://jobs.example.com/job',title:'Flutter Engineer',excerpt:'Flutter Engineer',observedAt:Date.now(),sourceHash:'a'.repeat(64),workplace:'unknown',verification:'public-listing-published',applicationDeadline:Date.now()+60000};
      f.router.errands=new ErrandWorkflow(f.router,async()=>[listing],async()=>{throw Object.assign(new Error('private provider diagnostic'),{code});});
      await f.wa.receiveMessage(f.msg('root',request));await f.wa.flush();
      assert.equal(f.sent.length,1);const text=f.sent[0].content.text as string;
      if(code==='authentication_required')assert.match(text,/Meta Brain authentication failed/);
      if(code==='provider_unavailable')assert.match(text,/Meta ranking is unavailable/);
      if(code==='unknown')assert.match(text,/Could not prepare a shortlist/);
      assert.doesNotMatch(text,/private provider diagnostic/);
      assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source LIKE 'errand-shortlist:%'").get()?.n,0);
    }finally{f.close();}
  }
});
test('owner change during source search discards results and cannot send to the former owner, even after it changes back',async()=>{
  for(const switchBack of [false,true]){const f=fixture();try{
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
    const listing:Listing={sourceUrl:'https://jobs.example.com/board',url:'https://jobs.example.com/job',title:'Flutter Engineer',excerpt:'Flutter Engineer',observedAt:Date.now(),sourceHash:'a'.repeat(64),workplace:'unknown',verification:'public-listing-published',applicationDeadline:Date.now()+60000};
    f.router.errands=new ErrandWorkflow(f.router,async()=>{await waiting;return [listing];},async rows=>rows.map(x=>x.id));
    const pending=f.wa.receiveMessage(f.msg('root',request));await new Promise(resolve=>setImmediate(resolve));
    f.store.set('whatsapp-owner','other@s.whatsapp.net');if(switchBack)f.store.set('whatsapp-owner',owner);release();await pending;await f.wa.flush();
    assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {n:number}).n,0);
    assert.equal(f.store.job('wa:root')?.status,'failed');
    assert.equal(f.sent.length,0);assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source='command-error:wa:root:0'").get() as {n:number}).n,0);
  }finally{f.close();}}
});
test('a pause and resume during source search invalidates its old authority',async()=>{
  const f=fixture();try{
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
    const listing:Listing={sourceUrl:'https://jobs.example.com/board',url:'https://jobs.example.com/job',title:'Flutter Engineer',excerpt:'Flutter Engineer',observedAt:Date.now(),sourceHash:'a'.repeat(64),workplace:'unknown',verification:'public-listing-published',applicationDeadline:Date.now()+60000};
    f.router.errands=new ErrandWorkflow(f.router,async()=>{await waiting;return [listing];},async rows=>rows.map(x=>x.id));
    const pending=f.wa.receiveMessage(f.msg('root',request));await new Promise(resolve=>setImmediate(resolve));
    f.store.enable(f.binding.id,false);f.store.enable(f.binding.id,true);release();await pending;
    assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {n:number}).n,0);
    assert.equal(f.store.job('wa:root')?.status,'failed');
  }finally{f.close();}
});
test('a bridge pause aborts a search and it cannot resume after the bridge is re-enabled',async()=>{
  const f=fixture();try{
    const power=new PowerPolicy(f.store,f.router,f.wa);f.wa.connect=async()=>{f.wa.status='connected';};
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
    const listing:Listing={sourceUrl:'https://jobs.example.com/board',url:'https://jobs.example.com/job',title:'Flutter Engineer',excerpt:'Flutter Engineer',observedAt:Date.now(),sourceHash:'a'.repeat(64),workplace:'unknown',verification:'public-listing-published',applicationDeadline:Date.now()+60000};
    f.router.errands=new ErrandWorkflow(f.router,async()=>{await waiting;return [listing];},async rows=>rows.map(x=>x.id));
    const pending=f.wa.receiveMessage(f.msg('root',request));await new Promise(resolve=>setImmediate(resolve));
    await power.update(false,false);await power.update(true,false);release();await pending;await f.wa.flush();power.close();
    assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {n:number}).n,0);
    assert.equal(f.store.job('wa:root')?.status,'failed');assert.equal(f.sent.length,0);
  }finally{f.close();}
});
test('shutdown aborts an in-flight search without revoking the durable owner generation',async()=>{
  const f=fixture();try{
    let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});
    f.router.errands=new ErrandWorkflow(f.router,async()=>{started();return await new Promise<never>(()=>{});},async rows=>rows.map(x=>x.id));
    const pending=f.wa.receiveMessage(f.msg('root',request));await entered;
    const generation=f.store.get('errand-authority-generation');f.router.stopped=true;await pending;
    assert.equal(f.store.get('errand-authority-generation'),generation);assert.equal(f.store.job('wa:root')?.status,'failed');
    assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {n:number}).n,0);
  }finally{f.close();}
});

test('explicit WhatsApp logout aborts a search before socket logout completes and prevents later ranking or delivery',async()=>{
  const f=fixture();try{
    let releaseSearch!:()=>void,releaseLogout!:()=>void;const search=new Promise<void>(r=>releaseSearch=r),logout=new Promise<void>(r=>releaseLogout=r);
    let ranks=0;
    const listing:Listing={sourceUrl:'https://jobs.example.com/board',url:'https://jobs.example.com/job',title:'Flutter Engineer',excerpt:'Flutter Engineer',observedAt:Date.now(),sourceHash:'a'.repeat(64),workplace:'unknown',verification:'public-listing-published',applicationDeadline:Date.now()+60000};
    f.router.errands=new ErrandWorkflow(f.router,async()=>{await search;return [listing];},async rows=>{ranks++;return rows.map(x=>x.id);});
    f.wa.sock=new GuardedSocket({logout:async()=>logout,sendMessage:async()=>({}),end:()=>{}} as any,{owners:()=>[owner],ownedGroup:()=>false});
    const pending=f.wa.receiveMessage(f.msg('root',request));await new Promise(resolve=>setImmediate(resolve));
    const before=f.store.get('errand-authority-generation'),loggingOut=f.wa.logout();
    assert.notEqual(f.store.get('errand-authority-generation'),before);
    releaseSearch();await pending;assert.equal(ranks,0);assert.equal(f.store.job('wa:root')?.status,'failed');
    releaseLogout();await loggingOut;
    f.wa.closed=false;f.wa.status='connected';f.wa.selfJid=owner;f.wa.owners=[owner];
    f.wa.sock=new GuardedSocket({sendMessage:async()=>{throw new Error('No message should be sent');},end:()=>{}} as any,{owners:()=>[owner],ownedGroup:()=>false});
    await f.wa.flush();assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {n:number}).n,0);
  }finally{f.close();}
});

test('explicit offline WhatsApp disconnect also invalidates queued errand output',async()=>{
  const f=fixture();try{
    await f.wa.receiveMessage(f.msg('root',request));
    const out=f.store.db.prepare("SELECT id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {id:string};
    f.wa.status='disconnected';await f.wa.disconnectForSwitch(true);
    f.wa.closed=false;f.wa.status='connected';f.wa.selfJid=owner;f.wa.owners=[owner];
    f.wa.sock=new GuardedSocket({sendMessage:async()=>{throw new Error('No message should be sent');},end:()=>{}} as any,{owners:()=>[owner],ownedGroup:()=>false});
    await f.wa.flush();assert.equal((f.store.db.prepare('SELECT status FROM outbox WHERE id=?').get(out.id) as {status:string}).status,'cancelled');
    assert.equal(f.store.job('wa:root')?.status,'failed');
  }finally{f.close();}
});

test('a failed cancellation rolls back the mission and request together',async()=>{
  const f=fixture();try{
    let release!:()=>void;const wait=new Promise<void>(r=>release=r);
    f.router.errands=new ErrandWorkflow(f.router,async()=>{await wait;return [];},async rows=>rows.map(x=>x.id));
    const pending=f.wa.receiveMessage(f.msg('root',request));await new Promise(resolve=>setImmediate(resolve));
    f.store.db.exec("CREATE TEMP TRIGGER fail_errand_cancel BEFORE UPDATE OF status ON inbox WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    await f.wa.receiveMessage(f.msg('cancel','cancel job search'));
    assert.equal((f.store.db.prepare('SELECT state FROM errand_missions WHERE root_request=?').get('wa:root') as {state:string}).state,'searching');
    assert.equal(f.store.job('wa:root')?.status,'submitted');assert.equal(f.router.errands.isActive('wa:root'),true);
    f.store.db.exec('DROP TRIGGER fail_errand_cancel');release();await pending;
  }finally{f.close();}
});

test('restart settles an older partially cancelled search once without replaying it',async()=>{
  const f=fixture();try{
    f.store.recordOwnerOrigin('wa:root',owner,owner);f.store.enqueue('wa:root',f.binding,request,owner);f.store.jobState('wa:root','submitted');
    const scope={requestId:'wa:root',owner,destination:owner,bindingId:f.binding.id,bindingIdentity:errandBindingIdentity(f.store,f.binding)};
    f.router.errands.ledger.begin(scope,{role:'Flutter',location:'Bangalore'});
    f.store.db.prepare('INSERT INTO errand_search_guards VALUES(?,?)').run('wa:root',f.store.get('errand-authority-generation')??'');
    f.store.db.prepare("UPDATE errand_missions SET state='cancelled' WHERE root_request=?").run('wa:root');
    f.router.errands.recover();f.router.errands.recover();await f.wa.flush();
    assert.equal(f.store.job('wa:root')?.status,'completed');assert.equal(f.store.job('wa:root')?.outcome,'cancelled');
    assert.equal(f.calls.length,0);assert.equal(f.sent.length,1);assert.match(f.sent[0].content.text,/cancelled/);
  }finally{f.close();}
});

test('recovery settles a partially cancelled search even if its optional notice cannot be guarded',()=>{
  const f=fixture();try{
    f.store.recordOwnerOrigin('wa:root',owner,owner);f.store.enqueue('wa:root',f.binding,request,owner);f.store.jobState('wa:root','submitted');
    const scope={requestId:'wa:root',owner,destination:owner,bindingId:f.binding.id,bindingIdentity:errandBindingIdentity(f.store,f.binding)};
    f.router.errands.ledger.begin(scope,{role:'Flutter',location:'Bangalore'});
    f.store.db.prepare('INSERT INTO errand_search_guards VALUES(?,?)').run('wa:root',f.store.get('errand-authority-generation')??'');
    f.store.db.prepare("UPDATE errand_missions SET state='cancelled' WHERE root_request=?").run('wa:root');
    f.store.db.exec("CREATE TEMP TRIGGER fail_recovery_notice BEFORE INSERT ON errand_notice_guards BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    f.router.errands.recover();f.router.errands.recover();
    assert.equal(f.store.job('wa:root')?.status,'completed');assert.equal(f.store.job('wa:root')?.outcome,'cancelled');
    assert.equal(f.store.db.prepare("SELECT 1 FROM outbox WHERE source='errand-cancel-recovery:wa:root:0'").get(),undefined);
    assert.equal(f.calls.length,0);
  }finally{f.close();}
});
