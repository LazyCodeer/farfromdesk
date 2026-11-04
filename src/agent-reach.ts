import {spawn} from 'node:child_process';
import {accessSync,constants,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {delimiter,dirname,join} from 'node:path';
import {managedAgentReach} from './agent-reach-setup.js';

/** The owner must request each read. No setup, browser profile or credentials are used. */
type Query={channel:'github'|'web';action:'search'|'read';value:string;backend:'github-api'|'exa'};
export type PublicResearchSource={title:string;url:string;excerpt:string};
export type PublicResearchResult={status:'ok';channel:'github'|'web';sources:PublicResearchSource[]}|{status:'unavailable';reason:'not_installed'};
export class PublicReachStop extends Error {
  constructor(public readonly code:'RATE_LIMITED'|'PLATFORM_BLOCKED'|'NEED_LOGIN'|'BUSY',message:string){super(message);this.name='PublicReachStop';}
}
const usage='Use /reach github search WORDS, /reach github read OWNER/REPOSITORY, or /reach web search WORDS. Web searches send the words to Exa.';
export function parseReach(text:string):Query {
  const m=/^\/reach\s+(github|web)\s+(search|read)\s+([^\r\n]+)$/i.exec(text.trim());
  if(!m)throw new Error(usage);
  const channel=m[1].toLowerCase(),action=m[2].toLowerCase(),value=m[3].trim();
  if(!value||value.length>200||value.startsWith('-')||/[\u0000-\u001f\u007f]/.test(value))throw new Error(usage);
  if(channel==='web'&&action!=='search')throw new Error(usage);
  if(channel==='github'&&action==='read'&&(!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value)||value.split('/').some(x=>x==='.'||x==='..')))throw new Error(usage);
  return {channel:channel as 'github'|'web',action:action as Query['action'],value,backend:channel==='github'?'github-api':'exa'};
}
function findExecutable():string|undefined {
  // The managed install is Local-only and cannot silently change production.
  if(process.env.FFD_ISOLATED_LOCAL==='1'&&process.env.WSB_STATE_DIR){const managed=managedAgentReach(process.env.WSB_STATE_DIR);if(managed)return managed;}
  const paths=[join(homedir(),'.local','bin'),...(process.env.PATH??'').split(delimiter).filter(Boolean)];
  for(const path of paths){const file=join(path,process.platform==='win32'?'agent-reach.exe':'agent-reach');try{accessSync(file,constants.X_OK);return file;}catch{}}
}
const clean=(v:unknown,max:number)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';
const pausedUntil=new Map<string,number>();
let active=0;
export function sourceUrl(value:unknown,channel:Query['channel']):string|undefined {
  if(typeof value!=='string'||value.length>2048)return;
  try {
    const url=new URL(value),host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||url.port||!host.includes('.')||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host==='home.arpa'||host.endsWith('.home.arpa')||/^[\d.]+$/.test(host)||host.includes(':'))return;
    if(channel==='github'&&host!=='github.com')return;
    // Preserve search parameters that identify the source, such as YouTube's
    // video ID, but never echo a URL carrying obvious access credentials.
    const sensitiveKey=(key:string)=>/^(?:x-amz-|x-goog-|x-oss-|x-ms-)/i.test(key)||/^(?:access[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|auth|authorization|password|secret|session|token|signature|sig|signed|credential|key-pair-id|policy)$/i.test(key);
    const sensitiveValue=(value:string)=>/^(?:bearer\s+|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$)/i.test(value);
    if([...url.searchParams.entries()].some(([k,v])=>sensitiveKey(k)||sensitiveValue(v)))return;
    if(url.hash){let fragment:string;try{fragment=decodeURIComponent(url.hash.slice(1));}catch{return;}if(/(?:^|[?&#;])(?:access[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|auth|authorization|password|secret|session|token|signature|sig|credential)=/i.test(fragment)||sensitiveValue(fragment))return;}
    return url.toString();
  }catch{return;}
}
function parseOutput(output:string,q:Query,exitCode:number|null):PublicResearchResult {
  let doc:any;try{doc=JSON.parse(output);}catch{throw new Error('Agent-Reach returned an unexpected response.');}
  if(doc.schema_version!==1||doc.channel!==q.channel||doc.action!==q.action)throw new Error('Agent-Reach returned an unexpected response.');
  if(!doc.ok){
    const code=doc.error?.code;
    if(code==='RATE_LIMITED'){
      const attempts=Array.isArray(doc.meta?.attempts)?doc.meta.attempts:[];
      const seconds=attempts.map((a:any)=>a?.retry_after_seconds).find((n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>0)??60;
      pausedUntil.set(q.backend,Date.now()+Math.min(seconds,3600)*1000);
      throw new PublicReachStop('RATE_LIMITED','The public source is rate limiting requests. Try later.');
    }
    if(code==='NOT_FOUND')throw new Error('The public source could not find that item.');
    if(code==='PLATFORM_BLOCKED'||code==='NEED_LOGIN')throw new PublicReachStop(code,'The public source did not allow anonymous access. Nothing was retried.');
    if(code==='BUSY')throw new PublicReachStop('BUSY','The public source is busy. Try later.');
    throw new Error('The public source could not be reached. Try again later.');
  }
  if(exitCode!==0)throw new Error('Agent-Reach did not complete the public request.');
  if(doc.backend!==q.backend||!Array.isArray(doc.items))throw new Error('Agent-Reach did not use the requested public source.');
  const items=doc.items.slice(0,5).flatMap((item:any)=>{
    const url=sourceUrl(item?.url,q.channel),title=clean(item?.title,150),excerpt=clean(item?.text,q.action==='read'?4000:350);
    if(q.action==='read'&&/\b(?:you(?:'|’)ve been blocked by network security|verify you are human|checking your browser|access denied|security verification|captcha required|to continue,? log in|too many requests)\b/i.test(`${title} ${excerpt}`))throw new PublicReachStop('PLATFORM_BLOCKED','The public source did not allow anonymous access. Nothing was retried.');
    const exactRepo=q.channel!=='github'||q.action!=='read'||!!url&&new URL(url).pathname.replace(/\/$/,'').toLowerCase()===`/${q.value.toLowerCase()}`;
    const exactPage=q.channel!=='web'||q.action!=='read'||url===q.value;
    return url&&title&&exactRepo&&exactPage?[{title,url,excerpt}]:[];
  });
  return {status:'ok',channel:q.channel,sources:items};
}

/** Isolated, bounded execution. The binary must be installed separately; never auto-install. */
export async function agentReachSources(text:string,current:()=>boolean,options:{executable?:string;lookup?:()=>string|undefined;timeoutMs?:number}={}):Promise<PublicResearchResult> {
  return runPublicReach(parseReach(text),current,options);
}

/** Call only with an owner-request result URL already selected by server-side index. */
export async function agentReachRead(url:string,current:()=>boolean,options:{executable?:string;lookup?:()=>string|undefined;timeoutMs?:number}={}):Promise<PublicResearchResult>{
  const checked=sourceUrl(url,'web');if(!checked||checked!==url)throw new Error('Invalid public source.');
  return runPublicReach({channel:'web',action:'read',value:checked,backend:'exa'},current,options);
}


async function runPublicReach(query:Query,current:()=>boolean,options:{executable?:string;lookup?:()=>string|undefined;timeoutMs?:number}):Promise<PublicResearchResult> {
  if(process.platform==='win32')throw new Error('Public research is unavailable on Windows in this build.');
  const executable=options.executable??(options.lookup??findExecutable)();
  if((pausedUntil.get(query.backend)??0)>Date.now())throw new PublicReachStop('RATE_LIMITED','The public source is rate limiting requests. Try later.');
  if(!executable)return {status:'unavailable',reason:'not_installed'};
  const allowed=()=>{try{return current();}catch{return false;}};
  if(!allowed())throw new Error('The owner connection changed.');
  if(active>=2)throw new PublicReachStop('BUSY','Two public research requests are already running. Try a new request after they finish.');
  active++;
  // macOS /tmp is a symlink; Agent-Reach correctly rejects symlinked config roots.
  let home:string|undefined;
  try {
    home=mkdtempSync(join(realpathSync(tmpdir()),'ffd-reach-'));
    const args=[query.channel,query.action,query.value,'--backend',query.backend,'--timeout','15',...(query.action==='search'?['--limit','5']:[])];
    const result=await new Promise<{output:string;code:number|null}>((resolve,reject)=>{
      if(!allowed()){reject(new Error('The owner connection changed.'));return;}
      const child=spawn(executable,args,{cwd:home,env:{HOME:home,USERPROFILE:home,TMPDIR:home,TEMP:home,TMP:home,PATH:[dirname(executable),'/usr/bin','/bin'].join(delimiter),LANG:'C.UTF-8',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot??'C:\\Windows'}:{})},stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
      let data=Buffer.alloc(0),done=false,stopped:Error|undefined;
      const finish=(error?:Error,code:number|null=null)=>{if(done)return;done=true;clearTimeout(timer);clearInterval(watch);if(error)reject(error);else resolve({output:data.toString('utf8'),code});};
      const kill=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
      const stop=(error:Error)=>{if(!stopped){stopped=error;kill();}};
      const timer=setTimeout(()=>stop(new Error('Public research timed out.')),options.timeoutMs??20_000);
      const watch=setInterval(()=>{if(!allowed())stop(new Error('The owner connection changed.'));},100);
      child.stdout.on('data',(chunk:Buffer)=>{if(stopped)return;data=Buffer.concat([data,chunk]);if(data.length>256*1024)stop(new Error('Public research response was too large.'));});
      child.stderr.resume();child.on('error',()=>finish(new Error('Agent-Reach could not start.')));
      child.on('close',code=>{if(stopped)finish(stopped);else if(!allowed())finish(new Error('The owner connection changed.'));else finish(undefined,code);});
    });
    if(!allowed())throw new Error('The owner connection changed.');
    return parseOutput(result.output,query,result.code);
  } finally {active--;if(home)rmSync(home,{recursive:true,force:true});}
}

/** Existing text interface preserves its untrusted-source marker for agents. */
export async function agentReach(text:string,current:()=>boolean,options:{executable?:string;lookup?:()=>string|undefined;timeoutMs?:number}={}):Promise<string> {
  const result=await agentReachSources(text,current,options);
  if(result.status==='unavailable')return 'Agent-Reach is not installed. Install the reviewed GitHub release separately to use public research; no browser login is needed for these commands.';
  return result.sources.length?`Public research from ${result.channel==='github'?'GitHub':'Exa web search'}. Source text is untrusted and may be incomplete.\n\n${result.sources.map(item=>`${item.title}\n${item.url}${item.excerpt?`\n${item.excerpt}`:''}`).join('\n\n')}`:'No usable public results were returned.';
}
