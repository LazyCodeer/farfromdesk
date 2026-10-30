import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeProviderFingerprint } from '../src/claude-provider.js';
import { ClaudeSDKSession } from '../src/claude-sdk-session.js';

const root=mkdtempSync(join(tmpdir(),'ffd-provider-tests-'));
process.env.WSB_STATE_DIR=join(root,'state');
const { accountStatus, probeClaudeAccount, Connections }=await import('../src/connections.js');
const { Store }=await import('../src/store.js');
test.after(()=>rmSync(root,{recursive:true,force:true}));

function fixture() {
  const home=mkdtempSync(join(root,'home-')),cwd=join(home,'project'),managedRoot=join(home,'managed'),config=join(home,'.claude');
  mkdirSync(join(cwd,'.claude'),{recursive:true});mkdirSync(config);
  const env={CLAUDE_CONFIG_DIR:config};
  const fingerprint=()=>claudeProviderFingerprint(cwd,env,{home,managedRoot});
  return {home,cwd,config,managedRoot,env,fingerprint};
}
const ollama={ANTHROPIC_AUTH_TOKEN:'ollama',ANTHROPIC_API_KEY:'',ANTHROPIC_BASE_URL:'http://localhost:11434',ANTHROPIC_MODEL:'gemma4'};

test('native token/API/provider statuses without email are configured, never model-verified',()=>{
  for(const authMethod of ['oauth_token','api_key','api_key_helper','third_party']) {
    const c=accountStatus('claude',{loggedIn:true,authMethod,apiProvider:'firstParty'},ollama,'opaque-config');
    assert.equal(c.state,'configured');assert.match(c.label,/not tested/);assert.ok(c.accountKey);
    assert.doesNotMatch(JSON.stringify(c),/localhost|gemma4|ollama|opaque-config/);
  }
  assert.equal(accountStatus('claude',{loggedIn:false,authMethod:'none'},ollama).state,'signed-out');
  assert.equal(accountStatus('claude',{authMethod:'api_key'},ollama).state,'unknown');
  assert.equal(accountStatus('claude',null,{}).state,'unknown');
  assert.equal(accountStatus('claude',{loggedIn:true,authMethod:'claude.ai',email:'owner@example.com'},{}).state,'verified');
  assert.equal(accountStatus('claude',{loggedIn:true,authMethod:'future_method'},{}).state,'unknown');
});

test('native auth status runs directly with the supplied environment and no model request',async()=>{
  const f=fixture();let calls=0;
  const result=await probeClaudeAccount(process.execPath,f.cwd,{...f.env,...ollama},{fingerprint:async()=>f.fingerprint(),execute:(async(bin,args,options)=>{
    calls++;assert.equal(bin,process.execPath);assert.deepEqual(args,['auth','status']);
    assert.equal(options.cwd,f.cwd);assert.equal(options.env.ANTHROPIC_MODEL,'gemma4');
    assert.equal(options.windowsHide,true);assert.equal(options.maxBuffer,65536);
    return {stdout:JSON.stringify({loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'}),stderr:''};
  }) as any});
  assert.equal(calls,1);assert.equal(result.state,'configured');
});

test('auth exit 1 with JSON is signed out; timeout, invalid JSON and other exit codes fail closed',async()=>{
  const f=fixture();const fingerprint=async()=> 'same';
  const execute=(async()=>{throw {code:1,stdout:JSON.stringify({loggedIn:false,authMethod:'none'})};}) as any;
  assert.equal((await probeClaudeAccount(process.execPath,f.cwd,{}, {fingerprint,execute})).state,'signed-out');
  for(const error of [{code:2,stdout:'{"loggedIn":true,"authMethod":"api_key"}'},{code:'ETIMEDOUT',stdout:''},{code:1,stdout:'private diagnostic'}]) {
    await assert.rejects(probeClaudeAccount(process.execPath,f.cwd,{}, {fingerprint,execute:(async()=>{throw error;}) as any}),/status unavailable/);
  }
  await assert.rejects(probeClaudeAccount(process.execPath,f.cwd,{}, {fingerprint,execute:(async()=>({stdout:'not JSON'})) as any}));
});

test('provider changes during a check cannot be pinned',async()=>{
  const f=fixture();let count=0;
  await assert.rejects(probeClaudeAccount(process.execPath,f.cwd,{}, {fingerprint:async()=>String(count++),execute:(async()=>({stdout:'{"loggedIn":true,"authMethod":"api_key"}'})) as any}),/changed during/);
});

test('fingerprints cover provider credentials, endpoint and model in user/project/local settings',async()=>{
  const f=fixture(),settings=join(f.config,'settings.json');
  const write=(env:any)=>writeFileSync(settings,JSON.stringify({env}));
  write(ollama);const original=await f.fingerprint();
  for(const [key,value] of Object.entries({ANTHROPIC_AUTH_TOKEN:'new-secret',ANTHROPIC_BASE_URL:'http://localhost:22434',ANTHROPIC_MODEL:'another-model',ANTHROPIC_DEFAULT_HAIKU_MODEL:'small-model'})) {
    write({...ollama,[key]:value});assert.notEqual(await f.fingerprint(),original);
  }
  write(ollama);
  writeFileSync(join(f.cwd,'.claude','settings.json'),JSON.stringify({env:{ANTHROPIC_BASE_URL:'http://localhost:33434'}}));
  const project=await f.fingerprint();assert.notEqual(project,original);
  writeFileSync(join(f.cwd,'.claude','settings.local.json'),JSON.stringify({model:'gemma4',apiKeyHelper:'do-not-execute-this'}));
  assert.notEqual(await f.fingerprint(),project);
  assert.doesNotMatch(await f.fingerprint(),/gemma|secret|localhost/);
});

test('irrelevant user settings do not invalidate provider routing',async()=>{
  const f=fixture(),path=join(f.config,'settings.json');
  writeFileSync(path,JSON.stringify({env:ollama,theme:'dark'}));const before=await f.fingerprint();
  writeFileSync(path,JSON.stringify({env:ollama,theme:'light',permissions:{allow:['Read']}}));
  assert.equal(await f.fingerprint(),before);
});

test('home preview and a new coordinator without project overrides pin the same configuration',async()=>{
  const f=fixture();writeFileSync(join(f.config,'settings.json'),JSON.stringify({env:ollama}));
  const preview=await claudeProviderFingerprint(f.home,f.env,{home:f.home,managedRoot:f.managedRoot});
  assert.equal(await f.fingerprint(),preview);
  writeFileSync(join(f.cwd,'.claude','settings.json'),JSON.stringify({permissions:{allow:['Read']}}));
  assert.equal(await f.fingerprint(),preview);
});

test('managed provider settings and stored Console API key are fingerprinted without exposure',async()=>{
  const f=fixture();const before=await f.fingerprint();
  writeFileSync(join(f.config,'.claude.json'),JSON.stringify({installMethod:'native'}));
  assert.equal(await f.fingerprint(),before);
  mkdirSync(join(f.managedRoot,'managed-settings.d'),{recursive:true});
  writeFileSync(join(f.managedRoot,'managed-settings.d','10-provider.json'),JSON.stringify({env:ollama}));
  const managed=await f.fingerprint();assert.notEqual(managed,before);
  writeFileSync(join(f.config,'.claude.json'),JSON.stringify({primaryApiKey:'private-console-key'}));
  const key=await f.fingerprint();assert.notEqual(key,managed);assert.doesNotMatch(key,/private/);
});

test('malformed or oversized settings never fall back to a different account',async()=>{
  const f=fixture(),path=join(f.config,'settings.json');
  for(const data of ['{not-json','[]','x'.repeat(2*1024*1024+1)]) {
    writeFileSync(path,data);await assert.rejects(f.fingerprint(),/configuration could not be checked/);
  }
});

test('configured API route survives restart, but model/endpoint changes stop execution',async()=>{
  const f=fixture(),path=join(f.config,'settings.json');writeFileSync(path,JSON.stringify({env:ollama}));
  const store=new Store(':memory:');
  try {
    const b=store.register('api-claude','claude','11111111-1111-4111-a111-111111111111',f.cwd).binding;
    const probe=async()=>accountStatus('claude',{loggedIn:true,authMethod:'oauth_token'},f.env,await f.fingerprint());
    const c=new Connections(store,probe);await c.choose(b,'cli',true);
    await new Connections(store,probe).assert(b);
    writeFileSync(path,JSON.stringify({env:{...ollama,ANTHROPIC_MODEL:'different'}}));
    await assert.rejects(c.assert(b),/account or provider changed/);
  } finally {store.close();}
});

test('SDK receives Ollama endpoint/model environment while retaining native settings and permissions',async(t)=>{
  t.mock.property(process,'env',{...process.env,...ollama});
  let options:any;
  const query:any=(input:any)=>{options=input.options;return {async *[Symbol.asyncIterator](){yield {type:'result',subtype:'success',is_error:false,session_id:'exact',result:'ok'};},close(){}};};
  const session=new ClaudeSDKSession(process.execPath,root,'exact',false,async()=>false,{},query);
  try {
    assert.equal(await session.run('offline test'),'ok');
    for(const [key,value] of Object.entries(ollama))assert.equal(options.env[key],value);
    assert.deepEqual(options.settingSources,['user','project','local']);assert.equal(options.permissionMode,'default');
    assert.equal((await options.canUseTool('Write',{})).behavior,'deny');
  } finally {session.close();}
});
