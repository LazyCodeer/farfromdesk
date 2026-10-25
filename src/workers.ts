import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Store, Provider, Binding } from './store.js';
import type { Router } from './router.js';
import type { Masters } from './masters.js';
import { executionMode, type ExecutionMode } from './desktop-claude.js';
import { saveBindingCredentials } from './server.js';
import type { SessionRoute } from './connections.js';

type Creation={route?:SessionRoute;executionMode?:ExecutionMode;desktopParentId?:string;id:string;requestId:string;masterId:string;provider:Provider;name:string;text:string;eventId:string;status:'awaiting_approval'|'needs_approval'|'creating'|'ready'|'denied'|'uncertain';bindingId?:string;cwd?:string;error?:string};
type Workspace={path:string;dev:number;ino:number;approvedAt:number};
export class Workers {
  tasks=new Map<string,Promise<void>>();
  private closed=false;
  private workspaceGrant?:Promise<Workspace|null>;
  constructor(private store:Store,private router:Router,private masters:Masters,readonly root=join(homedir(),'Tether Projects'),private saveCredentials=saveBindingCredentials) {
    for(const op of this.operations()) {
      if(op.status==='creating')this.save({...op,status:'uncertain',error:'The bridge restarted during native creation. Check this exact session before trying again.'});
      if(op.status==='awaiting_approval')this.save({...op,status:'needs_approval',error:'Approval was interrupted. Repeat the creation request with the same event ID to ask again.'});
    }
  }
  operations(){return this.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'worker-create:%'").all().map((r:any)=>JSON.parse(r.value) as Creation);}
  pending(requestId:string){return this.operations().some(o=>o.requestId===requestId&&['awaiting_approval','needs_approval','creating'].includes(o.status));}
  get(id:string){return JSON.parse(this.store.get(`worker-create:${id}`)??'null') as Creation|null;}
  save(op:Creation){this.store.set(`worker-create:${op.id}`,JSON.stringify(op));}
  view(id?:string){return this.operations().filter(o=>!id||o.id===id).map(({text,...op})=>{
    const taskRequestId=op.bindingId?`master:${op.requestId}:create-${op.id}:${op.bindingId}`:undefined;
    const task=taskRequestId?this.store.job(taskRequestId):undefined;
    const execution=task?(['uncertain','failed'].includes(task.status)?'blocked':task.status==='completed'?'answered':task.status==='submitted'?'awaiting_reply':task.status==='dispatched'?'submitting':task.status):'not_started';
    return {...op,taskRequestId,taskStatus:task?.status,execution,outcome:task?.outcome,currentError:task?.error??(task?null:op.error),lastError:task?.last_error??op.error};
  });}
  revoke() {
    this.store.set('worker-workspace','null');
    for(const b of this.store.bindings())if(this.store.get(`managed-worker:${b.id}`)==='true') {
      this.store.enable(b.id,false);this.router.approvals.cancel(b.id);this.masters.stopWorker(b.id);
    }
    for(const op of this.operations())if(['awaiting_approval','needs_approval'].includes(op.status))this.router.approvals.cancel(op.masterId);
    return 'Workspace approval revoked. Bridge-created worker sessions are paused; their files and histories are kept. Future creation will ask for approval again.';
  }
  workspace() {
    const w=JSON.parse(this.store.get('worker-workspace')??'null') as Workspace|null;
    if(!w)return null;
    const stat=lstatSync(this.root);
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==w.dev||stat.ino!==w.ino||realpathSync(this.root)!==w.path)throw new Error('The approved workspace changed. Review its location before creating sessions.');
    return w;
  }
  ensureRun(b:Binding) {
    const w=this.workspace(),op=this.operations().find(o=>o.bindingId===b.id);
    if(!w||!op||b.cwd!==join(w.path,`project-${op.id}`)||lstatSync(b.cwd).isSymbolicLink()||realpathSync(b.cwd)!==b.cwd)throw new Error('Worker workspace is not approved or its path changed. Forwarding stopped.');
  }
  async start(input:{requestId:string;provider:Provider;name:string;text:string;eventId:string;executionMode?:unknown}):Promise<any> {
    if(this.closed||this.router.stopped)throw new Error('Background operation is paused.');
    const parent=this.router.coordinator!.ownerRequest(input.requestId);
    if(!['codex','claude'].includes(input.provider)||!this.router.coordinator!.enabled().includes(input.provider))throw new Error('Choose an enabled platform.');
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100||/[\r\n]/.test(input.name)||typeof input.text!=='string'||!input.text.trim()||input.text.length>24000||typeof input.eventId!=='string'||!/^[a-zA-Z0-9._:-]{1,100}$/.test(input.eventId))throw new Error('A short project name, task and stable event ID are required.');
    const requestedMode=input.executionMode;
    const id=createHash('sha256').update(input.requestId+'\0'+input.eventId).digest('hex').slice(0,24);
    let op=this.get(id);
    const preference=JSON.parse(this.store.get(`platform-preference:${input.provider}`)??'null');
    const savedMode=preference?.executionMode;
    if(requestedMode===undefined&&!op&&!savedMode)throw new Error(`Choose ${input.provider} Desktop or CLI for this new session. No default connection has been selected for this platform.`);
    const mode=executionMode(input.provider,requestedMode??(op?(op.executionMode??'cli'):savedMode));
    const desktopParentId=op?.desktopParentId??(input.provider==='claude'&&mode==='desktop'?preference?.desktopParentId:undefined);
    if(op) {
      if((op.executionMode??'cli')!==mode||op.provider!==input.provider||op.name!==input.name||op.text!==input.text)throw new Error('A creation event ID cannot be reused for a different task.');
      if(op.status!=='needs_approval'||this.tasks.has(id))return this.view(id)[0];
    }else {
      const route=await this.masters.connections.prepare({provider:input.provider,cwd:join(this.root,`project-${id}`)},mode,mode==='cli');
      if(preference?.executionMode===mode&&mode==='cli'&&(route.accountKey!==preference.route?.accountKey||route.profileId!==preference.route?.profileId))throw new Error('The preferred CLI account or provider changed. Review Coding platforms in Home before creating this session.');
      // Recheck after the bounded account probe; an owner request may have closed meanwhile.
      this.router.coordinator!.ownerRequest(input.requestId);
      const concurrent=this.get(id);if(concurrent)return this.start(input);
      op={route,executionMode:mode,desktopParentId,requestId:input.requestId,provider:input.provider,name:input.name,text:input.text,eventId:input.eventId,id,masterId:parent.binding_id,status:'awaiting_approval'};
    }
    this.save(op);
    const destination=parent.destination??this.store.get('whatsapp-owner')!;
    const task=this.store.destinationContext.run(destination,()=>this.create(op!)).catch(e=>{
      if(this.closed)return;
      const current=this.get(id)!;this.save({...current,status:'uncertain',error:e instanceof Error?e.message:'Native creation could not be confirmed.'});
      if(current.bindingId&&!this.store.job(`master:${current.requestId}:create-${id}:${current.bindingId}`))this.masters.stopWorker(current.bindingId);
      this.store.output(undefined,`New ${input.provider} session could not be confirmed. ${this.get(id)!.error}\nReference: ${id}`,`worker-create:${id}:uncertain`,destination);
      this.reportFailure(this.get(id)!);
    }).finally(()=>this.tasks.delete(id));
    this.tasks.set(id,task);return this.view(id)[0];
  }
  private async approveWorkspace(op:Creation):Promise<Workspace|null> {
    const existing=this.workspace();if(existing)return existing;
    if(this.workspaceGrant)return this.workspaceGrant;
    this.workspaceGrant=(async()=>{
      const master=this.router.coordinator!.master()!;
      const answer=await this.router.approvals.ask(master,`Allow FarFromDesk to create new coding projects inside ${this.root}?\nThis approval applies to future owner-requested projects here. Codex uses workspace-write with native approvals; Claude CLI uses acceptEdits; Claude Desktop retains its own native permissions and may require initial folder approval. Commands or access requiring further native permission are sent here. This does not grant access to arbitrary folders.`);
      if(this.closed)return null;
      this.router.coordinator!.ownerRequest(op.requestId);
      if(answer!=='approve')return null;
      if(!existsSync(this.root))mkdirSync(this.root,{mode:0o700});
      const stat=lstatSync(this.root);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Choose a real workspace directory, not a symbolic link.');
      const w={path:realpathSync(this.root),dev:stat.dev,ino:stat.ino,approvedAt:Date.now()};this.store.set('worker-workspace',JSON.stringify(w));
      this.store.audit('worker-workspace-approved',master.id,JSON.stringify({path:w.path}));return w;
    })().finally(()=>{this.workspaceGrant=undefined;});
    return this.workspaceGrant;
  }
  async create(op:Creation) {
    if(op.provider==='claude'&&op.executionMode==='desktop') {
      const launcher=await this.masters.desktop.parent(op.desktopParentId);
      op={...op,desktopParentId:launcher.id};this.save(op);
    }
    const w=await this.approveWorkspace(op);
    if(this.closed)return;
    if(!w){this.save({...op,status:'denied'});this.store.output(undefined,'Project creation was not approved. No session was created.',`worker-create:${op.id}:denied`);this.reportFailure(this.get(op.id)!);return;}
    this.router.coordinator!.ownerRequest(op.requestId);
    if(this.router.stopped||!this.router.coordinator!.enabled().includes(op.provider))throw new Error('Background operation or this platform is paused.');
    if(this.workspace()?.approvedAt!==w.approvedAt)throw new Error('Workspace approval changed before creation.');
    op={...op,status:'creating'};this.save(op);
    const cwd=join(w.path,`project-${op.id}`);mkdirSync(cwd,{mode:0o700});
    if(realpathSync(cwd)!==cwd)throw new Error('Project path changed; creation stopped.');
    const r=this.store.register(`${op.provider}-work-${op.id}`,op.provider,randomUUID(),cwd);
    let b=r.binding;this.store.enable(b.id,false);this.saveCredentials(b,r.token);
    op={...op,bindingId:b.id,cwd};this.save(op);
    this.store.set(`execution-mode:${b.id}`,op.executionMode??'cli');if(op.desktopParentId)this.store.set(`desktop-parent:${b.id}`,op.desktopParentId);
    if(op.route)this.masters.connections.save(b,op.route);
    this.store.set(`name:${b.id}`,op.name);this.store.set(`managed-worker:${b.id}`,'true');
    const instructions='This is a dedicated owner-requested coding project. Preserve native permissions. Work only on the requested project. Report progress and final results on the exact incoming bridge request. Do not contact other sessions or approve your own permissions.';
    writeFileSync(join(cwd,'AGENTS.md'),instructions,{mode:0o600});writeFileSync(join(cwd,'CLAUDE.md'),instructions,{mode:0o600});
    await this.masters.provisionWorker(b);
    if(this.closed)return;
    b=this.store.binding(b.id)!;this.saveCredentials(b,r.token);
    if(this.workspace()?.approvedAt!==w.approvedAt){this.masters.stopWorker(b.id);throw new Error('Workspace approval changed during creation. The new session remains inactive.');}
    this.router.coordinator!.ownerRequest(op.requestId);
    if(this.router.stopped||!this.router.coordinator!.enabled().includes(op.provider))throw new Error('Creation finished while forwarding was paused; the new session remains inactive.');
    this.store.enable(b.id,true);
    const previous=JSON.parse(this.store.get('selected')??'[]') as string[];
    this.store.set('selected',JSON.stringify([...new Set([...previous,b.id])]));
    this.router.coordinator!.dispatch(op.requestId,[b.id],op.text,`create-${op.id}`);
    this.save({...op,status:'ready'});
    this.store.output(undefined,`Created “${op.name}” in ${op.provider} and queued your task. Your other sessions remain connected.`, `worker-create:${op.id}:ready`);
  }
  async recover(requestId:string,id:string) {
    if(this.closed||this.router.stopped)throw new Error('Background operation is paused.');
    const parent=this.router.coordinator!.ownerRequest(requestId),op=this.get(id);
    if(!op||op.status!=='uncertain'||!op.bindingId)throw new Error('No exact uncertain session is available to recover. Check creation status first.');
    if(this.tasks.has(id))return this.view(id)[0];
    let b=this.store.binding(op.bindingId);if(!b)throw new Error('The original binding is missing; recovery stopped.');
    if(!this.router.coordinator!.enabled().includes(b.provider))throw new Error('This platform is paused.');
    this.ensureRun(b);
    const existing=this.store.job(`master:${op.requestId}:create-${op.id}:${b.id}`);
    if(existing){this.save({...op,status:'ready',error:undefined});return {...this.view(id)[0],existingTaskStatus:existing.status,note:'The original task already exists. It was not resubmitted.'};}
    const next={...op,requestId,masterId:parent.binding_id,status:'creating' as const,error:undefined};this.save(next);
    const destination=parent.destination??this.store.get('whatsapp-owner')!;
    const task=this.store.destinationContext.run(destination,async()=>{
      await this.masters.recoverWorker(b!);b=this.store.binding(op.bindingId!)!;
      if(this.closed)return;
      this.router.coordinator!.ownerRequest(requestId);this.ensureRun(b);
      if(this.router.stopped||!this.router.coordinator!.enabled().includes(b.provider))throw new Error('Background operation or platform is paused.');
      this.store.enable(b.id,true);const selected=JSON.parse(this.store.get('selected')??'[]') as string[];
      this.store.set('selected',JSON.stringify([...new Set([...selected,b.id])]));
      this.router.coordinator!.dispatch(requestId,[b.id],op.text,`create-${op.id}`);
      this.save({...next,status:'ready'});this.store.output(undefined,`Recovered “${op.name}” in the same native session and queued the original task.`,`worker-create:${op.id}:recovered:${requestId}`);
    }).catch(e=>{if(this.closed)return;this.save({...next,status:'uncertain',error:e instanceof Error?e.message:'Exact-session recovery failed.'});this.store.output(undefined,`Recovery is still blocked: ${this.get(id)!.error}`,`worker-create:${id}:recovery-error:${requestId}`,destination);this.reportFailure(this.get(id)!);}).finally(()=>this.tasks.delete(id));
    this.tasks.set(id,task);return this.view(id)[0];
  }
  private reportFailure(op:Creation) {
    const master=this.router.coordinator!.master(),parent=this.store.job(op.requestId);
    if(!master||master.id!==op.masterId||!parent||parent.status==='replaced')return;
    this.store.set(`report-parent:report:creation:${op.id}:${op.status}`,op.requestId);
    this.store.enqueue(`report:creation:${op.id}:${op.status}`,master,`Creation operation ${op.id} for owner request ${op.requestId} is ${op.status}. ${op.error??'The owner did not approve workspace access.'} This is a status report, not authorization to retry. The user already received the status. Close the original owner request as blocked if no further work is possible; do not create a replacement or duplicate the notification.`,parent.destination??null);
    this.router.pump();
  }
  close(){this.closed=true;}
}
