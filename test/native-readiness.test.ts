import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const dir=realpathSync(mkdtempSync(join(tmpdir(),'ffd-native-readiness-'))),counter=join(dir,'sent'),mode=join(dir,'mode');
process.env.WSB_STATE_DIR=join(dir,'state');process.env.WSB_DESKTOP_SYNC_BIN=join(dir,'helper');
writeFileSync(process.env.WSB_DESKTOP_SYNC_BIN,`#!${process.execPath}
const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(counter)},'submitted\\n');
if(fs.readFileSync(${JSON.stringify(mode)},'utf8')==='uncertain'){console.log(JSON.stringify({status:'unknown'}));process.exit(1);}
console.log(JSON.stringify({status:'submitted'}));`,{mode:0o700});
const {Store}=await import('../src/store.js');
const {NativeAgents}=await import('../src/native.js');
const {Approvals}=await import('../src/approvals.js');
const {Router}=await import('../src/router.js');
const {SessionActivation}=await import('../src/session-activation.js');
const id='11111111-1111-4111-a111-111111111111';
test.after(()=>rmSync(dir,{recursive:true,force:true}));
async function fixture(readyAt=45_000) {
 rmSync(counter,{force:true});writeFileSync(mode,'ok');
 const store=new Store(':memory:'),approvals=new Approvals(store),native=new NativeAgents(store,approvals),router=new Router(store,native,approvals);
 router.uncertainNoticeMs=0;store.set('whatsapp-owner','owner');
 const b=store.register('atlas','claude',id,dir).binding;await native.connections.choose(b,'desktop',false,'test-account');
 let now=0,opens=0;const states:string[]=[];
 const saved={id,desktopId:'local_'+id,accountScope:'test-account',provider:'claude' as const,executionMode:'desktop' as const,cwd:dir,name:'Atlas',status:'saved',activation:'desktop-open' as const,available:true};
 native.catalog=async()=>({sessions:[{...saved,...(now>=readyAt?{activation:undefined,live:true}:{})}],cursor:null});
 (native as any).desktopConfig=async()=>{};
 native.activation=new SessionActivation(store,async()=>(await native.catalog('claude')).sessions,async()=>{opens++;},undefined,{now:()=>now,sleep:async(ms:number)=>{states.push(store.job('wa:first')?.status??'none');now+=ms;}});
 native.beforeRun=()=>{if(router.stopped)throw new Error('Router stopped');};
 return {store,native,router,b,states,now:()=>now,opens:()=>opens,close:()=>{router.stopped=true;native.close();store.close();}};
}
async function settled(router:InstanceType<typeof Router>) {
 const deadline=Date.now()+5000;
 while(router.busy.size&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
 assert.equal(router.busy.size,0,'native dispatch settled');
}
function sends(){return existsSync(counter)?readFileSync(counter,'utf8').trim().split('\n').length:0;}
test('first owner message waits for a slow inbox and submits exactly once with an immediate opening notice',async()=>{
 const f=await fixture();try {
  f.store.enqueue('wa:first',f.b,'Hello','original-chat');f.router.pump();f.router.pump();await settled(f.router);
  assert.equal(f.now(),45_000);assert.equal(f.opens(),1);assert.equal(sends(),1);assert.ok(f.states.length>0&&f.states.every(s=>s==='dispatched'));
  assert.equal(f.store.job('wa:first')?.status,'submitted');
  const notice=f.store.db.prepare("SELECT body,destination,request_id FROM outbox WHERE source='native-opening:wa:first:0'").get() as any;
  assert.equal(notice.destination,'original-chat');assert.equal(notice.request_id,'wa:first');assert.match(notice.body,/Opening atlas in Claude Desktop/);
  const events=f.store.events('wa:first') as any[];assert.ok(events.findIndex(e=>e.event==='reply_queued')<events.findIndex(e=>e.event==='submitted'));
  f.router.pump();await settled(f.router);assert.equal(sends(),1);assert.equal(f.opens(),1);
 }finally{f.close();}
});
test('ambiguous submission is marked uncertain and never automatically replayed',async()=>{
 const f=await fixture(0);try {
  f.router.uncertainNoticeMs=120_000;
  writeFileSync(mode,'uncertain');f.store.enqueue('wa:first',f.b,'Hello','original-chat');f.router.pump();await settled(f.router);
  assert.equal(f.store.job('wa:first')?.status,'uncertain');assert.equal(sends(),1);
  assert.equal(f.store.db.prepare("SELECT 1 FROM outbox WHERE source='error:wa:first:0'").get(),undefined,'ambiguous transport failure still uses its grace period');
  f.router.pump();await settled(f.router);assert.equal(sends(),1);
 }finally{f.close();}
});
test('a request closed while Desktop is opening is never submitted',async()=>{
 const f=await fixture();try {
  const previous=f.native.activation;
  f.native.activation={ready:async(s:any)=>{const ready=await previous.ready(s);f.store.jobState('wa:first','reviewed');return ready;}} as any;
  f.store.enqueue('wa:first',f.b,'Hello','original-chat');f.router.pump();await settled(f.router);
  assert.equal(f.store.job('wa:first')?.status,'reviewed');assert.equal(sends(),0);
 }finally{f.close();}
});

test('warming a selected Desktop target and its first dispatch share one open',async()=>{
 const f=await fixture();try {
  f.native.warmDesktop(f.b);
  f.store.enqueue('wa:first',f.b,'Hello','original-chat');f.router.pump();await settled(f.router);
  assert.equal(f.opens(),1);assert.equal(sends(),1);assert.equal(f.store.job('wa:first')?.status,'submitted');
 }finally{f.close();}
});
test('an already running Desktop process without its inbox waits instead of dropping the first message',async()=>{
 const f=await fixture();try {
  const catalog=f.native.catalog.bind(f.native);
  f.native.catalog=async()=>{const result=await catalog('claude');return {...result,sessions:result.sessions.map(s=>s.activation?{...s,activation:undefined,live:true,available:false}:s)};};
  f.store.enqueue('wa:first',f.b,'Hello','original-chat');f.router.pump();await settled(f.router);
  assert.equal(f.now(),45_000);assert.equal(f.opens(),1);assert.equal(sends(),1);assert.equal(f.store.job('wa:first')?.status,'submitted');
 }finally{f.close();}
});

test('switching the account route during readiness cannot submit to the old account',async()=>{
 const f=await fixture();try {
  const previous=f.native.activation;
  f.native.activation={ready:async(s:any)=>{const ready=await previous.ready(s);await f.native.connections.choose(f.b,'desktop',false,'other-account');return ready;}} as any;
  f.store.enqueue('wa:first',f.b,'Hello','original-chat');f.router.pump();await settled(f.router);
  assert.equal(f.store.job('wa:first')?.status,'uncertain');assert.equal(sends(),0);
 }finally{f.close();}
});

test('readiness timeout immediately reports that nothing was submitted, bypassing the ambiguous-submission grace period',async()=>{
 const f=await fixture(Infinity);try {
  f.router.uncertainNoticeMs=120_000;
  f.store.enqueue('wa:first',f.b,'Hello','original-chat');f.router.pump();await settled(f.router);
  assert.equal(f.now(),180_000);assert.equal(f.opens(),1);assert.equal(sends(),0);
  assert.equal(f.store.job('wa:first')?.status,'uncertain');
  const notice=f.store.db.prepare("SELECT body,destination,request_id,status FROM outbox WHERE source='error:wa:first:0'").get() as any;
  assert.ok(notice,'definitive non-submission notice is already queued when readiness returns');
  assert.equal(notice.status,'queued');assert.equal(notice.destination,'original-chat');assert.equal(notice.request_id,'wa:first');
  assert.match(notice.body,/No task was sent/);assert.doesNotMatch(notice.body,/couldn't confirm a reply/);
  f.router.pump();await settled(f.router);assert.equal(sends(),0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE source='error:wa:first:0'").get()?.count,1);
 }finally{f.close();}
});
