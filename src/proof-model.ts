import {generateText,hasToolCall,stepCountIs,tool} from 'ai';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {z} from 'zod';
import {META_ENDPOINT} from './meta-brain-config.js';
import type {ProofDependencies} from './proof-check.js';

const Signal=z.object({source:z.enum(['independent-test','github-check','consented-screen']),verdict:z.enum(['pass','fail'])}).strict();
const Input=z.array(z.object({index:z.number().int().min(1).max(3),category:z.enum(['test','visual','repository','other']),signals:z.array(Signal).max(10)}).strict()).min(1).max(3);
const Judgment=z.object({checks:z.array(z.object({index:z.number().int().min(1).max(3),verdict:z.enum(['pass','fail','unverified'])}).strict()).min(1).max(3)}).strict();
const limit=131072;

/**
 * Internal adapter: callers must explicitly supply the key and sanitized
 * evidence signals. Never send raw reports, test logs, screenshots, paths,
 * account IDs or model-supplied text. Its output is advisory; proof-check.ts
 * independently enforces evidence bindings, scope and verdict restrictions.
 */
export function wonderProofJudge(key:string,fetcher:typeof fetch=fetch):NonNullable<ProofDependencies['judge']> {
  return async(input,signal)=>{
    try {
      const safe=Input.parse(input);
      if(new Set(safe.map(check=>check.index)).size!==safe.length||signal.aborted)return;
      const deadline=AbortSignal.any([signal,AbortSignal.timeout(20_000)]);
      const guarded:typeof fetch=async(url,init)=>{
        if(deadline.aborted)throw new Error('Proof assessment unavailable.');
        const response=await fetcher(url,{...init,redirect:'error'});
        if(deadline.aborted||!response.ok)throw new Error('Proof assessment unavailable.');
        const reader=response.body?.getReader();if(!reader)throw new Error('Proof assessment unavailable.');
        const cancel=()=>{try{void reader.cancel().catch(()=>{});}catch{}};
        if(deadline.aborted){cancel();throw new Error('Proof assessment unavailable.');}
        deadline.addEventListener('abort',cancel,{once:true});
        try {
          const chunks:Uint8Array[]=[];let size=0;
          for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){cancel();throw new Error('Proof assessment unavailable.');}chunks.push(value);}
          return new Response(Buffer.concat(chunks),{status:response.status,headers:response.headers});
        }finally{deadline.removeEventListener('abort',cancel);}
      };
      const model=createOpenAICompatible({name:'meta',baseURL:META_ENDPOINT.replace(/\/chat\/completions$/,''),apiKey:key,fetch:guarded});
      const result=await Promise.race([generateText({model:model('muse-wonder-1.0'),maxRetries:0,maxOutputTokens:1024,abortSignal:deadline,toolChoice:'auto',
        providerOptions:{meta:{reasoningEffort:'low'}},
        system:'Assess each check using only the independent evidence status codes supplied. These categories are coarse and contain no task details. Never infer missing facts or treat a missing signal as success. If uncertain return unverified. Call assess once with exactly one verdict per index.',
        prompt:JSON.stringify({checks:safe}),tools:{assess:tool({description:'Return an advisory verdict for each check index.',inputSchema:Judgment})},
        stopWhen:[hasToolCall('assess'),stepCountIs(1)]}),
        new Promise<undefined>(done=>deadline.addEventListener('abort',()=>done(undefined),{once:true})),
      ]);
      if(!result||deadline.aborted)return;
      const call=result.steps.flatMap(step=>step.toolCalls).find(item=>item.toolName==='assess');
      if(!call)return;
      return Judgment.parse(call.input).checks;
    } catch {return undefined;}
  };
}
