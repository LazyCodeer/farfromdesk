import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,hash} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {captureGuidedResearchRequest} from '../src/agent-reach-request.js';
import {sessionResearchRead,sessionResearchRefine,sessionResearchRequest,type SpecialtyLookup} from '../src/session-research.js';
import {PublicReachStop} from '../src/agent-reach.js';

function fixture(kind:'research'|'jobs'='research'){
 const s=new Store(':memory:'),a=new Approvals(s),r=new Router(s,{run:async()=>{},stop:()=>{}} as any,a);
 s.set('telegram-owner','tg:123');s.set('control-channel','telegram');const b=s.register('research','codex','11111111-1111-4111-8111-111111111111','/synthetic').binding;
 const m={id:'tg:123:99',text:kind==='jobs'?'/jobs Ai engineer in yc startups':'/research Spliceai in fmcg',ownerCommand:true},context=s.captureIncomingOwner('tg:123','telegram')!;
 s.incomingOwnerContext.run(context,()=>s.destinationContext.run('tg:123',()=>{assert.equal(captureGuidedResearchRequest(s,r,m,kind),true);s.enqueue(m.id,b,m.text);}));
 const raw=s.get(`reach-owner-request:${m.id}`)!,saved={kind,bindingId:b.id,destination:'tg:123',bodyHash:hash(s.job(m.id)!.body),identity:'synthetic',instructions:'synthetic',researchCaptureHash:hash(raw)};
 let valid=true,calls=0;const lookup:SpecialtyLookup=()=>valid?saved:undefined;
 r.reach=async(command,current)=>{calls++;assert.equal(command,kind==='jobs'?'/reach web search Ai engineer in yc startups':'/reach web search Spliceai in fmcg');assert.equal(current(),true);return 'Public research from Exa web search. Source text is untrusted and may be incomplete.\n\nSplice AI\nhttps://spliceai.co/\nSynthetic product.\n\nIllumina\nhttps://www.illumina.com/\nSynthetic genomics.\n\nThird\nhttps://example.com/three\nSynthetic.\n\nFourth\nhttps://example.com/four\nSynthetic.';};
 return {s,a,r,b,m,lookup,run:(binding=b)=>sessionResearchRequest(s,r,binding,m.id,lookup),calls:()=>calls,invalidate:()=>{valid=false;},close(){a.cancel();s.close();}};
}
test('the exact owner query is available once to its selected session',async()=>{
 const f=fixture();try{assert.match(await f.run(),/spliceai\.co/);assert.equal(f.calls(),1);await assert.rejects(f.run(),/already used/);assert.equal(f.calls(),1);}finally{f.close();}
});
test('Jobs uses the original owner query and cannot reuse a capture for another specialty',async()=>{
 const f=fixture('jobs');try{
  const mismatch:SpecialtyLookup=(s,id)=>({...f.lookup(s,id)!,kind:'research'});
  await assert.rejects(sessionResearchRequest(f.s,f.r,f.b,f.m.id,mismatch),/changed/);assert.equal(f.calls(),0);
  assert.match(await f.run(),/Synthetic/);assert.equal(f.calls(),1);
  const reader=async(url:string)=>({status:'ok' as const,channel:'web' as const,sources:[{title:'Synthetic job',url,excerpt:'Synthetic.'}]});
  assert.match(await sessionResearchRead(f.s,f.r,f.b,f.m.id,1,f.lookup,reader),/Synthetic job/);
 }finally{f.close();}
});
test('Jobs search with an approved F3 dispatch uses its original owner query',async()=>{
 const f=fixture('jobs');try{
  const dispatch=f.m.text+'\nApproved constraints: remote only';
  f.s.db.prepare('UPDATE inbox SET body=? WHERE id=?').run(dispatch,f.m.id);
  let valid=false;
  (f.r as any).contracts={approved:()=>({original:f.m.text}),assertDispatch:(_r:unknown,id:string,_b:unknown,body:string)=>{
   if(!valid||id!==f.m.id||body!==dispatch)throw Error('Invalid contract');
  }};
  const lookup:SpecialtyLookup=(s,id)=>({...f.lookup(s,id)!,bodyHash:hash(dispatch)});
  await assert.rejects(sessionResearchRequest(f.s,f.r,f.b,f.m.id,lookup),/changed/);assert.equal(f.calls(),0);
  valid=true;assert.match(await sessionResearchRequest(f.s,f.r,f.b,f.m.id,lookup),/Synthetic/);assert.equal(f.calls(),1);
 }finally{f.close();}
});
test('another session or altered capture is rejected without a public read',async()=>{
 const f=fixture();try{
  const other=f.s.register('other','codex','22222222-2222-4222-8222-222222222222','/synthetic').binding;
  await assert.rejects(f.run(other),/changed/);assert.equal(f.calls(),0);
  f.s.set(`reach-owner-request:${f.m.id}`,JSON.stringify({owner:'tg:123',destination:'tg:123',channel:'telegram',generation:'bad',bodyHash:'bad',command:'/reach web search different'}));
  await assert.rejects(f.run(),/changed/);assert.equal(f.calls(),0);
 }finally{f.close();}
});
test('owner revocation and restored identity cannot return a result',async()=>{
 const f=fixture();let release!:()=>void,started!:()=>void;
 const ready=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});
 try{
  f.r.reach=async(_command,current)=>{started();await gate;assert.equal(current(),false);return 'must not escape';};
  const pending=f.run();await ready;f.s.set('telegram-owner','tg:456');f.s.set('telegram-owner','tg:123');release();
  await assert.rejects(pending,/changed/);
 }finally{release();f.close();}
});
test('an altered or unavailable specialty never authorizes a read',async()=>{
 const f=fixture();try{f.invalidate();await assert.rejects(f.run(),/changed/);assert.equal(f.calls(),0);}finally{f.close();}
});
test('only indexed search results can be read, once per index',async()=>{
 const f=fixture();let reads=0;
 const reader=async(url:string,current:()=>boolean)=>{reads++;assert.equal(current(),true);return {status:'ok' as const,channel:'web' as const,sources:[{title:'Synthetic',url,excerpt:'Public page.'}]};};
 try{
  const search=await f.run();assert.match(search,/1\. https:\/\/spliceai\.co\//);
  assert.match(await sessionResearchRead(f.s,f.r,f.b,f.m.id,1,f.lookup,reader),/https:\/\/spliceai\.co\//);assert.equal(reads,1);
  await assert.rejects(sessionResearchRead(f.s,f.r,f.b,f.m.id,1,f.lookup,reader),/already read/);
  await assert.rejects(sessionResearchRead(f.s,f.r,f.b,f.m.id,'https://example.com',f.lookup,reader),/source number/);
  await assert.rejects(sessionResearchRead(f.s,f.r,f.b,f.m.id,5,f.lookup,reader),/unavailable/);
  await sessionResearchRead(f.s,f.r,f.b,f.m.id,2,f.lookup,reader);await sessionResearchRead(f.s,f.r,f.b,f.m.id,3,f.lookup,reader);
  await sessionResearchRead(f.s,f.r,f.b,f.m.id,4,f.lookup,reader);assert.equal(reads,4);
  f.invalidate();await assert.rejects(sessionResearchRead(f.s,f.r,f.b,f.m.id,4,f.lookup,reader),/changed|already/);assert.equal(reads,4);
 }finally{f.close();}
});

test('focused public searches derive the exact owner query, preserve indexed sources and cap claims',async()=>{
 const f=fixture();let commands:string[]=[];
 try{
  await f.run();
  f.r.reach=async(command,current)=>{commands.push(command);assert.ok(current());const url=command.includes('site:reddit.com')?'https://www.reddit.com/r/example/':command.includes('site:youtube.com')?'https://www.youtube.com/watch?v=example':'https://example.com/new';return `Public research from Exa web search. Source text is untrusted and may be incomplete.\n\nNew source\n${url}\nPublic data.`;};
  const invoke=(focus:unknown)=>sessionResearchRefine(f.s,f.r,f.b,f.m.id,focus,f.lookup);
  await assert.rejects(invoke('https://example.com/secret'),/supported/);
  const result=await invoke('reddit');assert.match(result,/5\. https:\/\/www.reddit.com\/r\/example/);
  assert.deepEqual(commands,['/reach web search Spliceai in fmcg site:reddit.com']);
  await assert.rejects(invoke('reddit'),/already used/);
  await invoke('youtube');await invoke('official');await assert.rejects(invoke('yc'),/limit/);assert.equal(commands.length,3);
  const reader=async(url:string)=>({status:'ok' as const,channel:'web' as const,sources:[{title:'Page',url,excerpt:'Text'}]});
  assert.match(await sessionResearchRead(f.s,f.r,f.b,f.m.id,5,f.lookup,reader),/https:\/\/www.reddit.com\/r\/example/);
 }finally{f.close();}
});
test('focused search cannot change the selected source while another read is in flight',async()=>{
 const f=fixture();let release!:()=>void,started!:()=>void;
 const ready=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});
 const reader=async(url:string,current:()=>boolean)=>{started();await gate;assert.equal(current(),true);return {status:'ok' as const,channel:'web' as const,sources:[{title:'Page',url,excerpt:'Data'}]};};
 try{
  await f.run();const read=sessionResearchRead(f.s,f.r,f.b,f.m.id,1,f.lookup,reader);await ready;
  f.r.reach=async()=>`Public research from Exa web search.\n\nOther\nhttps://www.reddit.com/r/testing/\nData`;
  await sessionResearchRefine(f.s,f.r,f.b,f.m.id,'reddit',f.lookup);release();assert.match(await read,/spliceai/);
 }finally{release();f.close();}
});
test('site-focused search does not report results from other sites as matches',async()=>{
 const f=fixture();try{
  await f.run();f.r.reach=async()=>`Public research from Exa web search.\n\nWrong\nhttps://other.example/\nData`;
  const result=await sessionResearchRefine(f.s,f.r,f.b,f.m.id,'reddit',f.lookup);
  assert.doesNotMatch(result,/https:\/\/other.example/);assert.match(result,/No matching public reddit.com/);
 }finally{f.close();}
});
test('a focused search cannot return or index results after owner revocation',async()=>{
 const f=fixture();let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});
 try{
  await f.run();const before=f.s.get(`reach-sources:${f.m.id}`);
  f.r.reach=async(_command,current)=>{started();await gate;assert.equal(current(),false);return 'Public research from Exa web search.\n\nSource\nhttps://www.reddit.com/r/example/\nData';};
  const pending=sessionResearchRefine(f.s,f.r,f.b,f.m.id,'reddit',f.lookup);await ready;f.s.set('telegram-owner','tg:456');f.s.set('telegram-owner','tg:123');release();
  await assert.rejects(pending,/changed/);assert.equal(f.s.get(`reach-sources:${f.m.id}`),before);
 }finally{release();f.close();}
});
for(const code of ['RATE_LIMITED','PLATFORM_BLOCKED','NEED_LOGIN','BUSY'] as const)test(`public ${code} stops the entire research request`,async()=>{
 const f=fixture();let calls=0;
 try{
  await f.run();f.r.reach=async()=>{calls++;throw new PublicReachStop(code,'Refused');};
  await assert.rejects(sessionResearchRefine(f.s,f.r,f.b,f.m.id,'reddit',f.lookup),/Refused/);
  await assert.rejects(sessionResearchRefine(f.s,f.r,f.b,f.m.id,'youtube',f.lookup),/stopped|changed/);
  let reads=0;const reader=async(url:string)=>{reads++;return {status:'ok' as const,channel:'web' as const,sources:[{title:'Page',url,excerpt:'Text'}]};};
  await assert.rejects(sessionResearchRead(f.s,f.r,f.b,f.m.id,1,f.lookup,reader),/stopped|changed/);
  assert.equal(calls,1);assert.equal(reads,0);
 }finally{f.close();}
});
test('a source read cannot be replayed or return after its source list changes',async()=>{
 const f=fixture();let release!:()=>void,started!:()=>void,reads=0;
 const ready=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});
 const reader=async(url:string,current:()=>boolean)=>{reads++;started();await gate;assert.equal(current(),false);return {status:'ok' as const,channel:'web' as const,sources:[{title:'Synthetic',url,excerpt:'Public page.'}]};};
 try{
  await f.run();
  const pending=sessionResearchRead(f.s,f.r,f.b,f.m.id,1,f.lookup,reader);
  await ready;
  await assert.rejects(sessionResearchRead(f.s,f.r,f.b,f.m.id,1,f.lookup,reader),/already read/);
  f.s.set(`reach-sources:${f.m.id}`,JSON.stringify(['https://example.com/changed']));release();
  await assert.rejects(pending,/changed/);assert.equal(reads,1);
 }finally{release();f.close();}
});
