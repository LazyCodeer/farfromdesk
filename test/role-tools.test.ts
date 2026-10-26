import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { roleConfig } from '../src/roles.js';
import { masterCliTools } from '../src/master-policy.js';

test('only a coordinator without bridge MCP tools gets the CLI tool section',()=>{
  const store=new Store(':memory:');try {
    const bind=(alias:string,transport?:string)=>{const b=store.register(alias,'claude',randomUUID(),'/tmp').binding;if(transport)store.set(`session-route:${b.id}`,JSON.stringify({provider:'claude',executionMode:'desktop',transport,profileId:'claude:desktop'}));return b;};
    const native=bind('claude-native','native-session'),managed=bind('claude-managed','managed-cli'),legacy=bind('claude-legacy');
    assert.match(roleConfig(store,native,'master').instructions,/## Tools on this connection/);
    assert.match(roleConfig(store,legacy,'master').instructions,/## Tools on this connection/);
    assert.doesNotMatch(roleConfig(store,managed,'master').instructions,/## Tools on this connection/);
    assert.doesNotMatch(roleConfig(store,native,'worker').instructions,/## Tools on this connection/);
  }finally{store.close();}
});

test('every CLI command named in the coordinator tool section exists in the bridge CLI',()=>{
  const cli=readFileSync(new URL('../src/cli.ts',import.meta.url),'utf8');
  const operations=[...masterCliTools.matchAll(/: MASTER ([a-z-]+)/g)].map(m=>m[1]);
  assert.ok(operations.length>=13);
  for(const op of operations)assert.ok(cli.includes(`operation==='${op}'`)||cli.includes(`'${op}'`),`master ${op} is not a CLI operation`);
  for(const tool of [...masterCliTools.matchAll(/^- (master_[a-z_]+):/gm)].map(m=>m[1]))assert.match(readFileSync(new URL('../src/master-channel.ts',import.meta.url),'utf8'),new RegExp(`name:'${tool}'`));
});

test('only a Claude Desktop coordinator gets the direct-ask session start rule',()=>{
  const store=new Store(':memory:');try {
    const bind=(alias:string,provider:'claude'|'codex',mode:string)=>{const b=store.register(alias,provider,randomUUID(),'/tmp').binding;store.set(`session-route:${b.id}`,JSON.stringify({provider,executionMode:mode,transport:'native-session',profileId:`${provider}:${mode}`}));return b;};
    const desktop=bind('claude-desk','claude','desktop'),cli=bind('claude-cli','claude','cli'),codex=bind('codex-desk','codex','desktop');
    const text=roleConfig(store,desktop,'master').instructions;
    assert.match(text,/only when the owner asks you directly in this desktop chat/);assert.match(text,/detach_session/);assert.match(text,/Do not retry/);assert.match(text,/Never set or forge user_asked/);
    for(const b of [cli,codex])assert.doesNotMatch(roleConfig(store,b,'master').instructions,/Starting a session in a chosen folder/);
    assert.doesNotMatch(roleConfig(store,desktop,'worker').instructions,/Starting a session in a chosen folder/);
  }finally{store.close();}
});
