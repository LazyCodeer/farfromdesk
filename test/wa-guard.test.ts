import test from 'node:test';
import assert from 'node:assert/strict';
import { GuardedSocket } from '../src/wa-guard.js';

const ME='123@s.whatsapp.net',GROUP='mine@g.us';
function fixture() {
  const sent:any[]=[],handlers:Record<string,(d:any)=>void>={};
  const raw:any={user:{id:'123:7@s.whatsapp.net'},
    ev:{on:(e:string,h:any)=>{handlers[e]=h;}},
    sendMessage:async(jid:string,c:any)=>{sent.push(['send',jid,c]);return {};},
    relayMessage:async(jid:string)=>{sent.push(['relay',jid]);return 'id';},
    groupMetadata:async(jid:string)=>({id:jid,participants:[{id:ME}]}),
    groupCreate:async(_s:string,p:string[])=>{sent.push(['create',p]);return {id:'new@g.us'};},
    groupFetchAllParticipating:async()=>({[GROUP]:{id:GROUP,subject:'Mine',participants:[{id:ME}]},'family@g.us':{id:'family@g.us',subject:'Family',participants:[{id:ME},{id:'999@s.whatsapp.net'}]}}),
    refreshMediaConn:async()=>({hosts:[]}),logout:async()=>{},end:()=>{}};
  const sock=new GuardedSocket(raw,{owners:()=>[ME],ownedGroup:j=>j===GROUP});
  return {sock,sent,handlers};
}
const msg=(remoteJid:string,fromMe=true)=>({key:{id:'x',remoteJid,fromMe},message:{conversation:'hi'}});

test('incoming messages from other chats or other people never reach the app',()=>{
  const f=fixture(),seen:any[]=[];
  f.sock.ev.on('messages.upsert',e=>seen.push(...e.messages));
  f.handlers['messages.upsert']({type:'notify',messages:[msg(ME),msg(GROUP),msg('999@s.whatsapp.net'),msg('family@g.us'),msg(GROUP,false),msg(ME,false)]});
  assert.deepEqual(seen.map(m=>m.key.remoteJid),[ME,GROUP]);
  const receipts:any[]=[];f.sock.ev.on('messages.update',u=>receipts.push(...u));
  f.handlers['messages.update']([{key:{remoteJid:'family@g.us',fromMe:true}},{key:{remoteJid:ME,fromMe:true}}]);
  assert.equal(receipts.length,1);
  assert.throws(()=>f.sock.ev.on('chats.upsert' as any,()=>{}),/Blocked WhatsApp event/);
});

test('sending, relaying and group lookups outside your chat and your group are blocked',async()=>{
  const f=fixture();
  await f.sock.sendMessage(ME,{text:'ok'},{messageId:'1'});await f.sock.sendMessage(GROUP,{text:'ok'},{messageId:'2'});
  assert.throws(()=>f.sock.sendMessage('999@s.whatsapp.net',{text:'x'},{messageId:'3'}),/only sends to your own chat/);
  assert.throws(()=>f.sock.sendMessage('family@g.us',{text:'x'},{messageId:'4'}),/only sends to your own chat/);
  assert.throws(()=>f.sock.relayMessage('family@g.us',{} as any,{messageId:'5'}),/only sends/);
  assert.throws(()=>f.sock.sendMessage(ME,{text:'x',forward:{}} as any,{messageId:'6'}),/only text and documents/);
  assert.throws(()=>f.sock.groupMetadata('family@g.us'),/not registered/);
  assert.throws(()=>f.sock.groupCreate('Team',['999@s.whatsapp.net']),/just you/);
  assert.deepEqual(f.sent.map(s=>s[1]),[ME,GROUP]);
});

test('group listing only ever returns groups where you are the only member',async()=>{
  const f=fixture();
  assert.deepEqual(Object.keys(await f.sock.groupFetchAllParticipating()),[GROUP]);
  assert.equal((f.sock as any).raw,undefined);assert.equal((f.sock as any).readMessages,undefined);
  assert.equal((f.sock as any).chatModify,undefined);
});
