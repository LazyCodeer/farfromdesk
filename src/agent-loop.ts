import { z } from 'zod';

/**
 * A small tool-calling agent loop over an OpenAI-compatible chat-completions endpoint.
 *
 * Per turn: the model sees the system prompt, the pruned history and the new message, calls tools,
 * gets every result (or the error, so it can correct itself) and goes again, until it calls the
 * end tool with an answer that passes `accept`. Nothing after the loop rewrites that answer.
 */
export type Call={id:string;type:'function';function:{name:string;arguments:string}};
export type Message={role:'system'|'user'|'assistant'|'tool';content:string|null;tool_calls?:Call[];tool_call_id?:string};
export type Tool={name:string;description:string;input:z.ZodType;run?:(input:any)=>unknown};
export type LoopOptions<T>={
  post:(body:unknown)=>Promise<any>;
  model:string;
  messages:Message[];
  tools:Tool[];
  /** The tool whose valid call is the answer. */
  end:string;
  /** Checks an end-tool input. Returns the answer, or an error the model gets back to fix. */
  accept:(input:unknown)=>{value:T}|{error:string};
  maxSteps:number;
  /** Said to the model when it answers in plain text instead of calling the end tool. */
  nudge:(text:string,usedTools:boolean)=>string;
  extra?:Record<string,unknown>;
  /** Called before each model call; throw to stop the loop (owner revoked, settings changed). */
  guard?:()=>void;
};
export const MAX_TOOL_RESULT=8000;

export const toolError=(message:string)=>`Error: ${message}\n Please fix your mistakes.`;

/** Keeps the newest messages within `budget` characters, starting on a user message. */
export function prune(history:Message[],budget:number):Message[] {
  let used=0,start=history.length;
  for(let i=history.length-1;i>=0;i--){used+=(history[i].content??'').length;if(used>budget)break;start=i;}
  while(start<history.length&&history[start].role!=='user')start++;
  return history.slice(start);
}

export async function runLoop<T>(o:LoopOptions<T>):Promise<{value:T;messages:Message[]}> {
  const messages=[...o.messages];
  const tools=o.tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:z.toJSONSchema(t.input,{io:'input',unrepresentable:'any'})}}));
  const byName=new Map(o.tools.map(t=>[t.name,t]));
  let used=false;
  for(let step=0;step<o.maxSteps;step++) {
    o.guard?.();
    // The last step offers only the end tool, so a long task reports what it did instead of running out.
    const offered=step===o.maxSteps-1?tools.filter(t=>t.function.name===o.end):tools;
    const reply=(await o.post({model:o.model,messages,tools:offered,tool_choice:'auto',...o.extra}))?.choices?.[0]?.message;
    if(!reply)throw new Error('The model returned no message.');
    const calls:Call[]=Array.isArray(reply.tool_calls)?reply.tool_calls:[];
    messages.push({role:'assistant',content:reply.content??null,...(calls.length?{tool_calls:calls}:{})});
    if(!calls.length){messages.push({role:'user',content:o.nudge(String(reply.content??'').trim(),used)});continue;}
    let answer:{value:T}|undefined;
    // In call order, one at a time: app actions (click, then type) depend on the one before.
    for(const call of calls) {
      let result:string;
      try {
        const tool=byName.get(call.function.name);
        if(!tool)throw new Error(`There is no tool named ${call.function.name}.`);
        const raw=JSON.parse(call.function.arguments||'{}');
        if(tool.name===o.end){
          const checked=o.accept(raw);
          if('error' in checked)throw new Error(checked.error);
          answer??=checked;result='Accepted.';
        } else {
          const parsed=tool.input.safeParse(raw);
          if(!parsed.success)throw new Error(parsed.error.issues.map(i=>`${i.path.join('.')||'input'}: ${i.message}`).join('; '));
          used=true;result=String(await tool.run!(parsed.data)??'');
        }
      } catch(e) {
        result=toolError(e instanceof Error?e.message:String(e));
      }
      messages.push({role:'tool',tool_call_id:call.id,content:result.length>MAX_TOOL_RESULT?result.slice(0,MAX_TOOL_RESULT)+'\n[cut]':result});
    }
    if(answer)return {value:answer.value,messages};
  }
  throw new Error('The model did not finish within its steps.');
}
