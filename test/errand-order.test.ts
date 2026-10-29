import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {proto} from '@whiskeysockets/baileys';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {WhatsApp} from '../src/whatsapp.js';
import {ErrandMissions,errandBindingIdentity,type Listing} from '../src/errand-missions.js';

test('real WhatsApp ingress ordering precedes async group checks and delayed routing',async()=>{
  const owner='123@s.whatsapp.net',group='owner-only@g.us',store=new Store(':memory:'),approvals=new Approvals(store);
  const router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);router.pump=()=>{};
  store.set('whatsapp-owner',owner);store.set('destination-jid',group);store.set(`owned-group:${group}`,'Owner only');
  const binding=store.register('errand-test','codex',randomUUID(),'/tmp').binding;store.set('active',binding.id);
  const wa=new WhatsApp(store,router);wa.status='connected';wa.selfJid=owner;wa.owners=[owner];
  try{
    store.recordOwnerOrigin('wa:root',group,owner);store.enqueue('wa:root',binding,'find jobs',group);
    const root={requestId:'wa:root',owner,destination:group,bindingId:binding.id,bindingIdentity:errandBindingIdentity(store,binding)};
    const listing:Listing={sourceUrl:'https://jobs.example.com/board',url:'https://jobs.example.com/job',title:'Developer',excerpt:'Remote',observedAt:Date.now(),sourceHash:'a'.repeat(64),workplace:'unknown',verification:'public-listing-verified'};
    const ledger=new ErrandMissions(store,()=>true,async()=>[listing],async items=>items.map(x=>x.id));
    const mission=ledger.begin(root,{role:'Developer',location:'Bangalore'});
    await ledger.gather(mission,root,{},new AbortController().signal);await ledger.shortlist(mission,root,new AbortController().signal);
    store.output(binding,ledger.shortlistText(mission,root),`errand-shortlist:${mission}`,group,{plain:true,requestId:root.requestId,kind:'system',origin:'system'});
    const outbox=store.db.prepare('SELECT id,wa_id FROM outbox WHERE source=?').get(`errand-shortlist:${mission}:0`) as {id:string;wa_id:string};
    ledger.bindShortlistMessage(mission,root,outbox.id);
    let resume!:()=>void;const verifying=new Promise<void>(resolve=>{resume=resolve;});wa.verifyGroup=async()=>verifying;
    const message=(id:string)=>({key:{id,fromMe:true,remoteJid:group},message:{conversation:'draft 1'}});
    const early=wa.receiveMessage(message('early'));
    assert.equal(wa.receiveMessageUpdate({id:outbox.wa_id,remoteJid:group,fromMe:true},proto.WebMessageInfo.Status.DELIVERY_ACK),true);
    assert.equal(store.db.prepare("SELECT 1 FROM errand_transport_order WHERE kind='delivery' AND ref=?").get(outbox.id),undefined);
    assert.equal(wa.receiveReceipt({id:outbox.wa_id,remoteJid:group,fromMe:true},proto.WebMessageInfo.Status.DELIVERY_ACK,true),true);
    assert.ok(store.db.prepare("SELECT 1 FROM errand_transport_order WHERE kind='delivery' AND ref=?").get(outbox.id));
    store.sent(outbox.id);
    resume();await early;
    const scope={requestId:'wa:early',owner,destination:group,bindingId:binding.id,bindingIdentity:errandBindingIdentity(store,binding)};
    assert.ok(store.job(scope.requestId));assert.equal(wa.errandOrder.after(scope,outbox.id),false);
    wa.verifyGroup=async()=>{};await wa.receiveMessage(message('late'));
    assert.equal(wa.errandOrder.after({...scope,requestId:'wa:late'},outbox.id),true);
    store.set('whatsapp-owner','other@s.whatsapp.net');assert.equal(wa.errandOrder.after({...scope,requestId:'wa:late'},outbox.id),false);
  }finally{wa.close();approvals.cancel();store.close();}
});
