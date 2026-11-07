import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {installBrainOverride} from '../src/brain-override.js';
test('brain override reroutes only Meta chat calls',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bo-')),real=globalThis.fetch,seen:any[]=[];
  assert.equal(installBrainOverride(dir),false);
  globalThis.fetch=(async(u:any,i:any)=>{seen.push([String(u),i]);return new Response('{}');}) as any;
  try{
    writeFileSync(join(dir,'brain-override.json'),JSON.stringify({url:'https://x.azure/chat',key:'k'}));
    assert.equal(installBrainOverride(dir),true);
    await fetch('https://api.meta.ai/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer m'},body:JSON.stringify({model:'meta',tools:[1]})});
    await fetch('https://api.meta.ai/v1/images/generations',{method:'POST',body:'{}'});
    assert.equal(seen[0][0],'https://x.azure/chat');assert.equal(new Headers(seen[0][1].headers).get('api-key'),'k');assert.equal(new Headers(seen[0][1].headers).get('authorization'),null);
    assert.deepEqual(JSON.parse(seen[0][1].body),{tools:[1],reasoning_effort:'none'});
    assert.equal(seen[1][0],'https://api.meta.ai/v1/images/generations');
  }finally{globalThis.fetch=real;}
});
