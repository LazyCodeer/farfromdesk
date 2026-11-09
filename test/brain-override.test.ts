import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {installBrainOverride,installHostedBrain} from '../src/brain-override.js';
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
test('hosted brain sends Meta chat and image calls to the cloud and leaves the rest',async()=>{
  const real=globalThis.fetch,calls:any[]=[];
  globalThis.fetch=(async()=>new Response('real')) as any;
  try{
    installHostedBrain(async(path,body)=>{calls.push([path,body]);return {status:200,body:{ok:path}};});
    const r=await fetch('https://api.meta.ai/v1/chat/completions',{method:'POST',body:'{"a":1}'});
    assert.deepEqual(await r.json(),{ok:'/v1/brain'});
    await fetch('https://api.meta.ai/v1/images/generations',{method:'POST',body:'{"prompt":"p"}'});
    assert.equal(await (await fetch('https://example.com/x')).text(),'real');
    assert.deepEqual(calls,[['/v1/brain',{a:1}],['/v1/image',{prompt:'p'}]]);
  }finally{globalThis.fetch=real;}
});
