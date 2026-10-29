import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { coordinatorHome } from './config.js';
import { homedir } from 'node:os';
import type { Store, Provider, Binding } from './store.js';
import type { Router } from './router.js';
import type { Masters } from './masters.js';
import { executionMode, type ExecutionMode } from './desktop-claude.js';
import { saveBindingCredentials } from './server.js';
import type { SessionRoute } from './connections.js';

type Creation={workspaceRoot?:string;taskOwnerRequestId?:string;recoveryAttemptId?:string;recoveryPrevious?:{status:Creation['status'];error?:string};route?:SessionRoute;executionMode?:ExecutionMode;desktopParentId?:string;id:string;requestId:string;masterId:string;provider:Provider;name:string;text:string;eventId:string;status:'checking'|'awaiting_approval'|'needs_approval'|'creating'|'ready'|'denied'|'uncertain'|'blocked'|'needs_action';originRequestId?:string;stage?:'preflight'|'workspace'|'native'|'dispatch';bindingId?:string;cwd?:string;error?:string};
class WorkspaceApprovalExpired extends Error {}
type Workspace={root?:string;path:string;dev:number;ino:number;approvedAt:number};
export class Workers {
  tasks=new Map<string,Promise<void>>();
  private closed=false;
  private workspaceGeneration=0;
  readonly root:string;
  private workspaceGrants=new Map<string,Promise<Workspace|null>>();
  constructor(private store:Store,private router:Router,private masters:Masters,root?:string,private saveCredentials=saveBindingCredentials) {
    this.root=root??join(coordinatorHome,'projects');
    const legacy=JSON.parse(store.get('worker-workspace')??'null') as Workspace|null;
    for(let op of this.operations()) {
      // Freeze the old location before a new workspace is approved. Existing sessions never move.
      if(!op.workspaceRoot){op={...op,workspaceRoot:op.cwd?dirname(op.cwd):legacy?.path??root??join(homedir(),'Tether Projects')};this.save(op);}
      if(op.status==='checking')this.save({...op,status:'blocked',error:'Session preflight was interrupted before creation. Recover this same operation.'});
      if(op.status==='creating')this.save({...op,recoveryPrevious:undefined,status:'uncertain',error:'The bridge restarted during native creation. Check this exact session before trying again.'});
      if(op.status==='awaiting_approval')this.save({...op,status:'needs_approval',error:op.bindingId?'Workspace approval was interrupted. Recover this same operation to ask again.':'Approval was interrupted. Repeat the creation request with the same event ID to ask again.'});
    }
  }
  operations(){return this.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'worker-create:%'").all().map((r:any)=>JSON.parse(r.value) as Creation);}
  pending(requestId:string){return this.operations().some(o=>o.requestId===requestId&&(['checking','awaiting_approval','creating'].includes(o.status)||(o.status==='needs_approval'&&!o.bindingId)));}
  get(id:string){return JSON.parse(this.store.get(`worker-create:${id}`)??'null') as Creation|null;}
  save(op:Creation){this.store.set(`worker-create:${op.id}`,JSON.stringify(op));}
  view(id?:string){return this.operations().filter(o=>!id||o.id===id).map(({text,...op})=>{
    const taskRequestId=op.bindingId?`master:${op.taskOwnerRequestId??op.requestId}:create-${op.id}:${op.bindingId}`:undefined;
    const task=taskRequestId?this.store.job(taskRequestId):undefined;
    const execution=task?(['uncertain','failed'].includes(task.status)?'blocked':task.status==='completed'?'answered':task.status==='submitted'?'awaiting_reply':task.status==='dispatched'?'submitting':task.status):'not_started';
    let workspaceRequired=false;try{workspaceRequired=!!op.bindingId&&!this.workspace(this.operationRoot(op));}catch{workspaceRequired=!!op.bindingId;}
    return {...op,workspaceRequired,canRecover:['blocked','uncertain','needs_action'].includes(op.status)||(op.status==='ready'&&workspaceRequired)||(op.status==='needs_approval'&&!!op.bindingId),taskRequestId,taskStatus:task?.status,execution,outcome:task?.outcome,currentError:task?.error??(task?null:op.error),lastError:task?.last_error??op.error};
  });}
  revoke() {
    this.workspaceGeneration++;
    this.workspaceGrants.clear();
    this.store.set('worker-workspace','null');this.store.set('worker-workspaces','[]');
    for(const b of this.store.bindings())if(this.store.get(`managed-worker:${b.id}`)==='true') {
      this.store.enable(b.id,false);this.router.approvals.cancel(b.id);this.masters.stopWorker(b.id);
    }
    for(const op of this.operations())if(['awaiting_approval','needs_approval'].includes(op.status))this.router.approvals.cancel(op.masterId);
    return 'Workspace approval revoked. Bridge-created worker sessions are paused; their files and histories are kept. Future creation will ask for approval again.';
  }
  private grants():Workspace[] {
    const saved=JSON.parse(this.store.get('worker-workspaces')??'[]') as Workspace[];
    const legacy=JSON.parse(this.store.get('worker-workspace')??'null') as Workspace|null;
    return legacy&&!saved.some(w=>w.path===legacy.path)?[...saved,legacy]:saved;
  }
  workspaceSummary() {
    const paths=this.grants().map(w=>w.path);
    return `New project location: ${this.root}.\n${paths.length?'Saved workspace approvals:\n'+paths.join('\n'):'No project workspace approved.'}\nA different location needs its own approval. /workspace revoke pauses bridge-created workers and removes all workspace approvals; files stay in place.`;
  }
  workspace(root=this.root) {
    const grants=this.grants();if(!grants.length)return null;
    let path:string;
    try{path=realpathSync(root);}catch(e){if(grants.some(w=>w.path===root||w.root===root))throw e;return null;}
    const w=grants.find(w=>w.path===path||w.root===root);if(!w)return null;
    const stat=lstatSync(root);
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==w.dev||stat.ino!==w.ino||path!==w.path)throw new Error('The approved workspace changed. Review its location before creating sessions.');
    return w;
  }
  private operationRoot(op:Pick<Creation,'workspaceRoot'|'cwd'>){return op.workspaceRoot??(op.cwd?dirname(op.cwd):this.root);}
  ensureRun(b:Binding) {
    const op=this.operations().find(o=>o.bindingId===b.id),w=op?this.workspace(this.operationRoot(op)):null;
    if(!w||!op||b.cwd!==join(w.path,`project-${op.id}`)||lstatSync(b.cwd).isSymbolicLink()||realpathSync(b.cwd)!==b.cwd)throw new Error(`Worker workspace is not approved or its path changed. Forwarding stopped. Ask your proxy to recover operation ${op?.id??'for this session'} to review its original folder approval.`);
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
    if(requestedMode===undefined&&!op&&!savedMode&&!this.router.coordinator!.scope.getStore())throw new Error(`Choose ${input.provider} Desktop or CLI for this new session. No default connection has been selected for this platform.`);
    const own=this.router.coordinator!.scope.getStore()?this.router.coordinator!.registry.entry(parent.binding_id):undefined;
    const mode=executionMode(input.provider,requestedMode??(op?(op.executionMode??'cli'):own?.provider===input.provider?own.executionMode:savedMode));
    if(this.router.coordinator!.scope.getStore()&&(own?.provider!==input.provider||own.executionMode!==mode))throw new Error('Delegate creation to the coordinator for that connection.');
    const desktopParentId=op?.desktopParentId??(own?.provider==='claude'&&own.executionMode==='desktop'?this.store.binding(parent.binding_id)?.native_id:undefined)??(input.provider==='claude'&&mode==='desktop'?preference?.desktopParentId:undefined);
    if(op) {
      if((op.executionMode??'cli')!==mode||op.provider!==input.provider||op.name!==input.name||op.text!==input.text)throw new Error('A creation event ID cannot be reused for a different task.');
      if(op.status!=='needs_approval'||op.bindingId||this.tasks.has(id))return this.view(id)[0];
    }else {
      const route=await this.masters.connections.prepare({provider:input.provider,cwd:join(this.root,`project-${id}`)},mode,mode==='cli');
      if(own&&(route.profileId!==own.profileId&&own.profileId!==undefined||own.accountKey&&route.accountKey!==own.accountKey))throw new Error('Coordinator connection identity changed. Review its account before creating work.');
      if(!own&&preference?.executionMode===mode&&mode==='cli'&&(route.accountKey!==preference.route?.accountKey||route.profileId!==preference.route?.profileId))throw new Error('The preferred CLI account or provider changed. Review Coding platforms in Home before creating this session.');
      // Recheck after the bounded account probe; an owner request may have closed meanwhile.
      this.router.coordinator!.ownerRequest(input.requestId);
      const concurrent=this.get(id);if(concurrent)return this.start(input);
      op={workspaceRoot:this.root,route,executionMode:mode,desktopParentId,requestId:input.requestId,provider:input.provider,name:input.name,text:input.text,eventId:input.eventId,id,originRequestId:input.requestId,stage:'preflight',masterId:parent.binding_id,status:'checking'};
    }
    this.save(op);
    return this.runCreation(op,parent.destination??this.store.get('whatsapp-owner')!);
  }
  private runCreation(op:Creation,destination:string) {
    op={...op,recoveryAttemptId:randomUUID()};this.save(op);
    const task=this.store.destinationContext.run(destination,()=>this.create(op)).catch(e=>{
      if(this.closed)return;
      const current=this.get(op.id)!;
      const status=/^Desktop start needs owner action/.test(e instanceof Error?e.message:String(e))?'needs_action':!current.bindingId&&!current.cwd&&current.stage!=='native'&&current.stage!=='dispatch'?'blocked':'uncertain';
      this.save({...current,status,error:e instanceof Error?e.message:'Native creation could not be confirmed.'});
      if(current.bindingId&&!this.store.job(`master:${current.requestId}:create-${op.id}:${current.bindingId}`))this.masters.stopWorker(current.bindingId);
      this.store.output(undefined,status==='needs_action'?`A new Claude chat for “${op.name}” is open on your Mac. Press Send there to start it. FarFromDesk then connects it and queues your task. Reference: ${op.id}`:`New ${op.provider} session ${status==='blocked'?'has not started':'could not be confirmed'}. ${this.get(op.id)!.error}\nRecover this same operation after resolving the blocker. Reference: ${op.id}`,`worker-create:${op.id}:${status}:${op.recoveryAttemptId}`,destination);
      this.reportStatus(this.get(op.id)!);
    }).finally(()=>this.tasks.delete(op.id));
    this.tasks.set(op.id,task);return this.view(op.id)[0];
  }
  private async approveWorkspace(op:Creation):Promise<Workspace|null> {
    const root=this.operationRoot(op),existing=this.workspace(root);if(existing)return existing;
    const pending=this.workspaceGrants.get(root);if(pending)return pending;
    const generation=this.workspaceGeneration;
    const grant=(async()=>{
      const master=this.router.coordinator!.requestMaster(op.requestId)!;
      const answer=await this.router.approvals.ask(master,`Allow FarFromDesk to create new coding projects inside ${root}?\nThis approval applies to future owner-requested projects here. Codex uses workspace-write with native approvals; Claude CLI uses acceptEdits; Claude Desktop retains its own native permissions and may require initial folder approval. Commands or access requiring further native permission are sent here. This does not grant access to arbitrary folders.`,'approval',op.requestId);
      if(this.closed||generation!==this.workspaceGeneration)return null;
      // A cancelled origin cannot grant shared access, but must not turn another waiting session uncertain.
      try{this.router.coordinator!.ownerRequest(op.requestId);}catch{throw new WorkspaceApprovalExpired('The request that opened this workspace approval is closed. No access was granted. Recover the operation with a new owner request to ask again.');}
      if(answer!=='approve')return null;
      if(!existsSync(root))mkdirSync(root,{recursive:true,mode:0o700});
      const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Choose a real workspace directory, not a symbolic link.');
      const w={root,path:realpathSync(root),dev:stat.dev,ino:stat.ino,approvedAt:Date.now()};
      this.store.set('worker-workspaces',JSON.stringify([...this.grants().filter(g=>g.path!==w.path),w]));
      this.store.set('worker-workspace',JSON.stringify(w));
      this.store.audit('worker-workspace-approved',master.id,JSON.stringify({path:w.path}));return w;
    })().finally(()=>{if(this.workspaceGrants.get(root)===grant)this.workspaceGrants.delete(root);});
    this.workspaceGrants.set(root,grant);return grant;
  }
  async create(op:Creation) {
    op={...op,stage:'workspace',status:'awaiting_approval'};this.save(op);
    const w=await this.approveWorkspace(op);
    if(this.closed)return;
    if(!w){this.save({...op,status:'denied'});this.store.output(undefined,'Project creation was not approved. No session was created.',`worker-create:${op.id}:denied:${op.recoveryAttemptId}`);this.reportStatus(this.get(op.id)!);return;}
    this.router.coordinator!.ownerRequest(op.requestId);
    if(this.router.stopped||!this.router.coordinator!.enabled().includes(op.provider))throw new Error('Background operation or this platform is paused.');
    if(this.workspace(this.operationRoot(op))?.approvedAt!==w.approvedAt)throw new Error('Workspace approval changed before creation.');
    op={...op,status:'creating'};this.save(op);
    const cwd=join(w.path,`project-${op.id}`);mkdirSync(cwd,{mode:0o700});
    if(realpathSync(cwd)!==cwd)throw new Error('Project path changed; creation stopped.');
    const r=this.store.register(`${op.provider}-work-${op.id}`,op.provider,randomUUID(),cwd);
    let b=r.binding;this.store.enable(b.id,false);this.saveCredentials(b,r.token);
    op={...op,bindingId:b.id,cwd};this.save(op);
    this.store.set(`execution-mode:${b.id}`,op.executionMode??'cli');if(op.desktopParentId)this.store.set(`desktop-parent:${b.id}`,op.desktopParentId);
    if(op.route)this.masters.connections.save(b,op.route);
    this.store.set(`name:${b.id}`,op.name);this.store.set(`managed-worker:${b.id}`,'true');
    // The role travels with provider instructions or the first request, never as files in the project.
    // Desktop startup receipts live beside the project, inside the approved workspace.
    if(op.provider==='claude'&&op.executionMode==='desktop') {
      const support=join(w.path,'.farfromdesk',`project-${op.id}`);mkdirSync(support,{recursive:true,mode:0o700});
      if(realpathSync(support)!==support)throw new Error('Desktop setup directory must not be a symbolic link.');
      this.store.set(`master-support:${b.id}`,support);
    }
    op={...op,stage:'native'};this.save(op);
    await this.masters.provisionWorker(b);
    if(this.closed)return;
    b=this.store.binding(b.id)!;this.saveCredentials(b,r.token);
    if(this.workspace(this.operationRoot(op))?.approvedAt!==w.approvedAt){this.masters.stopWorker(b.id);throw new Error('Workspace approval changed during creation. The new session remains inactive.');}
    this.router.coordinator!.ownerRequest(op.requestId);
    if(this.router.stopped||!this.router.coordinator!.enabled().includes(op.provider))throw new Error('Creation finished while forwarding was paused; the new session remains inactive.');
    this.store.enable(b.id,true);
    const previous=JSON.parse(this.store.get('selected')??'[]') as string[];
    this.store.set('selected',JSON.stringify([...new Set([...previous,b.id])]));
    op={...op,stage:'dispatch'};this.save(op);
    this.router.coordinator!.dispatch(op.requestId,[b.id],op.text,`create-${op.id}`);
    this.save({...op,status:'ready'});
    this.store.output(undefined,`Created “${op.name}” in ${op.provider} and queued your task. Your other sessions remain connected.`, `worker-create:${op.id}:ready:${op.recoveryAttemptId}`);
  }
  async recover(requestId:string,id:string) {
    if(this.closed||this.router.stopped)throw new Error('Background operation is paused.');
    const parent=this.router.coordinator!.ownerRequest(requestId),op=this.get(id);
    if(op&&this.router.coordinator!.scope.getStore()&&op.masterId!==parent.binding_id)throw new Error('Creation belongs to another coordinator.');
    if(!op)throw new Error('No exact creation operation is available to recover. Check creation status first.');
    if(this.tasks.has(id))return this.view(id)[0];
    const needsWorkspace=!!op.bindingId&&!this.workspace(this.operationRoot(op));
    if(!['blocked','uncertain','needs_action'].includes(op.status)&&!(op.status==='ready'&&needsWorkspace)&&!(op.status==='needs_approval'&&op.bindingId))throw new Error('No blocked or uncertain session is available to recover. Check creation status first.');
    if(!this.router.coordinator!.enabled().includes(op.provider))throw new Error('This platform is paused.');
    if(!op.bindingId)return this.recoverPreflight(op,requestId,parent);
    let b=this.store.binding(op.bindingId);if(!b)throw new Error('The original binding is missing; recovery stopped.');
    if(!this.router.coordinator!.enabled().includes(b.provider))throw new Error('This platform is paused.');
    if(!needsWorkspace)this.ensureRun(b);
    const existing=this.store.job(`master:${op.taskOwnerRequestId??op.requestId}:create-${op.id}:${b.id}`);
    if(existing&&!needsWorkspace){this.save({...op,status:'ready',error:undefined,recoveryPrevious:undefined});return {...this.view(id)[0],existingTaskStatus:existing.status,note:'The original task already exists. It was not resubmitted.'};}
    // requestId follows the current owner operation; taskOwnerRequestId freezes an already dispatched task.
    const next:Creation={...op,originRequestId:op.originRequestId??op.requestId,requestId,masterId:parent.binding_id,taskOwnerRequestId:existing?(op.taskOwnerRequestId??op.requestId):undefined,recoveryAttemptId:randomUUID(),recoveryPrevious:op.recoveryPrevious??{status:op.status,error:op.error},status:needsWorkspace?'awaiting_approval':'creating',error:undefined};this.save(next);
    const destination=parent.destination??this.store.get('whatsapp-owner')!;
    const task=this.store.destinationContext.run(destination,async()=>{
      if(needsWorkspace){
        const w=await this.approveWorkspace({...op,requestId,masterId:parent.binding_id});
        if(this.closed)return;
        try{this.router.coordinator!.ownerRequest(requestId);}catch{throw new WorkspaceApprovalExpired('This recovery request is closed. No session work was resumed. Ask to recover again with a new owner request.');}
        if(!w){
          // Denial changes access, not the known state of the existing session/task.
          this.save({...next,...next.recoveryPrevious!,recoveryPrevious:undefined});
          const error='Original workspace was not approved. The session and its files are unchanged.';
          this.store.output(undefined,error,`worker-workspace-denied:${id}:${next.recoveryAttemptId}`,destination);
          this.reportStatus({...next,status:'denied',error});return;
        }
        if(this.router.stopped||!this.router.coordinator!.enabled().includes(b!.provider))throw new Error('Background operation or platform is paused.');
        this.ensureRun(b!);
        if(existing){
          // Restoring a folder grant must not replay an already queued/submitted task or launch its runtime.
          this.save({...next,status:'ready',error:undefined,recoveryPrevious:undefined});
          this.store.output(undefined,`Original workspace approval restored for “${op.name}”. The existing task was not resubmitted. ${this.store.binding(b!.id)?.enabled?'Forwarding can use this folder again.':`The session stays paused; use /resume ${b!.alias} when ready.`}`,`worker-workspace-restored:${id}:${next.recoveryAttemptId}`,destination);
          this.reportStatus({...next,status:'ready',error:'Workspace access restored. The existing task was not resubmitted and its session was not resumed.'});
          return;
        }
      }
      this.save({...next,status:'creating',recoveryPrevious:undefined});
      await this.masters.recoverWorker(b!);b=this.store.binding(op.bindingId!)!;
      if(this.closed)return;
      this.router.coordinator!.ownerRequest(requestId);this.ensureRun(b);
      if(this.router.stopped||!this.router.coordinator!.enabled().includes(b.provider))throw new Error('Background operation or platform is paused.');
      this.store.enable(b.id,true);const selected=JSON.parse(this.store.get('selected')??'[]') as string[];
      this.store.set('selected',JSON.stringify([...new Set([...selected,b.id])]));
      this.router.coordinator!.dispatch(requestId,[b.id],op.text,`create-${op.id}`);
      this.save({...next,status:'ready',recoveryPrevious:undefined});this.store.output(undefined,`Recovered “${op.name}” in the same native session and queued the original task.`,`worker-create:${op.id}:recovered:${next.recoveryAttemptId}`);
    }).catch(e=>{if(this.closed)return;
      if(e instanceof WorkspaceApprovalExpired){
        this.save({...next,...next.recoveryPrevious!,recoveryPrevious:undefined});
        this.store.output(undefined,e.message,`worker-workspace-expired:${id}:${next.recoveryAttemptId}`,destination);
        this.reportStatus({...next,status:'blocked',error:e.message});return;
      }
      this.save({...next,recoveryPrevious:undefined,status:/^Desktop start needs owner action/.test(e instanceof Error?e.message:String(e))?'needs_action':'uncertain',error:e instanceof Error?e.message:'Exact-session recovery failed.'});this.store.output(undefined,`Recovery is still blocked: ${this.get(id)!.error}`,`worker-create:${id}:recovery-error:${next.recoveryAttemptId}`,destination);this.reportStatus(this.get(id)!);}).finally(()=>this.tasks.delete(id));
    this.tasks.set(id,task);return this.view(id)[0];
  }
  // Connects a Desktop session once the owner has pressed Send and it wrote its own ready
  // receipt. Never opens or starts anything; recovery only verifies that exact session.
  reconcileDesktop() {
    if(this.closed||this.router.stopped)return;
    for(const op of this.operations()) {
      if(op.status!=='needs_action'||!op.bindingId||op.executionMode!=='desktop'||this.tasks.has(op.id))continue;
      const b=this.store.binding(op.bindingId);let receipt:string|null=null;
      try{
        // A timer may finish an approved setup, never request fresh access after revocation.
        if(!this.workspace(this.operationRoot(op)))continue;
        receipt=b?this.masters.desktop.acknowledgment(b):null;
      }catch{continue;}
      if(receipt)void this.recover(op.requestId,op.id).catch(()=>{/* The request closed; the owner can recover with a new request. */});
    }
  }
  private recoverPreflight(op:Creation,requestId:string,parent:{binding_id:string;destination?:string|null}) {
    // Legacy missing-launcher failures have no stage. No directory or binding can
    // exist on this branch: otherwise a side effect needs exact-child recovery.
    const cwd=join(this.operationRoot(op),`project-${op.id}`);
    if(op.cwd||op.stage==='native'||op.stage==='dispatch'||existsSync(cwd)||this.store.bindings().some(b=>b.cwd===cwd))
      throw new Error('Creation may already have local state. Automatic pre-start recovery stopped; inspect this exact operation.');
    const next:Creation={...op,originRequestId:op.originRequestId??op.requestId,requestId,masterId:parent.binding_id,recoveryAttemptId:randomUUID(),stage:'preflight',status:'checking',error:undefined};
    const destination=parent.destination??this.store.get('whatsapp-owner')!;
    // Claim the operation before the account check so simultaneous recovery calls
    // cannot create two children. Runtime/profile are frozen, never preferences.
    this.save(next);
    const task=this.store.destinationContext.run(destination,async()=>{
      const mode=op.executionMode??'cli';
      if(!op.route)throw new Error('Original connection identity is unavailable. Review this operation before recovery.');
      const route=await this.masters.connections.prepare({provider:op.provider,cwd},mode,mode==='cli',op.route.accountScope);
      if(route.profileId!==op.route.profileId||route.accountKey!==op.route.accountKey)throw new Error('Original account or profile changed. Recovery stopped without switching connections.');
      this.router.coordinator!.ownerRequest(requestId);
      if(this.closed||this.router.stopped||!this.router.coordinator!.enabled().includes(op.provider))throw new Error('Background operation or platform is paused.');
      const preference=JSON.parse(this.store.get(`platform-preference:${op.provider}`)??'null');
      const desktopParentId=op.desktopParentId??(mode==='desktop'&&preference?.executionMode===mode?preference.desktopParentId:undefined);
      await this.create({...next,desktopParentId});
    }).catch(e=>{
      if(this.closed)return;
      const current=this.get(op.id)!;
      this.save({...current,status:current.bindingId||current.cwd?'uncertain':'blocked',error:e instanceof Error?e.message:'Pre-start recovery failed.'});
      if(current.bindingId&&!this.store.job(`master:${current.requestId}:create-${op.id}:${current.bindingId}`))this.masters.stopWorker(current.bindingId);
      this.store.output(undefined,`Recovery is still blocked: ${this.get(op.id)!.error}\nReference: ${op.id}`,`worker-create:${op.id}:recovery-error:${next.recoveryAttemptId}`,destination);this.reportStatus(this.get(op.id)!);
    }).finally(()=>this.tasks.delete(op.id));
    this.tasks.set(op.id,task);return this.view(op.id)[0];
  }
  private reportStatus(op:Creation) {
    const master=this.router.coordinator!.requestMaster(op.requestId),parent=this.store.job(op.requestId);
    if(!master||master.id!==op.masterId||!parent||parent.status==='replaced')return;
    const reportId=`report:creation:${op.id}:${op.status}:${op.requestId}${op.recoveryAttemptId?`:${op.recoveryAttemptId}`:''}`;
    this.store.set(`report-parent:${reportId}`,op.requestId);
    const next=op.status==='ready'?'This workspace recovery request is finished. Report restored access only, not task completion. Do not resume or rerun the task or duplicate the notification.':op.status==='needs_action'?'Keep this owner request open: the bridge connects the session and queues its task once the owner presses Send in Claude. Do not open, start or create anything yourself, and do not duplicate the notification.':'Close this owner request as blocked if no further work is possible; do not create a replacement or duplicate the notification.';
    this.store.enqueue(reportId,master,`Creation operation ${op.id} for owner request ${op.requestId} is ${op.status}. ${op.error??'The owner did not approve workspace access.'} This is a status report, not authorization to retry. The user already received the status. ${next}`,parent.destination??null);
    this.router.pump();
  }
  close(){this.closed=true;}
}
