import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reservePort } from './test-port.js';


// The server reads its port and state directory when it is first imported, so
// both are fixed before any module of the app is loaded. Every test then loads
// the app through load() instead of a hoisted import.
const stateRoot=mkdtempSync(join(tmpdir(),'ffd-inbox-send-'));
const port=await reservePort();
process.env.WSB_STATE_DIR=join(stateRoot,'state');mkdirSync(process.env.WSB_STATE_DIR,{recursive:true});
process.env.WSB_PORT=String(port);
after(()=>rmSync(stateRoot,{recursive:true,force:true}));

async function load(){
  const [storeModule,routerModule,approvalsModule,commandsModule,serverModule]=await Promise.all([
    import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js'),import('../src/owner-commands.js'),import('../src/server.js')]);
  return {Store:storeModule.Store,Router:routerModule.Router,Approvals:approvalsModule.Approvals,
    authenticatedOwner:commandsModule.authenticatedOwner,APP_ORIGIN_WINDOW_MS:commandsModule.APP_ORIGIN_WINDOW_MS,serve:serverModule.serve};
}
type Loaded=Awaited<ReturnType<typeof load>>;

const owner='123@s.whatsapp.net';
/** One registered session and a router that never dispatches: only the send path is under test. */
function fixture({Store,Router,Approvals}:Loaded){
  const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const binding=store.register('app-send','codex',randomUUID(),'/synthetic').binding;
  store.set('whatsapp-owner',owner);store.set('active',binding.id);
  router.pump=()=>{};
  return {store,router,binding,close(){approvals.cancel();store.close();}};
}
const generation=(store:{get(key:string):string|undefined})=>store.get('incoming-owner-generation')??'';
/** Mirrors the route's own flags in src/server.ts: an app send is a fresh owner text message
 *  (ownerIntent and ownerCommand true, as whatsapp.ts:328 and telegram.ts:192 send), not a
 *  reply and not a command-shaped id. Keep this in step with that route. */
const send=(router:{receive(m:any):Promise<any>},id:string,text:string)=>router.receive({id,text,ownerIntent:true,ownerCommand:true,ownerChoice:true});

test('an app id without a claim is not the owner and receive() blocks it',async()=>{
  const loaded=await load(),{Store,Router,Approvals,authenticatedOwner}=loaded;
  const f=fixture(loaded);try{
    const id='app:'+randomUUID(),m={id,text:'/help',ownerIntent:false,ownerCommand:true};
    assert.equal(authenticatedOwner(f.router,m),false);
    const result=await f.router.receive(m);
    assert.equal(result.status,'blocked');assert.equal(result.requestId,id);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM inbox').get()?.n,0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,0);
    // A claim is consulted only for the exact id it names.
    assert.equal(f.store.claimAppOrigin('app:claimed',owner,'whatsapp',generation(f.store)),true);
    assert.equal(authenticatedOwner(f.router,{id:'app:another',text:'hello',ownerIntent:false,ownerCommand:false}),false);
  }finally{f.close();}
});

test('a claimed app id sends as the owner, reaches the owner chat and records a reply',async()=>{
  const loaded=await load(),{authenticatedOwner}=loaded;
  const f=fixture(loaded);try{
    const id='app:'+randomUUID();
    assert.equal(f.store.claimAppOrigin(id,owner,'whatsapp',generation(f.store)),true);
    assert.equal(authenticatedOwner(f.router,{id,text:'Please summarise the build',ownerIntent:false,ownerCommand:false}),true);
    const result=await send(f.router,id,'Please summarise the build');
    assert.equal(result.status,'queued');
    const job=f.store.job(id)!;
    assert.equal(job.binding_id,f.binding.id);assert.equal(job.body,'Please summarise the build');
    // The destination is the control channel's owner chat, so the answer is mirrored there.
    assert.equal(job.destination,owner);
    const origin=f.store.db.prepare('SELECT owner,destination FROM owner_request_origins WHERE request_id=?').get(id) as any;
    assert.equal(origin.owner,owner);assert.equal(origin.destination,owner);
    // The ordinary reply path, under the owner scope the pipeline captured, records the answer.
    const captured=f.store.captureIncomingOwner(owner,'whatsapp')!;assert.ok(captured);
    const queued=f.store.incomingOwnerContext.run(captured,()=>f.store.output(f.binding,'Here is the summary','app-reply:1',owner,{requestId:id,kind:'final',origin:'agent'}));
    assert.equal(queued,true);
    const row=f.store.db.prepare("SELECT id,destination,request_id,reply_kind FROM outbox WHERE source='app-reply:1:0'").get() as any;
    assert.equal(row.destination,owner);assert.equal(row.request_id,id);assert.equal(row.reply_kind,'final');
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM reply_receipts WHERE source='app-reply:1'").get()?.n,1);
    assert.equal(f.store.incomingOwnerDelivery(row.id),true);
    // The delivery stays bound to the owner generation it was captured under.
    f.store.set('whatsapp-owner','456@s.whatsapp.net');f.store.set('whatsapp-owner',owner);
    assert.equal(f.store.incomingOwnerDelivery(row.id),false);
  }finally{f.close();}
});

test('an app claim is single use and a replayed id is ignored',async()=>{
  const loaded=await load();
  const f=fixture(loaded);try{
    const id='app:'+randomUUID(),first=f.store.claimAppOrigin(id,owner,'whatsapp',generation(f.store));
    assert.equal(first,true);
    const stored=f.store.appOriginClaim(id)!;
    // A second claim for the same id is refused and leaves the first claim intact.
    assert.equal(f.store.claimAppOrigin(id,owner,'whatsapp',generation(f.store)),false);
    assert.deepEqual(f.store.appOriginClaim(id),stored);
    assert.equal((await send(f.router,id,'Send this exactly once')).status,'queued');
    const jobs=f.store.jobs().length,messages=f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n;
    const replay=await send(f.router,id,'Send this exactly once');
    assert.equal(replay.status,'ignored');assert.equal(replay.requestId,id);
    assert.equal(f.store.jobs().length,jobs);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get()?.n,messages);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM inbox').get()?.n,1);
  }finally{f.close();}
});

test('an app claim past its 120 second window is refused',async()=>{
  const loaded=await load(),{authenticatedOwner,APP_ORIGIN_WINDOW_MS}=loaded;
  const f=fixture(loaded);try{
    const id='app:'+randomUUID();
    f.store.set(`app-origin:${id}`,JSON.stringify({at:Date.now()-121_000,destination:owner,channel:'whatsapp',generation:generation(f.store)}));
    assert.equal(authenticatedOwner(f.router,{id,text:'/help',ownerIntent:false,ownerCommand:true}),false);
    const result=await send(f.router,id,'/help');
    assert.equal(result.status,'blocked');assert.equal(f.store.job(id),undefined);
    // Inside the window the very same claim is still accepted: the claim ages out, nothing else changed.
    const fresh='app:'+randomUUID();
    f.store.set(`app-origin:${fresh}`,JSON.stringify({at:Date.now()-APP_ORIGIN_WINDOW_MS+1000,destination:owner,channel:'whatsapp',generation:generation(f.store)}));
    assert.equal(authenticatedOwner(f.router,{id:fresh,text:'hello',ownerIntent:false,ownerCommand:false}),true);
  }finally{f.close();}
});

test('an app claim for another destination, another generation or a changed owner is refused',async()=>{
  const loaded=await load(),{authenticatedOwner}=loaded;
  const f=fixture(loaded);try{
    const wrongDestination='app:'+randomUUID();
    f.store.set(`app-origin:${wrongDestination}`,JSON.stringify({at:Date.now(),destination:'456@s.whatsapp.net',channel:'whatsapp',generation:generation(f.store)}));
    assert.equal(authenticatedOwner(f.router,{id:wrongDestination,text:'/help',ownerIntent:false,ownerCommand:true}),false);
    assert.equal((await send(f.router,wrongDestination,'/help')).status,'blocked');
    assert.equal(f.store.job(wrongDestination),undefined);

    const staleGeneration='app:'+randomUUID();
    f.store.set(`app-origin:${staleGeneration}`,JSON.stringify({at:Date.now(),destination:owner,channel:'whatsapp',generation:'stale-generation'}));
    assert.equal(authenticatedOwner(f.router,{id:staleGeneration,text:'/help',ownerIntent:false,ownerCommand:true}),false);
    assert.equal((await send(f.router,staleGeneration,'/help')).status,'blocked');

    // A claim that was valid when it was written is retired when the owner identity changes,
    // even if the owner is later restored to the same chat.
    const moved='app:'+randomUUID();
    assert.equal(f.store.claimAppOrigin(moved,owner,'whatsapp',generation(f.store)),true);
    assert.equal(authenticatedOwner(f.router,{id:moved,text:'hello',ownerIntent:false,ownerCommand:false}),true);
    f.store.set('whatsapp-owner','456@s.whatsapp.net');f.store.set('whatsapp-owner',owner);
    assert.equal(authenticatedOwner(f.router,{id:moved,text:'hello',ownerIntent:false,ownerCommand:false}),false);
    assert.equal((await send(f.router,moved,'/help')).status,'blocked');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM inbox').get()?.n,0);
  }finally{f.close();}
});

test('the composer route validates its text, refuses an unusable bridge and needs the admin session',async()=>{
  const loaded=await load(),{Store,Router,Approvals,serve,authenticatedOwner}=loaded;
  const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const binding=store.register('app-send','codex',randomUUID(),'/synthetic').binding;
  const worker=store.register('app-worker','claude',randomUUID(),'/synthetic');
  store.set('whatsapp-owner',owner);store.set('active',binding.id);
  router.pump=()=>{};
  const server=serve(store,router,{status:'not paired'} as any,'synthetic-admin',{macControl:{view:()=>({}),stop:()=>{}},desktopControl:{view:()=>({}),stop:()=>{}},masters:{options:()=>({}),platformPreferences:()=>[]},power:{view:()=>({})}} as any);
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${port}/api/inbox-send`;
  const post=(data:unknown,token='synthetic-admin',id?:string)=>fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(id?{'X-Binding-Id':id}:{})},body:typeof data==='string'?data:JSON.stringify(data)});
  const claims=()=>store.db.prepare("SELECT count(*) n FROM settings WHERE key LIKE 'app-origin:%'").get()?.n;
  try{
    // Unusable text is refused before anything is claimed.
    for(const body of [JSON.stringify({text:''}),JSON.stringify({text:'   \n\t '}),JSON.stringify({text:'x'.repeat(4001)}),JSON.stringify({})])assert.equal((await post(body)).status,400);
    assert.equal(claims(),0);assert.equal(store.db.prepare('SELECT count(*) n FROM inbox').get()?.n,0);

    // Another app session is authenticated, but is not the admin.
    assert.equal((await post({text:'Hello'},worker.token,worker.binding.id)).status,403);
    assert.equal((await post({text:'Hello'},'not-the-admin-token')).status,401);
    assert.equal(claims(),0);assert.equal(store.db.prepare('SELECT count(*) n FROM inbox').get()?.n,0);

    // A stopped bridge cannot accept anything, and neither can an unpaired owner chat.
    router.stopped=true;
    assert.equal((await post({text:'Hello'})).status,409);
    router.stopped=false;
    store.db.prepare("DELETE FROM settings WHERE key='whatsapp-owner'").run();
    assert.equal((await post({text:'Hello'})).status,409);
    assert.equal(claims(),0);
    store.set('whatsapp-owner',owner);

    // A claimed send is stored against the owner chat and comes back with its request id.
    const sent=await post({text:'Hello from the composer'});
    assert.equal(sent.status,200);
    const result=await sent.json();
    assert.match(result.requestId,/^app:[0-9a-f-]{36}$/);
    assert.equal(result.status,'queued');
    assert.equal(store.job(result.requestId)?.destination,owner);
    assert.equal(store.job(result.requestId)?.body,'Hello from the composer');
    assert.equal(authenticatedOwner(router,{id:result.requestId,text:'Hello from the composer',ownerIntent:false,ownerCommand:false}),true);
    assert.equal(claims(),1);

    // Every send gets its own claim and its own request.
    const again=await post({text:'A different message from the composer'});
    assert.equal(again.status,200);
    assert.notEqual((await again.json()).requestId,result.requestId);
    assert.equal(claims(),2);
  }finally{
    router.stopped=true;approvals.cancel();
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    store.close();
  }
});
test('an app send counts as a fresh owner message, so the owner-only paths stay open',async()=>{
  const loaded=await load(),{Store,Router,Approvals,serve}=loaded;
  const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  const binding=store.register('app-send-parity','codex',randomUUID(),'/synthetic').binding;
  store.set('whatsapp-owner',owner);store.set('active',binding.id);
  router.pump=()=>{};
  const refusal=()=>(store.db.prepare("SELECT count(*) n FROM outbox WHERE body LIKE 'Send schedules as a new message in your own chat%'").get() as {n:number}).n;
  const server=serve(store,router,{status:'not paired'} as any,'synthetic-admin',{macControl:{view:()=>({}),stop:()=>{}},desktopControl:{view:()=>({}),stop:()=>{}},masters:{options:()=>({}),platformPreferences:()=>[]},power:{view:()=>({})}} as any);
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${port}/api/inbox-send`;
  try{
    // The refusal below appears only when the turn is treated as a quoted one: router.ts:362
    // reads `m.quotedId||!ownerIntent`. The composer promises the same behaviour as a message
    // typed fresh into the owner's chat, so the refusal must not appear. This is what stops the
    // route's flags drifting back to ownerIntent:false, which silently closed every
    // owner-intent path the app claims to have.
    assert.ok(router.schedules.isScheduleLike('remind me to water the plants at 6pm'));
    const sent=await fetch(url,{method:'POST',headers:{Authorization:'Bearer synthetic-admin','Content-Type':'application/json'},body:JSON.stringify({text:'remind me to water the plants at 6pm'})});
    assert.equal(sent.status,200);
    assert.notEqual((await sent.json()).status,'blocked');
    assert.equal(refusal(),0);

    // The guard itself is intact: the same words through a turn that is not a fresh owner
    // message still take the refusal, so this test cannot pass by the check being removed.
    const stale='app:'+randomUUID();
    assert.ok(store.claimAppOrigin(stale,owner,store.controlChannel(),generation(store)));
    const quoted=await router.receive({id:stale,text:'remind me to water the plants at 6pm',ownerIntent:false,ownerCommand:false});
    assert.equal(quoted.status,'blocked');
    assert.equal(refusal(),1);
  }finally{
    router.stopped=true;approvals.cancel();
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    store.close();
  }
});
