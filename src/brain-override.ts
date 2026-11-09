import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useHostedBrain } from './meta-brain-config.js';

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

const HOSTED:Record<string,string>={'https://api.meta.ai/v1/chat/completions':'/v1/brain','https://api.meta.ai/v1/responses':'/v1/responses','https://api.meta.ai/v1/images/generations':'/v1/image'};
/** Meta billing is down, so the brain's chat and image calls go to the FarFromDesk cloud (hosted luna and gpt-image)
 * under this laptop's cloud key. Callers keep their Meta request shapes; the cloud answers in the same shape. */
export function installHostedBrain(call:(path:string,body:unknown)=>Promise<{status:number;body:unknown}>){
  useHostedBrain();
  const real=globalThis.fetch;
  globalThis.fetch=(async(input:any,init?:RequestInit)=>{
    const path=HOSTED[String(input)];
    if(!path||typeof init?.body!=='string')return real(input,init);
    const r=await call(path,JSON.parse(init.body));
    return new Response(JSON.stringify(r.body),{status:r.status,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
}
