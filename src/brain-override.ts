import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ponytail: test-only switch. A brain-override.json in the state dir ({"url","key"}, an Azure OpenAI chat-completions
// deployment) sends Meta chat calls there instead, for when the Meta account can't be billed. Absent file = no change.
export function installBrainOverride(dir:string){
  let o:{url:string;key:string};try{o=JSON.parse(readFileSync(join(dir,'brain-override.json'),'utf8'));}catch{return false;}
  if(!/^https:\/\//.test(o?.url)||!o.key)return false;
  const real=globalThis.fetch;
  globalThis.fetch=(async(input:any,init?:RequestInit)=>{
    if(String(input)!=='https://api.meta.ai/v1/chat/completions'||typeof init?.body!=='string')return real(input,init);
    const b=JSON.parse(init.body);delete b.model;
    // Azure rejects reasoning together with function tools.
    if(b.tools)b.reasoning_effort='none';
    const headers=new Headers(init.headers);headers.delete('authorization');headers.set('api-key',o.key);
    return real(o.url,{...init,headers,body:JSON.stringify(b)});
  }) as typeof fetch;
  return true;
}
