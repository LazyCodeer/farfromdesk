import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { Store, Binding } from './store.js';
import { masterPolicy } from './master-policy.js';
import { workerPolicy } from './worker-policy.js';
import { companionOperatingInstructions } from './role-instructions.js';

export type NamedAgent={name:string;description:string;instructions:string;kind:'master'|'worker'};
export type AgentRoots={codex:string;claude:string};
// Provider homes are trusted local configuration and may be deliberately moved
// to another disk. Resolve that home once; agent directories/files remain guarded.
function providerHome(path:string) {try{return realpathSync(path);}catch{return resolve(path);}}
export const agentRoots=():AgentRoots=>({codex:join(providerHome(process.env.CODEX_HOME??join(homedir(),'.codex')),'agents'),claude:join(providerHome(process.env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude')),'agents')});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const builtins=():NamedAgent[]=>[
  {name:'farfromdesk-coordinator',kind:'master',description:'Coordinate owner-selected coding sessions through WhatsApp with scoped handoffs, useful progress and verified results.',instructions:masterPolicy},
  {name:'farfromdesk-worker',kind:'worker',description:'Complete an owner-authorized task in the exact coding session and report evidence through FarFromDesk.',instructions:workerPolicy},
];
export function agentName(value:unknown) {
  if(typeof value!=='string'||!/^farfromdesk-[a-z][a-z0-9-]{0,47}$/.test(value))throw new Error('Use a lowercase agent name such as farfromdesk-code-reviewer (letters, numbers and hyphens).');
  return value;
}
export function listNamedAgents(store:Store) {
  return [...builtins(),...store.db.prepare("SELECT value FROM settings WHERE key LIKE 'agent-definition:%' ORDER BY key").all().map((r:any)=>JSON.parse(r.value) as NamedAgent)];
}
export function agentDefinition(store:Store,name:string):NamedAgent {
  agentName(name);const agent=listNamedAgents(store).find(a=>a.name===name);
  if(!agent)throw new Error('Unknown named agent. List agents and choose its exact name.');return agent;
}
export function defineNamedAgent(store:Store,input:any,roots=agentRoots()) {
  const name=agentName(input?.name);
  if(builtins().some(a=>a.name===name))throw new Error('Built-in FarFromDesk roles cannot be overwritten.');
  if(typeof input.description!=='string'||input.description.length<10||input.description.length>400||/[\x00-\x1f]/.test(input.description))throw new Error('Provide a one-line description of 10–400 characters.');
  if(typeof input.instructions!=='string'||input.instructions.trim().length<80||Buffer.byteLength(input.instructions)>12000||input.instructions.includes('\0'))throw new Error('Provide detailed role instructions (80 characters to 12 KB).');
  const definition:NamedAgent={name,description:input.description,instructions:`# ${name}\n\n## Specialty and owner instructions\n${input.instructions.trim()}\n\n${workerPolicy}`,kind:'worker'};
  const key=`agent-definition:${name}`,previous=store.get(key);
  if(previous&&previous!==JSON.stringify(definition))throw new Error('This name already has different instructions. Choose a new name to preserve the existing role.');
  store.set(key,JSON.stringify(definition));
  return {agent:{name,description:definition.description,kind:definition.kind},installation:installNamedAgent(store,definition,roots)};
}
function safeDirectory(path:string) {
  const abs=resolve(path),parent=dirname(abs);
  if(parent!==abs&&!existsSync(abs))safeDirectory(parent);
  if(!existsSync(abs))mkdirSync(abs,{mode:0o700});
  const st=lstatSync(abs);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Agent directory must be a real directory.');
  // Check existing parents too; never follow a redirected provider directory.
  let p=parent;
  while(dirname(p)!==p){if(lstatSync(p).isSymbolicLink())throw new Error('Agent directory has a symlinked parent.');p=dirname(p);}
  return realpathSync(abs);
}
export function renderNamedAgent(agent:NamedAgent,provider:'codex'|'claude') {
  const instructions=[companionOperatingInstructions,agent.instructions].join('\n\n');
  const marker='# Managed by FarFromDesk; existing user agents are never overwritten.\n';
  if(provider==='codex')return marker+`name = ${JSON.stringify(agent.name)}\ndescription = ${JSON.stringify(agent.description)}\ndeveloper_instructions = ${JSON.stringify(instructions)}\n`;
  return `---\nname: ${agent.name}\ndescription: ${JSON.stringify(agent.description)}\nmodel: inherit\n---\n\n${marker}\n${instructions}\n`;
}
export function installNamedAgent(store:Store,agent:NamedAgent,roots=agentRoots()) {
  const installation=(['codex','claude'] as const).map(provider=>{
    const filename=agent.name+(provider==='codex'?'.toml':'.md');let path=join(roots[provider],filename);
    try {
      agentName(agent.name);path=join(safeDirectory(roots[provider]),filename);
      const content=renderNamedAgent(agent,provider),digest=hash(content),key=`agent-install:${hash(path)}`;
      if(existsSync(path)) {
        const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw new Error('Unsafe existing agent file.');
        if(st.size>256*1024)return {provider,path,status:'conflict' as const};
        const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let current:string;try{current=readFileSync(fd,'utf8');}finally{closeSync(fd);}
        if(current===content){store.set(key,digest);return {provider,path,status:'installed' as const};}
        if(store.get(key)!==hash(current))return {provider,path,status:'conflict' as const};
        const temp=path+'.'+randomUUID()+'.tmp';
        try {writeFileSync(temp,content,{flag:'wx',mode:0o600});renameSync(temp,path);}finally{if(existsSync(temp))unlinkSync(temp);}
      } else writeFileSync(path,content,{flag:'wx',mode:0o600});
      store.set(key,digest);return {provider,path,status:'installed' as const};
    }catch{return {provider,path,status:'unavailable' as const};}
  });
  let previous:{name:string;installation:unknown}[]=[];
  try {const saved=JSON.parse(store.get('agent-install-status')??'[]');if(Array.isArray(saved))previous=saved;}catch{}
  store.set('agent-install-status',JSON.stringify([...previous.filter(a=>a.name!==agent.name),{name:agent.name,installation}]));
  return installation;
}
export function syncNamedAgents(store:Store,roots=agentRoots()) {
  const result=listNamedAgents(store).map(agent=>({name:agent.name,installation:installNamedAgent(store,agent,roots)}));
  store.set('agent-install-status',JSON.stringify(result));return result;
}
export function assignNamedAgent(store:Store,b:Binding,name:string,roots=agentRoots()) {
  const agent=agentDefinition(store,name);
  if(agent.kind==='master'&&b.id!==store.get('master')&&store.get(`role-kind:${b.id}`)!=='master')throw new Error('The coordinator role can only be assigned to the selected coordinator.');
  const installation=installNamedAgent(store,agent,roots);
  store.set(`named-agent:${b.id}`,agent.name);
  return {bindingId:b.id,agentName:agent.name,applies:'next-request',installation};
}
