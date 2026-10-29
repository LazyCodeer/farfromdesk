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
import {Coordinator} from '../src/coordinator.js';
import {MetaBrain} from '../src/meta-brain.js';
import {DEFAULT_BRAIN,MetaSecret,saveBrainConfig} from '../src/meta-brain-config.js';
import {TaskContracts} from '../src/task-contracts.js';
import {ErrandWorkflow} from '../src/errand-workflow.js';
import {WhatsApp} from '../src/whatsapp.js';
import {GuardedSocket} from '../src/wa-guard.js';
import type {Listing} from '../src/errand-missions.js';

test('synthetic WhatsApp text through the Meta memory tool grounds an owner-only draft',async()=>{
  if(process.platform==='win32')return;
  const root=mkdtempSync(join(tmpdir(),'ffd-profile-e2e-')),store=new Store(':memory:'),approvals=new Approvals(store),owner='123@s.whatsapp.net';
  const native={run:async()=>{},stop:()=>{},catalog:async()=>({sessions:[]})},router=new Router(store,native as any,approvals);
  let wa:WhatsApp|undefined;
  try{
    store.set('whatsapp-owner',owner);const binding=store.register('jobs','codex',randomUUID(),'/tmp').binding;store.set('active',binding.id);
    const coordinator=new Coordinator(store,native as any,router,()=>{});router.coordinator=coordinator;coordinator.registry.register(binding);router.pump=()=>{};
    const secret=new MetaSecret(root);secret.save('synthetic-test-key-never-a-real-key');
    saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,taskContracts:false,enabled:true,allowRouting:true,failure:'block',providers:['codex']}});
    router.contracts=new TaskContracts(store,secret,async()=>({kind:'pass',goal:'',exclusions:[],checks:[],question:''}));
    router.brain=new MetaBrain(store,secret,{interpret:async(_key,_policy,input,tool)=>{
      tool!({command:'insert',path:'about-me.md',insert_text:`- ${input.original}`});
      return {intent:'chat',normalized:'',provider:'unspecified',taskIds:[],reply:'Saved.'} as any;
    }});
    const listing:Listing={sourceUrl:'https://jobs.example.com/board',url:'https://jobs.example.com/job',title:'Flutter Engineer',excerpt:'Flutter Engineer',observedAt:Date.now(),sourceHash:'a'.repeat(64),workplace:'unknown',verification:'public-listing-published',applicationDeadline:Date.now()+60000};
    router.errands=new ErrandWorkflow(router,async()=>[listing],async rows=>rows.map(x=>x.id));
    const sent:any[]=[];wa=new WhatsApp(store,router);wa.sock=new GuardedSocket({sendMessage:async(jid:string,content:any)=>{sent.push({jid,content});return {message:{conversation:content.text}};},end:()=>{}} as any,{owners:()=>[owner],ownedGroup:()=>false});wa.status='connected';wa.selfJid=owner;wa.owners=[owner];
    const msg=(id:string,text:string)=>({key:{id,fromMe:true,remoteJid:owner},message:{conversation:text}}),fact='I built a synthetic Flutter prototype.';
    await wa.receiveMessage(msg('memory',fact));
    assert.ok(store.db.prepare('SELECT 1 FROM errand_profile_inputs WHERE request_id=?').get('wa:memory'));
    assert.equal((store.db.prepare("SELECT source FROM owner_memory_history WHERE path='about-me.md' ORDER BY id DESC LIMIT 1").get() as {source:string}).source,'brain:wa:memory');
    await wa.receiveMessage(msg('root','greenhouse jobs; board=example; role=Flutter; location=Bangalore'));await wa.flush();
    const shortlist=store.db.prepare("SELECT wa_id FROM outbox WHERE source LIKE 'errand-shortlist:%'").get() as {wa_id:string};
    wa.receiveMessageUpdate({id:shortlist.wa_id,remoteJid:owner,fromMe:true},proto.WebMessageInfo.Status.DELIVERY_ACK);
    await wa.receiveMessage(msg('choice','draft 1'));await wa.flush();
    assert.ok(sent.some(x=>x.jid===owner&&String(x.content.text).includes(`- ${fact}`)&&String(x.content.text).includes('Application answer starters')));
  }finally{wa?.close();approvals.cancel();store.close();rmSync(root,{recursive:true,force:true});}
});
