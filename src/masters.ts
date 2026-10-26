import { AsyncLocalStorage } from 'node:async_hooks';
import { CoordinatorRegistry } from './coordinator-registry.js';
import { checkCodexEnvironment } from './provider-readiness.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync,writeFileSync,realpathSync,existsSync } from 'node:fs';
import { join,basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID,createHash } from 'node:crypto';
import { stateDir,baseUrl,codexBin,claudeBin,coordinatorHome } from './config.js';
import type { Store,Binding,Provider } from './store.js';
import type { Router } from './router.js';
import { saveBindingCredentials } from './server.js';
import { CodexSession } from './codex-session.js';
import { ClaudeSession } from './claude-session.js';
import { DesktopStarts } from './desktop-start.js';
import { executionMode, type ExecutionMode } from './desktop-claude.js';
import { masterPolicy } from './master-policy.js';
import { roleConfig, coordinatorRoleStatus } from './roles.js';
import { portableAgents, requirePortableCLI, nativeCommand } from './platform.js';
import { ClaudeSDKSession } from './claude-sdk-session.js';
import { Connections } from './connections.js';
import { projectWorkspace } from './project-workspace.js';

const exec=promisify(execFile);
const root=fileURLToPath(new URL('..',import.meta.url));
const masterMode=(provider:Provider,value:unknown):ExecutionMode=>provider==='codex'&&value==='desktop'?'desktop':executionMode(provider,value);
const quote=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;
export function codexDesktopInstalled(home=homedir(),exists:(path:string)=>boolean=existsSync) {
  return ['/Applications',join(home,'Applications')].some(root=>exists(join(root,'Codex.app'))||exists(join(root,'ChatGPT.app/Contents/Frameworks/Codex Framework.framework')));
}
export function masterName(provider:Provider,mode:ExecutionMode,value:unknown) {
  if(value!==undefined&&typeof value!=='string')throw new Error('Session name must be text.');
  const name=(value as string|undefined)?.trim()??'';
  if(name.length>80||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name))throw new Error('Use a session name of up to 80 characters without control characters.');
  return name||`FarFromDesk · ${provider==='claude'?'Claude':'Codex'} ${mode==='desktop'?'Desktop':'CLI'}`;
}
// Workspace identity includes runtime and account; folder names are display only.
export function coordinatorFolder(operationId:string,name:string) {
  const slug=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||'coordinator';
  return join(coordinatorHome,'coordinators',`${slug}-${operationId.slice(0,8)}`);
}
export function masterWorkspaces(provider:Provider,mode:ExecutionMode,sessions:any[]) {
  const choices=new Map<string,any>();
  for(const s of [...sessions].sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0))) {
    if(typeof s.cwd!=='string'||!s.cwd)continue;
    try {
      const sessionCwd=realpathSync(s.cwd),cwd=projectWorkspace(sessionCwd);
      const accountScope=s.accountScope??null;
      const id=createHash('sha256').update(JSON.stringify([provider,mode,cwd,accountScope])).digest('hex');
      const available=provider!=='claude'||mode!=='desktop'||s.available===true;
      const existing=choices.get(id);
      // Prefer a reachable root-project chat over a newer temporary worktree.
      const rank=(available?2:0)+(sessionCwd===cwd?1:0);
      if(!existing||rank>existing.rank)choices.set(id,{id,name:basename(cwd)||cwd,cwd,accountScope,available,rank,launcherId:provider==='claude'&&mode==='desktop'?s.id:undefined});
    }catch{/* A moved or inaccessible folder is not a creation target. */}
  }
  const result=[...choices.values()];
  return result.map(({rank,...w})=>({...w,label:result.filter(other=>other.cwd===w.cwd).length>1?`${w.name} · account ${String(w.accountScope??'unknown').slice(0,8)}`:w.name}));
}
export class Masters {
  connections:Connections;
  registry:CoordinatorRegistry;
  runtimes=new Map<string,CodexSession>();
  claudeRuntimes=new Map<string,ClaudeSession|ClaudeSDKSession>();
  runtimeRoles=new Map<string,string>();
  desktop:DesktopStarts;
  private setupContext=new AsyncLocalStorage<{id:string;connection:string}>();
  private setupLocks=new Map<string,string>();
  get creating(){const c=this.setupContext.getStore();return c?this.setupLocks.has(c.connection):this.setupLocks.size>0;}
  set creating(value:boolean){const c=this.setupContext.getStore();if(value)this.setupLocks.set(c?.connection??'legacy',c?.id??'legacy');else if(this.setupLocks.get(c?.connection??'legacy')===(c?.id??'legacy'))this.setupLocks.delete(c?.connection??'legacy');}
  platforms:any[]=[];
  private discovery?:Promise<any[]>;
  private discoveryAt=0;
  private catalogRevision=randomUUID();
  private catalogDigest='';
  private automaticChecks=new Map<string,{receipt:string;attempts:number;after:number}>();
  private closed=false;
  constructor(private store:Store,private router:Router) {
    this.registry=router.coordinator?.registry??new CoordinatorRegistry(store);
    this.connections=router.native.connections??new Connections(store);
    router.native.connectionChanged=b=>this.stopWorker(b.id);
    this.desktop=new DesktopStarts(store,router.native);
    const operations=this.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'master-attempt:%'").all() as {value:string}[];
    const current=this.operation();if(current&&!operations.some(r=>JSON.parse(r.value).id===current.id))operations.push({value:JSON.stringify(current)});
    for(const row of operations){const op=JSON.parse(row.value);if(op?.status==='creating')this.saveOperation({...op,status:'uncertain',error:'Service restarted during creation. Recover this session or create a replacement.'},current?.id===op.id);}
  }
  operation(id?:string){id??=this.setupContext.getStore()?.id;const current=JSON.parse(this.store.get('master-operation')??'null');return !id||current?.id===id?current:JSON.parse(this.store.get(`master-attempt:${id}`)??'null');}
  private saveOperation(op:any,current=true){
    this.store.db.exec('SAVEPOINT master_operation');
    try {
      this.store.set(`master-attempt:${op.id}`,JSON.stringify(op));
      if(current)this.store.set('master-operation',JSON.stringify(op));
      this.store.db.exec('RELEASE master_operation');
    }catch(e){this.store.db.exec('ROLLBACK TO master_operation; RELEASE master_operation');throw e;}
  }
  private setAside(){
    const op=this.operation();if(!op)return;
    if(op.status==='uncertain') {
      if(op.bindingId&&!this.registry.isCoordinator(op.bindingId)){this.store.enable(op.bindingId,false);this.stopWorker(op.bindingId);}
      this.saveOperation({...op,status:'set-aside',updatedAt:Date.now()});
    }else this.saveOperation(op);
  }
  private assertIdle(){if(this.creating||this.operation()?.status==='creating')throw new Error('Setup is already in progress.');}
  private async catalog(provider:Provider,fresh=false){
    const sessions:any[]=[];let cursor:string|undefined;const seen=new Set<string>();
    do {const page=await this.router.native.catalog(provider,cursor,{fresh});sessions.push(...page.sessions);cursor=page.cursor??undefined;if(cursor){if(seen.has(cursor))throw new Error('Session pagination repeated. Refresh apps.');seen.add(cursor);}}while(cursor);
    return sessions;
  }
  async discover(fresh=false){
    if(!fresh&&this.platforms.length&&Date.now()-this.discoveryAt<15000)return this.platforms;
    if(this.discovery)return this.discovery;
    this.discovery=(async()=>{
    const platforms:any[]=await Promise.all(([['codex',codexBin],['claude',claudeBin]] as const).map(async([provider,bin])=>{
      try {const command=nativeCommand(bin,['--version']);await exec(command.binary,command.args,{timeout:5000,maxBuffer:10000,windowsHide:true});return {provider,executionMode:'cli',available:true,label:provider==='codex'?'Codex · native CLI':'Claude Code · background CLI'};}
      catch{return {provider,executionMode:'cli',available:false,label:provider==='codex'?'Codex':'Claude Code',reason:'Native CLI unavailable. Claude Desktop uses its separate app session.'};}
    }));
    const fallback=(provider:Provider)=>this.platforms.filter(p=>p.provider===provider&&(provider==='claude'||p.executionMode==='cli')).flatMap(p=>(p.sessions??[]).map((s:any)=>({...s,provider,executionMode:p.executionMode})));
    const errors=new Set<Provider>();
    const load=(provider:Provider)=>this.catalog(provider,fresh).catch(()=>{errors.add(provider);return fallback(provider);});
    const [claude,codex]=await Promise.all([load('claude'),load('codex')]);
    if(!errors.has('claude'))this.registry.adoptAccounts('claude',claude);
    const rows=(sessions:any[])=>sessions.map(s=>({id:s.id,desktopId:s.desktopId,executionMode:s.executionMode,accountScope:s.accountScope,name:s.name,cwd:s.cwd,status:s.status,updatedAt:s.updatedAt,available:s.available===true}));
    for(const platform of platforms)platform.sessions=rows(platform.provider==='claude'?claude.filter(s=>s.executionMode!=='desktop'):codex);
    platforms.push({provider:'claude',executionMode:'desktop',label:'Claude Desktop',available:claude.some(s=>s.executionMode==='desktop'),sessions:rows(claude.filter(s=>s.executionMode==='desktop')),reason:'Open a Claude Desktop Code chat to connect. Saved chats without a running local inbox cannot receive messages yet.'});
    platforms.push({provider:'codex',executionMode:'desktop',label:'Codex Desktop',available:platforms.find(p=>p.provider==='codex')?.available&&codexDesktopInstalled(),sessions:rows(codex),reason:'Requires Codex Desktop and its local adapter. Desktop and CLI share local Codex history; new chats use the native app-server.'});
    if(portableAgents)for(const platform of platforms)if(platform.executionMode==='desktop'){platform.available=false;platform.sessions=[];platform.reason='Desktop delivery is not supported by this adapter. Choose an exact saved CLI session.';}
    await Promise.all(platforms.map(async platform=>{
      const {accountKey,...connection}=await this.connections.read(platform.provider,platform.executionMode,fresh);
      platform.connection=connection;
      platform.canCreate=platform.available&&(platform.executionMode==='desktop'||connection.state==='verified');
      // CLI history can be resumed only with an explicitly selected, verified CLI account.
      if(platform.executionMode==='cli'&&(platform.provider==='codex'||portableAgents)) {
        platform.sessions=platform.sessions.map((s:any)=>({...s,available:s.available&&connection.state==='verified',status:connection.state==='verified'?s.status:connection.label}));
        if(connection.state!=='verified')platform.reason=connection.label;
      }
      if(platform.provider==='codex'&&platform.executionMode==='desktop')platform.reason='Existing chats use the native desktop queue and that chat’s account. New chats create a history record, then use Desktop for requests. CLI authentication is not used for model execution.';
      if(platform.provider==='claude'&&platform.executionMode==='desktop') {
        const preference=JSON.parse(this.store.get('platform-preference:claude')??'null');
        const coordinators=this.registry.entries().filter(r=>r.provider==='claude'&&r.executionMode==='desktop'&&this.store.binding(r.bindingId)?.enabled);
        platform.coordinatorId=coordinators.length===1?coordinators[0].bindingId:undefined;
        platform.launcherId=platform.coordinatorId?this.store.binding(platform.coordinatorId)?.native_id:preference?.desktopParentId;
        // New coordinators start in their own folder from a Claude chat the owner sends once; no launcher chat is needed.
        platform.creationReadiness={state:'ready',message:'Claude opens a new chat in the coordinator folder. Confirm the folder and press Send once to start it.'};
      }
    }));
    for(const platform of platforms)platform.workspaces=masterWorkspaces(platform.provider,platform.executionMode,platform.sessions??[]);
    for(const platform of platforms)if(errors.has(platform.provider))platform.discoveryError='Refresh incomplete. Showing the last saved list; try Refresh. Sessions are checked again before connecting.';
    const digest=createHash('sha256').update(JSON.stringify(platforms)).digest('hex');
    if(digest!==this.catalogDigest){this.catalogDigest=digest;this.catalogRevision=randomUUID();}
    this.platforms=platforms;this.discoveryAt=Date.now();return platforms;
    })();
    try{return await this.discovery;}finally{this.discovery=undefined;}
  }
  options(knownRevision?:string){
    const clean=(op:any)=>op?{...op,stage:op.bindingId?(this.desktop.get(op.bindingId)?.stage??op.stage):op.stage,proposalId:op.bindingId?this.desktop.get(op.bindingId)?.proposalId:undefined,needsTrust:op.needsTrust||/workspace not trusted/i.test(op.error??''),error:op.error?this.setupError(op.error):undefined}:op;
    const op=this.operation();
    const attempts=this.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'master-attempt:%'").all().map((r:any)=>JSON.parse(r.value)).filter(a=>a.id!==op?.id&&['creating','uncertain','set-aside','needs_action'].includes(a.status)).sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)).map(clean);
    const catalogUnchanged=knownRevision===this.catalogRevision;
    const selectedMaster=this.store.binding(this.store.get('master')??'');
    return {platforms:catalogUnchanged?[]:this.platforms,catalogRevision:this.catalogRevision,catalogUnchanged,operation:clean(op),attempts,prompt:selectedMaster?roleConfig(this.store,selectedMaster,'master').instructions:masterPolicy,roleDelivery:coordinatorRoleStatus(this.store)};
  }
  platformPreferences() {
    return (['codex','claude'] as const).map(provider=>{
      const saved=JSON.parse(this.store.get(`platform-preference:${provider}`)??'null');
      return {provider,executionMode:saved?.executionMode??null,desktopParentId:saved?.desktopParentId??null,launcherName:saved?.launcherName??null,connectionLabel:saved?.route?.label??null};
    });
  }
  async setPlatformPreference(provider:Provider,requestedMode:unknown,desktopParentId?:string,connectionRevision?:string) {
    if(!['codex','claude'].includes(provider)||!['desktop','cli'].includes(String(requestedMode)))throw new Error('Choose a detected coding platform and Desktop or CLI explicitly.');
    const mode=executionMode(provider,requestedMode);requirePortableCLI(mode);
    const detected=this.platforms.find(p=>p.provider===provider&&p.executionMode===mode);
    if(!detected?.available)throw new Error('This runtime is not detected. Refresh coding apps before selecting it.');
    const saved=JSON.parse(this.store.get(`platform-preference:${provider}`)??'null');
    // Runtime selection must not depend on a running launcher. Validate one only
    // when explicitly supplied; preserve an existing launcher for later creation.
    const launcher=provider==='claude'&&mode==='desktop'
      ?(desktopParentId?await this.desktop.parent(desktopParentId):{id:saved?.desktopParentId,name:saved?.launcherName,accountScope:saved?.route?.accountScope})
      :undefined;
    const route=await this.connections.prepare({provider,cwd:homedir()},mode,mode==='cli',launcher?.accountScope,connectionRevision);
    this.store.set(`platform-preference:${provider}`,JSON.stringify({provider,executionMode:mode,desktopParentId:launcher?.id,launcherName:launcher?.name,route}));
    return this.platformPreferences();
  }
  setupError(error:unknown) {
    const message=error instanceof Error?error.message:String(error);
    if(/^(Desktop (creation|start|setup|project)|Claude Desktop could not|The selected Claude Desktop|No owner-connected|Connected Claude Desktop|No desktop)/.test(message))return message.slice(0,400);
    if(/^(CLI account|CLI signed out|Connection changed|Review this existing|Custom provider|Configured|Session connection)/.test(message))return message.slice(0,400);
    if(/Claude authentication expired|OAuth|Failed to authenticate/i.test(message))return 'Claude authentication expired. Sign in to the selected Claude app or CLI, then recover this exact setup.';
    if(/workspace not trusted|Claude needs you to trust/i.test(message))return 'Claude needs you to trust this master folder. Open Claude setup, accept its workspace trust prompt, then return here and retry this setup.';
    return 'Native master setup could not be confirmed. Check the native app for details. You can recover this session, abandon it, or create a replacement.';
  }
  recordSetupFailure(error:unknown,id=this.operation()?.id) {
    const op=this.operation(id);if(!op)return;
    this.saveOperation({...op,status:/^Desktop start needs owner action/.test(error instanceof Error?error.message:String(error))?'needs_action':'uncertain',updatedAt:Date.now(),needsTrust:/workspace not trusted/i.test(error instanceof Error?error.message:String(error)),error:this.setupError(error)},this.operation()?.id===id);
  }
  // Receipt-driven recovery never creates/replays a child or approves a native prompt.
  // Only the current setup can activate automatically; older attempts stay set aside.
  async reconcileDesktopSetup(now=Date.now()) {
    const op=this.operation();
    if(this.closed||this.creating||!op||op.provider!=='claude'||op.executionMode!=='desktop'||!['needs_action','uncertain'].includes(op.status)||!op.bindingId)return;
    const b=this.store.binding(op.bindingId);if(!b)return;
    let receipt:string|null;
    try{receipt=this.desktop.acknowledgment(b);}catch{return;}
    if(!receipt)return;
    const prior=this.automaticChecks.get(op.id);
    const check=prior?.receipt===receipt?prior:{receipt,attempts:0,after:0};
    if(now<check.after||check.attempts>=3)return;
    this.automaticChecks.clear();this.automaticChecks.set(op.id,{receipt,attempts:check.attempts+1,after:now+30000});
    try{await this.recover(op.id);}catch{/* The normal setup error/recovery controls remain available. */}
  }
  async recover(operationId?:string) {
    const op=this.operation(operationId);if(!op)throw new Error('No exact setup to recover.');
    return this.setupContext.run({id:op.id,connection:`${op.provider}:${op.executionMode??'cli'}`},()=>this.recoverScoped(op.id));
  }
  private async recoverScoped(operationId?:string) {
    this.assertIdle();
    const op=this.operation(operationId);
    if(!op||!['uncertain','set-aside','needs_action'].includes(op.status)||!op.bindingId||(!op.nativeId&&!(op.executionMode==='desktop'&&op.provider!=='codex')))throw new Error('No exact created session is available to recover. Create a new session instead.');
    const b=this.store.binding(op.bindingId);if(!b||(op.nativeId&&b.native_id!==op.nativeId))throw new Error('Creation identity is incomplete.');
    this.setAside();this.creating=true;this.saveOperation({...op,status:'creating',stage:'Connecting your created session',error:undefined});
    void (async()=>{
      await this.connections.assert(b);
      if(b.provider==='claude'&&op.executionMode==='desktop')await this.desktop.confirm(b,true);
      else if(b.provider==='codex') {
        const runtime=new CodexSession(codexBin,b.cwd,(m,p)=>this.approval(b,m,p));
        try {await runtime.initialize();const r=await runtime.request('thread/read',{threadId:b.native_id,includeTurns:false});
          if(r.thread?.id!==b.native_id||typeof r.thread?.cwd!=='string'||realpathSync(r.thread.cwd)!==realpathSync(b.cwd))throw new Error('Native session identity does not match this setup.');
        }finally{runtime.close();}
        if(op.executionMode!=='desktop')this.store.set(`managed-codex:${b.id}`,'true');
      }else if(op.needsTrust||/workspace not trusted/i.test(op.error??''))await this.provisionClaude(b);
      else if(/Claude authentication expired/i.test(op.error??'')) {
        const runtime=this.claudeWorker(b,true);this.claudeRuntimes.set(b.id,runtime);
        try{await runtime.initialize();await runtime.run('Connection recovery only. Return READY without tools. Do not repeat earlier work.');this.store.set(`managed-claude:${b.id}`,'true');}
        catch(e){this.stopWorker(b.id);throw e;}
      }else await this.router.native.validate(b.provider,b.native_id,b.cwd);
      this.activate(this.store.binding(b.id)!,op.id);
    })().catch(e=>this.recordSetupFailure(e,op.id)).finally(()=>{this.creating=false;});
    return this.operation(op.id);
  }
  abandon(operationId?:string) {
    const op=this.operation(operationId);if(!op)throw new Error('No exact setup to abandon.');
    return this.setupContext.run({id:op.id,connection:`${op.provider}:${op.executionMode??'cli'}`},()=>this.abandonScoped(op.id));
  }
  private abandonScoped(operationId?:string) {
    this.assertIdle();const op=this.operation(operationId);
    if(!op||!['uncertain','set-aside','needs_action'].includes(op.status))throw new Error('Only an unconfirmed setup can be abandoned.');
    if(op.bindingId&&!this.registry.isCoordinator(op.bindingId)){this.store.set(`desktop-abandoned:${op.bindingId}`,'true');this.store.enable(op.bindingId,false);this.stopWorker(op.bindingId);}
    this.saveOperation({...op,status:'abandoned'},this.operation()?.id===op.id);
    return this.operation(op.id);
  }
  activate(b:Binding,operationId?:string) {
    if(operationId&&this.operation()?.id!==operationId)throw new Error('This setup was superseded.');
    const old=this.registry.bindingFor(b);
    const replacing=old&&old.id!==b.id;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      let closedRequests=0;
      if(replacing) {
        const closed=this.store.db.prepare(`WITH RECURSIVE related(id) AS (
          SELECT id FROM inbox WHERE binding_id=?
          UNION SELECT i.id FROM inbox i JOIN settings s ON s.key='parent:'||i.id JOIN related r ON s.value=r.id
        ) UPDATE inbox SET status='replaced',error=NULL,updated_at=?
          WHERE id IN (SELECT id FROM related) AND status IN ('queued','dispatched','submitted','uncertain','failed') RETURNING id`).all(old.id,Date.now());
        closedRequests=closed.length;
        this.store.enable(old.id,false);
        this.store.audit('master-replaced',old.id,JSON.stringify({replacement:b.id,closedRequests}));
      }
      this.store.enable(b.id,true);this.registry.register(b);this.store.set(`name:${b.id}`,this.operation()?.name??this.store.get(`name:${b.id}`)??'WhatsApp master');
      this.store.set(`native-master:${b.id}`,'true');
      if(b.provider==='claude'){this.store.set('claude-execution-mode',this.store.get(`execution-mode:${b.id}`)??'cli');if(this.store.get(`execution-mode:${b.id}`)==='desktop')this.store.set('claude-desktop-parent',b.native_id);}
      const enabled=this.router.coordinator?.enabled()??[];this.store.set('enabled-apps',JSON.stringify([...new Set([...enabled,b.provider])]));
      this.saveOperation({...this.operation(),status:'ready',nativeId:b.native_id,needsTrust:false,error:undefined,closedRequests});
      this.store.db.exec('COMMIT');
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
    if(replacing){this.router.approvals.cancel(old.id);this.stopWorker(old.id);}
  }

  async approval(binding:Binding,method:string,params:any) {
    if(!this.store.binding(binding.id)?.enabled)throw new Error('This master is inactive; approval denied.');
    if(this.router.stopped)throw new Error('Background operation is paused; native approval denied.');
    if(params?.threadId!==binding.native_id)throw new Error('Approval does not belong to this master.');
    if(method==='item/commandExecution/requestApproval'||method==='item/fileChange/requestApproval') {
      const answer=await this.router.approvals.ask(binding,`${method}\n${JSON.stringify(params).slice(0,12000)}`);
      return {decision:answer==='approve'?'accept':'decline'};
    }
    if(method==='item/tool/requestUserInput') {
      const answers:Record<string,any>={};
      for(const q of (params.questions??[]).slice(0,3))answers[q.id]={answers:[await this.router.approvals.ask(binding,String(q.question),'question')]};
      return {answers};
    }
    throw new Error('Unsupported native approval; finish it in the native interface.');
  }
  mcpConfig(b:Binding){return {command:process.execPath,args:[join(root,'dist/master-channel.js'),join(stateDir,'bindings',`${b.alias}.json`)],env:{WSB_STATE_DIR:stateDir,WSB_PORT:new URL(baseUrl).port}};}
  async useDesktop(sessionId:string,operationId:string){return this.useSession('claude','desktop',sessionId,operationId);}
  async useSession(provider:Provider,requestedMode:unknown,sessionId:string,operationId:string,connectionRevision?:string) {
    return this.setupContext.run({id:operationId,connection:`${provider}:${requestedMode??'cli'}`},()=>this.useSessionScoped(provider,requestedMode,sessionId,operationId,connectionRevision));
  }
  private async useSessionScoped(provider:Provider,requestedMode:unknown,sessionId:string,operationId:string,connectionRevision?:string) {
    if(!['codex','claude'].includes(provider)||!/^[0-9a-f-]{36}$/i.test(operationId)||typeof sessionId!=='string')throw new Error('A supported platform, session and stable selection ID are required.');
    requirePortableCLI(requestedMode);
    const mode=masterMode(provider,requestedMode),previous=this.operation(operationId);
    if(previous){if(previous.selectedSessionId!==sessionId||previous.provider!==provider||previous.executionMode!==mode)throw new Error('Selection ID cannot change sessions or platforms.');return previous;}
    this.assertIdle();this.creating=true;
    try {
      const session=provider==='claude'&&mode==='desktop'?await this.desktop.parent(sessionId):(await this.catalog(provider,true)).find(s=>s.id===sessionId&&(provider==='codex'||(s.executionMode??'cli')===mode));
      if(!session?.cwd||(!(provider==='claude'&&mode==='desktop')&&session.available!==true))throw new Error('This saved session is not reachable. Open it in its native app or CLI, then refresh.');
      if(!(provider==='claude'&&mode==='desktop'))await this.router.native.validate(provider,session.id,session.cwd);
      let b=this.store.bindings().find(b=>b.provider===provider&&b.native_id===session.id);
      if(b&&realpathSync(b.cwd)!==realpathSync(session.cwd))throw new Error('Selected project differs from the registered binding.');
      if(b&&mode==='desktop'&&(this.store.get(`managed-worker:${b.id}`)==='true'||this.store.get(`managed-claude:${b.id}`)==='true'))throw new Error('This session is managed by another runtime; choose its CLI mode.');
      if(b&&this.router.busy.has(b.id))throw new Error('This session is processing a request. Wait until it finishes.');
      const managed=mode==='cli'&&(provider==='codex'||portableAgents);
      const route=await this.connections.prepare({provider,cwd:session.cwd},mode,managed,session.accountScope,connectionRevision);
      const priorRoute=b?this.connections.route(b):undefined;
      if(b&&this.registry.isCoordinator(b.id)&&priorRoute&&(priorRoute.executionMode!==route.executionMode||priorRoute.profileId!==route.profileId||priorRoute.accountKey!==route.accountKey||priorRoute.accountScope!==route.accountScope))throw new Error('This coordinator belongs to another connection identity. Select a separate exact native session.');
      if(b&&priorRoute&&JSON.stringify(priorRoute)!==JSON.stringify(route)&&this.store.pendingJobs().some(j=>j.binding_id===b!.id))throw new Error('This session has unfinished requests. Close or finish them before changing its platform or account.');
      this.setAside();
      if(!b){const r=this.store.register(`selected-master-${operationId.slice(0,8)}`,provider,session.id,session.cwd);b=r.binding;saveBindingCredentials(b,r.token);}
      this.stopWorker(b.id);this.store.set(`execution-mode:${b.id}`,mode);
      this.connections.save(b,route);
      if(mode==='cli'&&(provider==='codex'||portableAgents))this.store.set(`managed-${provider}:${b.id}`,'true');
      this.saveOperation({id:operationId,provider,executionMode:mode,selectedSessionId:session.id,bindingId:b.id,nativeId:b.native_id,cwd:b.cwd,status:'creating'});
      this.activate(b,operationId);this.store.set(`name:${b.id}`,session.name);
      this.store.set('selected',JSON.stringify((JSON.parse(this.store.get('selected')??'[]') as string[]).filter(id=>id!==b!.id)));
      return this.operation();
    }finally{this.creating=false;}
  }
  async create(provider:Provider,operationId:string,requestedMode?:unknown,desktopParentId?:string,requestedName?:unknown,connectionRevision?:string,workspaceId?:string):Promise<any> {
    return this.setupContext.run({id:operationId,connection:`${provider}:${requestedMode??'cli'}`},()=>this.createScoped(provider,operationId,requestedMode,desktopParentId,requestedName,connectionRevision,workspaceId));
  }
  private async createScoped(provider:Provider,operationId:string,requestedMode?:unknown,desktopParentId?:string,requestedName?:unknown,connectionRevision?:string,workspaceId?:string):Promise<any> {
    if(!['codex','claude'].includes(provider)||!/^[0-9a-f-]{36}$/i.test(operationId))throw new Error('Choose a supported platform and a stable creation ID.');
    requirePortableCLI(requestedMode);
    const mode=masterMode(provider,requestedMode),name=masterName(provider,mode,requestedName),previous=this.operation(operationId);
    if(previous){if(previous.workspaceId!==workspaceId||previous.selectedSessionId||previous.provider!==provider||(previous.executionMode??'cli')!==mode||previous.desktopParentId!==desktopParentId||(previous.requestedName??'')!==(typeof requestedName==='string'?requestedName.trim():''))throw new Error('Creation ID cannot change platform, workspace or desktop launcher.');return previous;}
    this.assertIdle();
    if(!this.platforms.find(p=>p.provider===provider&&(p.executionMode??'cli')===mode)?.available)throw new Error('The selected execution mode is not available.');
    let workspace:any,sessions:any[]|undefined;
    if(workspaceId!==undefined) {
      if(typeof workspaceId!=='string'||!workspaceId)throw new Error('Choose a detected workspace.');
      sessions=await this.catalog(provider,true);
      workspace=masterWorkspaces(provider,mode,sessions.filter(s=>provider!=='claude'||(s.executionMode??'cli')===mode)).find(w=>w.id===workspaceId);
      if(!workspace?.available)throw new Error('Selected workspace is no longer available in this app and account. Refresh and choose it again.');
      if(desktopParentId&&workspace.launcherId!==desktopParentId)throw new Error('Selected workspace does not match the desktop launcher.');
    }
    const route=await this.connections.prepare({provider,cwd:workspace?.cwd??coordinatorFolder(operationId,name)},mode,mode==='cli',workspace?.accountScope??undefined,connectionRevision);
    if(this.operation(operationId))return this.create(provider,operationId,requestedMode,desktopParentId,requestedName,connectionRevision,workspaceId);
    this.assertIdle();
    this.setAside();this.creating=true;
    const op={id:operationId,provider,executionMode:mode,desktopParentId,workspaceId,workspaceCwd:workspace?.cwd,route,status:'creating',stage:'Preparing workspace',startedAt:Date.now(),name,requestedName:typeof requestedName==='string'?requestedName.trim():''};this.saveOperation(op);
    void (async()=>{
      const launcher=provider==='claude'&&mode==='desktop'&&workspace?await this.desktop.parent(workspace?.launcherId??desktopParentId,workspace?.accountScope??undefined,sessions):undefined;
      if(launcher)this.saveOperation({...this.operation(),route:{...route,accountScope:launcher.accountScope},resolvedDesktopParentId:launcher.id});
      await this.provision(provider,operationId,mode,launcher?.id??desktopParentId);
    })().catch(e=>this.recordSetupFailure(e,operationId)).finally(()=>{this.creating=false;});
    return op;
  }
  async provision(provider:Provider,operationId:string,mode:ExecutionMode='cli',desktopParentId?:string) {
    const selected=this.operation()?.workspaceCwd;
    let cwd=selected?realpathSync(selected):coordinatorFolder(operationId,this.operation()?.name??'coordinator');
    if(selected&&cwd!==selected)throw new Error('Selected workspace path changed. Choose it again.');
    mkdirSync(cwd,{recursive:true,mode:0o700});cwd=realpathSync(cwd);
    // Existing project instructions must never be replaced by bridge setup.
    const support=selected?join(cwd,'.farfromdesk','coordinators',operationId):cwd;
    mkdirSync(support,{recursive:true,mode:0o700});
    if(realpathSync(support)!==support)throw new Error('Workspace setup directory must not be a symbolic link.');
    if(selected)writeFileSync(join(support,'.gitignore'),'*\n',{mode:0o600,flag:'wx'});
    const alias=`whatsapp-master-${operationId.slice(0,8)}`;
    const registered=this.store.register(alias,provider,randomUUID(),cwd);
    let b=registered.binding;this.store.set(`execution-mode:${b.id}`,mode);this.store.enable(b.id,false);saveBindingCredentials(b,registered.token);
    const route=this.operation()?.route??await this.connections.prepare(b,mode,mode==='cli');this.connections.save(b,route);
    await this.connections.assert(b);
    this.store.set(`master-support:${b.id}`,support);
    this.saveOperation({...this.operation(),bindingId:b.id,cwd,stage:'Starting native session'});
    const name=this.operation().name??'WhatsApp master';this.store.set(`name:${b.id}`,name);
    this.store.set(`role-kind:${b.id}`,'master');
    const tools=mode==='desktop'?`Use the local bridge CLI for coordination: ${quote(process.execPath)} ${quote(join(root,'dist/cli.js'))} master --binding ${quote(b.alias)}. Incoming requests include the exact reply command.`:'Use the session_bridge MCP tools for coordination and replies.';
    // Support files are written once and may be auto-loaded beside the provider instructions,
    // so they point to the versioned role instead of carrying a copy that would go stale.
    // A coordinator in its own home folder reads the owner's other folders only through native permission prompts.
    const access=selected?'':' This is your own home folder. When a request needs another folder (a project, Documents), read it there and let your app ask the owner for file access; never change permission settings or copy credentials.';
    const pointer=`# FarFromDesk coordinator workspace\n\nThis folder belongs to the owner's FarFromDesk coordinator. FarFromDesk supplies the current coordinator role through provider instructions or a one-time role bootstrap, and every request envelope names its roleFile; reread that file after context loss. ${tools}${access} Native permissions and project instructions still apply.\n`;
    for(const filename of ['AGENTS.md','CLAUDE.md','MASTER.md'])writeFileSync(join(support,filename),pointer,{mode:0o600,flag:selected?'wx':'w'});
    for(const directory of ['.agents/skills/whatsapp-master','.claude/skills/whatsapp-master']) {
      mkdirSync(join(support,directory),{recursive:true,mode:0o700});
      writeFileSync(join(support,directory,'SKILL.md'),`---\nname: whatsapp-master\ndescription: Coordinate owner-selected coding sessions and send supportive, request-bound WhatsApp replies.\n---\n${pointer}`,{mode:0o600});
    }
    const instruction=`${roleConfig(this.store,b,'master').instructions}\n\n${tools}${access} Your native permissions still apply.`;
    if(provider==='claude'&&mode==='desktop') {
      // The role arrives once with the first request envelope; the launcher session never sees it.
      if(selected)await this.desktop.create(b,desktopParentId!,name,`You will be the owner's FarFromDesk coordinator. ${tools}`);
      else await this.desktop.createDirect(b,`You are my FarFromDesk coordinator. ${tools}${access}`);
      b=this.store.binding(b.id)!;saveBindingCredentials(b,registered.token);
    } else if(provider==='codex') {
      const runtime=new CodexSession(codexBin,cwd,(method,params)=>this.approval(b,method,params));
      this.runtimes.set(b.id,runtime);await runtime.initialize();
      const created=await runtime.request('thread/start',{cwd,approvalPolicy:'on-request',sandbox:'read-only',developerInstructions:instruction,config:{'mcp_servers.session_bridge':this.mcpConfig(b)},ephemeral:false});
      if(!/^[0-9a-f-]{36}$/i.test(created?.thread?.id??''))throw new Error('Native creation did not return an exact session ID.');
      this.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(created.thread.id,b.id);
      b=this.store.binding(b.id)!;saveBindingCredentials(b,registered.token);
      this.saveOperation({...this.operation(),nativeId:b.native_id});
      await runtime.request('thread/name/set',{threadId:b.native_id,name});
      if(mode==='cli')this.store.set(`managed-codex:${b.id}`,'true');
      else {runtime.close();this.runtimes.delete(b.id);}
    } else {
      this.saveOperation({...this.operation(),nativeId:b.native_id});
      await this.provisionClaude(b);
    }
    this.activate(b,operationId);
    await this.router.coordinator?.refresh().catch(()=>{});
  }
  async provisionClaude(b:Binding) {
    // Keep generated configuration separate from the selected project's instructions.
    // Use Claude's supported headless interface; never edit Claude's trust database.
    const mcp=join(this.store.get(`master-support:${b.id}`)??b.cwd,'bridge-mcp.json');writeFileSync(mcp,JSON.stringify({mcpServers:{session_bridge:this.mcpConfig(b)}}),{mode:0o600});
    const runtime=this.claudeWorker(b,false);this.claudeRuntimes.set(b.id,runtime);
    try{await runtime.initialize();await runtime.run('Return exactly READY without using tools. Wait for the owner’s first WhatsApp message.');this.store.set(`managed-claude:${b.id}`,'true');}
    catch(e){runtime.close();this.claudeRuntimes.delete(b.id);throw e;}
  }
  async run(b:Binding,message:string,jobId:string) {
    await this.connections.assert(b);
    const role=roleConfig(this.store,b);
    if(this.runtimeRoles.get(b.id)!==role.version){this.stopWorker(b.id);this.runtimeRoles.set(b.id,role.version);}
    if(b.provider==='claude'&&(this.store.get(`managed-worker:${b.id}`)==='true'||this.store.get(`managed-claude:${b.id}`)==='true')) {
      let runtime=this.claudeRuntimes.get(b.id);
      if(!runtime?.alive){runtime=this.claudeWorker(b,true);this.claudeRuntimes.set(b.id,runtime);await runtime.initialize();}
      const text=await runtime.run(message,this.router.attachments.imageInputs(b,jobId));
      if(runtime.lastUsage)this.store.event(jobId,'provider_usage',{provider:'claude',...runtime.lastUsage});
      if(this.store.job(jobId)?.status==='replaced')return;
      if(this.store.job(jobId)?.status!=='completed') {
        if(!text.trim()&&(this.router.hasPendingCreation?.(jobId)||this.router.unfinishedChildren(jobId)))return;
        if(!text.trim())throw new Error('Claude ended without a reply. Check its exact session.');
        this.router.channelReply(b,text,(this.router.hasPendingCreation?.(jobId)||this.router.unfinishedChildren(jobId))?'progress':'final',jobId,`native-final:${jobId}`);
      }
      return;
    }
    let runtime=this.runtimes.get(b.id);
    if(!runtime?.alive) {
      runtime=new CodexSession(codexBin,b.cwd,(method,params)=>this.approval(b,method,params));this.runtimes.set(b.id,runtime);
      await runtime.initialize();
      const worker=this.store.get(`managed-worker:${b.id}`)==='true';
      await checkCodexEnvironment(runtime,b.cwd);
      const resumed=await runtime.request('thread/resume',{threadId:b.native_id,cwd:b.cwd,excludeTurns:true,approvalPolicy:'on-request',sandbox:worker?'workspace-write':'read-only',developerInstructions:role.instructions,config:{'mcp_servers.session_bridge':this.mcpConfig(b)}});
      if((resumed.thread?.id!==b.native_id||typeof resumed.thread?.cwd!=='string'||realpathSync(resumed.thread.cwd)!==realpathSync(b.cwd))){this.stopWorker(b.id);throw new Error('Native resume returned a different session or project. Delivery stopped.');}
    }
    const active=runtime;
    await new Promise<void>((resolve,reject)=>{
      let text='';
      const cleanup=()=>{active.off('notification',event);active.off('closed',closed);};
      const closed=()=>{cleanup();reject(new Error('Native master disconnected during a request; check it before resending.'));};
      const event=(method:string,p:any)=>{
        if(p?.threadId!==b.native_id)return;
        if(method==='thread/tokenUsage/updated'&&p.tokenUsage?.last)this.store.event(jobId,'provider_usage',{provider:'codex',inputTokens:p.tokenUsage.last.inputTokens,outputTokens:p.tokenUsage.last.outputTokens},p.turnId);
        if(method==='turn/started'&&p.turn?.id)this.store.event(jobId,'provider_turn_started',{provider:'codex'},p.turn.id);
        if(method==='item/completed'&&p.item?.type==='agentMessage'&&p.item.phase!=='commentary')text=p.item.text??'';
        if(method==='turn/completed'){
          cleanup();
          if(p.turn?.status!=='completed'){reject(new Error(p.turn?.error?.message??'Native master did not finish this request.'));return;}
          try {
            if(this.store.job(jobId)?.status==='replaced'){resolve();return;}
            if(this.store.job(jobId)?.status!=='completed') {
              if(!text.trim()&&(this.router.hasPendingCreation?.(jobId)||this.router.unfinishedChildren(jobId))){resolve();return;}
              if(!text.trim())throw new Error('Native master ended without a reply. Check the session before sending again.');
              this.router.channelReply(b,text,(this.router.hasPendingCreation?.(jobId)||this.router.unfinishedChildren(jobId))?'progress':'final',jobId,`native-final:${jobId}`,{turnId:p.turn.id});
            }
            resolve();
          }catch(e){reject(e);}
        }
      };
      active.on('notification',event);active.on('closed',closed);
      active.request('turn/start',{threadId:b.native_id,input:[{type:'text',text:message,text_elements:[]},...this.router.attachments.references(b,jobId,true).filter(a=>['image/jpeg','image/png','image/webp','image/gif'].includes(a.mime)&&a.bytes<=10*1024*1024).map(a=>({type:'localImage',path:a.path!}))]}).catch(e=>{cleanup();reject(e);});
    });
  }
  private claudeWorker(b:Binding,resume:boolean) {
    if(portableAgents||(this.store.get(`managed-claude:${b.id}`)==='true'&&!this.registry.isCoordinator(b.id)&&this.store.get(`managed-worker:${b.id}`)!=='true'))return new ClaudeSDKSession(claudeBin,b.cwd,b.native_id,resume,async(tool,input)=>{
      if(this.router.stopped||!this.store.binding(b.id)?.enabled)return false;
      const answer=await this.router.approvals.ask(b,`${tool}\n${JSON.stringify(input).slice(0,12000)}`);
      return answer==='approve'&&!this.router.stopped&&!!this.store.binding(b.id)?.enabled;
    },{session_bridge:this.mcpConfig(b)},undefined,roleConfig(this.store,b).instructions);
    return new ClaudeSession(claudeBin,b.cwd,b.native_id,resume,async(tool,input)=>{
      if(this.router.stopped||!this.store.binding(b.id)?.enabled)return false;
      const answer=await this.router.approvals.ask(b,`${tool}\n${JSON.stringify(input).slice(0,12000)}`);
      return answer==='approve'&&!this.router.stopped&&!!this.store.binding(b.id)?.enabled;
    },{...process.env,WSB_STATE_DIR:stateDir,WSB_PORT:new URL(baseUrl).port},{instructions:roleConfig(this.store,b).instructions,...(this.store.get(`managed-worker:${b.id}`)==='true'?{}:{name:this.store.get(`name:${b.id}`),permissionMode:'manual',mcpConfig:join(this.store.get(`master-support:${b.id}`)??b.cwd,'bridge-mcp.json'),allowedTools:['master_agents','master_define_agent','master_assign_agent','master_sessions','master_selected','master_connect','master_dispatch','master_create_session','master_creation_status','master_recover_session','whatsapp_reply','master_quiet','master_resolve'].map(t=>`mcp__session_bridge__${t}`).join(',')})});
  }
  async provisionWorker(b:Binding) {
    requirePortableCLI(this.store.get(`execution-mode:${b.id}`));
    await this.connections.assert(b);
    if(b.provider==='claude'&&this.store.get(`execution-mode:${b.id}`)==='desktop') {
      await this.desktop.create(b,this.store.get(`desktop-parent:${b.id}`)!,this.store.get(`name:${b.id}`)??'FarFromDesk project','You will be a FarFromDesk worker for this project. Your role arrives with the first request; use its bridge CLI reply command.');return;
    }
    if(b.provider==='claude') {
      const runtime=this.claudeWorker(b,false);this.claudeRuntimes.set(b.id,runtime);
      try{await runtime.initialize();await runtime.run('This newly created empty project is explicitly approved by the owner. Return exactly READY without using any tools. Wait for the actual task.');}
      catch(e){runtime.close();this.claudeRuntimes.delete(b.id);throw e;}
      return;
    }
    const runtime=new CodexSession(codexBin,b.cwd,(m,p)=>this.approval(this.store.binding(b.id)!,m,p));
    this.runtimes.set(b.id,runtime);await runtime.initialize();
    this.store.set(`worker-preflight:${b.id}`,'blocked');
    if(this.store.get(`execution-mode:${b.id}`)!=='desktop')await checkCodexEnvironment(runtime,b.cwd);
    this.store.set(`worker-preflight:${b.id}`,'passed');
    const r=await runtime.request('thread/start',{cwd:b.cwd,approvalPolicy:'on-request',sandbox:'workspace-write',developerInstructions:roleConfig(this.store,b).instructions,config:{'mcp_servers.session_bridge':this.mcpConfig(b)},ephemeral:false});
    if(!/^[0-9a-f-]{36}$/i.test(r.thread?.id??''))throw new Error('Native worker creation did not return an exact session ID.');
    this.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(r.thread.id,b.id);
    if(this.store.get(`execution-mode:${b.id}`)!=='desktop')this.store.set(`managed-codex:${b.id}`,'true');
    await runtime.request('thread/name/set',{threadId:r.thread.id,name:this.store.get(`name:${b.id}`)??'FarFromDesk project'});
    if(this.store.get(`execution-mode:${b.id}`)==='desktop'){runtime.close();this.runtimes.delete(b.id);}
  }
  stopWorker(id:string){this.runtimeRoles.delete(id);this.runtimes.get(id)?.close();this.runtimes.delete(id);this.claudeRuntimes.get(id)?.close();this.claudeRuntimes.delete(id);}
  async recoverWorker(b:Binding) {
    requirePortableCLI(this.store.get(`execution-mode:${b.id}`));
    this.stopWorker(b.id);
    await this.connections.assert(b);
    // A failed configuration read occurs before thread/start. Recovering this
    // exact binding can safely make its first native session; it is not a replay.
    if(b.provider==='codex'&&this.store.get(`worker-preflight:${b.id}`)==='blocked'){await this.provisionWorker(b);return;}
    if(b.provider==='claude'&&this.store.get(`execution-mode:${b.id}`)==='desktop'){await this.desktop.confirm(b,true);return;}
    if(b.provider==='claude') {
      const runtime=this.claudeWorker(b,true);this.claudeRuntimes.set(b.id,runtime);
      try{await runtime.initialize();await runtime.run('Resume this exact project for a connection check only. Return READY without using tools or repeating any prior work.');}
      catch(e){this.stopWorker(b.id);throw e;}return;
    }
    const runtime=new CodexSession(codexBin,b.cwd,(m,p)=>this.approval(this.store.binding(b.id)!,m,p));
    try {
      await runtime.initialize();const r=await runtime.request('thread/read',{threadId:b.native_id,includeTurns:false});
      if(r.thread?.id!==b.native_id||realpathSync(r.thread.cwd)!==realpathSync(b.cwd))throw new Error('Native session identity differs; recovery stopped.');
      if(this.store.get(`execution-mode:${b.id}`)!=='desktop')this.store.set(`managed-codex:${b.id}`,'true');
    }finally{runtime.close();}
  }
  close(){this.closed=true;this.desktop.close();for(const r of this.runtimes.values())r.close();for(const r of this.claudeRuntimes.values())r.close();}
}
