import { desktopInput } from './desktop-control.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

/** The farfromdesk skill: one short command (ffd) per session with the app paths, port and
 * session name built in, so a session never assembles bridge commands by hand. */
const hash=(...parts:string[])=>createHash('sha256').update(parts.join('\0')).digest('hex').slice(0,24);

export function ffdSkill(ffd:string) {
  return `---
name: farfromdesk
description: Reply to the owner and hand work to other sessions or coordinators through FarFromDesk. Use for every FarFromDesk envelope.
---
# FarFromDesk

FFD below is ${ffd}. Run it as given; it already knows your session, the app and its port. REQ is the requestId from the current envelope. Text goes as one single-quoted argument, or on stdin when you leave it out.

- Reply to the owner: FFD reply REQ progress 'text' for a meaningful update, FFD reply REQ final 'text' only when the request is done or clearly blocked.
- Ask another platform's coordinator (for example the owner says Claude, or a voice note says "cloud"): FFD ask claude REQ 'task' or FFD ask codex REQ 'task'. Give the owner's request and what you already know. If that coordinator is not set up, ffd says so; tell the owner to add it in FarFromDesk, Coding platforms.
- Desktop functions (proxies only): FFD desktop REQ, JSON on stdin. Use list_apps/list_browsers, then list_tabs with explicit browser or list_windows with appRef. Read using exact windowRef/tabRef. Every mutation needs UUID actionId; unknown outcomes are never retried. Browser tabs support new_tab/focus_tab/navigate_tab/close_tab in an existing chosen window. chat_controls reads known app context; chat_action new/draft/send follows the owner task, and send requires exact expectedDraft and explicit authorization. Stop and disable remains in Settings.
- List sessions: FFD sessions [search words]. It lists your platform's sessions and shows which coordinator handles the other platforms.
- Send to a connected session: FFD send REQ 'session name' 'task'. Connect it first with FFD master connect REQ TARGET, using the target exactly as sessions printed it.
- Everything else: FFD master OPERATION ..., with the operations your role lists (MASTER in the role means FFD master).

Reply/ask/send commands use stable event IDs. Repeat the exact request, target and text only when retrying that same operation. Queued does not mean delivered. Never contact a session or coordinator the owner did not ask about.
`;
}

/** Writes this session's ffd launcher and skill once, under the app's coordinator home (outside the private data folder). */
export function ensureFfd(home:string,stateDir:string,alias:string,scopedCli:string,extraSkillDirs:string[]=[]) {
  if(!/^[a-z][a-z0-9-]{0,39}$/.test(alias))throw new Error('Invalid session name');
  const dir=join(home,'ffd',hash(stateDir).slice(0,10),alias),ffd=join(dir,'ffd'),skill=join(dir,'SKILL.md');
  const write=(file:string,content:string,mode:number)=>{if(!existsSync(file)||readFileSync(file,'utf8')!==content){writeFileSync(file,content,{mode});chmodSync(file,mode);}};
  mkdirSync(dir,{recursive:true,mode:0o700});
  // ponytail: POSIX shell only, like scopedBridgeCommand; add an ffd.cmd when CLI routes reach Windows.
  write(ffd,`#!/bin/sh\nexec ${scopedCli} ffd '${alias}' "$@"\n`,0o700);
  const text=ffdSkill(ffd);write(skill,text,0o600);
  for(const d of extraSkillDirs){mkdirSync(d,{recursive:true,mode:0o700});write(join(d,'SKILL.md'),text,0o600);}
  return {ffd,skill};
}

type Call=(path:string,data?:unknown)=>Promise<any>;
const usage='Use ffd reply REQ progress|final [TEXT] | ask claude|codex REQ [TEXT] | sessions [SEARCH] | send REQ SESSION [TEXT] | master OPERATION ...';

/** Runs one ffd command. Event IDs come from the content, so a retried command is recognised instead of sent twice. */
export async function runFfd(args:string[],self:{id:string},call:Call,stdin:()=>string):Promise<string> {
  const op=args.shift(),text=(rest:string[])=>{const t=rest.length?rest.join(' '):stdin();if(!t.trim())throw new Error('The text is empty; nothing was sent.');return t;};
  if(op==='desktop') {
    if(args.length!==1||!args[0])throw new Error('Use ffd desktop REQUEST-ID with action JSON on stdin.');
    const input=desktopInput.parse(JSON.parse(stdin()));
    return JSON.stringify(await call('/api/master/desktop-control',{...input,requestId:args[0]}),null,2);
  }
  if(op==='reply') {
    const [req,kind,...rest]=args;
    if(!req||kind!=='progress'&&kind!=='final')throw new Error('Use ffd reply REQ progress|final [TEXT]');
    const body=text(rest);
    await call('/api/session/reply',{text:body,requestId:req,kind,eventId:`ffd-${hash(req,kind,body)}`});
    return `Queued your ${kind} reply. Queued is not delivered; the owner may not have seen it yet.`;
  }
  if(op==='ask') {
    const [provider,req,...rest]=args;
    if(provider!=='claude'&&provider!=='codex'||!req)throw new Error('Use ffd ask claude|codex REQ [TEXT]');
    const body=text(rest),r=await call('/api/master/delegate',{requestId:req,coordinatorId:provider,text:body,eventId:`ask-${hash(provider,body)}`});
    return `Handed to the ${provider==='claude'?'Claude':'Codex'} coordinator (${r.requestId}). Its reply comes back to you as a worker report; it is not delivered yet.`;
  }
  if(op==='sessions') {
    const [list,coordinators]=await Promise.all([call('/api/master/sessions?search='+encodeURIComponent(args.join(' '))+'&page=0'),call('/api/master/coordinators')]);
    const own=coordinators.coordinators.find((c:any)=>c.bindingId===self.id);
    const others=(['codex','claude'] as const).filter(p=>p!==own?.provider).map(p=>{
      const c=coordinators.coordinators.find((c:any)=>c.provider===p),label=p==='claude'?'Claude':'Codex';
      return c?`${label} sessions are handled by the ${label} coordinator "${c.name}" (${c.state}). Hand work to it with: ffd ask ${p} REQ 'task'.`:`No ${label} coordinator is set up, so ${label} sessions cannot be reached. Tell the owner to add one in FarFromDesk, Coding platforms.`;
    });
    return [list.text,...others].join('\n\n');
  }
  if(op==='send') {
    const [req,name,...rest]=args;
    if(!req||!name)throw new Error('Use ffd send REQ SESSION [TEXT]');
    const {sessions}=await call('/api/master/selected'),wanted=name.trim().toLowerCase();
    const exact=sessions.filter((s:any)=>s.id===name||s.alias===name),named=sessions.filter((s:any)=>String(s.name).trim().toLowerCase()===wanted);
    const matches=exact.length?exact:named;
    if(matches.length>1)throw new Error(`More than one connected session is named "${name}". Use its alias: ${matches.map((s:any)=>s.alias).join(', ')}.`);
    if(!matches.length)throw new Error(`"${name}" is not connected. Run ffd sessions, then ffd master connect REQ TARGET, then send again.`);
    const body=text(rest),target=matches[0];
    await call('/api/master/dispatch',{requestId:req,targets:[target.id],text:body,eventId:`send-${hash(target.id,body)}`});
    return `Sent to "${target.name}". Its reply comes back to you as a worker report.`;
  }
  throw new Error(usage);
}
