import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {inboxSessions,inboxThread} from '../src/inbox-view.js';

function fixture() {
 const store=new Store(':memory:');
 const binding=store.register('voice-session','claude',randomUUID(),'/tmp').binding;
 const audio=(id:string,destination:string)=>store.db.prepare('INSERT INTO audio_inbox VALUES(?,?,?,?)').run(id,destination,'routing_blocked',100);
 return {store,binding,audio};
}
test('orphan WhatsApp routing failures show and search their exact recorded command error',()=>{
 const f=fixture();try {
  f.audio('wa:blocked','owner-chat');
  f.store.output(undefined,'Exact routing failure for owner','command-error:wa:blocked','owner-chat');
  const message=inboxThread(f.store,'unassigned-voice').messages.find(m=>m.requestId==='wa:blocked');
  assert.match(message.text,/Exact routing failure for owner/);
  assert.ok(inboxSessions(f.store,'exact routing failure').sessions.some(s=>s.id==='unassigned-voice'));
 }finally{f.store.close();}
});
test('orphan error from another destination is never displayed or searchable',()=>{
 const f=fixture();try {
  f.audio('wa:collision','chat-b');
  f.store.output(undefined,'Private unrelated diagnostic phrase','command-error:wa:collision','chat-a');
  const message=inboxThread(f.store,'unassigned-voice').messages.find(m=>m.requestId==='wa:collision');
  assert.match(message.text,/recorded cause is unavailable/i);
  assert.doesNotMatch(message.text,/Private unrelated|Open Details/i);
  assert.equal(inboxSessions(f.store,'private unrelated diagnostic phrase').sessions.some(s=>s.id==='unassigned-voice'),false);
 }finally{f.store.close();}
});
test('linked voice failures correlate unlinked and linked command-error replies without changing plain errors',()=>{
 const f=fixture();try {
  f.store.enqueue('wa:voice',f.binding,'Voice text','owner-chat');f.audio('wa:voice','owner-chat');
  f.store.output(undefined,'Voice routing denied','command-error:wa:voice','owner-chat');
  f.store.enqueue('wa:voice-linked',f.binding,'Other voice','owner-chat');f.audio('wa:voice-linked','owner-chat');
  f.store.output(undefined,'Linked voice routing denied','command-error:wa:voice-linked','owner-chat',{requestId:'wa:voice-linked',kind:'system'});
  f.store.enqueue('wa:plain',f.binding,'Text only','owner-chat');
  f.store.output(undefined,'Ordinary command error','command-error:wa:plain','owner-chat',{requestId:'wa:plain',kind:'system'});
  f.store.enqueue('wa:linked-wrong',f.binding,'Linked voice','owner-chat');f.audio('wa:linked-wrong','owner-chat');
  f.store.output(undefined,'Other destination sensitive text','command-error:wa:linked-wrong','other-chat');
  const messages=inboxThread(f.store,f.binding.id).messages;
  assert.equal(messages.filter(m=>m.requestId==='wa:voice'&&m.kind==='voice-failed').length,1);
  assert.equal(messages.filter(m=>m.requestId==='wa:voice-linked'&&m.kind==='voice-failed').length,1);
  assert.equal(messages.find(m=>m.requestId==='wa:plain'&&m.text.includes('Ordinary command error'))?.kind,'system');
  assert.ok(inboxSessions(f.store,'voice routing denied').sessions.some(s=>s.id===f.binding.id));
  assert.equal(messages.some(m=>m.text.includes('Other destination sensitive text')),false);
  assert.equal(inboxSessions(f.store,'other destination sensitive text').sessions.some(s=>s.id===f.binding.id),false);
 }finally{f.store.close();}
});
