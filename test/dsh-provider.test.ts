import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DSH_MODEL,
  DEFAULT_DSH_ROUTE,
  ROUTE_KEY_ENV,
  credentialHint,
  defaultKeyEnv,
  dshSettings,
  dshStatus,
  keyEnvironment,
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