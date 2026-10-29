import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=mkdtempSync(join(tmpdir(),'ffd-managed-collab-'));
process.env.WSB_STATE_DIR=root;process.env.FARFROMDESK_HOME=join(root,'home');
test.after(()=>rmSync(root,{recursive:true,force:true}));
const {Store}=await import('../src/store.js');
const {Router}=await import('../src/router.js');
const {Approvals}=await import('../src/approvals.js');
const {Coordinator}=await import('../src/coordinator.js');
const {MetaBrain}=await import('../src/meta-brain.js');
const {DEFAULT_BRAIN,MetaSecret,saveBrainConfig}=await import('../src/meta-brain-config.js');
const {TaskContracts}=await import('../src/task-contracts.js');
const {ManagedCollaboration}=await import('../src/managed-collaboration.js');
const {CollaborationRoles}=await import('../src/collaboration-roles.js');
const {NativeAgents}=await import('../src/native.js');
const {DispatchNotSubmittedError}=await import('../src/brief-dispatch-guard.js');

function deferred<T=void>(){let resolve!:(v:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(predicate:()=>boolean){for(let i=0;i<100&&!predicate();i++)await turn();assert.ok(predicate(),'operation did not reach the expected state');}

async function fixture(delaySource=false,beforePump?:(store:InstanceType<typeof Store>,owner:string)=>void,sourceProvider:'codex'|'claude'='codex'){
  const dir=mkdtempSync(join(root,'case-')),store=new Store(join(dir,'test.sqlite')),approvals=new Approvals(store),sourceEnd=deferred(),targetEnd=deferred();
  const starts:{id:string;body:string}[]=[],routes=new Map<string,{transport:string;executionMode:string}>();
  const native:any={connections:{route:(b:any)=>routes.get(b.id)},stop:()=>{},run:async(b:any,body:string,id:string)=>{native.beforeDispatch?.(b,id);native.beforeManagedSubmission?.(b,id);starts.push({id,body});if(id==='wa:approve')await sourceEnd.promise;else if(id.includes(':f5-'))await targetEnd.promise;}};
  const r=new Router(store,native,approvals),c=new Coordinator(store,native,r,()=>{});r.coordinator=c;
  const owner='owner@s.whatsapp.net';store.set('whatsapp-owner',owner);
  const proxy=store.register('proxy',sourceProvider,randomUUID(),'/tmp').binding,worker=store.register('worker','codex',randomUUID(),'/tmp').binding;
  for(const b of [proxy,worker]){routes.set(b.id,{transport:'managed-cli',executionMode:'cli'});store.set(`execution-mode:${b.id}`,'cli');}
  c.registry.register(proxy);store.set('master',proxy.id);store.set('selected',JSON.stringify([worker.id]));
  const secret=new MetaSecret(dir);secret.save('synthetic-key-not-a-real-secret');
  saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex','claude'],failure:'block'}});
  r.brain=new MetaBrain(store,secret,{interpret:async()=>{throw new Error('unused');}} as any);
  r.brain.handle=async()=>false;
  r.contracts=new TaskContracts(store,secret,async()=>({kind:'contract',goal:'Add dark theme',exclusions:['Do not publish'],checks:['Theme works','Existing theme works'],question:''}));
  const send=(id:string,text:string)=>store.destinationContext.run(owner,()=>r.receive({id:`wa:${id}`,text,source:'text',ownerIntent:true,ownerCommand:true}));
  const first=await send('request','Add dark theme. Do NOT publish.');assert.equal(first.status,'handled');store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  const originalPump=r.pump;if(delaySource)r.pump=()=>{};
  const approved=await send('approve','ok');assert.equal(approved.status,'queued',JSON.stringify(store.db.prepare('SELECT body FROM outbox ORDER BY rowid').all()));
  if(delaySource){beforePump?.(store,owner);r.pump=originalPump;r.pump();}await until(()=>starts.some(x=>x.id==='wa:approve'));
  const collab=new ManagedCollaboration(r,{authorize:()=> 'test-approval'});r.collaboration=collab;
  return {dir,store,r,c,native,proxy,worker,owner,starts,routes,sourceEnd,targetEnd,collab,
    async close(){r.stopped=true;sourceEnd.resolve();targetEnd.resolve();await turn();await until(()=>r.busy.size===0);await turn();approvals.cancel();store.close();rmSync(dir,{recursive:true,force:true});}};
}

function roleScope(f:Awaited<ReturnType<typeof fixture>>) {
  const c=f.r.contracts.approved('wa:approve')!;
  return {owner:c.owner,destination:c.destination,rootRequestId:c.dispatch_id!,itemId:c.item_id!,contractId:c.id,revision:c.revision,approvedHash:c.approved_hash!};
}

test('role policy requires an exact owner-approved proposal and current memory, scope and sessions',async()=>{
  const f=await fixture();try {
    let memory='# Collaboration\n- Planning: selected Codex session\n',memoryRevision='1';
    const roles=new CollaborationRoles(f.store,()=>({text:memory,revision:memoryRevision}),(_scope,digest,receipt)=>receipt===`approved:${digest}`),scope=roleScope(f);
    const rules=[{role:'plan',fromBindingId:f.proxy.id,toBindingId:f.worker.id}];
    const proposal=roles.propose(scope,rules);
    assert.equal(roles.authorize(scope,f.proxy,f.worker,'task','plan'),undefined);
    assert.throws(()=>roles.activate(proposal,'model says yes'),/approval/);
    memory+='- Review: another session\n';
    assert.throws(()=>roles.activate(proposal,`approved:${proposal.digest}`),/changed/);
    memory='# Collaboration\n- Planning: selected Codex session\n';
    const revision=roles.activate(proposal,`approved:${proposal.digest}`);
    assert.equal(roles.authorize(scope,f.proxy,f.worker,'task','plan'),revision);
    assert.throws(()=>roles.activate(proposal,`approved:${proposal.digest}`));
    assert.equal(roles.authorize(scope,f.proxy,f.worker,'task','plan'),revision);
    assert.equal(roles.authorize(scope,f.proxy,f.worker,'task','build'),undefined);
    assert.equal(roles.authorize({...scope,approvedHash:'0'.repeat(64)},f.proxy,f.worker,'task','plan'),undefined);
    memory+='Changed';assert.equal(roles.authorize(scope,f.proxy,f.worker,'task','plan'),undefined);memory=memory.slice(0,-7);
    memoryRevision='2';assert.equal(roles.authorize(scope,f.proxy,f.worker,'task','plan'),undefined);
    roles.revoke(scope.rootRequestId);
    assert.throws(()=>roles.activate(proposal,`approved:${proposal.digest}`));
    const fresh=roles.propose(scope,rules);roles.activate(fresh,`approved:${fresh.digest}`);
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.worker.id);
    assert.equal(roles.authorize(scope,f.proxy,f.store.binding(f.worker.id)!,'task','plan'),undefined);
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(f.worker.native_id,f.worker.id);
    assert.equal(roles.authorize(scope,f.proxy,f.worker,'task','plan'),undefined);
    const afterSession=roles.propose(scope,rules);roles.activate(afterSession,`approved:${afterSession.digest}`);
    f.store.set(`execution-mode:${f.worker.id}`,'desktop');f.store.set(`execution-mode:${f.worker.id}`,'cli');
    assert.equal(roles.authorize(scope,f.proxy,f.worker,'task','plan'),undefined);
    const afterRoute=roles.propose(scope,rules);roles.activate(afterRoute,`approved:${afterRoute.digest}`);
    f.store.set('whatsapp-owner','other@s.whatsapp.net');f.store.set('whatsapp-owner',f.owner);
    assert.equal(roles.authorize(scope,f.proxy,f.worker,'task','plan'),undefined);
    roles.revoke(scope.rootRequestId);
  }finally{await f.close();}
});

test('replacing an approved role policy during readiness cannot submit a staged handoff',async()=>{
  const f=await fixture();try {
    const roles=new CollaborationRoles(f.store,()=>({text:'# Collaboration\n- Planning: Codex',revision:'fake-1'}),(_scope,digest,receipt)=>receipt===digest),scope=roleScope(f);
    const rules=[{role:'plan',fromBindingId:f.proxy.id,toBindingId:f.worker.id}],proposal=roles.propose(scope,rules);
    roles.activate(proposal,proposal.digest);f.r.collaboration=f.collab=new ManagedCollaboration(f.r,roles);
    assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Plan','wrong-role','build'),/authorize/);
    const id=f.collab.stage('wa:approve',f.worker.id,'Plan','policy-roundtrip','plan');
    assert.equal(f.collab.history(scope.rootRequestId,scope.itemId)[0].role,'plan');
    const waiting=deferred(),started=deferred();let sent=0;const prior=f.native.run;f.native.store=f.store;
    f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id){started.resolve();await waiting.promise;}};
    f.native.managedRun=async()=>{sent++;};
    f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
    f.sourceEnd.resolve();await started.promise;
    roles.revoke(scope.rootRequestId);const replacement=roles.propose(scope,rules);roles.activate(replacement,replacement.digest);
    waiting.resolve();await until(()=>f.store.job(id)?.status==='failed');
    assert.equal(sent,0);assert.equal(f.store.db.prepare('SELECT state FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.state,'invalid');
  }finally{await f.close();}
});

test('approval must still match after the trusted verifier returns',async()=>{
  const f=await fixture();try {
    let revision='before';
    const roles=new CollaborationRoles(f.store,()=>({text:'# Collaboration\n- Planning: Codex',revision}),()=>{revision='after';return true;}),scope=roleScope(f);
    const proposal=roles.propose(scope,[{role:'plan',fromBindingId:f.proxy.id,toBindingId:f.worker.id}]);
    assert.throws(()=>roles.activate(proposal,'receipt'),/changed/);
    assert.equal(roles.authorize(scope,f.proxy,f.worker,'task','plan'),undefined);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM collaboration_role_approvals').get()?.n,0);
  }finally{await f.close();}
});

test('a changed role approval during staging rolls back the queued task and item link',async()=>{
  const f=await fixture();try {
    let checks=0;f.r.collaboration=f.collab=new ManagedCollaboration(f.r,{authorize:()=>++checks===1?'old-revision':'new-revision'});
    const id=`master:wa:approve:f5-race:${f.worker.id}`;
    assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Plan','race','plan'),/unavailable/);
    assert.equal(f.store.job(id),undefined);assert.equal(f.store.itemOf(id),undefined);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM managed_collaboration_handoffs').get()?.n,0);
  }finally{await f.close();}
});

test('revoking role approval after submission keeps the claim until the outcome is reconciled',async()=>{
  const f=await fixture();try {
    const roles=new CollaborationRoles(f.store,()=>({text:'# Collaboration\n- Planning: Codex',revision:'fake-1'}),(_scope,digest,receipt)=>receipt===digest),scope=roleScope(f);
    const proposal=roles.propose(scope,[{role:'plan',fromBindingId:f.proxy.id,toBindingId:f.worker.id}]);
    roles.activate(proposal,proposal.digest);f.r.collaboration=f.collab=new ManagedCollaboration(f.r,roles);
    const id=f.collab.stage('wa:approve',f.worker.id,'Plan','revoke-after-submit','plan');
    f.sourceEnd.resolve();await until(()=>f.starts.some(x=>x.id===id));
    roles.revoke(scope.rootRequestId);f.r.channelReply(f.worker,'Plan reported.','final',id);
    f.targetEnd.resolve();await until(()=>!f.r.busy.has(f.worker.id));
    assert.equal(f.store.db.prepare('SELECT state FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.state,'claimed');
    assert.ok(f.store.db.prepare('SELECT token FROM collaboration_claims WHERE item_id=?').get(scope.itemId)?.token);
  }finally{await f.close();}
});

test('legacy handoffs without a policy revision never dispatch',async()=>{
  const f=await fixture();try {
    const id=f.collab.stage('wa:approve',f.worker.id,'Plan','legacy-policy');
    f.store.db.prepare('UPDATE managed_collaboration_handoffs SET authority_revision=NULL WHERE job_id=?').run(id);
    f.sourceEnd.resolve();await until(()=>!f.r.busy.has(f.proxy.id));f.r.pump();await turn();
    assert.equal(f.starts.some(x=>x.id===id),false);
    assert.notEqual(f.store.job(id)?.status,'submitted');
  }finally{await f.close();}
});

test('role approval and session revision survive database reopen',async()=>{
  const f=await fixture();let reopened:InstanceType<typeof Store>|undefined;try {
    const memory=()=>({text:'# Collaboration\n- Planning: Codex',revision:'fake-1'}),verify=(_scope:any,digest:string,receipt:unknown)=>digest===receipt;
    const scope=roleScope(f),rules=[{role:'plan',fromBindingId:f.proxy.id,toBindingId:f.worker.id}];
    f.store.set(`session-route:${f.worker.id}`,'original-route');
    const roles=new CollaborationRoles(f.store,memory,verify),proposal=roles.propose(scope,rules),revision=roles.activate(proposal,proposal.digest);
    reopened=new Store(join(f.dir,'test.sqlite'));const afterRestart=new CollaborationRoles(reopened,memory,verify);
    const from=reopened.binding(f.proxy.id)!,to=reopened.binding(f.worker.id)!;
    assert.equal(afterRestart.authorize(scope,from,to,'task','plan'),revision);
    reopened.set(`session-route:${to.id}`,'changed');reopened.set(`session-route:${to.id}`,'original-route');
    assert.equal(afterRestart.authorize(scope,from,to,'task','plan'),undefined);
    reopened.close();reopened=new Store(join(f.dir,'test.sqlite'));
    const again=new CollaborationRoles(reopened,memory,verify);
    assert.equal(again.authorize(scope,reopened.binding(from.id)!,reopened.binding(to.id)!,'task','plan'),undefined);
  }finally{reopened?.close();await f.close();}
});

test('managed-only handoff waits for the source turn, claims once, and carries the approved contract',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement the approved theme.','first');
    f.r.pump();await turn();assert.equal(f.starts.filter(x=>x.id===id).length,0);
    assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Another task','second'));
    f.sourceEnd.resolve();await until(()=>f.starts.some(x=>x.id===id));
    const delivered=f.starts.find(x=>x.id===id)!;assert.match(delivered.body,/Owner-approved task contract/);assert.match(delivered.body,/Do NOT publish/);
    assert.equal(f.starts.filter(x=>x.id===id).length,1);
    const h=f.collab.history('wa:approve',f.store.itemOf(id)!);assert.equal(h.length,1);assert.equal(h[0].drift,'not_checked');assert.equal(h[0].state,'claimed');assert.equal(h[0].result,null);
    f.r.channelReply(f.worker,'Implementation reported complete.','final',id);
    f.targetEnd.resolve();await until(()=>f.collab.history('wa:approve',f.store.itemOf(id)!)[0]?.state==='complete');
    assert.equal(f.store.job(id)?.status,'completed');
  }finally{await f.close();}
});

test('synthetic managed sessions plan, build and review in sequence under one contract',async()=>{
  const f=await fixture(),gates=new Map<string,ReturnType<typeof deferred>>();try{
    const builder=f.store.register('builder','codex',randomUUID(),'/tmp').binding;
    f.routes.set(builder.id,{transport:'managed-cli',executionMode:'cli'});f.store.set(`execution-mode:${builder.id}`,'cli');
    f.store.set('selected',JSON.stringify([f.worker.id,builder.id]));
    const item=f.store.itemOf('wa:approve')!,scope=roleScope(f);
    const roles=new CollaborationRoles(f.store,()=>({text:'# Collaboration\n- Codex plans, builds and reviews.',revision:'fake-1'}),(_scope,digest,receipt)=>digest===receipt);
    const proposal=roles.propose(scope,[
      {role:'plan',fromBindingId:f.proxy.id,toBindingId:f.worker.id},
      {role:'build',fromBindingId:f.proxy.id,toBindingId:builder.id},
      {role:'review',fromBindingId:f.proxy.id,toBindingId:f.worker.id},
    ]);
    roles.activate(proposal,proposal.digest);f.r.collaboration=f.collab=new ManagedCollaboration(f.r,roles);
    assert.throws(()=>f.collab.stage('wa:approve',builder.id,'Unapproved task.','unauthorized','plan'),/did not authorize/);
    f.native.run=async(b:any,body:string,id:string)=>{
      f.native.beforeDispatch?.(b,id);f.native.beforeManagedSubmission?.(b,id);f.starts.push({id,body});
      const gate=deferred();gates.set(id,gate);await gate.promise;
    };
    const plan=f.collab.stage('wa:approve',f.worker.id,'Plan the approved change.','plan','plan');
    f.sourceEnd.resolve();await until(()=>gates.has(plan));
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM collaboration_claims WHERE token IS NOT NULL').get()?.n,1);
    assert.match(f.starts.find(x=>x.id===plan)!.body,/Owner-approved task contract/);
    f.r.channelReply(f.worker,'Plan recorded: implement the theme and preserve existing settings.','final',plan);gates.get(plan)!.resolve();
    const planReport=`report:${plan}`;await until(()=>gates.has(planReport));
    f.store.enqueue('wa:unrelated-item-work',f.worker,'Other work on this item',f.owner);f.store.linkItem('wa:unrelated-item-work',item);f.store.jobState('wa:unrelated-item-work','submitted');
    assert.throws(()=>f.collab.stage(planReport,builder.id,'Build the approved plan.','conflict','build'),/active or uncertain/);
    f.store.jobState('wa:unrelated-item-work','failed');
    const build=f.collab.stage(planReport,builder.id,'Build the approved plan.','build','build');
    f.r.channelReply(f.proxy,'Plan report acknowledged.','final',planReport);
    gates.get(planReport)!.resolve();await until(()=>gates.has(build));
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM collaboration_claims WHERE token IS NOT NULL').get()?.n,1);
    f.r.channelReply(builder,'Build reported: theme implementation prepared.','final',build);gates.get(build)!.resolve();
    const buildReport=`report:${build}`;await until(()=>gates.has(buildReport));
    const review=f.collab.stage(buildReport,f.worker.id,'Review the approved change.','review','review');
    f.r.channelReply(f.proxy,'Build report acknowledged.','final',buildReport);
    gates.get(buildReport)!.resolve();await until(()=>gates.has(review));
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM collaboration_claims WHERE token IS NOT NULL').get()?.n,1);
    f.r.channelReply(f.worker,'Review reported: checks still require independent proof.','final',review);gates.get(review)!.resolve();
    await until(()=>f.collab.history('wa:approve',item).filter(h=>h.state==='complete').length===3);
    assert.deepEqual(f.collab.history('wa:approve',item).map(h=>h.summary),['Plan the approved change.','Build the approved plan.','Review the approved change.']);
    assert.deepEqual(f.collab.history('wa:approve',item).map(h=>h.role),['plan','build','review']);
    assert.deepEqual(f.collab.history('wa:approve',item).map(h=>h.result),['Plan recorded: implement the theme and preserve existing settings.','Build reported: theme implementation prepared.','Review reported: checks still require independent proof.'].map(text=>({kind:'session_report',verification:'unverified',text})));
    assert.ok(f.collab.history('wa:approve',item).every(h=>h.drift==='not_checked'));
    for(const id of [plan,build,review]){assert.equal(f.store.itemOf(id),item);assert.match(f.starts.find(x=>x.id===id)!.body,/Do NOT publish/);}
  }finally{for(const gate of gates.values())gate.resolve();await f.close();}
});

test('late progress after an uncertain coordinator turn cannot make it a parked ancestor',async()=>{
  const f=await fixture(),childGate=deferred(),reportGate=deferred();try{
    const builder=f.store.register('builder','codex',randomUUID(),'/tmp').binding;
    f.routes.set(builder.id,{transport:'managed-cli',executionMode:'cli'});f.store.set(`execution-mode:${builder.id}`,'cli');f.store.set('selected',JSON.stringify([f.worker.id,builder.id]));
    const item=f.store.itemOf('wa:approve')!,child=`master:wa:approve:synthetic-child:${f.worker.id}`;
    f.native.run=async(b:any,body:string,id:string)=>{f.native.beforeDispatch?.(b,id);f.native.beforeManagedSubmission?.(b,id);f.starts.push({id,body});if(id===child)await childGate.promise;else if(id===`report:${child}`)await reportGate.promise;};
    f.sourceEnd.reject(new Error('Synthetic transport loss; provider may still run.'));
    await until(()=>f.store.job('wa:approve')?.status==='uncertain'&&!f.r.busy.has(f.proxy.id));
    f.r.channelReply(f.proxy,'Still working on the original task.','progress','wa:approve');
    assert.equal(f.store.job('wa:approve')?.status,'submitted');
    assert.equal(f.store.db.prepare('SELECT 1 FROM managed_collaboration_turn_ends WHERE request_id=?').get('wa:approve'),undefined);
    f.store.set(`parent:${child}`,'wa:approve');f.store.linkItem(child,item);
    const scoped=f.r.contracts.bindChild(f.r,'wa:approve',child,f.worker,'Existing delegated task',item);
    f.store.enqueue(child,f.worker,scoped,f.owner);f.r.pump();await until(()=>f.starts.some(x=>x.id===child));
    f.r.channelReply(f.worker,'Previous worker finished.','final',child);childGate.resolve();
    const report=`report:${child}`;await until(()=>f.starts.some(x=>x.id===report)&&!f.r.busy.has(f.worker.id));
    f.store.db.prepare("UPDATE items SET status='in progress' WHERE id=?").run(item);
    assert.throws(()=>f.collab.stage(report,builder.id,'Continue approved work','unsafe-ancestor'),/active or uncertain/);
    assert.equal(f.starts.some(x=>x.id.includes(':f5-unsafe-ancestor:')),false);
  }finally{childGate.resolve();reportGate.resolve();await f.close();}
});

test('a stale managed completion cannot mark a different dispatch attempt finished',async()=>{
  const f=await fixture();try{
    const original=f.store.job('wa:approve')!.attempt_id!,next=f.collab.stage('wa:approve',f.worker.id,'Implement','new-attempt');
    const replacement=randomUUID();f.store.db.prepare('UPDATE inbox SET attempt_id=? WHERE id=?').run(replacement,'wa:approve');
    f.sourceEnd.resolve();await until(()=>!f.r.busy.has(f.proxy.id));
    assert.notEqual(original,replacement);assert.equal(f.starts.some(x=>x.id===next),false);
    assert.equal(f.store.db.prepare('SELECT 1 FROM managed_collaboration_turn_ends WHERE request_id=? AND attempt_id=?').get('wa:approve',replacement),undefined);
  }finally{await f.close();}
});

test('Claude sources cannot stage handoffs without exact turn correlation',async()=>{
  // Both current Claude transports lack a bridge-verified per-request turn ID.
  for(const transport of ['stdio','sdk'] as const){const f=await fixture(false,undefined,'claude');try{
    f.store.set(`synthetic-claude-transport:${f.proxy.id}`,transport);
    const target=f.store.register('claude-target','claude',randomUUID(),'/tmp').binding;
    f.routes.set(target.id,{transport:'managed-cli',executionMode:'cli'});f.store.set(`execution-mode:${target.id}`,'cli');f.store.set('selected',JSON.stringify([target.id]));
    assert.throws(()=>f.collab.stage('wa:approve',target.id,'Implement the approved theme.',`claude-${transport}`),/managed Codex/);
    f.sourceEnd.resolve();await until(()=>!f.r.busy.has(f.proxy.id));f.r.pump();await turn();
    assert.equal(f.starts.some(x=>x.id.includes(':f5-')),false);
    assert.equal(f.store.db.prepare('SELECT 1 FROM managed_collaboration_turn_ends WHERE request_id=?').get('wa:approve'),undefined);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM managed_collaboration_handoffs').get()?.n,0);
  }finally{await f.close();}}
});

test('Claude targets cannot receive a staged handoff without exact turn correlation',async()=>{
  const f=await fixture();try{
    const target=f.store.register('claude-worker','claude',randomUUID(),'/tmp').binding;
    f.routes.set(target.id,{transport:'managed-cli',executionMode:'cli'});f.store.set(`execution-mode:${target.id}`,'cli');f.store.set('selected',JSON.stringify([target.id]));
    // Exercise this boundary even if platform selection later allows mixed providers.
    f.c.registry.matches=()=>true;
    assert.throws(()=>f.collab.stage('wa:approve',target.id,'Implement the approved theme.','claude-target'),/managed Codex/);
    f.sourceEnd.resolve();await until(()=>!f.r.busy.has(f.proxy.id));f.r.pump();await turn();
    assert.equal(f.starts.some(x=>x.id.includes(':f5-')),false);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM managed_collaboration_handoffs').get()?.n,0);
  }finally{await f.close();}
});

test('a parked ancestor requires exact recorded attempt, identity, owner and contract evidence',async()=>{
  const f=await fixture(),reportGate=deferred();try{
    const builder=f.store.register('builder','codex',randomUUID(),'/tmp').binding;
    f.routes.set(builder.id,{transport:'managed-cli',executionMode:'cli'});f.store.set(`execution-mode:${builder.id}`,'cli');f.store.set('selected',JSON.stringify([f.worker.id,builder.id]));
    const prior=f.native.run;f.native.run=async(b:any,body:string,id:string)=>{if(id.startsWith('report:')){f.native.beforeDispatch?.(b,id);f.starts.push({id,body});await reportGate.promise;}else await prior(b,body,id);};
    const plan=f.collab.stage('wa:approve',f.worker.id,'Plan the approved change.','plan-evidence');
    f.sourceEnd.resolve();await until(()=>f.starts.some(x=>x.id===plan));
    f.r.channelReply(f.worker,'Plan recorded.','final',plan);f.targetEnd.resolve();
    const report=`report:${plan}`;await until(()=>f.starts.some(x=>x.id===report)&&!f.r.busy.has(f.worker.id));
    const row=f.store.db.prepare('SELECT * FROM managed_collaboration_turn_ends WHERE request_id=?').get('wa:approve') as Record<string,unknown>;
    assert.ok(row);assert.equal(row.attempt_id,f.store.job('wa:approve')?.attempt_id);
    const fields=['attempt_id','binding_id','binding_identity','body_hash','owner_generation','root_id','item_id','contract_id','revision','approved_hash'] as const;
    for(const [index,field] of fields.entries()){
      f.store.db.prepare(`UPDATE managed_collaboration_turn_ends SET ${field}=? WHERE request_id=?`).run(field==='item_id'||field==='revision'?999:'synthetic-mismatch','wa:approve');
      assert.throws(()=>f.collab.stage(report,builder.id,'Build the approved plan.',`mismatch-${index}`),/active or uncertain/,field);
      f.store.db.prepare(`UPDATE managed_collaboration_turn_ends SET ${field}=? WHERE request_id=?`).run(row[field] as any,'wa:approve');
    }
    f.store.db.prepare('DELETE FROM managed_collaboration_turn_ends WHERE request_id=?').run('wa:approve');
    assert.throws(()=>f.collab.stage(report,builder.id,'Build the approved plan.','missing-evidence'),/active or uncertain/);
    f.store.db.prepare('INSERT INTO managed_collaboration_turn_ends VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...['request_id','attempt_id','binding_id','binding_identity','body_hash','owner_generation','root_id','item_id','contract_id','revision','approved_hash','ended_event_id'].map(key=>row[key] as any));
    f.store.jobState('wa:approve','uncertain','Synthetic loss after earlier completion.');
    f.r.channelReply(f.proxy,'Still working on the task.','progress','wa:approve');
    assert.equal(f.store.job('wa:approve')?.status,'submitted');
    f.store.db.prepare("UPDATE items SET status='in progress' WHERE id=?").run(f.store.itemOf('wa:approve'));
    assert.throws(()=>f.collab.stage(report,builder.id,'Build the approved plan.','later-uncertainty'),/active or uncertain/);
    // The persisted uncertainty fence remains effective after a real reopen.
    const reopened=new Store(join(f.dir,'test.sqlite')),a=new Approvals(reopened),n:any={connections:{route:(b:any)=>f.routes.get(b.id)},stop:()=>{},run:async()=>{}};
    try{
      reopened.recover();const router=new Router(reopened,n,a),c=new Coordinator(reopened,n,router,()=>{});router.coordinator=c;
      router.contracts=new TaskContracts(reopened,new MetaSecret(f.dir));const collab=new ManagedCollaboration(router,{authorize:()=> 'test-approval'});
      assert.equal((collab as any).parkedAncestor(report,reopened.job('wa:approve')),false);
    }finally{a.cancel();reopened.close();}
  }finally{reportGate.resolve();await f.close();}
});

test('without explicit internal activation, no collaboration guard is installed',async()=>{
  const f=await fixture();try{f.r.collaboration=undefined;assert.equal(f.r.collaboration,undefined);}finally{await f.close();}
});

test('desktop or unapproved handoffs fail before queueing',async()=>{
  const f=await fixture();try{
    f.routes.set(f.worker.id,{transport:'native-session',executionMode:'desktop'});
    assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Implement','desktop'),/managed/);
    f.routes.set(f.worker.id,{transport:'managed-cli',executionMode:'cli'});
    f.store.db.prepare("UPDATE task_contracts SET state='invalid' WHERE dispatch_id='wa:approve'").run();
    assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Implement','revoked'),/approved/);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM managed_collaboration_handoffs").get()?.n,0);
  }finally{await f.close();}
});

test('changed owner or target before source turn end fails closed without sending',async()=>{
  for(const mode of ['owner','target','authority']){
    const f=await fixture();try{
      if(mode==='authority')f.r.collaboration=f.collab=new ManagedCollaboration(f.r,{authorize:()=>undefined});
      if(mode==='authority'){assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Implement','unauthorized'),/authorize/);continue;}
      const id=f.collab.stage('wa:approve',f.worker.id,'Implement',`changed-${mode}`);
      if(mode==='owner')f.store.set('whatsapp-owner','new-owner@s.whatsapp.net');
      else f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.worker.id);
      f.sourceEnd.resolve();await until(()=>f.store.job(id)?.status==='failed');
      assert.equal(f.starts.filter(x=>x.id===id).length,0);
    }finally{await f.close();}
  }
});

test('an interrupted source turn never grants a handoff after restart',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','restart');
    // Recovery cannot manufacture the managed completion evidence.
    f.r.busy.clear();f.store.recover();f.r.pump();await turn();
    assert.equal(f.starts.filter(x=>x.id===id).length,0);
    assert.notEqual(f.store.job(id)?.status,'submitted');
  }finally{await f.close();}
});

test('held handoff does not block unrelated work for the target session',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','no-starvation');
    f.store.enqueue('wa:unrelated',f.worker,'Another owner task',f.owner);f.r.pump();
    await until(()=>f.starts.some(x=>x.id==='wa:unrelated'));
    assert.equal(f.starts.filter(x=>x.id===id).length,0);
  }finally{await f.close();}
});

test('a prior queued or uncertain item job prevents handoff staging',async()=>{
  for(const status of ['queued','uncertain']){
    const f=await fixture();try{
      const item=f.store.itemOf('wa:approve')!,existing=`master:prior:${status}`;
      f.store.enqueue(existing,f.worker,'Earlier work',f.owner);f.store.linkItem(existing,item);
      f.store.db.prepare('UPDATE inbox SET status=? WHERE id=?').run(status,existing);
      assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Implement',`blocked-${status}`),/active or uncertain/);
      assert.equal(f.store.db.prepare('SELECT count(*) n FROM managed_collaboration_handoffs').get()?.n,0);
    }finally{await f.close();}
  }
});

test('a queued later item follow-up does not prevent release after managed final',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','followup');f.sourceEnd.resolve();await until(()=>f.starts.some(x=>x.id===id));
    const later='wa:later';f.store.enqueue(later,f.worker,'Later follow-up',f.owner);f.store.linkItem(later,f.store.itemOf(id)!);
    f.r.channelReply(f.worker,'Implementation reported complete.','final',id);f.targetEnd.resolve();
    await until(()=>f.collab.history('wa:approve',f.store.itemOf(id)!)[0]?.state==='complete');
    await until(()=>f.starts.some(x=>x.id===later));
  }finally{await f.close();}
});

test('native readiness rechecks the claimed exact target before actual submission',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','readiness'),waiting=deferred(),started=deferred();let sent=0;
    const prior=f.native.run;
    f.native.store=f.store;f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id){started.resolve();await waiting.promise;}};
    f.native.managedRun=async()=>{sent++;};
    f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
    f.sourceEnd.resolve();await started.promise;
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.worker.id);waiting.resolve();
    await until(()=>f.store.job(id)?.status==='failed');assert.equal(sent,0);
  }finally{await f.close();}
});

test('a channel change during native readiness invalidates the old handoff',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','channel-hold'),waiting=deferred(),started=deferred();let sent=0,first=true;
    const prior=f.native.run;f.native.store=f.store;
    f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id&&first){first=false;started.resolve();await waiting.promise;}};
    f.native.managedRun=async()=>{sent++;};
    f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
    f.sourceEnd.resolve();await started.promise;f.store.set('control-channel','telegram');waiting.resolve();
    await until(()=>f.store.job(id)?.status==='queued'&&!f.r.busy.has(f.worker.id));assert.equal(sent,0);
    f.store.set('control-channel','whatsapp');f.r.pump();await until(()=>f.store.job(id)?.status==='failed');assert.equal(sent,0);
  }finally{await f.close();}
});

test('owner and channel changes away and back invalidate a staged handoff',async()=>{
  for(const mode of ['owner','channel']){
    const f=await fixture();try{
      const id=f.collab.stage('wa:approve',f.worker.id,'Implement',`roundtrip-${mode}`);
      if(mode==='owner'){f.store.set('whatsapp-owner','replacement@s.whatsapp.net');f.store.set('whatsapp-owner',f.owner);}
      else{f.store.set('control-channel','telegram');f.store.set('control-channel','whatsapp');}
      assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Implement',`roundtrip-${mode}`),/changed/);
      f.sourceEnd.resolve();await until(()=>f.store.job(id)?.status==='failed');
      assert.equal(f.starts.filter(x=>x.id===id).length,0,mode);
    }finally{await f.close();}
  }
});

test('a background-started source cannot stage after owner or channel changes away and back',async()=>{
  for(const mode of ['owner','channel']){
    const f=await fixture(true);try{
      if(mode==='owner'){f.store.set('whatsapp-owner','replacement@s.whatsapp.net');f.store.set('whatsapp-owner',f.owner);}
      else{f.store.set('control-channel','telegram');f.store.set('control-channel','whatsapp');}
      assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Implement',`prestage-${mode}`),/source owner connection changed/);
      assert.equal(f.starts.filter(x=>x.id.includes(':f5-')).length,0);
    }finally{await f.close();}
  }
});

test('an owner or channel roundtrip before background dispatch cannot authorize a later handoff',async()=>{
  for(const mode of ['owner','channel']){
    const f=await fixture(true,(s,owner)=>{
      if(mode==='owner'){s.set('whatsapp-owner','replacement@s.whatsapp.net');s.set('whatsapp-owner',owner);}
      else{s.set('control-channel','telegram');s.set('control-channel','whatsapp');}
    });try{
      assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Implement',`before-dispatch-${mode}`),/source owner connection changed/);
      assert.equal(f.starts.filter(x=>x.id.includes(':f5-')).length,0);
    }finally{await f.close();}
  }
});

test('a background-started source without a durable owner approval cannot stage a handoff',async()=>{
  const f=await fixture(true);try{
    f.store.db.prepare('DELETE FROM incoming_owner_inputs WHERE id=?').run('wa:approve');
    assert.throws(()=>f.collab.stage('wa:approve',f.worker.id,'Implement','legacy-source'),/cannot be verified/);
    assert.equal(f.starts.filter(x=>x.id.includes(':f5-')).length,0);
  }finally{await f.close();}
});

test('a stale owner context cannot stage a new handoff',async()=>{
  const f=await fixture();try{
    const captured=f.store.captureIncomingOwner(f.owner,'whatsapp')!;
    f.store.set('whatsapp-owner','replacement@s.whatsapp.net');f.store.set('whatsapp-owner',f.owner);
    assert.throws(()=>f.store.incomingOwnerContext.run(captured,()=>f.collab.stage('wa:approve',f.worker.id,'Implement','stale-context')),/owner connection changed/);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM managed_collaboration_handoffs').get()?.n,0);
  }finally{await f.close();}
});

test('an owner roundtrip while readiness is pending prevents provider submission',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','readiness-owner'),waiting=deferred(),started=deferred();let sent=0;
    const prior=f.native.run;f.native.store=f.store;
    f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id){started.resolve();await waiting.promise;}};
    f.native.managedRun=async()=>{sent++;};
    f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
    f.sourceEnd.resolve();await started.promise;
    f.store.set('whatsapp-owner','replacement@s.whatsapp.net');f.store.set('whatsapp-owner',f.owner);
    waiting.resolve();await until(()=>f.store.job(id)?.status==='failed');assert.equal(sent,0);
    assert.ok(f.store.db.prepare('SELECT token FROM collaboration_claims WHERE item_id=?').get(f.store.itemOf(id)!)?.token);
  }finally{await f.close();}
});

test('an owner roundtrip after submission cannot release the claim',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','release-owner');f.sourceEnd.resolve();await until(()=>f.starts.some(x=>x.id===id));
    f.store.set('whatsapp-owner','replacement@s.whatsapp.net');f.store.set('whatsapp-owner',f.owner);
    f.r.channelReply(f.worker,'Done','final',id);f.targetEnd.resolve();await until(()=>!f.r.busy.has(f.worker.id));
    assert.ok(f.store.db.prepare('SELECT token FROM collaboration_claims WHERE item_id=?').get(f.store.itemOf(id)!)?.token);
    assert.equal(f.store.db.prepare('SELECT state FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.state,'claimed');
  }finally{await f.close();}
});

test('a dispatch failure rolls back both the claim and the attempt',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','atomic');
    f.store.jobState('wa:approve','submitted');
    f.collab.managedTurnEnded('wa:approve',f.proxy,f.store.job('wa:approve')!.attempt_id!);f.r.busy.delete(f.proxy.id);
    f.store.db.exec(`CREATE TRIGGER fail_test_dispatch BEFORE INSERT ON request_events
      WHEN NEW.event='dispatched' AND NEW.request_id LIKE '%:f5-%'
      BEGIN SELECT RAISE(ABORT,'test-atomic-failure'); END`);
    assert.throws(()=>f.r.pump(),/test-atomic-failure/);
    assert.equal(f.store.job(id)?.status,'queued');
    const exists=f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_claims'").get();
    if(exists)assert.equal(f.store.db.prepare('SELECT count(*) n FROM collaboration_claims').get()?.n,0);
    assert.equal(f.store.db.prepare('SELECT state FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.state,'waiting');
    assert.equal(f.starts.filter(x=>x.id===id).length,0);
  }finally{await f.close();}
});

test('identity or authorization changes during asynchronous readiness never submit',async()=>{
  for(const mode of ['source','owner','target-route','contract','authority','item-status','other-active']){
    const f=await fixture();try{
      let allowed=true;f.r.collaboration=f.collab=new ManagedCollaboration(f.r,{authorize:()=>allowed?'test-approval':undefined});
      const id=f.collab.stage('wa:approve',f.worker.id,'Implement',`async-${mode}`),waiting=deferred(),started=deferred();let sent=0;
      const prior=f.native.run;f.native.store=f.store;
      f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id){started.resolve();await waiting.promise;}};
      f.native.managedRun=async()=>{sent++;};
      f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
      f.sourceEnd.resolve();await started.promise;
      if(mode==='source')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.proxy.id);
      if(mode==='owner')f.store.set('whatsapp-owner','new-owner@s.whatsapp.net');
      if(mode==='target-route')f.routes.set(f.worker.id,{transport:'native-session',executionMode:'desktop'});
      if(mode==='contract')f.store.db.prepare("UPDATE task_contracts SET state='invalid' WHERE dispatch_id='wa:approve'").run();
      if(mode==='authority')allowed=false;
      if(mode==='item-status')f.store.db.prepare("UPDATE items SET status='blocked' WHERE id=?").run(f.store.itemOf(id));
      if(mode==='other-active'){
        f.store.enqueue('wa:external',f.proxy,'Conflicting work',f.owner);f.store.linkItem('wa:external',f.store.itemOf(id)!);
        f.store.jobState('wa:external','submitted');
      }
      waiting.resolve();await until(()=>f.store.job(id)?.status==='failed');assert.equal(sent,0,mode);
      assert.equal(f.store.db.prepare('SELECT state FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.state,'invalid');
    }finally{await f.close();}
  }
});

test('a real database reopen does not replay an interrupted managed handoff',async()=>{
  for(const phase of ['source','target']){
    const f=await fixture();let reopened:InstanceType<typeof Store>|undefined;try{
      const id=f.collab.stage('wa:approve',f.worker.id,'Implement',`reopen-${phase}`);
      if(phase==='target'){f.sourceEnd.resolve();await until(()=>f.starts.some(x=>x.id===id));}
      f.r.stopped=true;
      reopened=new Store(join(f.dir,'test.sqlite'));reopened.recover();
      let deliveries=0;const n:any={connections:{route:(b:any)=>f.routes.get(b.id)},stop:()=>{},run:async()=>{deliveries++;}};
      const a=new Approvals(reopened),r=new Router(reopened,n,a),c=new Coordinator(reopened,n,r,()=>{});r.coordinator=c;
      const secret=new MetaSecret(f.dir);r.contracts=new TaskContracts(reopened,secret);
      r.collaboration=new ManagedCollaboration(r,{authorize:()=> 'test-approval'});r.pump();await turn();
      assert.equal(deliveries,0,phase);
      if(phase==='target')assert.equal(reopened.job(id)?.status,'uncertain');
      else assert.notEqual(reopened.job(id)?.status,'submitted');
      r.stopped=true;a.cancel();
    }finally{reopened?.close();await f.close();}
  }
});

test('an unsent readiness failure releases only its own claim and a new attempt can run',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','first-fails'),waiting=deferred(),started=deferred();let sent=0;
    const prior=f.native.run;f.native.store=f.store;
    f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id){started.resolve();await waiting.promise;}};
    f.native.managedRun=async()=>{sent++;};
    f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
    f.sourceEnd.resolve();await started.promise;
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.worker.id);
    waiting.resolve();await until(()=>f.store.job(id)?.status==='failed'&&!f.r.busy.has(f.worker.id));
    assert.equal(sent,0);
    const claim=f.store.db.prepare('SELECT holder_id,token FROM collaboration_claims WHERE item_id=?').get(f.store.itemOf(id)!);
    assert.equal(claim?.holder_id,null);assert.equal(claim?.token,null);
    // The owner unblocks the item and starts a new authorized source turn.
    f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(f.worker.native_id,f.worker.id);
    f.store.db.prepare("UPDATE items SET status='in progress' WHERE id=?").run(f.store.itemOf(id)!);
    f.store.jobState('wa:approve','dispatched');f.r.busy.add(f.proxy.id);
    const retry=f.collab.stage('wa:approve',f.worker.id,'Implement','retry');
    f.store.jobState('wa:approve','submitted');f.collab.managedTurnEnded('wa:approve',f.proxy,f.store.job('wa:approve')!.attempt_id!);f.r.busy.delete(f.proxy.id);
    f.r.pump();for(let n=0;n<10;n++)await turn();
    assert.ok(f.starts.some(x=>x.id===retry),JSON.stringify({job:f.store.job(retry),handoff:f.store.db.prepare('SELECT state,yielded FROM managed_collaboration_handoffs WHERE job_id=?').get(retry)}));
    assert.equal(f.starts.filter(x=>x.id===retry).length,1);
  }finally{await f.close();}
});

test('an old rejected handoff cannot release a different fenced claim',async()=>{
  const f=await fixture();try{
    const id=f.collab.stage('wa:approve',f.worker.id,'Implement','fence'),waiting=deferred(),started=deferred();
    const prior=f.native.run;f.native.store=f.store;
    f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id){started.resolve();await waiting.promise;}};
    f.native.managedRun=async()=>{throw new Error('should not submit');};
    f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
    f.sourceEnd.resolve();await started.promise;
    const newer=randomUUID();f.store.db.prepare('UPDATE collaboration_claims SET token=?,generation=generation+1 WHERE item_id=?').run(newer,f.store.itemOf(id)!);
    waiting.resolve();await until(()=>f.store.job(id)?.status==='failed');
    assert.equal(f.store.db.prepare('SELECT token FROM collaboration_claims WHERE item_id=?').get(f.store.itemOf(id)!)?.token,newer);
  }finally{await f.close();}
});

test('a provider-bound failure remains uncertain and retains its exact claim',async()=>{
  for(const error of [new Error('provider connection dropped'),new DispatchNotSubmittedError('provider supplied misleading error')]){
    const f=await fixture();try{
      const id=f.collab.stage('wa:approve',f.worker.id,'Implement','uncertain');let calls=0;
      const prior=f.native.run;f.native.store=f.store;f.native.connections.assert=async()=>{};
      f.native.managedRun=async()=>{calls++;throw error;};
      f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
      f.sourceEnd.resolve();await until(()=>f.store.job(id)?.status==='uncertain');
      const before=f.store.db.prepare('SELECT holder_id,token,generation FROM collaboration_claims WHERE item_id=?').get(f.store.itemOf(id)!);
      assert.equal(calls,1);assert.equal(before?.holder_id,f.worker.id);assert.ok(before?.token);
      f.collab.reject(id,'not proven');
      assert.deepEqual(f.store.db.prepare('SELECT holder_id,token,generation FROM collaboration_claims WHERE item_id=?').get(f.store.itemOf(id)!),before);
      assert.equal(f.store.job(id)?.status,'uncertain');
      assert.equal(f.store.db.prepare('SELECT state,submission_started FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.submission_started,1);
      f.r.pump();await turn();assert.equal(calls,1);
    }finally{await f.close();}
  }
});

test('restart releases only a proven unsent exact attempt and never replays a handoff',async()=>{
  for(const phase of ['before','after','legacy','other-fence','owner-roundtrip','legacy-owner','missing-origin','changed-origin']){
    const f=await fixture();let reopened:InstanceType<typeof Store>|undefined;try{
      const id=f.collab.stage('wa:approve',f.worker.id,'Implement',`recovery-${phase}`),ready=deferred(),started=deferred(),providerEnd=deferred();let calls=0;
      const prior=f.native.run;f.native.store=f.store;
      f.native.connections.assert=async(b:any)=>{if(b.id===f.worker.id&&phase!=='after'){started.resolve();await ready.promise;}};
      f.native.managedRun=async()=>{calls++;started.resolve();await providerEnd.promise;};
      f.native.run=async(b:any,body:string,jobId:string)=>jobId===id?NativeAgents.prototype.run.call(f.native,b,body,jobId):prior(b,body,jobId);
      f.sourceEnd.resolve();await started.promise;f.r.stopped=true;
      const item=f.store.itemOf(id)!;
      if(phase==='legacy')f.store.db.exec('ALTER TABLE managed_collaboration_handoffs DROP COLUMN submission_started');
      if(phase==='other-fence')f.store.db.prepare('UPDATE collaboration_claims SET token=?,generation=generation+1 WHERE item_id=?').run(randomUUID(),item);
      if(phase==='owner-roundtrip'){f.store.set('whatsapp-owner','replacement@s.whatsapp.net');f.store.set('whatsapp-owner',f.owner);}
      if(phase==='legacy-owner')f.store.db.exec('ALTER TABLE managed_collaboration_handoffs DROP COLUMN owner_generation');
      if(phase==='missing-origin')f.store.db.prepare('DELETE FROM incoming_owner_inputs WHERE id=?').run('wa:approve');
      if(phase==='changed-origin')f.store.db.prepare('UPDATE incoming_owner_inputs SET generation=? WHERE id=?').run('different-generation','wa:approve');
      reopened=new Store(join(f.dir,'test.sqlite'));reopened.recover();
      let replayed=0;const n:any={connections:{route:(b:any)=>f.routes.get(b.id)},stop:()=>{},run:async()=>{replayed++;}};
      const a=new Approvals(reopened),r=new Router(reopened,n,a),c=new Coordinator(reopened,n,r,()=>{});r.coordinator=c;
      const secret=new MetaSecret(f.dir);r.contracts=new TaskContracts(reopened,secret);
      r.collaboration=new ManagedCollaboration(r,{authorize:()=> 'test-approval'});r.pump();await turn();
      const claim=reopened.db.prepare('SELECT holder_id,token FROM collaboration_claims WHERE item_id=?').get(item);
      if(phase==='before'){
        assert.equal(reopened.job(id)?.status,'failed');assert.equal(claim?.holder_id,null);assert.equal(claim?.token,null);
        assert.equal(reopened.db.prepare('SELECT state FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.state,'invalid');
      }else{
        assert.equal(reopened.job(id)?.status,'uncertain',phase);assert.ok(claim?.token,phase);
        assert.equal(reopened.db.prepare('SELECT state FROM managed_collaboration_handoffs WHERE job_id=?').get(id)?.state,'claimed');
      }
      assert.equal(replayed,0);assert.equal(calls,phase==='after'?1:0);
      r.stopped=true;a.cancel();reopened.close();reopened=undefined;
      ready.resolve();providerEnd.resolve();await turn();
      assert.equal(calls,phase==='after'?1:0,`old process must not submit after ${phase} recovery`);
    }finally{reopened?.close();await f.close();}
  }
});
