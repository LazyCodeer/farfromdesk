import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { codexBin, claudeBin } from './config.js';
import { nativeCommand } from './platform.js';
import { CodexSession } from './codex-session.js';
import type { Binding, Provider, Store } from './store.js';
import type { ExecutionMode } from './desktop-claude.js';

const exec=promisify(execFile);
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=(path:string)=>{try{return realpathSync(path);}catch{return path;}};
export type Connection = {id:string;provider:Provider;executionMode:ExecutionMode;state:'verified'|'signed-out'|'unknown'|'native';label:string;revision:string;accountKey?:string};
export type SessionRoute={provider:Provider;executionMode:ExecutionMode;transport:'managed-cli'|'native-session';profileId:string;accountKey?:string;accountScope?:string;label:string};
export function connectionProfile(provider:Provider,mode:ExecutionMode,env=process.env) {
  const home=homedir();
  const root=mode==='desktop'&&provider==='claude'?join(home,'Library/Application Support/Claude'):
    provider==='codex'?(env.CODEX_HOME??join(home,'.codex')):(env.CLAUDE_CONFIG_DIR??join(home,'.claude'));
  return `${provider}:${mode}:${digest(canonical(root)).slice(0,20)}`;
}
function maskedEmail(value:unknown) {
  if(typeof value!=='string'||!value.includes('@'))return undefined;
  const [name,domain]=value.replace(/[\r\n\u0000-\u001f]/g,'').slice(0,160).split('@');
  return `${name.slice(0,1)}***@${domain}`;
}
/** Only these identity fields leave the native status response; never return credentials. */
export function accountStatus(provider:Provider,response:any,env=process.env):Pick<Connection,'state'|'label'|'accountKey'> {
  const row=provider==='codex'?response?.account:response;
  if(!row||(provider==='claude'&&row.loggedIn===false))return {state:'signed-out',label:'CLI signed out · sign in to this CLI'};
  const method=provider==='codex'?row.type:row.authMethod;
  const email=typeof row.email==='string'?row.email:undefined;
  const org=provider==='codex'?(row.workspaceId??row.organizationId):row.orgId;
  const identity=email||org||row.accountId;
  const key=provider==='codex'?env.OPENAI_API_KEY:(env.ANTHROPIC_AUTH_TOKEN??env.ANTHROPIC_API_KEY);
  if(!identity&&!key)return {state:'unknown',label:'CLI account could not be identified · review its sign-in'};
  return {state:'verified',label:key&&!identity?'Configured API credential · separate billing':`${maskedEmail(email)??'Verified account'} · ${method==='chatgpt'?'ChatGPT':provider==='claude'?'Claude CLI':'Codex CLI'}`,
    accountKey:digest([provider,method,email,org,row.accountId,row.apiProvider,key?digest(key):null])};
}
export async function probeAccount(provider:Provider,cwd:string):Promise<Pick<Connection,'state'|'label'|'accountKey'>> {
  if(provider==='claude') {
    const command=nativeCommand(claudeBin,['auth','status','--json']);
    let stdout:string;
    try {({stdout}=await exec(command.binary,command.args,{cwd:existsSync(cwd)?cwd:homedir(),timeout:5000,maxBuffer:65536,windowsHide:true}));}
    catch(e:any){if(typeof e.stdout==='string'&&e.stdout.trim().startsWith('{'))stdout=e.stdout;else throw new Error('CLI status unavailable');}
    return accountStatus(provider,JSON.parse(stdout));
  }
  const runtime=new CodexSession(codexBin,existsSync(cwd)?cwd:homedir(),async()=>{throw new Error('Account checks cannot approve operations.');});
  const timer=setTimeout(()=>runtime.close(),12000);
  try {
    await runtime.initialize();
    const config=(await runtime.request('config/read',{cwd,includeLayers:false}))?.config;
    const selected=config?.model_provider??'openai',p=config?.model_providers?.[selected];
    if(selected!=='openai'&&!p?.requires_openai_auth) {
      const key=typeof p?.env_key==='string'?process.env[p.env_key]:undefined;
      if(!key)return {state:'unknown',label:'Custom provider identity unavailable · review CLI configuration'};
      return {state:'verified',label:'Configured provider API credential · separate billing',accountKey:digest([selected,p?.base_url,digest(key)])};
    }
    const result=accountStatus(provider,await runtime.request('account/read',{refreshToken:false}));
    if(result.accountKey)result.accountKey=digest([result.accountKey,selected,p?.base_url]);
    return result;
  } finally {clearTimeout(timer);runtime.close();}
}

export class Connections {
  private cache=new Map<string,{until:number;value:Connection}>();
  private pending=new Map<string,Promise<Connection>>();
  constructor(private store:Store,private probe=probeAccount) {}
  async read(provider:Provider,mode:ExecutionMode,fresh=false,cwd=homedir()):Promise<Connection> {
    const id=connectionProfile(provider,mode),key=id+':'+canonical(cwd);
    const cached=this.cache.get(key);if(!fresh&&cached&&cached.until>Date.now())return {...cached.value};
    const existing=this.pending.get(key);if(existing)return {...await existing};
    if(this.pending.size>=8)throw new Error('CLI account checks are busy. Retry this exact connection shortly.');
    const task=(async()=>{
      let status:Pick<Connection,'state'|'label'|'accountKey'>={state:'native',label:'Uses the selected desktop chat’s account · identity not exposed'};
      if(mode==='cli')try{status=await this.probe(provider,cwd);}catch{status={state:'unknown',label:'CLI account check unavailable · no Desktop fallback'};}
      const value={id,provider,executionMode:mode,...status,revision:digest([id,status])};
      this.cache.set(key,{until:Date.now()+15000,value});while(this.cache.size>64)this.cache.delete(this.cache.keys().next().value!);
      return value;
    })();
    this.pending.set(key,task);try{return {...await task};}finally{this.pending.delete(key);}
  }
  route(b:Binding):SessionRoute|undefined {const raw=this.store.get(`session-route:${b.id}`);return raw?JSON.parse(raw):undefined;}
  save(b:Binding,route:SessionRoute) {this.store.set(`session-route:${b.id}`,JSON.stringify(route));this.store.set(`execution-mode:${b.id}`,route.executionMode);}
  async choose(b:Binding,mode:ExecutionMode,managed:boolean,accountScope?:string,expectedRevision?:string) {
    const route=await this.prepare(b,mode,managed,accountScope,expectedRevision);this.save(b,route);return route;
  }
  async prepare(b:Pick<Binding,'provider'|'cwd'>,mode:ExecutionMode,managed:boolean,accountScope?:string,expectedRevision?:string) {
    const c=managed||expectedRevision?await this.read(b.provider,managed?'cli':mode,true,b.cwd):
      {id:connectionProfile(b.provider,mode),state:'native',label:'Existing native session account',revision:'',accountKey:undefined};
    // A preview made outside a project is not sufficient for project-specific CLI config.
    if(expectedRevision&&expectedRevision!==c.revision)throw new Error('Connection changed since selection. Review the account and select again.');
    if(managed&&c.state!=='verified')throw new Error(c.label+'. Sign in or configure this CLI, then select it again.');
    const route:SessionRoute={provider:b.provider,executionMode:mode,transport:managed?'managed-cli':'native-session',profileId:c.id,
      accountKey:managed?c.accountKey:undefined,accountScope,label:managed?c.label:`${b.provider==='claude'?'Claude':'Codex'} ${mode==='desktop'?'Desktop':'CLI'} · existing session account`};
    return route;
  }
  async assert(b:Binding) {
    const route=this.route(b);if(!route)return;
    if(route.provider!==b.provider||route.executionMode!==this.store.get(`execution-mode:${b.id}`)||route.profileId!==connectionProfile(b.provider,route.executionMode))
      throw new Error('Session connection changed. Select its original platform/profile again; no fallback was used.');
    if(route.transport==='managed-cli') {
      const current=await this.read(b.provider,'cli',true,b.cwd);
      if(current.state!=='verified'||current.accountKey!==route.accountKey)throw new Error('CLI account or provider changed. Review and reselect this session before sending more work. No other account was used.');
    }
  }
}
