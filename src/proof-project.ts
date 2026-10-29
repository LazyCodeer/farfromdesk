import {execFile} from 'node:child_process';
import {lstatSync,realpathSync,statSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {promisify} from 'node:util';
import type {Router} from './router.js';
import {hash} from './store.js';

const run=promisify(execFile);
type Boundary='before'|'after';
type Snapshot={cwd:string;device:string;inode:string;gitDevice:string;gitInode:string;repository:string;head:string;trackedAndUntrackedClean:boolean};
type Context={fingerprint:string;attempt:string;startedAt:number;cwd:string;contractId:string;revision:number;approvedHash:string;owner:string;destination:string;bindingId:string;requestId:string};
const commit=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/**
 * Unwired internal boundary capture. The caller must be the bridge task
 * lifecycle, never an owner/session supplied path or claimed GitHub result.
 * Status excludes ignored files; no snapshot is evidence of tests or checks.
 */
export class ProofProjectSnapshots {
  constructor(private router:Router){
    router.store.db.exec(`CREATE TABLE IF NOT EXISTS proof_project_boundaries(
      request_id TEXT NOT NULL,attempt_id TEXT NOT NULL,phase TEXT NOT NULL,
      contract_id TEXT NOT NULL,revision INTEGER NOT NULL,approved_hash TEXT NOT NULL,
      owner TEXT NOT NULL,destination TEXT NOT NULL,binding_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,cwd TEXT NOT NULL,device TEXT NOT NULL,inode TEXT NOT NULL,git_device TEXT NOT NULL,git_inode TEXT NOT NULL,
      repository TEXT NOT NULL,head TEXT NOT NULL,tracked_untracked_clean INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,PRIMARY KEY(request_id,attempt_id,phase));`);
  }
  private context(id:string,phase:Boundary):Context|undefined {
    const {store,contracts}=this.router,job=store.job(id),row=contracts.approved(id);
    // The first implementation deliberately excludes delegated and scheduled
    // requests; F3's child lifecycle may outlive the parent authorization.
    if(!job||!row||row.dispatch_id!==id||!job.attempt_id||!row.approved_hash||!row.approved_at||!row.item_id||
       !job.destination||job.destination!==row.destination||
       (phase==='before'?job.status!=='dispatched':job.status!=='completed'||job.outcome!=='done'))return;
    const binding=store.binding(job.binding_id);if(!binding||!binding.enabled)return;
    try{contracts.assertDispatch(this.router,id,binding,job.body);}catch{return;}
    const events=store.db.prepare("SELECT at FROM request_events WHERE request_id=? AND attempt_id=? AND event='dispatched'").all(id,job.attempt_id) as {at:number}[];
    if(events.length!==1||events[0].at<row.approved_at)return;
    const value={attempt:job.attempt_id,startedAt:events[0].at,cwd:binding.cwd,contractId:row.id,revision:row.revision,
      approvedHash:row.approved_hash,owner:row.owner,destination:row.destination,bindingId:binding.id,requestId:id};
    return {...value,fingerprint:hash(JSON.stringify(value))};
  }
  protected async git(cwd:string,args:string[]):Promise<string>{
    // Git status can execute arbitrary repository-defined clean filters. The
    // sandbox denies writes, network, and all child executables except the Git
    // shim and its known Apple toolchain binaries. This does not restrict
    // configuration includes' reads, so it is not ready for production.
    // Unsupported platforms fail closed.
    if(process.platform!=='darwin'||/[\x00-\x1f]/.test(cwd))throw new Error('Git unavailable');
    const profile=`(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (literal "/dev/null")) (deny process-exec) `+
      `(allow process-exec (literal "/usr/bin/git") (literal "/Applications/Xcode.app/Contents/Developer/usr/bin/git") (literal "/Library/Developer/CommandLineTools/usr/bin/git"))`;
    const {stdout,stderr}=await run('/usr/bin/sandbox-exec',['-p',profile,'/usr/bin/git','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',cwd,...args],{
      env:{PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'},
      timeout:3000,maxBuffer:2*1024*1024,encoding:'utf8',windowsHide:true,
    });
    // Git status can exit zero after a clean filter fails. Do not interpret
    // its empty output as clean if it emitted any warning or error.
    if(stderr.trim())throw new Error('Git observation incomplete');return stdout;
  }
  private async read(cwd:string):Promise<Snapshot|undefined>{
    try {
      if(!isAbsolute(cwd)||resolve(cwd)!==cwd||realpathSync(cwd)!==cwd||!statSync(cwd).isDirectory())return;
      // Linked worktrees and symlinked .git directories can point outside the
      // approved workspace; leave them unverified for a separate design.
      const dot=join(cwd,'.git');if(!lstatSync(dot).isDirectory()||realpathSync(dot)!==dot)return;
      const root=await this.git(cwd,['rev-parse','--show-toplevel']);if(root!==cwd+'\n')return;
      const files=await this.git(cwd,['ls-files','--stage','-z']);
      if(files.split('\0').some(line=>line.startsWith('160000 ')))return; // no nested submodule inspection
      const read=async()=>{
        const head=(await this.git(cwd,['rev-parse','--verify','HEAD^{commit}'])).trim();if(!commit.test(head))throw new Error('Invalid revision');
        const remote=await this.git(cwd,['config','--local','--get-all','remote.origin.url']);
        // A configured origin is only a local observation, not proof of
        // ownership, a PR, a run, or an owner-approved evidence binding.
        const match=/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\n$/.exec(remote);
        if(!match||[match[1],match[2]].some(part=>part==='.'||part==='..'))throw new Error('Unsupported remote');
        const status=await this.git(cwd,['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none']);
        return {head,repository:`${match[1].toLowerCase()}/${match[2].toLowerCase()}`,status};
      };
      const before=statSync(cwd,{bigint:true}),gitBefore=statSync(dot,{bigint:true}),a=await read(),b=await read(),after=statSync(cwd,{bigint:true}),gitAfter=lstatSync(dot,{bigint:true});
      if(before.dev!==after.dev||before.ino!==after.ino||!gitAfter.isDirectory()||gitBefore.dev!==gitAfter.dev||gitBefore.ino!==gitAfter.ino||realpathSync(cwd)!==cwd||realpathSync(dot)!==dot||JSON.stringify(a)!==JSON.stringify(b))return;
      return {cwd,device:String(before.dev),inode:String(before.ino),gitDevice:String(gitBefore.dev),gitInode:String(gitBefore.ino),repository:a.repository,head:a.head,trackedAndUntrackedClean:a.status.length===0};
    }catch{return;}
  }
  async capture(id:string,phase:Boundary):Promise<boolean>{
    if(phase!=='before'&&phase!=='after')return false;
    const ctx=this.context(id,phase);if(!ctx)return false;
    const existing=this.router.store.db.prepare('SELECT 1 FROM proof_project_boundaries WHERE request_id=? AND attempt_id=? AND phase=?').get(id,ctx.attempt,phase);
    if(existing)return false; // snapshots are immutable, never overwritten by a later attempt
    const snapshot=await this.read(ctx.cwd);if(!snapshot||this.context(id,phase)?.fingerprint!==ctx.fingerprint)return false;
    const db=this.router.store.db;db.exec('SAVEPOINT proof_project');
    try {
      if(this.context(id,phase)?.fingerprint!==ctx.fingerprint){db.exec('ROLLBACK TO proof_project; RELEASE proof_project');return false;}
      if(phase==='after'){
        const prior=db.prepare("SELECT cwd,device,inode,git_device,git_inode,repository FROM proof_project_boundaries WHERE request_id=? AND attempt_id=? AND phase='before'").get(id,ctx.attempt) as {cwd:string;device:string;inode:string;git_device:string;git_inode:string;repository:string}|undefined;
        if(!prior||prior.cwd!==snapshot.cwd||prior.device!==snapshot.device||prior.inode!==snapshot.inode||prior.git_device!==snapshot.gitDevice||prior.git_inode!==snapshot.gitInode||prior.repository!==snapshot.repository){db.exec('ROLLBACK TO proof_project; RELEASE proof_project');return false;}
      }
      db.prepare('INSERT INTO proof_project_boundaries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,ctx.attempt,phase,ctx.contractId,ctx.revision,ctx.approvedHash,ctx.owner,ctx.destination,ctx.bindingId,ctx.startedAt,snapshot.cwd,snapshot.device,snapshot.inode,snapshot.gitDevice,snapshot.gitInode,snapshot.repository,snapshot.head,snapshot.trackedAndUntrackedClean?1:0,Date.now());
      db.exec('RELEASE proof_project');return true;
    }catch{db.exec('ROLLBACK TO proof_project; RELEASE proof_project');return false;}
  }
}
