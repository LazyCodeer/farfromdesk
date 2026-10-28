import { hash, type Binding } from './store.js';
import type { Router, Incoming } from './router.js';
import { brainPolicy } from './meta-brain-config.js';
import { endDirect, DIRECT_IDLE_MS } from './owner-routing.js';

export const TELEGRAM_COMMANDS=[
  {command:'claude',description:'Talk to a connected Claude session'},
  {command:'codex',description:'Talk to a connected Codex session'},
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
type Choice={provider:string;targets:Extract<Target,{kind:'session'}>[];expires:number};
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
  if(!b||!enabled(r,b.provider)||!candidates(r,b.provider).some(x=>x.id===b.id)||identity(r,b)!==target.identity)throw Error('Your chosen session is paused, disconnected or changed. Choose /claude or /codex again. Nothing was sent elsewhere.');
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
  if(cmd==='help')return `Current target: ${currentTarget(r)}\n\n${TELEGRAM_COMMANDS.map(c=>`/${c.command}: ${c.description}`).join('\n')}\n\nOnly commands you type as a new message change routing. Existing /to, /talk, /use, /pause, /resume and permission commands still work.`;
  if(cmd==='back'){clear(r);return 'Back to normal routing. Your next messages use the configured brain/proxy.';}
  if(cmd==='brain'){brain(r);clear(r);r.store.set(routeKey(r),JSON.stringify({kind:'brain'}));return 'Now using the Meta brain. If it is unavailable, you will get an error, not a fallback session. Use /back to leave.';}
  if(cmd==='screen')return r.remoteControl?await r.remoteControl('/remote')??'Screen viewing is unavailable. Check Remote Desktop settings in FarFromDesk.':'Screen viewing is unavailable in this build. Open Remote Desktop settings in FarFromDesk on your Mac.';
  const provider=cmd==='codex'?'codex':'claude';if(!enabled(r,provider))throw Error(`${provider==='claude'?'Claude':'Codex'} is disabled. Enable it in Coding platforms first.`);
  let target:Extract<Target,{kind:'session'}>;
  if(arg){
    const choice=JSON.parse(r.store.get(choiceKey(r))??'null') as Choice|null;
    if(!/^\d+$/.test(arg)||!choice||choice.provider!==provider||choice.expires<Date.now()||!choice.targets[Number(arg)-1])throw Error(`Send /${cmd} for a fresh list, then /${cmd} NUMBER to choose.`);
    target=choice.targets[Number(arg)-1];
  }else{
    const available=candidates(r,provider);
    if(!available.length)throw Error(`No enabled connected ${provider==='claude'?'Claude':'Codex'} session is available. Connect or resume one in Coding platforms; no session was created.`);
    const targets=available.map(b=>({kind:'session' as const,id:b.id,identity:identity(r,b)}));
    if(targets.length>1){
      r.store.set(choiceKey(r),JSON.stringify({provider,targets,expires:Date.now()+10*60_000}));
      return `Choose a connected ${provider==='claude'?'Claude':'Codex'} target:\n${available.map((b,i)=>`${i+1}. ${name(r,b)} · ${r.store.get(`execution-mode:${b.id}`)??'cli'}${r.coordinator?.isCoordinator(b.id)?' · proxy':''}`).join('\n')}\nReply /${cmd} NUMBER. Current target: ${currentTarget(r)}.`;
    }
    target=targets[0];
  }
  const b=session(r,target);clear(r);r.store.set(routeKey(r),JSON.stringify(target));
  return `Now talking to ${name(r,b)} (${provider}). Your next messages go to this exact session. Permissions, account and runtime are unchanged. Use /back to leave.`;
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
