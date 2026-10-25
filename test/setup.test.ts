import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { Approvals } from '../src/approvals.js';
import { WhatsApp,ownerOnlyGroup } from '../src/whatsapp.js';
import { PowerPolicy } from '../src/power.js';

const owner='123@s.whatsapp.net',group='456@g.us';
function fixture() {
  const store=new Store(':memory:');store.set('whatsapp-owner',owner);
  const approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals),wa=new WhatsApp(store,router);
  wa.status='connected';wa.selfJid=owner;wa.owners=[owner,'789@lid'];
  return {store,router,wa,approvals,close:()=>{wa.close();approvals.cancel();store.close();}};
}
test('group membership rejects strangers and empty/malformed membership',()=>{
  assert.equal(ownerOnlyGroup({participants:[{id:'123:2@s.whatsapp.net'}]},[owner]),true);
  assert.equal(ownerOnlyGroup({participants:[{id:'789@lid',phoneNumber:owner}]},[owner]),true);
  assert.equal(ownerOnlyGroup({participants:[{id:owner},{id:'999@s.whatsapp.net'}]},[owner]),false);
  assert.equal(ownerOnlyGroup({participants:[]},[owner]),false);
  assert.equal(ownerOnlyGroup({},[owner]),false);
});
test('group creation has a single durable operation and never invites others',async()=>{
  const f=fixture();let calls=0;
  f.wa.sock={end:()=>{},groupCreate:async(name:string,members:string[])=>{calls++;assert.deepEqual(members,[]);return {id:group,subject:name};},groupMetadata:async()=>({participants:[{id:owner}]})} as any;
  const id='11111111-1111-4111-a111-111111111111';
  await f.wa.createGroup('My bridge',id);await f.wa.createGroup('My bridge',id);
  assert.equal(calls,1);assert.equal(f.wa.destination().jid,group);f.close();
});
test('ambiguous group creation cannot be automatically repeated',async()=>{
  const f=fixture();let calls=0;
  f.wa.sock={end:()=>{},groupCreate:async()=>{calls++;throw new Error('lost receipt');}} as any;
  await assert.rejects(f.wa.createGroup('Bridge','11111111-1111-4111-a111-111111111111'));
  await assert.rejects(f.wa.createGroup('Bridge','22222222-2222-4222-a222-222222222222'),/unconfirmed/);
  assert.equal(calls,1);assert.equal(f.wa.destination().jid,owner);f.close();
});
test('queued messages and late replies retain the original destination after switching',async()=>{
  const f=fixture();const b=f.store.register('test','codex','11111111-1111-4111-a111-111111111111','/tmp').binding;
  f.store.set('destination-jid',owner);
  f.store.enqueue('wa:original',b,'work');f.store.output(b,'before','before');
  f.store.set('destination-jid',group);
  f.router.channelReply(b,'after','final','wa:original','after');
  assert.deepEqual(f.store.db.prepare('SELECT destination FROM outbox').all().map((r:any)=>r.destination),[owner,owner]);
  await Promise.all([owner,group].map(dest=>f.store.destinationContext.run(dest,async()=>{await Promise.resolve();f.store.output(undefined,'concurrent',dest);})));
  assert.equal(f.store.db.prepare('SELECT destination FROM outbox WHERE source=?').get(group+':0')?.destination,group);
  f.close();
});
test('outbound group delivery is held if another member joins',async()=>{
  const f=fixture();let sent=0;f.store.set(`owned-group:${group}`,'Bridge');f.store.set('destination-jid',group);f.store.output(undefined,'private','event');
  f.wa.sock={end:()=>{},groupMetadata:async()=>({participants:[{id:owner},{id:'999@s.whatsapp.net'}]}),sendMessage:async()=>{sent++;}} as any;
  await f.wa.flush();assert.equal(sent,0);assert.match(f.wa.error!,/paused/);
  assert.equal(f.store.db.prepare('SELECT status FROM outbox').get()?.status,'queued');f.close();
});
test('keep-awake requires opt-in and releases when background permission is removed',async()=>{
  const f=fixture();let starts=0,kills=0;
  const power=new PowerPolicy(f.store,f.router,f.wa,()=>{starts++;return Object.assign(new EventEmitter(),{kill:()=>{kills++;}}) as any;});
  power.apply();assert.equal(starts,0);
  await power.update(true,true);assert.equal(starts,1);power.apply();assert.equal(starts,1);
  await power.update(false,true);assert.equal(kills,1);assert.equal(power.view().keepAwake,false);assert.equal(f.router.stopped,true);assert.equal(f.wa.closed,true);
  power.close();f.close();
});
test('fresh installation does not grant background permission implicitly',()=>{
  const s=new Store(':memory:');const router={stopped:false} as any,wa={} as any;
  const power=new PowerPolicy(s,router,wa);assert.equal(power.enabled,false);assert.equal(router.stopped,true);assert.equal(power.view().keepAwake,false);s.close();
});
test('pausing during a membership check leaves outbound delivery queued',async()=>{
  const f=fixture();let sent=0;
  f.store.set(`owned-group:${group}`,'Bridge');f.store.set('destination-jid',group);f.store.output(undefined,'private','pause-race');
  f.wa.sock={end:()=>{},groupMetadata:async()=>{f.wa.close();return {participants:[{id:owner}]};},sendMessage:async()=>{sent++;}} as any;
  await f.wa.flush();assert.equal(sent,0);assert.equal(f.store.db.prepare('SELECT status FROM outbox').get()?.status,'queued');f.close();
});
test('group recovery only lists registered or matching owner-only groups',async()=>{
  const f=fixture();f.store.set('group-operation',JSON.stringify({id:'attempt',name:'Bridge',status:'uncertain'}));
  f.wa.sock={end:()=>{},groupFetchAllParticipating:async()=>({a:{id:group,subject:'Bridge',participants:[{id:owner}]},b:{id:'999@g.us',subject:'Bridge',participants:[{id:owner},{id:'999@s.whatsapp.net'}]}}),groupMetadata:async()=>({participants:[{id:owner}]})} as any;
  assert.deepEqual(await f.wa.recoverGroups(),[{id:group,name:'Bridge'}]);await f.wa.selectDestination(group);
  assert.equal(JSON.parse(f.store.get('group-operation')!).status,'created');f.close();
});


test('an exited keep-awake assertion can be re-established while consent remains on',async()=>{
  const f=fixture();const children:EventEmitter[]=[];
  const power=new PowerPolicy(f.store,f.router,f.wa,()=>{const c=Object.assign(new EventEmitter(),{kill:()=>{}});children.push(c);return c as any;});
  await power.update(true,true);children[0].emit('exit');assert.equal(power.view().assertionActive,false);
  power.apply();assert.equal(children.length,2);assert.equal(power.view().assertionActive,true);assert.equal(power.error,undefined);
  await power.update(true,false);power.apply();assert.equal(children.length,2);power.close();f.close();
});


test('phone display uses only a normalized phone JID, never a WhatsApp LID',()=>{
  const f=fixture();f.wa.selfJid='15551234567:4@s.whatsapp.net';assert.equal(f.wa.phoneNumber(),'+15551234567');
  f.wa.selfJid='15551234567@lid';assert.equal(f.wa.phoneNumber(),undefined);
  f.wa.status='logged out';assert.equal(f.wa.phoneNumber(),undefined);f.close();
});
test('logout waits for pending auth writes, clears only auth and retains owner and request history',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'wsb-logout-')),auth=join(dir,'auth');mkdirSync(auth);
  writeFileSync(join(auth,'creds.json'),'test credential');writeFileSync(join(dir,'history'),'keep');
  const wa=new WhatsApp(f.store,f.router,auth);wa.status='connected';wa.selfJid=owner;wa.owners=[owner];
  let unlinked=0,closed=0;wa.sock={logout:async()=>{unlinked++;},end:()=>{closed++;}} as any;
  let finish:()=>void=()=>{};wa.authWrites.add(new Promise<void>(r=>{finish=r;}));
  const promise=wa.logout();await new Promise(r=>setTimeout(r,5));assert.equal(existsSync(auth),true);
  finish();await promise;assert.equal(unlinked,1);assert.equal(closed,1);assert.equal(existsSync(auth),false);
  assert.equal(existsSync(join(dir,'history')),true);assert.equal(f.store.get('whatsapp-owner'),owner);
  assert.equal(wa.status,'logged out');assert.equal(wa.sock,undefined);assert.equal(wa.owners.length,0);assert.equal(wa.reconnect,undefined);
  await assert.rejects(wa.logout(),/Reconnect/);f.close();rmSync(dir,{recursive:true});
});
test('failed remote logout retains local credentials and reports a useful error',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'wsb-logout-fail-'));writeFileSync(join(dir,'creds.json'),'test credential');
  const wa=new WhatsApp(f.store,f.router,dir);wa.status='connected';wa.sock={logout:async()=>{throw new Error('private diagnostic');},end:()=>{}} as any;
  await assert.rejects(wa.logout(),/Logout could not finish/);assert.equal(existsSync(join(dir,'creds.json')),true);assert.equal(wa.loggingOut,false);
  wa.close();f.close();rmSync(dir,{recursive:true});
});
