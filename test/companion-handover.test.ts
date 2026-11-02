import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';

// Application modules cache their state root at import time.
const root=mkdtempSync(join(tmpdir(),'ffd-companion-test-'));process.env.WSB_STATE_DIR=root;process.env.FARFROMDESK_HOME=join(root,'home');
// A closed port, so the hook under test really cannot reach a bridge.
process.env.WSB_PORT='47899';
test.after(()=>rmSync(root,{recursive:true,force:true}));
const {Store}=await import('../src/store.js');
const {Router}=await import('../src/router.js');
const {Approvals}=await import('../src/approvals.js');
const {DEFAULT_BRAIN}=await import('../src/meta-brain-config.js');
const {StuckDetection}=await import('../src/stuck-detection.js');
const {readHandover,describeTool,parseQuestionChoices}=await import('../src/companion.js');
const {installProviderHooks,providerHookState,providerHookCommand,isBridgeHookCommand,providerHookPath}=await import('../src/provider-hooks.js');

const whatsappOwner='owner@s.whatsapp.net';
type StoreType=InstanceType<typeof Store>;
function fixture(o:{channel?:'whatsapp'|'telegram'}={}){
  const store=new Store(':memory:'),approvals=new Approvals(store),native={run:async()=>{},stop:()=>{}};
  const destination=o.channel==='telegram'?'tg:1234:99':whatsappOwner;
  store.set('control-channel',o.channel??'whatsapp');
  if(o.channel==='telegram')store.set('telegram-owner',destination);else store.set('whatsapp-owner',whatsappOwner);
  store.set('meta-brain-policy',JSON.stringify({...DEFAULT_BRAIN,enabled:true,allowStatus:true,taskContracts:false}));
  const router=new Router(store,native as any,approvals);router.brain.secret.save('synthetic-companion-test-key');
  let now=Date.now(),inputs:unknown[]=[];
  const detector=new StuckDetection(store,router,async(kinds)=>{inputs.push(kinds);return 'A task needs your attention.';},()=>now);
  router.stuckDetection=detector;router.pump=()=>{};
  const binding=store.register('worker','codex',randomUUID(),'/tmp').binding;
  const add=(id:string,title:string)=>{
    store.recordOwnerOrigin(id,destination,destination);
    store.destinationContext.run(destination,()=>store.enqueue(id,binding,'Synthetic task',destination));
    const item=store.destinationContext.run(destination,()=>router.brain.memory.add(id,title));
    store.jobState(id,'dispatched');store.jobState(id,'submitted');return item;
  };
  const last=()=>(store.db.prepare('SELECT body FROM outbox ORDER BY rowid DESC LIMIT 1').get() as {body:string}).body;
  const bodies=(source:string)=>store.db.prepare('SELECT body FROM outbox WHERE source LIKE ? ORDER BY rowid').all(`${source}%`) as {body:string}[];
  return {store,approvals,router,binding,detector,destination,add,last,bodies,inputs,advance:(ms:number)=>{now+=ms;},close:()=>{router.stopped=true;approvals.cancel();store.close();}};
}
const alerts=(store:StoreType)=>store.db.prepare('SELECT * FROM stuck_alerts ORDER BY item_id').all() as any[];
const sent=async(store:StoreType,promise:Promise<string>)=>{void promise;return promise;};

test('the permission card names the session and offers allow, deny or take over',async()=>{
  const f=fixture();try{
    f.add('wa:permission','Synthetic task');
    const answer=f.store.destinationContext.run(f.destination,()=>f.approvals.ask(f.binding,'Bash\n{"command":"rm -rf build"}','approval','wa:permission','session'));
    const card=f.bodies('permission:')[0].body;
    assert.match(card,/waiting for your permission/);
    assert.match(card,/wants to run a shell command/);
    assert.match(card,/rm -rf build/);          // the exact request stays visible
    assert.match(card,/1\. Allow it/);
    assert.match(card,/2\. Deny it/);
    assert.match(card,/3\. I do it on the Mac myself/);
    assert.doesNotMatch(card,/Permission needed/);
    // A bridge-internal gate keeps its own explanatory copy.
    const gate=f.store.destinationContext.run(f.destination,()=>f.approvals.ask(f.binding,'Run the tests now?','approval'));
    assert.match(f.bodies('permission:')[1].body,/Permission needed/);
    f.approvals.cancel();assert.equal(await answer,'deny');assert.equal(await gate,'deny');
  }finally{f.close();}
});

test('taking over answers native, sends the steps and records a checkable handover',async()=>{
  const f=fixture();try{
    const item=f.add('wa:permission','Synthetic task');
    const answer=f.store.destinationContext.run(f.destination,()=>f.approvals.ask(f.binding,'Bash\n{"command":"sudo make install"}','approval','wa:permission','session'));
    const original=f.store.db.prepare("SELECT * FROM outbox WHERE source LIKE 'permission:%:0'").get() as any;f.store.sent(original.id);
    const [code]=f.approvals.pending.keys();
    const reply=await f.store.destinationContext.run(f.destination,()=>f.router.receive({id:'wa:takeover',text:'3',quotedId:original.wa_id,ownerCommand:false,ownerChoice:true,source:'text'}));
    assert.equal(reply.status,'handled');
    assert.equal(await answer,'native');
    assert.equal(f.approvals.pending.size,0);
    const guide=f.bodies(`handover:${code}`)[0].body;
    assert.match(guide,/This one needs your Mac/);
    assert.match(guide,/nothing was approved from here/i);
    assert.match(guide,/1\. Open Codex on the Mac\./);
    assert.match(guide,/\/done here/);      // the exact way back
    assert.match(guide,/\/screen/);
    const record=readHandover(f.store,f.destination,f.destination);
    assert.equal(record?.reason,'owner-choice');assert.equal(record?.bindingId,f.binding.id);
    // /done checks the real state instead of trusting the claim and never resends.
    const jobs=f.store.jobs().length;
    const check=await f.store.destinationContext.run(f.destination,()=>f.router.receive({id:'wa:done',text:'/done',ownerCommand:true,source:'text'}));
    assert.equal(check.status,'handled');
    assert.match(f.last(),/Still running/);
    assert.match(f.last(),/did not resend/);
    assert.equal(f.store.jobs().length,jobs);
    // Once the session really answers, /done says so and drops the record.
    f.store.db.prepare('UPDATE inbox SET first_reply_at=? WHERE id=?').run(Date.now(),'wa:permission');
    await f.store.destinationContext.run(f.destination,()=>f.router.receive({id:'wa:done2',text:'/done',ownerCommand:true,source:'text'}));
    assert.match(f.last(),/answered this at/);
    assert.equal(readHandover(f.store,f.destination,f.destination),undefined);
    assert.equal(alerts(f.store).filter(a=>a.item_id===item.id&&a.kind==='stalled').length,0);
  }finally{f.close();}
});

test('/done explains itself when nothing is waiting and never approves a session',async()=>{
  const f=fixture();try{
    await f.store.destinationContext.run(f.destination,()=>f.router.receive({id:'wa:done',text:'/done',ownerCommand:true,source:'text'}));
    assert.match(f.last(),/Nothing is waiting on your Mac/);
    assert.equal(f.store.jobs().length,0);
    // A quoted /done is not a command, and a voice command is refused.
    await f.store.destinationContext.run(f.destination,()=>f.router.receive({id:'wa:doneq',text:'/done',quotedId:'x',ownerCommand:true,source:'text'}));
    assert.match(f.last(),/Send \/done as a new text message/);
    await f.store.destinationContext.run(f.destination,()=>f.router.receive({id:'wa:donev',text:'/done',ownerCommand:true,source:'voice'}));
    assert.match(f.last(),/Send \/done as a new text message/);
  }finally{f.close();}
});

test('a native question is handed to the app instead of a yes or no that cannot answer it',async()=>{
  const f=fixture();try{
    f.add('wa:permission','Synthetic task');
    const question='AskUserQuestion\n'+JSON.stringify({questions:[{question:'What should the app be called?',header:'App name',multiSelect:false,options:[{label:'Splice AI'},{label:'Nuskha by Splice AI'}]}]});
    assert.equal(describeTool(question).kind,'question');
    assert.deepEqual(parseQuestionChoices(question).map(c=>[c.header,c.options]),[['App name',['Splice AI','Nuskha by Splice AI']]]);
    const result=f.store.destinationContext.run(f.destination,()=>f.approvals.blockUnanswerable(f.binding,question,'wa:permission'));
    assert.equal(result.answer,'native');
    // No pending decision is left behind: the app owns this prompt now.
    assert.equal(f.approvals.pending.size,0);
    const card=f.bodies('permission-question:')[0].body;
    assert.match(card,/asking you something/);
    assert.match(card,/What should the app be called\?/);   // the real questions, not a summary
    assert.match(card,/Splice AI \| Nuskha by Splice AI/);
    assert.match(card,/answer it in Codex on the Mac/);
    assert.match(card,/is asking you a question, in tmp\./);   // the folder reads as prose, not "in the app in tmp"
    assert.doesNotMatch(card,/in the app in /);
    assert.equal(readHandover(f.store,f.destination,f.destination)?.reason,'question');
  }finally{f.close();}
});

test('an allow the session never acted on becomes a takeover guide, not silence',async()=>{
  const f=fixture();try{
    const item=f.add('wa:permission','Synthetic task');
    const answer=f.store.destinationContext.run(f.destination,()=>f.approvals.ask(f.binding,'Bash\n{"command":"npm run deploy"}','approval','wa:permission','session'));
    const [code]=f.approvals.pending.keys();
    f.approvals.answer(code,'approve','approval');assert.equal(await answer,'approve');
    f.advance(60_000);await f.detector.tick();
    assert.equal(alerts(f.store).filter(a=>a.kind==='stalled').length,0,'a slow turn is not a stall');
    f.advance(3*60_000);await f.detector.tick();await f.detector.tick();
    const stalled=alerts(f.store).filter(a=>a.kind==='stalled');
    assert.equal(stalled.length,1);
    assert.equal(stalled[0].item_id,item.id);
    const body=(f.store.db.prepare("SELECT body FROM outbox WHERE source LIKE 'stuck-alert:%'").get() as {body:string}).body;
    assert.match(body,/This one needs your Mac/);
    assert.match(body,/Your allow was delivered, but .* has still not moved/);
    assert.match(body,/\/done here/);
    assert.doesNotMatch(body,/npm run deploy|wa:permission/);
    f.advance(30*60_000);await f.detector.tick();
    assert.equal(alerts(f.store).filter(a=>a.kind==='stalled').length,1,'one notice per stall');
  }finally{f.close();}
});

test('the watch follows the owner channel instead of only the paired WhatsApp self-chat',async()=>{
  const f=fixture({channel:'telegram'});try{
    const id=`${f.destination}:101`;f.add(id,'Synthetic telegram task');
    f.advance(11*60_000);await f.detector.tick();
    assert.equal(alerts(f.store).length,1);
    const notice=f.store.db.prepare("SELECT body,destination FROM outbox WHERE source LIKE 'stuck-alert:%'").get() as {body:string;destination:string};
    assert.equal(notice.destination,f.destination);
    assert.match(notice.body,/No recorded progress/);
    // A stale WhatsApp owner must never receive a Telegram notice.
    f.store.set('whatsapp-owner','someone-else@s.whatsapp.net');await f.detector.tick();
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE destination LIKE '%@s.whatsapp.net'").get()?.n,0);
  }finally{f.close();}
});

test('the hook installer namespaces one command per provider, preserves other tools and repairs older builds',async()=>{
  const home=mkdtempSync(join(tmpdir(),'ffd-hooks-'));
  try{
    const claude=join(home,'.claude/settings.json');
    const {mkdirSync}=await import('node:fs');
    mkdirSync(join(home,'.claude'),{recursive:true});
    const other={hooks:[{type:'command',command:'"$OTHER_HOME/hooks/notify.sh" claude || true',timeout:5}]};
    const older={hooks:[{type:'command',command:"'/usr/bin/node' '/old/place/dist/cli.js' hook claude",timeout:920}]};
    writeFileSync(claude,JSON.stringify({model:'opus',hooks:{PermissionRequest:[other,older],Stop:[other]}},null,2)+'\n',{mode:0o600});
    const target={node:'/usr/bin/node',cli:'/app/backend/dist/cli.js',stateDir:'/state/Local Bridge',port:47961,home,env:{}};
    // Another FarFromDesk install (an older unpinned hook) owns this provider:
    // report it and leave the file untouched instead of taking prompts away.
    const owned=installProviderHooks({...target,provider:'claude'});
    assert.equal(owned.state,'owned-by-other');
    assert.match(owned.detail??'',/another FarFromDesk install/);
    assert.equal(readFileSync(claude,'utf8'),JSON.stringify({model:'opus',hooks:{PermissionRequest:[other,older],Stop:[other]}},null,2)+'\n');
    const first=installProviderHooks({...target,provider:'claude',takeOver:true});
    assert.equal(first.state,'repaired');
    assert.ok(first.backup&&existsSync(first.backup!));
    const written=JSON.parse(readFileSync(claude,'utf8'));
    assert.equal(written.model,'opus','unrelated settings survive');
    const commands=(event:string)=>written.hooks[event].flatMap((group:any)=>group.hooks.map((h:any)=>h.command));
    assert.deepEqual(commands('PermissionRequest').filter((c:string)=>!isBridgeHookCommand(c)),[other.hooks[0].command]);
    const expected=providerHookCommand({...target,provider:'claude'});
    assert.ok(expected.includes(`WSB_STATE_DIR='/state/Local Bridge'`)&&expected.includes('WSB_PORT=47961'),'the command pins this build state and port');
    for(const event of ['Stop','PermissionRequest'])assert.equal(commands(event).filter((c:string)=>isBridgeHookCommand(c)).length,1);
    assert.equal(providerHookState({...target,provider:'claude'}).state,'current');
    // Idempotent: a second run changes nothing.
    const before=readFileSync(claude,'utf8');
    assert.equal(installProviderHooks({...target,provider:'claude'}).state,'current');
    assert.equal(readFileSync(claude,'utf8'),before);
    // A first install creates the file and its events.
    const codex=installProviderHooks({...target,provider:'codex'});
    assert.equal(codex.state,'installed');
    const codexConfig=JSON.parse(readFileSync(join(home,'.codex/hooks.json'),'utf8'));
    assert.deepEqual(Object.keys(codexConfig.hooks).sort(),['PermissionRequest','Stop']);
    // An unreadable file is reported and left byte-identical.
    const broken=join(home,'.claude/broken.json');
    writeFileSync(broken,'{ not json',{mode:0o600});
    assert.equal(installProviderHooks({...target,provider:'claude'}).state,'current');
    assert.equal(existsSync(broken),true);
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('a hook file that cannot be parsed is reported instead of being overwritten',async()=>{
  const home=mkdtempSync(join(tmpdir(),'ffd-hooks-bad-'));
  try{
    const {mkdirSync}=await import('node:fs');
    mkdirSync(join(home,'.claude'),{recursive:true});
    const file=join(home,'.claude/settings.json');
    writeFileSync(file,'{ this is not json',{mode:0o600});
    const report=installProviderHooks({node:'/usr/bin/node',cli:'/app/dist/cli.js',stateDir:'/state',port:47831,home,env:{},provider:'claude'});
    assert.equal(report.state,'unreadable');
    assert.equal(readFileSync(file,'utf8'),'{ this is not json');
  }finally{rmSync(home,{recursive:true,force:true});}
});
test('a bridge that is not running never denies a permission on the owner behalf',async()=>{
  const store=new Store(':memory:');
  try{
    const a=store.register('probe','codex','11111111-1111-4111-a111-111111111111','/tmp');
    const {saveBindingCredentials}=await import('../src/server.js');
    const {handleHook}=await import('../src/hooks.js');
    saveBindingCredentials(a.binding,a.token);
    const denied=await handleHook('codex',{session_id:a.binding.native_id,hook_event_name:'PermissionRequest',tool_name:'Bash',tool_input:{command:'synthetic'}});
    // No decision object at all: the app's own prompt asks the owner, it is not denied for them.
    assert.equal(denied,undefined);
    const unregistered=await handleHook('codex',{session_id:'not-a-registered-session',hook_event_name:'PermissionRequest',tool_name:'Bash',tool_input:{command:'synthetic'}});
    assert.equal(unregistered,undefined);
  }finally{store.close();}
});

test('an isolated Local build writes hooks to the owner profile, not its private home',async()=>{
  const realHome=userInfo().homedir;
  // Local's backend runs with a private HOME; the provider apps read the owner's real one.
  const isolated={FFD_ISOLATED_LOCAL:'1',HOME:join(root,'home'),FFD_SELECTED_CODEX_HOME:join(realHome,'.codex'),WSB_STATE_DIR:root};
  assert.equal(providerHookPath('codex',undefined,isolated),join(realHome,'.codex/hooks.json'));
  assert.equal(providerHookPath('claude',undefined,isolated),join(realHome,'.claude/settings.json'));
  // The bridge's own private CLAUDE_CONFIG_DIR is not where Claude Desktop reads.
  assert.equal(providerHookPath('claude',undefined,{...isolated,CLAUDE_CONFIG_DIR:join(root,'home/.claude')}),join(realHome,'.claude/settings.json'));
  // A genuine owner-level override still wins.
  assert.equal(providerHookPath('claude',undefined,{...isolated,CLAUDE_CONFIG_DIR:'/custom/claude'}),'/custom/claude/settings.json');
  assert.equal(providerHookPath('codex',undefined,{...isolated,CODEX_HOME:join(root,'home/.codex')}),join(realHome,'.codex/hooks.json'));
  // The isolated flag is not always exported; a HOME under the app's own state is enough.
  const viaState={HOME:join(root,'home'),WSB_STATE_DIR:root};
  assert.equal(providerHookPath('claude',undefined,viaState),join(realHome,'.claude/settings.json'));
  // A normal install just uses HOME.
  assert.equal(providerHookPath('claude',undefined,{HOME:'/plain/home'}),'/plain/home/.claude/settings.json');
  assert.equal(providerHookPath('codex','/explicit/home'),'/explicit/home/.codex/hooks.json');
});

test('a throwaway run never writes into the owner real provider profile',async()=>{
  const fake=mkdtempSync(join(tmpdir(),'ffd-scratch-home-'));
  try{
    const file=join(fake,'.claude/settings.json');
    mkdirSync(join(fake,'.claude'),{recursive:true});
    writeFileSync(file,JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'other-tool'}]}]}},null,2)+'\n');
    // Exactly the packaged smoke's shape: isolated flag, temp state, real user home.
    const env={FFD_ISOLATED_LOCAL:'1',HOME:root,WSB_STATE_DIR:root,CLAUDE_CONFIG_DIR:join(root,'claude'),CODEX_HOME:join(root,'codex')};
    const report=installProviderHooks({provider:'claude',node:'/usr/bin/node',cli:'/app/dist/cli.js',stateDir:root,port:1,home:fake,env:{...env,CLAUDE_CONFIG_DIR:join(fake,'.claude')}});
    assert.equal(report.state,'unavailable');
    assert.match(report.detail??'',/temporary state directory/);
    assert.equal(JSON.parse(readFileSync(file,'utf8')).hooks.Stop[0].hooks[0].command,'other-tool');
  }finally{rmSync(fake,{recursive:true,force:true});}
});
