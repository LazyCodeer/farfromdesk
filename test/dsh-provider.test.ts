import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dshArgs } from '../src/dsh-session.js';
import {
  DEFAULT_DSH_MODEL,
  DEFAULT_DSH_ROUTE,
  ROUTE_KEY_ENV,
  credentialHint,
  defaultKeyEnv,
  dshSettings,
  dshStatus,
  composePatch,
  credentialRef,
  entryById,
  keyEnvironment,
  modelListed,
  parseProfile,
  readProfile,
  reasoningSupported,
  withModel,
  patchYaml,
  writePatch,
  type DshProviderSettings,
} from '../src/dsh-provider.js';

const settings=(over:Partial<DshProviderSettings>={}):DshProviderSettings=>({
  route:DEFAULT_DSH_ROUTE,
  model:DEFAULT_DSH_MODEL,
  keyEnv:ROUTE_KEY_ENV[DEFAULT_DSH_ROUTE],
  ...over,
});

test('a missing setting falls back to the shipped headless route',()=>{
  const s=dshSettings(()=>undefined);
  assert.equal(s.route,DEFAULT_DSH_ROUTE);
  assert.equal(s.model,DEFAULT_DSH_MODEL);
  assert.equal(s.keyEnv,'DEEPSEEK_API_KEY');
  assert.equal(s.key,undefined);
  assert.equal(s.reasoningEffort,undefined);
});

test('the owner can name another provider, model, effort and key variable',()=>{
  const values:Record<string,string>={
    'deepseek-provider':'openai',
    'deepseek-model':'gpt-5',
    'deepseek-reasoning-effort':'high',
    'deepseek-api-key':'sk-stored',
  };
  const s=dshSettings(key=>values[key]);
  assert.deepEqual(s,{route:'openai',model:'gpt-5',reasoningEffort:'high',keyEnv:'OPENAI_API_KEY',key:'sk-stored'});
  // A route we do not know still works when the owner names the variable.
  const named=dshSettings(key=>({'deepseek-provider':'some-gateway','deepseek-key-env':'GATEWAY_TOKEN'})[key]);
  assert.equal(named.keyEnv,'GATEWAY_TOKEN');
  assert.equal(defaultKeyEnv('some-gateway'),undefined);
});

test('a stored key is used first, an inherited one second, and neither is reported honestly',()=>{
  assert.deepEqual(keyEnvironment(settings({key:'sk-stored'}),{DEEPSEEK_API_KEY:'sk-env'}),{
    env:{DEEPSEEK_API_KEY:'sk-stored'},
    source:'settings',
  });
  assert.deepEqual(keyEnvironment(settings(),{DEEPSEEK_API_KEY:'sk-env'}),{env:{},source:'environment'});
  assert.deepEqual(keyEnvironment(settings(),{}),{env:{},source:'none'});
  // A route with no key variable at all is never guessed at.
  assert.deepEqual(keyEnvironment(settings({keyEnv:'',key:'sk-stored'}),{}),{env:{},source:'none'});
});

test('the patch names the whole agent-default-model config',()=>{
  assert.equal(
    patchYaml(settings()),
    "- id: agent-default-model\n  config:\n    provider: 'deepseek-official'\n    model: 'deepseek-flash'\n",
  );
  assert.equal(
    patchYaml(settings({reasoningEffort:'high'})),
    "- id: agent-default-model\n  config:\n    provider: 'deepseek-official'\n    model: 'deepseek-flash'\n    reasoningEffort: 'high'\n",
  );
  // A quote in a value cannot break out of the scalar.
  assert.match(patchYaml(settings({model:"o'brien"}))!,/model: 'o''brien'/);
  // With no route or model there is nothing to say, so the profile's own defaults stand.
  assert.equal(patchYaml(settings({model:''})),null);
});

test('the patch is written where the run can be told to read it',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ffd-dsh-patch-'));
  try {
    const path=writePatch(join(dir,'state'),settings());
    assert.equal(path,join(dir,'state','deepseek-provider.yml'));
    assert.equal(readFileSync(path!,'utf8'),patchYaml(settings()));
    assert.equal(writePatch(join(dir,'state'),settings({model:''})),null);
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});

test('status tells the owner what will happen without ever holding the key',()=>{
  const stored=dshStatus(settings({key:'sk-secret-value',model:'deepseek-reasoner'}),{});
  assert.equal(stored.configured,true);
  assert.equal(stored.keySource,'settings');
  assert.equal(stored.hint,'DeepSeek runs deepseek-official with deepseek-reasoner in this folder.');
  assert.ok(!JSON.stringify(stored).includes('sk-secret-value'));

  const inherited=dshStatus(settings(),{DEEPSEEK_API_KEY:'sk-env'});
  assert.equal(inherited.configured,true);
  assert.equal(inherited.keySource,'environment');

  const missing=dshStatus(settings(),{});
  assert.equal(missing.configured,false);
  assert.match(missing.hint,/needs an API key for deepseek-official/);
  assert.match(missing.hint,/DEEPSEEK_API_KEY/);

  const unknown=dshStatus(settings({route:'mystery-gateway',keyEnv:''}),{});
  assert.match(unknown.hint,/do not know which environment variable/);
  assert.match(unknown.hint,/mystery-gateway/);
});

test('only a credential failure is replaced by the next step the owner can take',()=>{
  const status=dshStatus(settings(),{});
  // The two wordings this machine actually produced (the CLI's own and the provider's 401).
  assert.equal(
    credentialHint('dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"',status),
    status.hint,
  );
  assert.equal(credentialHint('dsh: AUTH: Authentication Fails, Your api key: ****real is invalid (status 401)',status),status.hint);
  // Anything else stays as the CLI said it, because guessing hides the real error.
  assert.equal(credentialHint('DeepSeek Harness exited with code 1: no such file or directory',status),null);
  assert.equal(credentialHint('The DeepSeek run was cancelled.',status),null);
});
test('the provider patch is a launcher flag, so it precedes the headless app flags',()=>{
  // Measured: `dsh --profile headless --json --patch X -` answers `unknown option '--patch'`.
  const args=dshArgs({prompt:'x',cwd:'/tmp',sessionId:'session-1',patchPath:'/tmp/p.yml'});
  assert.deepEqual(args,['--profile','headless','--patch','/tmp/p.yml','--json','--session-id','session-1','-']);
  assert.deepEqual(dshArgs({prompt:'x',cwd:'/tmp'}),['--profile','headless','--json','-']);
});

// The owner's own profile, typed as they wrote it: an Azure route the shipped headless profile does
// not know, a model list that carries only the dated id, and no reasoning-effort declaration.
const PROFILE = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: azure-deepseek
    model: DeepSeek-V4.1-Flash
    reasoningEffort: medium
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      azure-deepseek:
        displayName: Azure DeepSeek
        apiKeyEnv: AZURE_DEEPSEEK_API_KEY
        api: openai-completions
        baseURL: https://example.invalid/openai/v1
        models:
          - id: DeepSeek-V4.1-Flash-2026-09-10
            name: DeepSeek-V4.1-Flash-2026-09-10
`;
const PROFILE_WITH_EFFORT = PROFILE.replace('          - id: DeepSeek-V4.1-Flash-2026-09-10',
  '          - id: DeepSeek-V4.1-Flash-2026-09-10\n            reasoningEfforts: [medium]');

test('the owner\'s own provider block is mirrored into a run, and its model list is completed',()=>{
  const profile=parseProfile(PROFILE);
  assert.equal(profile?.route,'azure-deepseek');
  assert.equal(profile?.model,'DeepSeek-V4.1-Flash');
  assert.equal(profile?.keyEnv,'AZURE_DEEPSEEK_API_KEY');
  // The owner's profile asks for medium effort; this provider does not declare support for it.
  const patch=composePatch({route:'azure-deepseek',model:'DeepSeek-V4.1-Flash',reasoningEffort:'medium',keyEnv:'AZURE_DEEPSEEK_API_KEY'},profile);
  assert.ok(patch);
  // The provider block travels verbatim, so no field the plugin accepts is lost in a rewrite.
  assert.match(patch.text,/api: openai-completions/);
  assert.match(patch.text,/baseURL: https:\/\/example\.invalid\/openai\/v1/);
  // The run's model is in the list even when the profile carried only the dated id: the CLI refuses
  // a model its provider block does not declare (measured: UNKNOWN_MODEL).
  assert.match(patch.text,/- id: DeepSeek-V4\.1-Flash\n\s+name: DeepSeek-V4\.1-Flash/);
  assert.match(patch.text,/- id: DeepSeek-V4\.1-Flash-2026-09-10/);
  // The provider declares no reasoning-effort support, so the effort is dropped and said so.
  assert.doesNotMatch(patch.text,/reasoningEffort/);
  assert.match(patch.notes.join(' '),/does not declare reasoning-effort support/);
});

test('a provider that declares reasoning-effort support keeps the owner\'s effort',()=>{
  const patch=composePatch({route:'azure-deepseek',model:'DeepSeek-V4.1-Flash',reasoningEffort:'medium',keyEnv:'AZURE_DEEPSEEK_API_KEY'},parseProfile(PROFILE_WITH_EFFORT));
  assert.ok(patch);
  assert.match(patch.text,/reasoningEffort: 'medium'/);
  assert.equal(patch.notes.length,0);
});

test('a run without a profile still writes the route it was given',()=>{
  const patch=composePatch({route:'openai',model:'gpt-5',reasoningEffort:'high',keyEnv:'OPENAI_API_KEY'},null);
  assert.ok(patch);
  assert.match(patch.text,/provider: 'openai'/);
  assert.match(patch.text,/reasoningEffort: 'high'/);
  assert.doesNotMatch(patch.text,/llm-pi-ai/);
});

test('entry lookup and model listing are exact, not substring matches',()=>{
  const entry=entryById(PROFILE,'llm-pi-ai');
  assert.ok(entry?.startsWith('- id: llm-pi-ai'));
  assert.equal(entryById(PROFILE,'llm-pi-ai-extra'),null);
  assert.equal(modelListed(entry!,'DeepSeek-V4.1-Flash'),false);
  assert.equal(modelListed(entry!,'DeepSeek-V4.1-Flash-2026-09-10'),true);
  assert.equal(reasoningSupported(entry!),false);
  assert.equal(reasoningSupported(entryById(PROFILE_WITH_EFFORT,'llm-pi-ai')!),true);
  // Adding a model twice changes nothing.
  assert.equal(withModel(withModel(entry!,'X'),'X').match(/- id: X/g)?.length,1);
});

test('the key order is the owner\'s choice, then the environment, then the DSH store',()=>{
  const home=mkdtempSync(join(tmpdir(),'ffd-dsh-home-'));
  try {
    writeFileSync(join(home,'.credentials.yaml'),['version: 1','refs:','  AZURE_DEEPSEEK_API_KEY: an-azure-key-value-that-is-long','  SHORT: abc'].join('\n'));
    assert.equal(credentialRef(home,'AZURE_DEEPSEEK_API_KEY'),'an-azure-key-value-that-is-long');
    assert.equal(credentialRef(home,'SHORT'),undefined);
    assert.equal(credentialRef(home,'NOT_THERE'),undefined);
    const refs=(name:string)=>credentialRef(home,name);
    const settings={route:'azure-deepseek',model:'DeepSeek-V4.1-Flash',keyEnv:'AZURE_DEEPSEEK_API_KEY'};
    assert.equal(keyEnvironment(settings,{},refs).source,'credentials');
    assert.equal(keyEnvironment(settings,{},refs).env.AZURE_DEEPSEEK_API_KEY,'an-azure-key-value-that-is-long');
    assert.equal(keyEnvironment(settings,{AZURE_DEEPSEEK_API_KEY:'from-env'},refs).source,'environment');
    assert.equal(keyEnvironment({...settings,key:'stored'},{AZURE_DEEPSEEK_API_KEY:'from-env'},refs).source,'settings');
    assert.equal(keyEnvironment({...settings,key:'stored'},{},refs).env.AZURE_DEEPSEEK_API_KEY,'stored');
    // The settings view reports the credential store as configured, and never prints the key.
    const status=dshStatus(settings,{},refs);
    assert.equal(status.configured,true);
    assert.equal(status.keySource,'credentials');
    assert.doesNotMatch(status.hint,/an-azure-key-value/);
  } finally {
    rmSync(home,{recursive:true,force:true});
  }
});

test('the app settings win, and the owner\'s profile fills what they left empty',()=>{
  const profile=parseProfile(PROFILE);
  const empty=dshSettings(()=>undefined,profile);
  assert.equal(empty.route,'azure-deepseek');
  assert.equal(empty.model,'DeepSeek-V4.1-Flash');
  assert.equal(empty.keyEnv,'AZURE_DEEPSEEK_API_KEY');
  const chosen=dshSettings((key:string)=>key==='deepseek-provider'?'openai':undefined,profile);
  assert.equal(chosen.route,'openai');
  assert.equal(chosen.model,'DeepSeek-V4.1-Flash');
  // No profile and no settings keeps the shipped defaults.
  assert.equal(dshSettings(()=>undefined,null).route,DEFAULT_DSH_ROUTE);
});

test('a profile is read from the desktop app\'s own patch file, and a missing one is not an error',()=>{
  const home=mkdtempSync(join(tmpdir(),'ffd-dsh-profile-'));
  try {
    assert.equal(readProfile(home),null);
    mkdirSync(join(home,'profiles','desktop'),{recursive:true});
    writeFileSync(join(home,'profiles','desktop','cordis.patch.yml'),PROFILE);
    assert.equal(readProfile(home)?.route,'azure-deepseek');
    // A profile file that says nothing about a model is null, not a half-filled default.
    writeFileSync(join(home,'profiles','desktop','cordis.patch.yml'),'- id: ui-chat\n  config:\n    transcriptView: detailed\n');
    assert.equal(readProfile(home),null);
  } finally {
    rmSync(home,{recursive:true,force:true});
  }
});
