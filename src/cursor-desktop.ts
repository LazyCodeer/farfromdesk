import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import type {Session} from './session-catalog.js';
import {cursorConversationDb,cursorOwnerHome,cursorProjectsDir,cursorProjectPath} from './cursor-paths.js';

/**
 * Cursor's agent runs inside the app, and the app is reachable from outside through exactly one
 * documented surface: the prompt deeplink. `cursor://anysphere.cursor-deeplink/prompt?text=...` only
 * PREFILLS a Cursor window that is already open - measured live: it never opens a window and never
 * submits - so a delivered prompt runs only while the owner has Cursor open and, unless their Cursor
 * is configured to auto-run, presses Enter. When the turn does run, the app writes the exchange to the
 * chat transcript under `~/.cursor/projects/<project>/agent-transcripts/<chatId>/<chatId>.jsonl`,
 * ending it with a `turn_ended` line. The transcript is therefore both the session list and the answer
 * channel.
 *
 * Delivery and completion are two separate facts, and they are read separately here: the deeplink
 * being accepted only means Cursor took (prefilled) the prompt, while a `turn_ended` line is what says
 * the agent finished. A run that never reaches `turn_ended` - the common case when no window is open,
 * or nobody presses Enter - is reported as unfinished rather than answered, so the failure stays
 * visible instead of being mistaken for an autonomous turn.
 *
 * The deeplink has no chat-id parameter, so a delivered prompt starts a new chat every time and can
 * not be aimed at an existing one. `workspace` routes to a window whose workspace name matches, and a
 * name that matches no open window is silently ignored - the prompt is then only prefilled and never
 * runs - so it is passed only when the caller knows the owner has that project open.
 */
export type CursorMessage={role:'user'|'assistant';text:string;tools:string[]};
export type CursorTranscriptFile={file:string;chatId:string;project:string;updatedAt:number};
export type CursorChat=CursorTranscriptFile&{title:string;cwd:string};
export type CursorTranscript={messages:CursorMessage[];complete:boolean};
export type CursorTurnOptions={
  prompt:string;
  workspace?:string;
  mode?:string;
  timeoutMs?:number;
  pollMs?:number;
  env?:NodeJS.ProcessEnv;
  open?:(url:string)=>Promise<void>;
  /** A signed-in `cursor-agent`, from findCursorCli. When set the turn runs by command: no window, no focus. */
  cli?:string;
  /** The folder the command-line agent works in. */
  cwd?:string;
  /** How long Cursor may take to show it took the prompt before the run is reported as not picked up. */
  pickupMs?:number;
};
export type CursorTurnResult={text:string;sessionId:string|null};

// A transcript is read from its tail: the exchange we are waiting for is always the newest one, and
// the older part of a long chat is not needed to answer it. Titles come from the head instead.
const MAX_READ_BYTES=8*1024*1024;
const MAX_TITLE_BYTES=64*1024;
const MAX_CHATS=50;

export function cursorPromptUrl(prompt:string,options:{workspace?:string;mode?:string}={}):string {
  const params=new URLSearchParams({text:prompt});
  const workspace=options.workspace?.trim();
  if(workspace)params.set('workspace',workspace);
  const mode=options.mode?.trim();
  if(mode)params.set('mode',mode);
  // Spaces are encoded as %20 rather than as the form-encoded `+`, which a URL parser is free to
  // leave alone.
  return `cursor://anysphere.cursor-deeplink/prompt?${params.toString().replace(/\+/g,'%20')}`;
}

/**
 * Read a bounded slice of a file. Cursor appends whole JSON lines, so a tail slice is trimmed to its
 * first complete line and a head slice to its last, leaving every retained line parseable.
 */
export function readBounded(file:string,maxBytes:number,from:'head'|'tail'='tail'):string {
  let buffer:Buffer;
  try{buffer=readFileSync(file);}catch{return '';}
  if(buffer.length<=maxBytes)return buffer.toString('utf8');
  if(from==='head'){
    const end=buffer.lastIndexOf(0x0a,maxBytes);
    return buffer.subarray(0,end<0?maxBytes:end).toString('utf8');
  }
  const start=buffer.length-maxBytes;
  const newline=buffer.indexOf(0x0a,start);
  return buffer.subarray(newline<0?start:newline+1).toString('utf8');
}

/** Parse one transcript file. Unreadable lines are skipped: a record being written is not a message. */
export function readCursorTranscript(file:string,maxBytes=MAX_READ_BYTES,from:'head'|'tail'='tail'):CursorTranscript {
  const messages:CursorMessage[]=[];
  let complete=false;
  for(const line of readBounded(file,maxBytes,from).split('\n')){
    const text=line.trim();
    if(!text.startsWith('{'))continue;
    let record:any;
    try{record=JSON.parse(text);}catch{continue;}
    if(record?.type==='turn_ended'){complete=true;continue;}
    const role=record?.role;
    if(role!=='user'&&role!=='assistant')continue;
    const parts=Array.isArray(record?.message?.content)?record.message.content:[];
    const texts:string[]=[],tools:string[]=[];
    for(const part of parts){
      if(part?.type==='text'&&typeof part.text==='string')texts.push(part.text);
      else if(part?.type==='tool_use'&&typeof part.name==='string')tools.push(part.name);
    }
    if(!texts.length&&!tools.length)continue;
    messages.push({role,text:texts.join('\n'),tools});
  }
  return {messages,complete};
}

/** Cursor wraps the owner's own text in timestamp and user_query tags; the title should not keep them. */
export function cursorUserText(raw:string):string {
  const match=/<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(raw);
  const text=(match?match[1]:raw).replace(/<timestamp>[\s\S]*?<\/timestamp>/g,'');
  return text.replace(/\s+/g,' ').trim();
}

/** Chat titles live in the searchable chat list; the transcripts themselves carry no title. */
export function cursorChatTitles(env:NodeJS.ProcessEnv=process.env):Map<string,string> {
  const out=new Map<string,string>();
  const file=cursorConversationDb(env);
  if(!existsSync(file))return out;
  let db:DatabaseSync;
  try{db=new DatabaseSync(file,{readOnly:true});}catch{return out;}
  try{
    for(const row of db.prepare('SELECT id,title FROM conversations').all() as any[]){
      const id=typeof row?.id==='string'?row.id:'';
      const title=typeof row?.title==='string'?row.title.trim():'';
      if(id&&title)out.set(id,title);
    }
  }catch{/* an unreadable chat list only costs the titles */}
  finally{try{db.close();}catch{}}
  return out;
}

/**
 * Every chat Cursor has written a transcript for. Subagent transcripts live one level deeper and are
 * excluded: they are the agent's internal workers, not chats the owner can select.
 */
export function cursorTranscriptFiles(env:NodeJS.ProcessEnv=process.env):CursorTranscriptFile[] {
  const root=cursorProjectsDir(env);
  let projects:string[]=[];
  try{projects=readdirSync(root,{withFileTypes:true}).filter((entry)=>entry.isDirectory()&&!entry.name.startsWith('.')).map((entry)=>entry.name);}catch{return [];}
  const files:CursorTranscriptFile[]=[];
  for(const project of projects){
    const dir=join(root,project,'agent-transcripts');
    let entries;
    try{entries=readdirSync(dir,{withFileTypes:true});}catch{continue;}
    for(const entry of entries){
      if(!entry.isDirectory())continue;
      const file=join(dir,entry.name,`${entry.name}.jsonl`);
      let updatedAt:number;
      try{updatedAt=statSync(file).mtimeMs;}catch{continue;}
      files.push({file,chatId:entry.name,project,updatedAt});
    }
  }
  return files;
}

export function cursorChats(env:NodeJS.ProcessEnv=process.env):CursorChat[] {
  const titles=cursorChatTitles(env);
  return cursorTranscriptFiles(env).map((entry)=>{
    const first=readCursorTranscript(entry.file,MAX_TITLE_BYTES,'head').messages.find((message)=>message.role==='user');
    return {
      ...entry,
      cwd:cursorProjectPath(entry.project,env)??'',
      title:titles.get(entry.chatId)||cursorUserText(first?.text??'').slice(0,80)||entry.chatId,
    };
  }).sort((a,b)=>b.updatedAt-a.updatedAt);
}

export function cursorSessions(env:NodeJS.ProcessEnv=process.env):Session[] {
  return cursorChats(env).slice(0,MAX_CHATS).map((chat)=>({
    id:chat.chatId,
    provider:'cursor',
    cwd:chat.cwd,
    name:chat.title,
    status:'Cursor chat · desktop',
    updatedAt:chat.updatedAt,
    executionMode:'cli',
    available:true,
  }));
}

function openUrl(url:string):Promise<void> {
  return new Promise((resolve,reject)=>{
    const command=process.platform==='darwin'?'open':process.platform==='win32'?'explorer':'xdg-open';
    const child=spawn(command,[url],{stdio:'ignore',detached:false});
    child.on('error',(error)=>reject(new Error(`Cursor could not be opened: ${error.message}`)));
    child.on('close',(code)=>code===0?resolve():reject(new Error(`Cursor could not be opened (exit ${code ?? 'unknown'}).`)));
  });
}

function sleep(ms:number):Promise<void>{return new Promise((resolve)=>setTimeout(resolve,ms));}

/** The app's prefill needs Cursor running, so a closed Cursor is opened first instead of the prompt being lost. */
async function openInCursor(url:string):Promise<void> {
  const running=()=>{try{execFileSync('/usr/bin/pgrep',['-xq','Cursor']);return true;}catch{return false;}};
  if(process.platform==='darwin'&&!process.env.NODE_TEST_CONTEXT&&!running()){
    await new Promise<void>(resolve=>spawn('/usr/bin/open',['-a','Cursor'],{stdio:'ignore'}).on('close',()=>resolve()).on('error',()=>resolve()));
    for(let i=0;i<30&&!running();i++)await sleep(500);
    await sleep(5000); // its window restores a few seconds after the process starts
  }
  await openUrl(url);
}

/** Cursor's own command-line agent, when it is installed and signed in in the owner's home. */
export function findCursorCli(env:NodeJS.ProcessEnv=process.env):string|undefined {
  const home=cursorOwnerHome(env),bin=env.CURSOR_AGENT_BIN?.trim()||join(home,'.local','bin','cursor-agent');
  if(process.env.NODE_TEST_CONTEXT&&!env.CURSOR_AGENT_BIN||!existsSync(bin))return;
  try{
    const out=execFileSync(bin,['status'],{env:{...env,HOME:home},timeout:15000,encoding:'utf8'});
    return /not logged in/i.test(out)?undefined:bin;
  }catch{return;}
}

/**
 * One headless turn. The stream lists each message Cursor wrote; its final `result` glues them all
 * together, so a working note ran straight into the answer (live: "...exact ping string.PONG").
 * The answer is what Cursor wrote after its last tool call. `--force` lets it run shell commands
 * (the owner chose this on 5 Nov 2026): without it every command is refused, including the curl that
 * reaches the owner's Mac apps.
 */
function runCursorCli(bin:string,prompt:string,cwd:string|undefined,timeoutMs:number,env:NodeJS.ProcessEnv):Promise<CursorTurnResult> {
  return new Promise((resolve,reject)=>{
    const child=spawn(bin,['-p','--output-format','stream-json','--trust','--force',...(cwd?['--workspace',cwd]:[]),prompt],{cwd,env:{...env,HOME:cursorOwnerHome(env)},stdio:['ignore','pipe','pipe']});
    let out='',err='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('Cursor did not finish this turn in time.'));},timeoutMs);
    child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
    child.on('error',e=>{clearTimeout(timer);reject(new Error(`Cursor could not start: ${e.message}`));});
    child.on('close',code=>{
      clearTimeout(timer);
      let answer:string[]=[],result:any;
      for(const line of out.split('\n')){
        let e:any;try{e=JSON.parse(line);}catch{continue;}
        if(e.type==='tool_call')answer=[];
        else if(e.type==='assistant')answer.push((e.message?.content??[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('').trim());
        else if(e.type==='result')result=e;
      }
      if(code!==0||!result||result.is_error)return reject(new Error(`Cursor failed: ${String(result?.result??err??out).trim().slice(0,300)||`exit ${code}`}`));
      const text=answer.filter(Boolean).join('\n\n')||String(result.result??'').trim();
      resolve({text,sessionId:result.session_id??null});
    });
  });
}

/**
 * Hand one prompt to Cursor as a prefill of an open window and wait for the turn it starts to finish,
 * returning the answer text and the chat id Cursor wrote it to. This is a hand-off, not autonomous
 * delivery: if no Cursor window is open nothing runs. Rejects when the turn never completes (consumer
 * timeout), so an unfinished or unpicked turn is never reported as an answer.
 */
export async function runCursorTurn(options:CursorTurnOptions):Promise<CursorTurnResult> {
  const prompt=options.prompt.trim();
  if(!prompt)throw new Error('Cursor was given no prompt.');
  const env=options.env??process.env;
  const timeoutMs=options.timeoutMs??10*60*1000;
  const pollMs=options.pollMs??750;
  if(options.cli)return runCursorCli(options.cli,prompt,options.cwd,timeoutMs,env);
  const open=options.open??openInCursor;
  // Cursor writes the transcript only when the turn ends (live: a one-line answer landed at 60 s), so this is generous.
  const pickupMs=options.pickupMs??180_000;
  let picked=false;
  // Cursor normalises whitespace before storing the message, so the same normalisation has to be
  // applied to the prompt when matching it back - otherwise every multi-line prompt misses.
  const needle=prompt.replace(/\s+/g,' ').trim();
  const seen=new Map<string,number>();
  for(const entry of cursorTranscriptFiles(env))seen.set(entry.file,entry.updatedAt);
  const deadline=Date.now()+timeoutMs;
  await open(cursorPromptUrl(prompt,{workspace:options.workspace,mode:options.mode}));
  const started=Date.now();
  while(Date.now()<deadline){
    await sleep(pollMs);
    // A prompt Cursor never took will not finish either: say so in minutes, not after the whole timeout.
    if(!picked&&pickupMs<timeoutMs&&Date.now()-started>pickupMs)throw new Error('Cursor did not take the message. Bring a Cursor chat window up on the Mac and send it again.');
    for(const entry of cursorTranscriptFiles(env)){
      // Cursor either appends to the chat that had focus or opens a new one, so both are candidates.
      if((seen.get(entry.file)??-1)>=entry.updatedAt)continue;
      const transcript=readCursorTranscript(entry.file);
      if(!picked&&transcript.messages.some(message=>message.role==='user'&&message.text.includes(needle)))picked=true;
      if(!transcript.complete)continue;
      // The newest user message carrying our prompt is the one this delivery started.
      let index=-1;
      for(let at=transcript.messages.length-1;at>=0;at--){
        const message=transcript.messages[at]!;
        if(message.role==='user'&&message.text.includes(needle)){index=at;break;}
      }
      if(index<0)continue;
      const text=transcript.messages.slice(index+1).filter((message)=>message.role==='assistant'&&message.text.trim()).map((message)=>message.text.trim()).join('\n\n');
      if(!text)throw new Error('Cursor finished the turn without any answer text. Check the chat before retrying.');
      return {text,sessionId:entry.chatId};
    }
  }
  throw new Error('Cursor did not finish this turn in time. Check the Cursor window, then try again.');
}