#!/usr/bin/env node
import { initializeState,stateDir,baseUrl,claudeBin } from './config.js';
import { readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync,readdirSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn,execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { handleHook } from './hooks.js';
import { inspectLocalArtifact } from './large-file.js';
import { uploadArtifact } from './artifact-upload.js';
import { parseRespondArgs } from './reply-args.js';
import { runFfd } from './ffd.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const args=process.argv.slice(2);let command=args.shift();
// ffd ALIAS master OP ... is the master command with the session already chosen.
if(command==='ffd'&&args[1]==='master'){const alias=args.shift()!;args.shift();args.push('--binding',alias);command='master';}
async function api(path:string,data?:unknown) {
  const r=await fetch(baseUrl+path,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${initializeState()}`,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  const d=await r.json() as any;if(!r.ok)throw new Error(d.error);return d;
}
function credentials(alias:string) {
  if(!/^[a-z][a-z0-9-]{0,39}$/.test(alias??''))throw new Error('A registered session name is required');
  const path=join(stateDir,'bindings',`${alias}.json`);return {path,data:JSON.parse(readFileSync(path,'utf8'))};
}
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const serviceFile=join(homedir(),'Library/LaunchAgents/com.sagar.whatsapp-session-bridge.plist');
const target=`gui/${process.getuid?.()}/com.sagar.whatsapp-session-bridge`;
function resolveBin(name:string){if(name.includes('/'))return name;return execFileSync('/usr/bin/which',[name],{encoding:'utf8'}).trim();}
async function main() {
  if(command==='status'){const d=await api('/api/status');delete d.whatsapp.qr;console.log(JSON.stringify(d,null,2));}
  else if(command==='mac-status') {
    if(args.length)throw new Error('Use mac-status without arguments. It only checks permission and never prompts or controls an app.');
    console.log(JSON.stringify(await api('/api/mac-control',{action:'check'}),null,2));
  }
  else if(command==='request-events') {
    if(args.length!==1||!args[0]||args[0].length>1000)throw new Error('Use request-events REQUEST-ID to read saved events and delivery status.');
    console.log(JSON.stringify(await api('/api/request-events?id='+encodeURIComponent(args[0])),null,2));
  }
  else if(command==='sessions'){console.log(JSON.stringify(await api(`/api/catalog?provider=${encodeURIComponent(args[0]??'codex')}`),null,2));}
  else if(command==='register') {
    const [provider,alias,nativeId,cwd,mode='desktop']=args;
    if(!cwd)throw new Error('Usage: register codex|claude NAME EXACT-SESSION-ID /absolute/project [desktop|channel]');
    console.log(JSON.stringify(await api('/api/register',{provider,alias,nativeId,cwd,mode}),null,2));
  }
  else if(command==='ffd') {
    const alias=args.shift()!,c=credentials(alias);
    const call=async(path:string,data?:unknown)=>{const r=await fetch(baseUrl+path,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${c.data.token}`,'X-Binding-Id':c.data.id,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const d=await r.json() as any;if(!r.ok)throw new Error(d.error);return d;};
    console.log(await runFfd(args,c.data,call,()=>readFileSync(0,'utf8')));
  }
  else if(command==='send'||command==='respond') {
    const flag=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args.splice(i,2)[1];};
    const reply=command==='respond'?parseRespondArgs(args):undefined;
    const turnId=reply?reply.turnId:flag('--turn-id'),outcome=reply?reply.outcome:flag('--outcome');
    const alias=reply?.alias??args[0],c=credentials(alias);
    const text=command==='send'&&args.length>1?args.slice(1).join(' '):readFileSync(0,'utf8');
    if(reply&&!text.trim())throw new Error('The reply text on stdin is empty; nothing was sent.');
    const requestId=reply?.requestId,kind=reply?.kind??'final';
    const r=await fetch(baseUrl+'/api/session/reply',{method:'POST',headers:{Authorization:`Bearer ${c.data.token}`,'X-Binding-Id':c.data.id,'Content-Type':'application/json'},body:JSON.stringify({text,requestId,kind,eventId:randomUUID(),turnId,outcome})});
    if(!r.ok)throw new Error(await r.text());console.log('Queued for WhatsApp.');
  }
  else if(command==='prepare-file'||command==='prepare-desktop-file') {
    const desktop=command==='prepare-desktop-file'?JSON.parse(readFileSync(0,'utf8')):undefined;
    const [alias,requestId,path]=desktop?['',desktop.requestId,desktop.path]:args;
    const bindingId=desktop?desktop.bindingId:credentials(alias).data.id;
    if(typeof bindingId!=='string'||!requestId||!path||(args[3]!==undefined&&args[3]!=='--self'))throw new Error('Usage: prepare-file NAME REQUEST-ID /absolute/reviewed/document.html [--self]');
    let capability:any;try{capability=await api('/api/media/capabilities');}catch{throw new Error('Could not confirm streaming file support in the installed backend. Update it separately before preparing documents with this CLI.');}
    if(capability.preparation!=='stream-v1')throw new Error('Installed backend does not support streaming file preparation. Update it separately first.');
    const artifact=await inspectLocalArtifact(path);let uploadId:string|undefined;
    try {
      if(artifact.bytes>capability.maxOutgoingDocumentBytes)throw new Error('This file exceeds the installed backend document limit.');
      const reservation=await api('/api/artifacts/reserve',{bindingId,requestId,filename:artifact.filename,bytes:artifact.bytes,sha256:artifact.sha256,destinationMode:args[3]==='--self'?'self':'request'});
      if(reservation.artifactId){console.log(JSON.stringify(reservation,null,2));return;}
      uploadId=reservation.uploadId;
      const result=await uploadArtifact(baseUrl+'/api/artifacts/upload/'+uploadId,initializeState(),artifact.handle,artifact.bytes);
      console.log(JSON.stringify(result,null,2));
    }catch(e){if(uploadId){
      const status=await api('/api/artifacts/upload-status?id='+encodeURIComponent(uploadId)).catch(()=>undefined);
      if(status?.state==='prepared'){console.log(JSON.stringify(status,null,2));return;}
      await api('/api/artifacts/upload-cancel',{uploadId}).catch(()=>{});
    }throw e;}
    finally{await artifact.handle.close();}
  }
  else if(command==='respond-file'||command==='delivery') {
    const c=credentials(args[0]);
    const path=command==='delivery'?'/api/session/delivery?id='+encodeURIComponent(args[1]??''):'/api/session/document';
    const d=command==='respond-file'?{requestId:args[1],artifactId:args[2],caption:readFileSync(0,'utf8').trim()}:undefined;
    const r=await fetch(baseUrl+path,{method:d?'POST':'GET',headers:{Authorization:`Bearer ${c.data.token}`,'X-Binding-Id':c.data.id,'Content-Type':'application/json'},body:d?JSON.stringify(d):undefined});
    const result=await r.json() as any;if(!r.ok)throw new Error(result.error);console.log(JSON.stringify(result,null,2));
  }
  else if(command==='agents') {
    const op=args.shift()??'list';
    if(op==='list')console.log(JSON.stringify(await api('/api/agents'),null,2));
    else if(op==='sync')console.log(JSON.stringify(await api('/api/agents/sync',{}),null,2));
    else if(op==='create')console.log(JSON.stringify(await api('/api/agents',JSON.parse(readFileSync(0,'utf8'))),null,2));
    else if(op==='assign'){const c=credentials(args[0]);console.log(JSON.stringify(await api('/api/agents/assign',{bindingId:c.data.id,name:args[1]}),null,2));}
    else throw new Error('Use agents list|sync|create (JSON on stdin)|assign SESSION AGENT-NAME');
  }
  else if(command==='style') {
    const c=credentials(args[0]);console.log(JSON.stringify(await api('/api/roles',{bindingId:c.data.id,style:args[1]}),null,2));
  }
  else if(command==='media-capabilities')console.log(JSON.stringify(await api('/api/media/capabilities'),null,2));
  else if(command==='cleanup-media')console.log(await api('/api/media/cleanup',{}));
  else if(command==='cancel-file'||command==='cancel-attachments') {
    const c=credentials(args[0]);console.log(await api(command==='cancel-file'?'/api/artifacts/cancel':'/api/attachments/cancel',{bindingId:c.data.id,artifactId:args[1],requestId:args[1]}));
  }
  else if(command==='configure-audio')console.log(await api('/api/audio-config',{ffmpeg:args[0],whisper:args[1],model:args[2]}));
  else if(command==='hook') {
    const result=await handleHook(args[0],JSON.parse(readFileSync(0,'utf8')));if(result)console.log(JSON.stringify(result));
  }
  else if(command==='install-hooks') {
    initializeState();
    const q=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;
    for(const [provider,file] of [['codex',join(homedir(),'.codex/hooks.json')],['claude',join(homedir(),'.claude/settings.json')]]) {
      const original=existsSync(file)?readFileSync(file,'utf8'):'{}';const config=JSON.parse(original);
      config.hooks??={};let changed=false;
      for(const event of ['Stop','PermissionRequest']) {
        config.hooks[event]??=[];
        const command=`${q(process.execPath)} ${q(join(root,'dist/cli.js'))} hook ${provider}`;
        if(!config.hooks[event].some((group:any)=>group.hooks?.some((h:any)=>h.command===command))) {
          config.hooks[event].push({hooks:[{type:'command',command,timeout:event==='PermissionRequest'?920:8}]});changed=true;
        }
      }
      if(changed){writeFileSync(`${file}.whatsapp-bridge-backup-${Date.now()}`,original,{mode:0o600});writeFileSync(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});}
    }
    console.log('Installed session-scoped Stop and PermissionRequest hooks. Existing hooks preserved. Native apps may require their normal hook trust/reload step.');
  }
  else if(command==='command'){console.log(await api('/api/action',{command:args.join(' ')}));}
  else if(command==='master-setup'){const s=await api('/api/status'),b=s.bindings.find((b:any)=>b.alias===args[0]);if(!b)throw new Error('Master binding not found');console.log(await api('/api/master-setup',{bindingId:b.id}));}
  else if(command==='master') {
    const bindingIndex=args.indexOf('--binding');
    const alias=bindingIndex<0?'whatsapp-master':args.splice(bindingIndex,2)[1];
    const operation=args.shift(),c=credentials(alias);
    const attachmentIndex=args.indexOf('--attachments');
    const attachmentIds=attachmentIndex>=0?args.splice(attachmentIndex,2)[1]?.split(','):[];
    if(attachmentIndex>=0&&(!attachmentIds?.length||operation!=='dispatch'))throw new Error('Use --attachments ID[,ID] only with master dispatch.');
    const pageIndex=args.findIndex(a=>['--more','--back','--page'].includes(a));
    let page='0';if(operation==='sessions'&&pageIndex>=0){const flag=args.splice(pageIndex,1)[0];page=flag==='--more'?'more':flag==='--back'?'back':args.splice(pageIndex,1)[0];}
    if(operation==='browser'||operation==='mac'||operation==='desktop') {
      const input=JSON.parse(readFileSync(0,'utf8'));
      const r=await fetch(baseUrl+(operation==='desktop'?'/api/master/desktop-control':operation==='mac'?'/api/master/mac-control':'/api/master/browser'),{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${c.data.token}`,'X-Binding-Id':c.data.id,'Content-Type':'application/json'},body:JSON.stringify({...input,requestId:args[0]}),signal:AbortSignal.timeout(65000)});
      const result=await r.json() as any;if(!r.ok)throw new Error(result.error);console.log(JSON.stringify(result,null,2));return;
    }
    if(operation==='reach') {
      if(args.length!==1)throw new Error('Use master reach REQUEST-ID. The query comes only from the original owner message.');
      const r=await fetch(baseUrl+'/api/master/reach',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${c.data.token}`,'X-Binding-Id':c.data.id,'Content-Type':'application/json'},body:JSON.stringify({requestId:args[0]}),signal:AbortSignal.timeout(25000)});
      const result=await r.json() as any;if(!r.ok)throw new Error(result.error);console.log(JSON.stringify(result,null,2));return;
    }
    if(['agents','define-agent','assign-agent'].includes(operation??'')) {
      const d=operation==='agents'?undefined:operation==='define-agent'?{...JSON.parse(readFileSync(0,'utf8')),requestId:args[0]}:{requestId:args[0],bindingId:args[1],name:args[2]};
      const result=await fetch(baseUrl+'/api/master/'+operation,{method:d?'POST':'GET',headers:{Authorization:`Bearer ${c.data.token}`,'X-Binding-Id':c.data.id,'Content-Type':'application/json'},body:d?JSON.stringify(d):undefined});
      const data=await result.json() as any;if(!result.ok)throw new Error(data.error);console.log(JSON.stringify(data,null,2));return;
    }
    const path=operation==='coordinators'?'/api/master/coordinators':operation==='delegate'?'/api/master/delegate':operation==='recover-worker'?'/api/master/recover-worker':operation==='create-worker'?'/api/master/create-worker':operation==='creation-status'?'/api/master/worker-status?id='+encodeURIComponent(args[0]??''):operation==='sessions'?'/api/master/sessions?search='+encodeURIComponent(args.join(' '))+'&page='+encodeURIComponent(page):operation==='selected'?'/api/master/selected':operation==='connect'?'/api/master/connect':operation==='dispatch'?'/api/master/dispatch':operation==='resolve'?'/api/master/resolve':operation==='quiet'?'/api/master/quiet':null;
    if(!path)throw new Error('Use master [--binding ALIAS] coordinators | delegate REQUEST-ID COORDINATOR-ID EVENT-ID (task on stdin) | create-worker REQUEST-ID PROVIDER NAME EVENT-ID [desktop|cli] (task on stdin) | creation-status [ID] | recover-worker REQUEST-ID ID | sessions [search] [--more|--back|--page N] | selected | connect REQUEST-ID PROVIDER:UUID[,PROVIDER:UUID] | dispatch REQUEST-ID BINDING-ID[,BINDING-ID] EVENT-ID | quiet REPORT-ID [done|blocked|reviewed|cancelled] | resolve OWNER-REQUEST-ID done|blocked|reviewed|cancelled');
    const data=operation==='delegate'?{requestId:args[0],coordinatorId:args[1],eventId:args[2],text:readFileSync(0,'utf8')}:operation==='recover-worker'?{requestId:args[0],id:args[1]}:operation==='create-worker'?{requestId:args[0],provider:args[1],name:args[2],eventId:args[3],executionMode:args[4],text:readFileSync(0,'utf8')}:operation==='connect'?{requestId:args[0],targets:args[1]?.split(',')}:operation==='dispatch'?{requestId:args[0],targets:args[1]?.split(','),eventId:args[2],attachmentIds,text:readFileSync(0,'utf8')}:operation==='resolve'?{requestId:args[0],outcome:args[1]}:operation==='quiet'?{requestId:args[0],resolveOutcome:args[1]}:undefined;
    const r=await fetch(baseUrl+path,{method:data?'POST':'GET',headers:{Authorization:`Bearer ${c.data.token}`,'X-Binding-Id':c.data.id,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
    const out=await r.json() as any;if(!r.ok)throw new Error(out.error);console.log(JSON.stringify(out,null,2));
  }
  else if(command==='open') {
    const app=[join(homedir(),'Applications/FarFromDesk.app'),'/Applications/FarFromDesk.app',join(homedir(),'Applications/Sidekick.app'),'/Applications/Sidekick.app',join(homedir(),'Applications/Session Bridge.app'),'/Applications/Session Bridge.app',join(root,'build/release-arm64/FarFromDesk.app'),join(root,'build/release-x86_64/FarFromDesk.app'),join(root,'build/Session Bridge.app')].find(existsSync);
    if(!app)throw new Error('Install FarFromDesk.app first. The browser dashboard has been retired.');
    execFileSync('/usr/bin/open',[app],{stdio:'ignore'});
  }
  else if(command==='channel-config'||command==='claude-channel') {
    const c=credentials(args[0]);if(c.data.provider!=='claude')throw new Error('Channel mode is for Claude Code.');
    const config=join(stateDir,'bindings',`${args[0]}.mcp.json`);
    writeFileSync(config,JSON.stringify({mcpServers:{'whatsapp-session':{command:process.execPath,args:[join(root,'dist/channel.js'),c.path],env:{WSB_STATE_DIR:stateDir,WSB_PORT:String(new URL(baseUrl).port)}}}},null,2),{mode:0o600});
    if(command==='channel-config'){console.log(config);return;}
    const child=spawn(claudeBin,['--resume',c.data.nativeId,'--mcp-config',config,'--dangerously-load-development-channels','server:whatsapp-session'],{cwd:c.data.cwd,stdio:'inherit'});
    child.on('exit',code=>process.exit(code??1));child.on('error',e=>{console.error(e.message);process.exit(1);});
  }
  else if(command==='install') {
    if(process.platform!=='darwin')throw new Error('Install the FarFromDesk desktop app with the platform installer.');
    initializeState();mkdirSync(dirname(serviceFile),{recursive:true});mkdirSync(join(stateDir,'logs'),{recursive:true,mode:0o700});
    const env:Record<string,string>={PATH:process.env.PATH??'/usr/bin:/bin',WSB_STATE_DIR:stateDir,WSB_PORT:new URL(baseUrl).port,WSB_CODEX_BIN:resolveBin('codex'),WSB_CLAUDE_BIN:resolveBin(claudeBin)};
    if(process.env.WSB_CODEX_SOCKET)env.WSB_CODEX_SOCKET=process.env.WSB_CODEX_SOCKET;
    const p=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.sagar.whatsapp-session-bridge</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(root,'dist/main.js'))}</string></array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v])=>`<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(stateDir,'logs/service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(stateDir,'logs/error.log'))}</string></dict></plist>`;
    writeFileSync(serviceFile,p,{mode:0o600});
    try{execFileSync('/bin/launchctl',['bootout',target],{stdio:'ignore'});}catch{}
    execFileSync('/bin/launchctl',['bootstrap',`gui/${process.getuid?.()}`,serviceFile],{stdio:'inherit'});
    console.log('Installed background service. Run npm run bridge -- open to pair WhatsApp.');
  }
  else if(command==='stop-service') {if(process.platform!=='darwin')throw new Error('Use FarFromDesk Settings to stop background operation.');execFileSync('/bin/launchctl',['bootout',target],{stdio:'inherit'});console.log('Stopped. Credentials and sessions are retained.');}
  else if(command==='install-skills') {
    for(const dir of [join(homedir(),'.codex/skills/whatsapp-session'),join(homedir(),'.claude/skills/whatsapp-session')]){
      mkdirSync(dir,{recursive:true});let skill=readFileSync(join(root,'skills/whatsapp-session/SKILL.md'),'utf8').replaceAll('{{BRIDGE_CLI}}',join(root,'dist/cli.js')).replaceAll('{{NODE}}',process.execPath);
      writeFileSync(join(dir,'SKILL.md'),skill);
    }
    console.log('Installed the session-scoped WhatsApp skill for Claude Code and Codex.');
  }
  else console.log('Commands: style NAME friendly|cheerful|professional|coding | media-capabilities | cleanup-media | cancel-file NAME ARTIFACT-ID | cancel-attachments NAME REQUEST-ID | status | sessions codex|claude | register PROVIDER NAME ID CWD [desktop|channel] | send NAME [TEXT, or stdin] | respond NAME REQUEST-ID [progress|final] | prepare-file NAME REQUEST-ID /absolute/file | respond-file NAME REQUEST-ID ARTIFACT-ID (caption on stdin) | delivery NAME DELIVERY-ID | configure-audio /absolute/ffmpeg /absolute/whisper-cli /absolute/model | command /COMMAND | open | channel-config NAME | claude-channel NAME | install | stop-service | install-skills | install-hooks');
}
// A refused connection means the app is closed or restarting; ffd and master commands repeat safely.
main().catch(e=>{console.error(e.message==='fetch failed'?'FarFromDesk is not reachable right now (it may be restarting). Wait a minute and run the exact same command again; the same ffd or master command with the same text never sends twice.':e.message);process.exitCode=1;});
