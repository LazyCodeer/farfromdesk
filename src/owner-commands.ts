import { createOptions, selectOption } from './message-options.js';
import { hash, type Binding } from './store.js';
import type { Router, Incoming } from './router.js';
import { brainPolicy } from './meta-brain-config.js';
import { endDirect, DIRECT_IDLE_MS } from './owner-routing.js';
import { sameProject } from './session-catalog.js';
import { errorCode } from './request-events.js';

export const TELEGRAM_COMMANDS=[
  {command:'claude',description:'Talk to your Claude coordinator'},
  {command:'codex',description:'Talk to your Codex coordinator'},
  {command:'brain',description:'Use the Meta brain, without fallback'},
  {command:'screen',description:'Open the password-protected Mac viewer'},
  {command:'back',description:'Return to normal routing'},
  {command:'help',description:'Commands and current target'},
  {command:'sessions',description:'Show your sessions'},
  {command:'status',description:'Show current activity'},
];
export function telegramCommand(text:string,username:string):string|null {
  const m=/^\s*\/([a-z][a-z0-9_]*)(?:@([a-z0-9_]+))?(?=\s|$)/i.exec(text);
  if(!m)return text;
  if(m[2]&&m[2].toLowerCase()!==username.toLowerCase())return null;
  return `/${m[1].toLowerCase()}${text.slice(m[0].length)}`;
}
type Target={kind:'session';id:string;identity:string}|{kind:'brain'};
type Choice={provider:string;targets:Extract<Target,{kind:'session'}>[];expires:number;requestId:string;names:string[]};
const routeKey=(r:Router)=>`owner-target:${r.store.destination()}`;
const choiceKey=(r:Router)=>`owner-target-choice:${r.store.destination()}`;
export function authenticatedOwner(r:Router,m:Incoming) {
  const d=r.store.destination();
  if(!d||r.store.get(`parent:${m.id}`)||r.store.get(`report-parent:${m.id}`))return false;
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
  const b=r.store.binding(t.id);return b?`${name(r,b)} (${b.provider})`:'Unavailable session';
}
export async function ownerCommand(r:Router,m:Incoming):Promise<string|undefined> {
  if(!authenticatedOwner(r,m)||!m.ownerCommand||m.quotedId||m.source==='voice')return;
  const match=/^\/(claude|codex|brain|screen|back|help)(?:\s+(.*))?$/i.exec(m.text.trim());if(!match)return;
  const cmd=match[1].toLowerCase(),arg=(match[2]??'').trim();
  if(['help','back','brain','screen'].includes(cmd)&&arg)throw Error(`Use /${cmd} on its own.`);
  if(cmd==='help')return `Current target: ${currentTarget(r)}\n\n${TELEGRAM_COMMANDS.map(c=>`/${c.command}: ${c.description}`).join('\n')}\n\nSend /claude list or /codex list to choose another session. Existing /to, /talk, /use, /pause, /resume and permission commands still work.`;
  if(cmd==='back'){clear(r);return 'Back to normal routing. Your next messages use the configured brain/proxy.';}
  if(cmd==='brain'){brain(r);clear(r);r.store.set(routeKey(r),JSON.stringify({kind:'brain'}));return 'Now using the Meta brain. If it is unavailable, you will get an error, not a fallback session. Use /back to leave.';}
  if(cmd==='screen')return r.remoteControl?await r.remoteControl('/remote')??'Screen viewing is unavailable. Check Remote Desktop settings in FarFromDesk.':'Screen viewing is unavailable in this build. Open Remote Desktop settings in FarFromDesk on your Mac.';
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
/** Best effort: reopen the picked Claude Desktop chat so its inbox is live before the
 * first message. Opens through the same once-only activation dispatch uses; sends nothing. */
function warm(r:Router,b:Binding) {
  if(b.provider!=='claude')return;
  void Promise.resolve().then(async()=>{
    if((r.native.connections.route(b)?.executionMode??r.store.get(`execution-mode:${b.id}`))!=='desktop')return;
    const s=(await r.native.catalog('claude',undefined,{fresh:true})).sessions.find(s=>s.id===b.native_id&&sameProject(s.cwd,b.cwd)&&s.executionMode==='desktop'&&s.available===true);
    if(s?.activation==='desktop-open')await r.native.activation.ready(s);
  }).catch(e=>console.error(`Desktop warm-up failed: ${errorCode(e)}`));
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
  }else r.queue(m.id,session(r,target),m.text);
  return true;
}
export function clearOwnerTarget(r:Router){clear(r);}

export function ownerAttachmentTarget(r:Router,m:Incoming):Binding|undefined {
  if(!authenticatedOwner(r,m)||m.quotedId)return;
  const target=JSON.parse(r.store.get(routeKey(r))??'null') as Target|null;if(!target)return;
  if(target.kind==='brain')throw Error('Meta brain mode accepts text and voice. Choose /claude or /codex for a file, or quote the intended session reply.');
  return session(r,target);
}

export const isOwnerCommand=(text:string)=>/^\/(claude|codex|brain|screen|back|help)(?:\s|$)/i.test(text.trim());
