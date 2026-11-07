import { cursorRunning } from './cursor-paths.js';
import { computerName } from './platform.js';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { safeFilename } from './file-types.js';
import { homedir } from 'node:os';
import { createOptions, selectOption } from './message-options.js';
import { hash, type Binding } from './store.js';
import type { Router, Incoming } from './router.js';
import { brainPolicy } from './meta-brain-config.js';
import { endDirect, DIRECT_IDLE_MS } from './owner-routing.js';
import { errorCode } from './request-events.js';
import { runMuse } from './muse-session.js';
import { runDshQueued, dshCancel, dshQueueState, dshSessionKey, dshLegacySessionKey, dshActiveLabelKey, dshLabelsKey, dshLabels, addDshLabel, DEFAULT_DSH_LABEL } from './dsh-sessions.js';
import { sendMessage, claimMessages, settleMessages, pendingMessages, listMessages, messagePrompt } from './dsh-inbox.js';
import { dshSettings, dshStatus, credentialHint, keyEnvironment, writePatch, readProfile, credentialRef } from './dsh-provider.js';
import { dshHome } from './dsh-paths.js';
import { stateDir, currentStateDir, baseUrl } from './config.js';
import { openDirectMac } from './direct-mac.js';
import { runCursorTurn, findCursorCli } from './cursor-desktop.js';

export const TELEGRAM_COMMANDS=[
  {command:'claude',description:'Talk to your Claude coordinator'},
  {command:'codex',description:'Talk to your Codex coordinator'},
  {command:'brain',description:'Use the Meta brain, without fallback'},
  {command:'muse',description:'Run Muse Code on this project'},
  {command:'deepseek',description:'Run DeepSeek Harness on this project'},
  {command:'cursor',description:'Run Cursor on this project'},
  {command:'screen',description:`Control your ${process.platform==='win32'?'PC':'Mac'} screen from your phone, password protected`},
  {command:'back',description:'Return to normal routing'},
  {command:'help',description:'Commands and current target'},
  {command:'sessions',description:'Show your sessions'},
  {command:'status',description:'Show current activity'},
  {command:'social',description:'Create social drafts with your selected session'},
];
export function telegramCommand(text:string,username:string):string|null {
  const m=/^\s*\/([a-z][a-z0-9_]*)(?:@([a-z0-9_]+))?(?=\s|$)/i.exec(text);
  if(!m)return text;
  if(m[2]&&m[2].toLowerCase()!==username.toLowerCase())return null;
  return `/${m[1].toLowerCase()}${text.slice(m[0].length)}`;
}
type Tool='muse'|'deepseek'|'cursor';
type Target={kind:'session';id:string;identity:string}|{kind:'brain'}|{kind:'tool';tool:Tool};
const TOOL_NAMES:Record<Tool,string>={muse:'Muse',deepseek:'DeepSeek',cursor:'Cursor'};
const runTool=(r:Router,m:Incoming,tool:Tool,arg:string)=>tool==='muse'?museCommand(r,m,arg):tool==='deepseek'?deepseekCommand(r,m,arg):cursorCommand(r,m,arg);
type HandoffKind='fresh'|'claude'|'codex'|'no';
type Handoff={tool:Tool;text:string;requestId:string;kinds:HandoffKind[];agent?:{id:string;name:string};expires:number};
const handoffKey=(optionId:string)=>`owner-handoff:${optionId}`;
const DSH_LOCKED=/DeepSeek session is open in the DeepSeek Harness app|already owned by an active write handle/i;
/** The agent a failed tool task can go to: the session chosen before the tool mode, else the default coordinator. */
function handoffAgent(r:Router):Binding|undefined {
  try{
    const before=JSON.parse(r.store.get(`${routeKey(r)}:before-tool`)??'null') as Target|null;
    if(before?.kind==='session'){const b=session(r,before);if(b)return b;}
  }catch{}
  for(const provider of ['claude','codex'])try{return defaultSession(r,provider);}catch{}
  return undefined;
}
function failureReason(tool:Tool,message:string):string {
  if(tool==='deepseek'&&DSH_LOCKED.test(message))return 'This DeepSeek chat is open in the DeepSeek Harness app on your PC, so a second run cannot write to it.';
  return message.replace(/^DeepSeek Harness exited with code \d+:\s*/,'').replace(/\s+/g,' ').slice(0,300);
}
/**
 * A tool task that fails asks the owner whether to pass it on, with buttons. Nothing runs
 * elsewhere until the owner chooses. Returns false when there is nobody to offer it to.
 */
function offerHandoff(r:Router,m:Incoming,tool:Tool,text:string,error:unknown,retried=false):boolean {
  const destination=r.store.destination();if(!destination||!authenticatedOwner(r,m)||!text.trim())return false;
  const message=(error as Error)?.message??String(error);
  let agent:Binding|undefined;try{agent=handoffAgent(r);}catch{agent=undefined;}
  const kinds:HandoffKind[]=[];
  if(tool==='deepseek'&&DSH_LOCKED.test(message)&&!retried)kinds.push('fresh');
  if(agent)kinds.push(agent.provider==='codex'?'codex':'claude');
  if(!kinds.length)return false;
  kinds.push('no');
  const agentName=agent?name(r,agent):'';
  const labels:Record<HandoffKind,string>={fresh:`Yes, new ${TOOL_NAMES[tool]} chat`,claude:'Yes, send to Claude',codex:'Yes, send to Codex',no:'No, leave it'};
  const choices=kinds.map((kind,i)=>({id:`target${i+1}`,label:`${i+1}. ${labels[kind]}`.slice(0,80)}));
  const source=`tool-handoff:${m.id}`;
  const body=[
    `⚠️ **${TOOL_NAMES[tool]} could not run this task**`,
    `Reason: ${failureReason(tool,message)}`,
    'Nothing was done.',
    '',
    '**Pass this task to another agent?**',
    ...(kinds.includes('fresh')?[`New ${TOOL_NAMES[tool]} chat: runs it again in a separate chat the PC app is not using.`]:[]),
    ...(agent?[`${agent.provider==='codex'?'Codex':'Claude'}: sends it to ${agentName}.`]:[]),
    ...(destination.startsWith('tg:')?[]:['',...choices.map(c=>c.label),'Reply to this message with a number.']),
    'This question expires in 10 minutes.',
  ].join('\n');
  r.store.db.exec('SAVEPOINT owner_handoff');
  try{
    r.store.output(undefined,body,source,undefined,{plain:true});
    const row=r.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(source+':0') as {id:string}|undefined;
    if(!row)throw Error('The question could not be queued.');
    const optionId=createOptions(r.store,row.id,m.id,'',destination,{choices,expiresInSeconds:600});
    r.store.db.prepare('INSERT INTO owner_target_options(option_id) VALUES(?)').run(optionId);
    const payload:Handoff={tool,text,requestId:m.id,kinds,agent:agent?{id:agent.id,name:agentName}:undefined,expires:Date.now()+10*60_000};
    r.store.set(handoffKey(optionId),JSON.stringify(payload));
    r.store.db.exec('RELEASE owner_handoff');
  }catch(e){r.store.db.exec('ROLLBACK TO owner_handoff; RELEASE owner_handoff');throw e;}
  return true;
}
/** Run a tool task. A failure becomes a pass-it-on question when one can be offered, and '' is returned. */
async function runToolOrOffer(r:Router,m:Incoming,tool:Tool,arg:string,retried=false):Promise<string> {
  try{return await runTool(r,m,tool,arg);}
  catch(error){if(offerHandoff(r,m,tool,arg,error,retried))return '';throw error;}
}
/** The owner's answer to a pass-it-on question. Returns the reply, and starts the chosen run. */
function answerHandoff(r:Router,m:Incoming,row:any,payload:Handoff):string {
  let reply='This question was already answered.';
  let after:(()=>void)|undefined,fresh=false;
  const typed=m.text.trim();
  selectOption(r.store,{responseId:m.id,destination:r.store.destination()!,messageId:row.wa_id,token:m.optionToken,number:/^\d+$/.test(typed)?Number(typed):undefined} as any,()=>{throw Error('This question cannot create an agent task.');},(_requestId:string,choiceId:string)=>{
    if(payload.expires<=Date.now())throw Error('This question expired. Send the task again.');
    const kind=payload.kinds[Number(choiceId.replace(/^target/,''))-1];
    if(!kind)throw Error('Choose one of the offered answers.');
    if(kind==='no'){reply='OK. Nothing was sent anywhere.';return;}
    if(kind==='fresh'){
      const cwd=deepseekWorkspace(r);
      let label='phone';for(let n=2;dshSessionId(r,cwd,label)&&n<100;n++)label=`phone-${n}`;
      addDshLabel(key=>r.store.get(key)??undefined,(key,value)=>r.store.set(key,value),cwd,label);
      r.store.set(dshSessionKey(cwd,label),'');r.store.set(dshActiveLabelKey(cwd),label);
      reply=`Running it again in a new DeepSeek chat called ${label}. Your next DeepSeek tasks use this chat too. Send /deepseek use default to go back.`;
      const retry:Incoming={...m,id:`${payload.requestId}:fresh`,optionToken:undefined,quotedId:undefined};
      after=()=>{runToolOrOffer(r,retry,payload.tool,payload.text,true)
        .then(text=>{if(text)r.store.output(undefined,text,`command:${retry.id}`,undefined,{plain:true});})
        .catch(e=>r.store.output(undefined,(e as Error).message,`command-error:${retry.id}`,undefined,{plain:true}));};
      fresh=true;return;
    }
    const b=payload.agent&&r.store.binding(payload.agent.id);
    if(!b||!b.enabled)throw Error(`${payload.agent?.name??'That agent'} is no longer available. Nothing was sent.`);
    r.queue(`${payload.requestId}:handoff`,b,`[FarFromDesk] ${TOOL_NAMES[payload.tool]} could not run this task, so the owner asked you to do it instead.\n\n${payload.text}`);
    reply=`Sent to ${payload.agent!.name}. Its answer comes here.`;
    after=()=>r.pump();
  });
  r.store.set(handoffKey(row.id),'"done"');
  // The note goes out before the rerun's own progress message.
  if(fresh){r.store.output(undefined,reply,`command:${m.id}`,undefined,{plain:true});after?.();return '';}
  after?.();
  return reply;
}
/** Cursor's own app process, so a bare /cursor can say whether a run could start right now. */
function cursorOpen(){return cursorRunning();}
type Choice={provider:string;targets:Extract<Target,{kind:'session'}>[];expires:number;requestId:string;names:string[]};
const routeKey=(r:Router)=>`owner-target:${r.store.destination()}`;
const choiceKey=(r:Router)=>`owner-target-choice:${r.store.destination()}`;
/** How long an app-minted claim stays usable: one composer send, then never again. */
export const APP_ORIGIN_WINDOW_MS=120_000;
export function authenticatedOwner(r:Router,m:Incoming) {
  const d=r.store.destination();
  if(!d||r.store.get(`parent:${m.id}`)||r.store.get(`report-parent:${m.id}`))return false;
  // Exactly one added origin: the app's own composer. It is authenticated only
  // by a single-use claim this bridge minted for this id, still inside its
  // window, for this destination and this owner generation. A transported
  // wa:/tg: id can never satisfy this, and nothing here is reachable without
  // the claim the admin route writes.
  if(m.id.startsWith('app:')){
    const claim=r.store.appOriginClaim(m.id);
    // The channel is re-checked as well as the destination: a claim minted while the owner
    // was on one channel must not authenticate a message once the owner moved to the other.
    return !!claim&&Date.now()-claim.at<APP_ORIGIN_WINDOW_MS&&claim.destination===d
      &&claim.channel===r.store.controlChannel()
      &&claim.generation===(r.store.get('incoming-owner-generation')??'');
  }
  if(r.store.controlChannel()==='telegram')return d===r.store.get('telegram-owner')&&m.id.startsWith(d+':')&&/^\d+$/.test(m.id.slice(d.length+1));
  const owner=r.store.get('whatsapp-owner');
  return !!owner&&m.id.startsWith('wa:')&&m.id.length>3&&r.store.ownerFor(d)===owner&&(d===owner||d===r.store.get('destination-jid')&&!!r.store.get(`owned-group:${d}`));
}
const identity=(r:Router,b:Binding)=>hash(JSON.stringify([b.id,b.native_id,b.cwd,b.token_hash,r.store.get(`execution-mode:${b.id}`),r.store.get(`session-route:${b.id}`),r.coordinator?.registry.entry(b.id)]));
function candidates(r:Router,provider:string) {
  const ids=new Set<string>([...JSON.parse(r.store.get('selected')??'[]'),...r.coordinator?.registry.entries().map(e=>e.bindingId)??[],r.store.get('active')??'']);
  return [...ids].map(id=>r.store.binding(id)).filter((b):b is Binding=>!!b&&b.provider===provider&&!!b.enabled&&!r.store.get(`native-history-error:${b.id}`));
}
function enabled(r:Router,provider:string){return (r.coordinator?.enabled()??JSON.parse(r.store.get('enabled-apps')??'["codex","claude"]')).includes(provider);}
function session(r:Router,target:Extract<Target,{kind:'session'}>) {
  const b=r.store.binding(target.id);
  if(!b||!enabled(r,b.provider)||!candidates(r,b.provider).some(x=>x.id===b.id)||identity(r,b)!==target.identity)throw Error('Your chosen session is paused, disconnected or changed. Send /claude or /codex again. Nothing was sent elsewhere.');
  const entry=r.coordinator?.registry.entry(b.id);
  if(entry&&r.coordinator!.registry.identity(b).key!==entry.key)throw Error('This proxy account or runtime changed. Review Coding platforms before choosing it again.');
  return b;
}
function brain(r:Router) {
  if(!brainPolicy(r.store).enabled)throw Error('The Meta brain is disabled. Enable it in FarFromDesk Brain settings first.');
  if(!r.brain.secret.present())throw Error('The Meta brain needs an API key. Add it in FarFromDesk Brain settings first.');
  if(!r.coordinator)throw Error('Brain routing is unavailable. Finish setting up Coding platforms in FarFromDesk.');
}
function clear(r:Router){r.store.set(routeKey(r),'null');r.store.set(choiceKey(r),'null');endDirect(r.store);r.brain.clearChoice();}
/** A pending list that can still be answered. An expired list or one saved by an older build has no requestId to claim against. */
function livePending(r:Router):Choice|null {
  const pending=JSON.parse(r.store.get(choiceKey(r))??'null') as Choice|null;
  if(pending&&(typeof pending.requestId!=='string'||pending.expires<=Date.now())){r.store.set(choiceKey(r),'null');return null;}
  return pending;
}
/** The provider's default coordinator, as the proxy line in currentTarget already defines it. */
function defaultSession(r:Router,provider:string):Binding {
  // The /claude list hint only when that list would offer something.
  const label=provider==='claude'?'Claude':'Codex',list=candidates(r,provider).length?` Or send /${provider} list to choose a connected session.`:'';
  // The saved default, read directly: master() hides a paused one, and falling through would silently swap the target.
  const saved=r.store.binding(r.store.get(r.coordinator?'master':'active')??'');
  let b:Binding|undefined;
  if(saved?.provider===provider&&(!r.coordinator||r.coordinator.isCoordinator(saved.id))){
    if(!saved.enabled)throw Error(`Your default ${label} coordinator, ${name(r,saved)}, is paused. Resume it in the FarFromDesk desktop app.${list}`);
    b=saved;
  }else if(r.coordinator?.registry.entries().some(e=>e.provider===provider)){
    try{b=r.coordinator.registry.choose(provider);}catch(e){throw Error(`${(e as Error).message}${list}`);} // paused or ambiguous, one line
  }
  if(!b||!candidates(r,provider).some(x=>x.id===b!.id))throw Error(`No ${label} coordinator is connected. Connect one in the FarFromDesk desktop app, Coding platforms.${list}`);
  return b;
}
/** The folder Muse Code works in: an explicit setting, else the session you are talking to. */
function museWorkspace(r:Router) {
  const configured=r.store.get('muse-workspace');
  if(configured&&existsSync(configured))return configured;
  const target=JSON.parse(r.store.get(routeKey(r))??'null') as Target|null;
  if(target?.kind==='session'){const b=r.store.binding(target.id);if(b?.cwd)return b.cwd;}
  const master=r.store.get('master'),b=master?r.store.binding(master):undefined;
  return b?.cwd??homedir();
}
/**
 * DeepSeek, with labels and a durable inbox.
 *
 * One workspace can hold several labelled sessions (the CLI adopts a session scoped to its working
 * directory, and two sessions in one folder are two different ids). A turn is one finished run: a
 * run that did not finish is reported, never passed off as an answer. Messages addressed to another
 * session are written to disk first and carried into that session's next turn, and the owner is told
 * the difference between "queued" and "read".
 */
const DEEPSEEK_SUBCOMMANDS=new Set(['status','list','use','new','reset','stop','send','inbox','help']);

async function museCommand(r:Router,m:Incoming,arg:string) {
  const cwd=museWorkspace(r),key=`muse-session:${cwd}`,label=basename(cwd)||cwd;
  if(!arg)return `Muse Code is ready in ${label}. It continues the same Muse session in this folder; /muse reset starts a new one.`;
  if(arg.toLowerCase()==='reset'){r.store.set(key,'');return 'The next /muse starts a fresh Muse session in this folder.';}
  const destination=r.store.destination();
  if(destination)r.store.output(undefined,`🧠 Muse is working in ${label}.`,`muse-progress:${m.id}`,destination,{kind:'system',origin:'system',plain:true});
  // The owner's Mac apps for this one run, and the network Muse needs to reach the local bridge.
  const mac=openDirectMac(r.store,stateDir,new URL(baseUrl).port,`muse:${m.id}`);
  let result;try{result=await runMuse({prompt:`${arg}\n\n[FarFromDesk] ${mac.note}`,cwd,sessionId:r.store.get(key)||null,timeoutMs:20*60*1000,network:true});}finally{mac.close();}
  if(result.sessionId)r.store.set(key,result.sessionId);
  return result.text.slice(0,20000);
}
/** The folder DeepSeek Harness works in: an explicit setting, else the session you are talking to. */
function deepseekWorkspace(r:Router) {
  const configured=r.store.get('deepseek-workspace');
  if(configured&&existsSync(configured))return configured;
  const target=JSON.parse(r.store.get(routeKey(r))??'null') as Target|null;
  if(target?.kind==='session'){const b=r.store.binding(target.id);if(b?.cwd)return b.cwd;}
  const master=r.store.get('master'),b=master?r.store.binding(master):undefined;
  return b?.cwd??homedir();
}
/**
 * Labels, so one workspace can hold several DeepSeek conversations. A label owns a session id and a
 * queue; the messages another session left for it are written to disk first and carried into its next
 * turn, because a headless run is not a daemon that can be handed a message out of band.
 */
function dshSessionId(r:Router,folder:string,label:string):string|null {
  const own=r.store.get(dshSessionKey(folder,label));
  if(own)return own;
  // Labels arrived after the first builds; a session saved under the old key is still this folder's
  // default conversation rather than a lost one.
  return label===DEFAULT_DSH_LABEL?(r.store.get(dshLegacySessionKey(folder))||null):null;
}
function dshActiveLabel(r:Router,folder:string):string {
  const stored=(r.store.get(dshActiveLabelKey(folder))??'').trim();
  return stored||DEFAULT_DSH_LABEL;
}
function dshLabelLine(r:Router,folder:string,label:string):string {
  const id=dshSessionId(r,folder,label),pending=pendingMessages(currentStateDir(),folder,label).length;
  const marks=[`\`${label}\``,id?`session ${id.slice(0,18)}…`:'no session yet',pending?`${pending} queued`:'nothing queued'];
  return marks.join(' · ');
}
/** One prompt, one finished run. A run that did not finish is reported, never passed off as an answer. */
async function deepseekCommand(r:Router,m:Incoming,arg:string) {
  const cwd=deepseekWorkspace(r),workspace=basename(cwd)||cwd;
  // The desktop app's own settings are the source of truth for provider and model, and the store's
  // `refs` map is where a key set in the app settings lands for a child process.
  const profile=readProfile(dshHome()),keyOf=(name:string)=>credentialRef(dshHome(),name);
  const settings=dshSettings(name=>r.store.get(name)??undefined,profile),status=dshStatus(settings,process.env,keyOf);
  const words=arg.trim().split(/\s+/),head=(words[0]??'').toLowerCase();
  const sub=DEEPSEEK_SUBCOMMANDS.has(head)?head:'';
  const rest=sub===''?arg.trim():arg.trim().slice(words[0].length).trim();
  let label=dshActiveLabel(r,cwd);
  const queue=()=>dshQueueState(cwd,label);
  const busy=()=>{const q=queue();return q.busy?` A turn is still running in \`${label}\`${q.waiting?` with ${q.waiting} queued`:''}; your message joins the queue.`:'';};

  if(!arg||sub==='status'||sub==='help')
    return [
      '🤖 **DeepSeek Harness is ready**',
      `Folder: ${workspace}`,
      status.configured?`Model: ${status.model} (${status.route})`:`Setup needed: ${status.hint}`,
      `Chat: ${label}${dshSessionId(r,cwd,label)?'':' (new, your first task opens it)'}`,
      ...(busy()?[busy().trim()]:[]),
      '',
      '**How to use**',
      'Type your task as a normal message.',
      '',
      '**Commands**',
      '/deepseek new [name]: start a fresh chat',
      '/deepseek use <name>: switch to another chat',
      '/deepseek list: show your chats',
      '/deepseek send <name> <message>: leave a message for another chat',
      '/deepseek inbox: show queued messages',
      '/deepseek stop: cancel the running task',
    ].join('\n');

  if(sub==='list'){
    const labels=dshLabels(name=>r.store.get(name)??undefined,cwd);
    return `DeepSeek sessions in ${workspace}:\n`+labels.map(name=>`${name===label?'▶ ':'  '}${dshLabelLine(r,cwd,name)}`).join('\n')
      +`\nEach label is its own conversation and its own queue. Web-search and provider settings are shared.`;
  }

  if(sub==='use'){
    const wanted=(rest||'').trim().replace(/^`|`$/g,'');
    if(!wanted)return `Which session? /deepseek list shows them, then /deepseek use <label>.`;
    if(!/^[A-Za-z0-9._-]{1,24}$/.test(wanted))return 'A session label is 1-24 letters, digits, dot, dash or underscore.';
    addDshLabel(name=>r.store.get(name)??undefined,(name,value)=>r.store.set(name,value),cwd,wanted);
    r.store.set(dshActiveLabelKey(cwd),wanted);
    return `Now using \`${wanted}\` in ${workspace}${dshSessionId(r,cwd,wanted)?'':' (no session yet; the next task opens one)'}.`;
  }

  if(sub==='new'||sub==='reset'){
    const wanted=(rest||'').trim().replace(/^`|`$/g,'')||label;
    if(!/^[A-Za-z0-9._-]{1,24}$/.test(wanted))return 'A session label is 1-24 letters, digits, dot, dash or underscore.';
    addDshLabel(name=>r.store.get(name)??undefined,(name,value)=>r.store.set(name,value),cwd,wanted);
    r.store.set(dshSessionKey(cwd,wanted),'');
    if(wanted===DEFAULT_DSH_LABEL)r.store.set(dshLegacySessionKey(cwd),'');
    r.store.set(dshActiveLabelKey(cwd),wanted);
    label=wanted;
    return `The next /deepseek starts a fresh DeepSeek session in \`${wanted}\` (${workspace}).`;
  }

  if(sub==='stop'){
    const wanted=(rest||'').trim().replace(/^`|`$/g,'')||label;
    return dshCancel(cwd,wanted)?`Stopped the DeepSeek turn in \`${wanted}\`.`:`Nothing is running in \`${wanted}\`.`;
  }

  if(sub==='send'){
    const target=(rest.split(/\s+/)[0]??'').replace(/^`|`$/g,'');
    const text=rest.slice(target.length).trim();
    if(!target||!text)return 'Send it like: /deepseek send <label> <message>. /deepseek list shows the labels.';
    if(!/^[A-Za-z0-9._-]{1,24}$/.test(target))return 'A session label is 1-24 letters, digits, dot, dash or underscore.';
    addDshLabel(name=>r.store.get(name)??undefined,(name,value)=>r.store.set(name,value),cwd,target);
    const message=sendMessage({root:currentStateDir(),folder:cwd,label:target,text,from:'the owner'});
    return `Queued for \`${target}\` as \`${message.id}\`. I carry it into that session's next turn in this workspace; that is a local write, not delivery. Ask that session for the id if you need proof it read it.`;
  }

  if(sub==='inbox'){
    const messages=listMessages(currentStateDir(),cwd,label);
    if(!messages.length)return `Nothing has been sent to \`${label}\` in ${workspace}.`;
    const lines=messages.slice(-10).map(message=>`${message.state} · ${message.id} · from ${message.from} · ${message.text.slice(0,60).replace(/\s+/g,' ')}`);
    return `Messages for \`${label}\`:\n${lines.join('\n')}\nprepared = not carried yet, received = a finished turn carried it, unknown = the turn that carried it failed.`;
  }

  // A task: carry whatever is queued for this session, then run one turn.
  const claimed=claimMessages(currentStateDir(),cwd,label);
  const destination=r.store.destination();
  if(destination)r.store.output(undefined,`🤖 DeepSeek is working in ${workspace}${label===DEFAULT_DSH_LABEL?'':` (${label})`}.${claimed.length?` Carrying ${claimed.length} queued message${claimed.length>1?'s':''}.`:''}${queue().busy?' Queued behind the previous task.':''}`,`deepseek-progress:${m.id}`,destination,{kind:'system',origin:'system',plain:true});
  const {env}=keyEnvironment(settings,process.env,keyOf);
  const mac=openDirectMac(r.store,stateDir,new URL(baseUrl).port,`deepseek:${m.id}`);
  const {result}=runDshQueued(cwd,{prompt:`${messagePrompt(claimed)}${arg}\n\n[FarFromDesk] ${mac.note}`,cwd,sessionId:dshSessionId(r,cwd,label),patchPath:writePatch(stateDir,settings,profile),env,timeoutMs:20*60*1000},undefined,label);
  let finished;
  try {
    finished=await result;
  } catch(error) {
    mac.close();
    const message=(error as Error)?.message??String(error);
    if(claimed.length)settleMessages(currentStateDir(),cwd,label,claimed.map(entry=>entry.id),'unknown',message.slice(0,200));
    // The run is attempted even without a configured key, because the CLI may resolve its own
    // credential. Only a credential failure is replaced by the next step the owner can take.
    const hint=credentialHint(message,status);
    const carried=claimed.length?` The ${claimed.length} message${claimed.length>1?'s':''} I was carrying ${claimed.length>1?'are':'is'} marked unknown, not re-queued.`:'';
    if(!hint)throw error;
    return `${hint}${carried}`;
  }
  mac.close();
  if(finished.sessionId)r.store.set(dshSessionKey(cwd,label),finished.sessionId);
  if(claimed.length)settleMessages(currentStateDir(),cwd,label,claimed.map(entry=>entry.id),'received');
  return finished.text.slice(0,20000);
}
/**
 * One prompt, one finished turn, one brand-new Cursor chat. The deeplink only prefills the Composer
 * and never opens a window. Measured: Cursor submitted and answered four delivered prompts by itself,
 * but the same surface later ignored every prompt for two hours, so submission is Cursor's own
 * behaviour and cannot be relied on. `runCursorTurn` waits for `turn_ended` and rejects on timeout, so
 * an unpicked delivery is reported as unfinished, not as an answer. Cursor's
 * deeplink has no chat id and cannot be aimed at an existing chat, so there is no session to continue
 * and no folder to choose. `workspace` is deliberately never passed: a name that matches no open
 * Cursor window is silently ignored. The returned chat id is display-only.
 */
async function cursorCommand(r:Router,m:Incoming,arg:string) {
  if(!arg)return findCursorCli()?`Cursor is ready. It runs by command on your ${computerName()}, no window needed.`:`Cursor is ready.${cursorOpen()?'':' It is closed now; I open it when you send something.'} Each message starts a new Cursor chat. To run it without the app window, sign in its command-line agent once: run cursor-agent login in ${process.platform==='win32'?'a terminal':'Terminal'}.`;
  const destination=r.store.destination();
  if(destination)r.store.output(undefined,'🖱️ Cursor is working.','cursor-progress:'+m.id,destination,{kind:'system',origin:'system',plain:true});
  const mac=openDirectMac(r.store,stateDir,new URL(baseUrl).port,`cursor:${m.id}`);
  let result;try{result=await runCursorTurn({prompt:`${arg}\n\n[FarFromDesk] ${mac.note}`,timeoutMs:10*60*1000,cli:findCursorCli(),cwd:museWorkspace(r)});}finally{mac.close();}
  return result.text.slice(0,20000);
}
function name(r:Router,b:Binding){return (r.store.get(`name:${b.id}`)??b.alias).replace(/[\r\n*_`]/g,' ').slice(0,80);}
export function currentTarget(r:Router) {
  const t=JSON.parse(r.store.get(routeKey(r))??'null') as Target|null;
  if(!t){
    const direct=JSON.parse(r.store.get(`direct:${r.store.destination()}`)??'null');
    const b=direct&&Date.now()-direct.at<DIRECT_IDLE_MS?r.store.binding(direct.bindingId):undefined;
    if(b?.enabled)return `${name(r,b)} (${b.provider})`;
    const proxy=r.coordinator?.master()??r.store.binding(r.store.get('active')??'');
    return brainPolicy(r.store).enabled?'Normal routing (Meta brain)':`Normal routing${proxy?` (${name(r,proxy)})`:''}`;
  }
  if(t.kind==='brain')return 'Meta brain (no fallback)';
  if(t.kind==='tool')return TOOL_NAMES[t.tool];
  const b=r.store.binding(t.id);return b?`${name(r,b)} (${b.provider})`:'Unavailable session';
}
export async function ownerCommand(r:Router,m:Incoming):Promise<string|undefined> {
  if(!authenticatedOwner(r,m)||!m.ownerCommand||m.quotedId||m.source==='voice')return;
  const match=/^\/(claude|codex|brain|screen|back|help|muse|deepseek|cursor)(?:\s+(.*))?$/i.exec(m.text.trim());if(!match)return;
  const cmd=match[1].toLowerCase(),arg=(match[2]??'').trim();
  if(['help','back','brain','screen'].includes(cmd)&&arg)throw Error(`Use /${cmd} on its own.`);
  if(cmd==='help')return `Current target: ${currentTarget(r)}\n\n${TELEGRAM_COMMANDS.map(c=>`/${c.command}: ${c.description}`).join('\n')}\n\nSend /claude list or /codex list to choose another session. Existing /to, /talk, /use, /pause, /resume and permission commands still work.${r.store.controlChannel()==='whatsapp'?'\n\nTo bind an approved GitHub check, use /proof bind #ITEM CHECK_NUMBER OWNER/REPO. This does not verify the task.':''}`;
  if(cmd==='muse'||cmd==='deepseek'||cmd==='cursor'){
    if(arg)return runToolOrOffer(r,m,cmd,arg);
    // A bare command selects the tool, like /claude selects a session: plain messages go there until /back.
    const ready=await runTool(r,m,cmd,'');
    // /back from a tool returns to the mode the owner was in (brain or a session), not to plain routing.
    const before=r.store.get(routeKey(r))??'null';
    if(JSON.parse(before)?.kind!=='tool')r.store.set(`${routeKey(r)}:before-tool`,before);
    clear(r);r.store.set(routeKey(r),JSON.stringify({kind:'tool',tool:cmd}));
    return `${ready}\n\nYour next messages go to ${TOOL_NAMES[cmd]} until you send /back.`;
  }
  if(cmd==='back'){
    const now=JSON.parse(r.store.get(routeKey(r))??'null') as Target|null,before=r.store.get(`${routeKey(r)}:before-tool`)??'null';
    clear(r);r.store.set(`${routeKey(r)}:before-tool`,'null');
    if(now?.kind==='tool'&&before!=='null'){r.store.set(routeKey(r),before);return `Left ${TOOL_NAMES[now.tool]}. Back to ${currentTarget(r)}.`;}
    return 'Back to normal routing. Your next messages use the configured brain/proxy.';
  }
  if(cmd==='brain'){brain(r);clear(r);r.store.set(routeKey(r),JSON.stringify({kind:'brain'}));return 'Now using the Meta brain. If it is unavailable, you will get an error, not a fallback session. Use /back to leave.';}
  if(cmd==='screen')return r.remoteControl?await r.remoteControl('/remote')??'Screen viewing is unavailable. Check Settings > Remote control in FarFromDesk.':'Screen viewing is unavailable in this build. Open Settings > Remote control in FarFromDesk on your computer.';
  const provider=cmd==='codex'?'codex':'claude';if(!enabled(r,provider))throw Error(`${provider==='claude'?'Claude':'Codex'} is disabled. Enable it in Coding platforms first.`);
  if(!arg){const b=defaultSession(r,provider);return activateTarget(r,{kind:'session',id:b.id,identity:identity(r,b)},true);}
  if(arg.toLowerCase()!=='list')return pickOwnerTarget(r,m,provider)??`Send /${cmd} list for a fresh list, then choose a session.`;
  const available=candidates(r,provider);
  if(!available.length)throw Error(`No enabled connected ${provider==='claude'?'Claude':'Codex'} session is available. Connect or resume one in Coding platforms; no session was created.`);
  const targets=available.map(b=>({kind:'session' as const,id:b.id,identity:identity(r,b)}));
  if(targets.length===1)return activateTarget(r,targets[0]);
  r.store.db.exec('SAVEPOINT owner_target_list');
  try {
    r.store.set(choiceKey(r),JSON.stringify({provider,targets,expires:Date.now()+10*60_000,requestId:m.id,names:available.map(b=>name(r,b))}));
    for(let offset=0;offset<available.length;offset+=6){
      const page=available.slice(offset,offset+6);
      const choices=page.map((b,i)=>({id:`target${offset+i+1}`,label:`${offset+i+1}. ${name(r,b)}${r.coordinator?.isCoordinator(b.id)?' · coordinator':''}`.slice(0,80)}));
      const source=`owner-choice:${m.id}:${offset}`;
      // Telegram shows the labels as buttons, so the body does not repeat them. WhatsApp has only the numbered text.
      const label=provider==='claude'?'Claude':'Codex';
      r.store.output(undefined,r.store.destination()!.startsWith('tg:')?`Choose a connected ${label} session. This list expires in 10 minutes.`:`Choose a connected ${label} session:
${choices.map(c=>c.label).join('\n')}
Reply to this message with a number, or send /${cmd} NUMBER. This list expires in 10 minutes.`,source,undefined,{plain:true});
      const row=r.store.db.prepare('SELECT id FROM outbox WHERE source=?').get(source+':0') as {id:string};
      const optionId=createOptions(r.store,row.id,m.id,'',r.store.destination()!,{choices,expiresInSeconds:600});
      r.store.db.prepare('INSERT INTO owner_target_options(option_id) VALUES(?)').run(optionId);
    }
    r.store.db.exec('RELEASE owner_target_list');
  }catch(e){r.store.db.exec('ROLLBACK TO owner_target_list; RELEASE owner_target_list');throw e;}
  return ''; // The paged messages above already carry their buttons and number fallback.
}
/** Best effort: Codex's native warm-up makes the picked chat's inbox live before the first
 * message. It does not block and handles its own rejections; this guard only covers a sync throw. */
function warm(r:Router,b:Binding) {
  try{r.native.warmDesktop(b);}catch(e){console.error(`Desktop warm-up failed: ${errorCode(e)}`);}
}
function activateTarget(r:Router,target:Extract<Target,{kind:'session'}>,short=false) {
  const b=session(r,target);clear(r);r.store.set(routeKey(r),JSON.stringify(target));warm(r,b);
  if(short)return `Now talking to ${name(r,b)}. /back to leave.`;
  return `Now talking to ${name(r,b)} (${b.provider}). Your next messages go to this exact session. Permissions, account and runtime are unchanged. Use /back to leave.`;
}
/** Target lists share the atomic option claim, but never enqueue an agent task. */
export function ownerTurnLabel(r:Router,m:Incoming):string|undefined {
  if(authenticatedOwner(r,m)&&isOwnerCommand(m.text))return m.text.trim().split(/\s+/)[0].toLowerCase();
  if(m.quotedId&&r.store.db.prepare('SELECT 1 FROM owner_target_options t JOIN message_options o ON o.id=t.option_id JOIN outbox b ON b.id=o.outbox_id WHERE b.wa_id=? AND o.destination=?').get(m.quotedId,r.store.destination()))return 'Session selection';
  if(authenticatedOwner(r,m)&&m.ownerCommand&&/^\d+$/.test(m.text.trim())&&livePending(r))return 'Session selection';
}
export function pickOwnerTarget(r:Router,m:Incoming,provider?:string):string|undefined {
  const destination=r.store.destination();if(!destination)return;
  // A stale list is dropped here, so later numbers and names route normally instead of failing forever.
  const pending=livePending(r);
  let row:any;
  if(m.quotedId){
    row=r.store.db.prepare('SELECT o.*,b.wa_id FROM owner_target_options t JOIN message_options o ON o.id=t.option_id JOIN outbox b ON b.id=o.outbox_id WHERE b.wa_id=? AND o.destination=?').get(m.quotedId,destination);
    if(!row)return;
    if(!m.optionToken&&(!authenticatedOwner(r,m)||!m.ownerChoice||m.source==='voice'))throw Error('Choose a session with a button or a typed reply to its list.');
    const handoff=JSON.parse(r.store.get(handoffKey(row.id))??'null') as Handoff|'done'|null;
    if(handoff==='done')return 'This question was already answered.';
    if(handoff)return answerHandoff(r,m,row,handoff);
  }else if(!authenticatedOwner(r,m)||!m.ownerCommand||m.source==='voice')return;
  const value=(provider?m.text.trim().replace(/^\/\S+\s*/, ''):m.text.trim());
  let number=/^\d+$/.test(value)?Number(value):undefined;
  if(number===undefined&&!m.optionToken&&pending){
    const matches=pending.names?.map((n,i)=>({n,i})).filter(x=>x.n.toLowerCase()===value.toLowerCase())??[];
    if(matches.length>1)throw Error('Several sessions have that name. Choose its number or button.');
    if(matches.length===1)number=matches[0].i+1;
  }
  // With no live list, /claude WORD falls back to the command's own "send /claude list" hint.
  if(number===undefined&&!m.optionToken){if(row||provider&&pending?.provider===provider)throw Error('Choose a number or button from the session list.');return;}
  if(!row){
    if(!pending){if(provider)throw Error(`Send /${provider} list for a fresh session list.`);return;}
    if(provider&&pending.provider!==provider)throw Error(`Send /${provider} list for a fresh session list.`);
    row=r.store.db.prepare('SELECT o.*,b.wa_id FROM owner_target_options t JOIN message_options o ON o.id=t.option_id JOIN outbox b ON b.id=o.outbox_id WHERE o.request_id=? AND o.destination=?').all(pending.requestId,destination).find((o:any)=>JSON.parse(o.choices).some((c:any)=>c.id===`target${number}`));
    if(!row)throw Error('Choose one of the offered session numbers.');
  }
  let reply='This session choice was already recorded.';
  selectOption(r.store,{responseId:m.id,destination,messageId:row.wa_id,token:m.optionToken,number},()=>{throw Error('A session choice cannot create an agent task.');},(requestId,choiceId)=>{
    if(!pending||pending.requestId!==requestId||pending.expires<=Date.now())throw Error(`This session list expired or was replaced. Send /claude list or /codex list again.`);
    const index=Number(choiceId.replace(/^target/,''))-1;
    if(!pending.targets[index])throw Error('Choose one of the offered sessions.');
    reply=activateTarget(r,pending.targets[index]);
  });
  return reply;
}

/** An explicit mode takes precedence over model guesses; stale targets fail closed. */
export async function routeOwnerTarget(r:Router,m:Incoming):Promise<boolean> {
  if(!authenticatedOwner(r,m)||m.quotedId)return false;
  const target=JSON.parse(r.store.get(routeKey(r))??'null') as Target|null;if(!target)return false;
  if(target.kind==='brain'){
    brain(r);if(!await r.brain.handle(r,m,true))throw Error('Meta brain is unavailable. Nothing was sent to another session.');
  }else if(target.kind==='tool'){
    const reply=await runToolOrOffer(r,m,target.tool,m.text.trim());
    if(reply)r.store.output(undefined,reply,`command:${m.id}`,undefined,{plain:true});
  }else r.queue(m.id,session(r,target),m.text);
  return true;
}
export function clearOwnerTarget(r:Router){clear(r);}

/** Resolve the selected destination with the same identity checks as direct chat. */
export function specialtyTarget(r:Router,m:Incoming):Binding {
  if(!authenticatedOwner(r,m)||m.quotedId||(m.source==='voice'?m.ownerIntent!==true:m.ownerCommand!==true))throw Error('Send this request as a new message in your own chat.');
  const target=JSON.parse(r.store.get(routeKey(r))??'null') as Target|null;
  // A tool mode (Cursor, Muse, DeepSeek) runs one-off turns with no session, so Social uses the default session below.
  if(target?.kind==='brain')throw Error('Choose a Codex or Claude session before starting this task.');
  if(target?.kind==='session')return session(r,target);
  const directKey=`direct:${r.store.destination()??'owner'}`,raw=r.store.get(directKey);
  if(raw){
    let direct:{bindingId:string;at:number};try{direct=JSON.parse(raw);}catch{throw Error('The selected session changed. Select it again.');}
    if(typeof direct.bindingId!=='string'||!Number.isFinite(direct.at))throw Error('The selected session changed. Select it again.');
    if(Date.now()-direct.at<=DIRECT_IDLE_MS){
      const b=r.store.binding(direct.bindingId);
      if(!b?.enabled||r.coordinator?.isCoordinator(b.id)||!enabled(r,b.provider)||r.store.get(`native-history-error:${b.id}`))throw Error('Your chosen session is paused or unavailable. Select it again. Nothing was sent elsewhere.');
      r.store.set(directKey,JSON.stringify({...direct,at:Date.now()}));
      return b;
    }
    endDirect(r.store);
  }
  const b=r.store.binding(r.store.get('active')??r.store.get('master')??'');
  if(!b)throw Error('Choose a connected Codex or Claude session first.');
  return session(r,{kind:'session',id:b.id,identity:identity(r,b)});
}

/** The tool (DeepSeek, Muse, Cursor) the owner's chat is pointed at, when a file arrives there. */
export function ownerAttachmentTool(r:Router,m:Incoming):Tool|undefined {
  if(!authenticatedOwner(r,m)||m.quotedId)return;
  const target=JSON.parse(r.store.get(routeKey(r))??'null') as Target|null;
  return target?.kind==='tool'?target.tool:undefined;
}
export function toolName(tool:Tool){return TOOL_NAMES[tool];}
const TOOL_FILE_DAYS=7;
/**
 * Keeps a file for a tool run. The CLIs read files by path, so the file is copied out of the
 * download scratch folder into the bridge's own state folder, where it stays for a week.
 */
export function keepToolAttachment(requestId:string,file:{filename:string;data?:Buffer;download?:{path:string}}):string {
  const root=join(currentStateDir(),'tool-attachments');mkdirSync(root,{recursive:true});
  for(const entry of readdirSync(root)){try{const at=join(root,entry);if(Date.now()-statSync(at).mtimeMs>TOOL_FILE_DAYS*86400000)rmSync(at,{recursive:true,force:true});}catch{}}
  const dir=join(root,requestId.replace(/[^A-Za-z0-9_-]/g,'-'));mkdirSync(dir,{recursive:true});
  const path=join(dir,safeFilename(file.filename));
  if(file.download)copyFileSync(file.download.path,path);else writeFileSync(path,file.data!);
  return path;
}
/** One tool turn about an attached file; the reply goes to the owner like a typed /deepseek. */
export async function runToolAttachment(r:Router,m:Incoming,tool:Tool,caption:string,file:{kind:string;filename:string;path:string}) {
  const what=file.kind==='image'?'an image':'a file';
  // Starts with "[" so a caption such as "status" is never read as a /deepseek subcommand.
  const prompt=`[FarFromDesk] The owner sent ${what} named ${file.filename}. It is saved at ${file.path}. Open it from that path to answer.

${caption.trim()||'The owner sent no caption. Say what the file is and ask what they want done with it.'}`;
  const reply=await runToolOrOffer(r,m,tool,prompt);
  if(reply)r.store.output(undefined,reply,`command:${m.id}`,undefined,{plain:true});
}
export function ownerAttachmentTarget(r:Router,m:Incoming):Binding|undefined {
  if(!authenticatedOwner(r,m)||m.quotedId)return;
  const target=JSON.parse(r.store.get(routeKey(r))??'null') as Target|null;
  if(target){
    if(target.kind!=='session')throw Error(`${target.kind==='brain'?'Meta brain':TOOL_NAMES[target.tool]} mode accepts text${target.kind==='brain'?' and voice':''}. Choose /claude or /codex for a file, or quote the intended session reply.`);
    return session(r,target);
  }
  // /talk selects an exact direct session even when it is not in the selected
  // list. Never fall through to an unrelated active session while it is valid.
  const directKey=`direct:${r.store.destination()??'owner'}`,raw=r.store.get(directKey);if(!raw)return;
  let direct:{bindingId:string;at:number};try{direct=JSON.parse(raw);}catch{throw Error('The selected session changed. Select it again.');}
  if(typeof direct.bindingId!=='string'||!Number.isFinite(direct.at))throw Error('The selected session changed. Select it again.');
  if(Date.now()-direct.at>DIRECT_IDLE_MS){endDirect(r.store);return;}
  const b=r.store.binding(direct.bindingId);
  if(!b?.enabled||r.coordinator?.isCoordinator(b.id)||!enabled(r,b.provider)||r.store.get(`native-history-error:${b.id}`))throw Error('Your chosen session is paused or unavailable. Select it again. Nothing was sent elsewhere.');
  return b;
}

/**
 * Every command the owner may type. `/help` advertises these, and a command missing from this
 * list is not merely unknown: it skips its own handler and falls through to the generic
 * slash-command reply, so it looks like the bridge did not understand ordinary words.
 */
export const isOwnerCommand=(text:string)=>/^\/(claude|codex|brain|muse|deepseek|cursor|screen|back|help|social)(?:\s|$)/i.test(text.trim());

/** A coordinator session, not the brain, gets the owner's plain messages right now. */
export function sessionSelected(r:Router):boolean {
  try{
    if(JSON.parse(r.store.get(routeKey(r))??'null')?.kind==='session')return true;
    const direct=JSON.parse(r.store.get(`direct:${r.store.destination()}`)??'null');
    return !!(direct&&Date.now()-direct.at<DIRECT_IDLE_MS&&r.store.binding(direct.bindingId)?.enabled);
  }catch{return false;}
}
export function brainSelected(r:Router):boolean {try{return JSON.parse(r.store.get(routeKey(r))??'null')?.kind==='brain';}catch{return false;}}
export function toolSelected(r:Router):boolean {try{return JSON.parse(r.store.get(routeKey(r))??'null')?.kind==='tool';}catch{return false;}}
