import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { OwnerReplyPolicy,replyFindings } from '../src/owner-reply-policy.js';

function fixture() {
  const store=new Store(':memory:'),policy=new OwnerReplyPolicy(store);
  const master=store.register('master','codex','11111111-1111-4111-a111-111111111111','/tmp').binding;
  const worker=store.register('worker','claude','22222222-2222-4222-a222-222222222222','/tmp').binding;
  store.enqueue('tg:root',master,'Check build','tg:owner');
  store.enqueue('master:child',worker,'Check build','tg:owner');store.set('parent:master:child','tg:root');
  return {store,policy,master,worker};
}

test('sent worker findings suppress only the same findings in the same owner request',()=>{
  const f=fixture();try {
    const text='✅ *Done*\n- Build passed.\n- Voice is still untested.';
    f.store.output(f.worker,text,'worker-reply','tg:owner',{requestId:'master:child',kind:'final'});
    f.policy.recordWorker('master:child','worker-reply',text);
    assert.equal(f.policy.alreadySent('tg:root',text),false,'queued is not sent');
    f.store.db.prepare("UPDATE outbox SET status='sent'").run();
    assert.equal(f.policy.alreadySent('tg:root','📋 *Summary*\nBuild passed.\nVoice is still untested.'),true);
    assert.equal(f.policy.alreadySent('tg:root',text+'\nDeployment is blocked.'),false);
    assert.equal(f.policy.alreadySent('tg:root','Build failed.\nVoice is still untested.'),false);
    f.store.enqueue('tg:other',f.master,'Another request','tg:owner');
    assert.equal(f.policy.alreadySent('tg:other',text),false);
    f.store.db.prepare("UPDATE outbox SET status='uncertain'").run();
    assert.equal(f.policy.alreadySent('tg:root',text),false);
  }finally{f.store.close();}
});

test('destination, split-message delivery and nested request provenance are preserved',()=>{
  const f=fixture();try {
    f.store.enqueue('master:nested',f.worker,'Nested check','tg:owner');f.store.set('parent:master:nested','master:child');
    const text='Details '.repeat(700);
    f.store.output(f.worker,text,'nested','tg:owner',{requestId:'master:nested',kind:'final'});
    f.policy.recordWorker('master:nested','nested',text);
    f.store.db.prepare("UPDATE outbox SET status='sent'").run();
    assert.equal(f.policy.alreadySent('tg:root',text),true);
    f.store.db.prepare("UPDATE outbox SET status='failed' WHERE source='nested:1'").run();
    assert.equal(f.policy.alreadySent('tg:root',text),false);
    f.store.db.prepare("UPDATE outbox SET status='sent',destination='tg:other'").run();
    assert.equal(f.policy.alreadySent('tg:root',text),false);
  }finally{f.store.close();}
});

test('empty final markers are not findings and meaningful qualifiers are retained',()=>{
  for(const text of ['Done','✅ *Done*','*Final*\nCompleted.','✅ *Verified*','Success!'])assert.equal(replyFindings(text),'');
  assert.equal(replyFindings('Tests passed, but installation failed.'),'Tests passed, but installation failed.');
  assert.notEqual(replyFindings('Balance: +5'),replyFindings('Balance: -5'));
  assert.notEqual(replyFindings('✅ Cache'),replyFindings('❌ Cache'));
  assert.notEqual(replyFindings('✅ *Deployment failed*\nBuild passed.'),replyFindings('Build passed.'));
});
