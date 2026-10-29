import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,realpathSync,renameSync,rmSync,symlinkSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {MetaBrain} from '../src/meta-brain.js';
import {DEFAULT_BRAIN,MetaSecret,saveBrainConfig} from '../src/meta-brain-config.js';
import {TaskContracts} from '../src/task-contracts.js';
import {ProofProjectSnapshots} from '../src/proof-project.js';

const git=(cwd:string,...args:string[])=>execFileSync('/usr/bin/git',['-C',cwd,...args],{env:{PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},stdio:'pipe'}).toString().trim();
// Tests already run inside a sandbox that restricts child executables and
// network. macOS cannot nest sandbox-exec, so use its equivalent command here.
class TestSnapshots extends ProofProjectSnapshots {
  protected override async git(cwd:string,args:string[]){
    const {stdout,stderr}=await promisify(execFile)('/usr/bin/git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',cwd,...args],{env:{PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'},timeout:3000,maxBuffer:2*1024*1024,encoding:'utf8'});
    if(stderr.trim())throw new Error('Git observation incomplete');return stdout;
  }
}
async function fixture(){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'ffd-proof-project-'))),repo=join(dir,'repo');
  mkdirSync(repo);
  git(repo,'init','-q');git(repo,'remote','add','origin','https://github.com/example/project.git');
  writeFileSync(join(repo,'example.txt'),'initial\n');git(repo,'add','example.txt');
  git(repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','initial');
  const store=new Store(':memory:'),approvals=new Approvals(store),router=new Router(store,{run:async()=>{},stop:()=>{}} as any,approvals);
  router.pump=()=>{};store.set('whatsapp-owner','owner@s.whatsapp.net');
  const binding=store.register('codex-one','codex',randomUUID(),repo).binding;store.set('active',binding.id);
  const secret=new MetaSecret(dir);secret.save('synthetic-key-not-a-real-secret');
  router.brain=new MetaBrain(store,secret,{interpret:async()=>{throw new Error('unused');}} as any);
  saveBrainConfig(store,secret,{policy:{...DEFAULT_BRAIN,enabled:true,allowRouting:true,providers:['codex'],failure:'block'}});
  router.contracts=new TaskContracts(store,secret,async()=>({kind:'contract',goal:'Edit file',exclusions:[],checks:['First check','Second check'],question:''}));
  await router.receive({id:'wa:request',text:'Edit file',ownerIntent:true,ownerCommand:true});
  store.db.prepare("UPDATE outbox SET status='sent' WHERE source LIKE 'task-contract:%'").run();
  await router.receive({id:'wa:approved',text:'ok',ownerIntent:true,ownerCommand:true});
  const snapshots=new TestSnapshots(router),id='wa:approved';
  return {repo,store,router,binding,snapshots,id,rows:()=>store.db.prepare('SELECT * FROM proof_project_boundaries ORDER BY phase DESC').all() as any[],
    close(){approvals.cancel();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('captures immutable pre/post repository identity and commit for one approved attempt',async()=>{
  const f=await fixture();try{
    assert.equal(await f.snapshots.capture(f.id,'before'),false);f.store.jobState(f.id,'dispatched');
    assert.equal(await f.snapshots.capture(f.id,'before'),true);assert.equal(await f.snapshots.capture(f.id,'before'),false);
    const old=git(f.repo,'rev-parse','HEAD');writeFileSync(join(f.repo,'example.txt'),'changed\n');git(f.repo,'add','example.txt');git(f.repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','change');
    const head=git(f.repo,'rev-parse','HEAD');f.store.jobState(f.id,'completed',null,'done');
    assert.equal(await f.snapshots.capture(f.id,'after'),true);
    const rows=f.rows(),before=rows.find(x=>x.phase==='before'),after=rows.find(x=>x.phase==='after');
    assert.equal(before.head,old);assert.equal(after.head,head);assert.notEqual(head,old);
    for(const row of rows){assert.equal(row.repository,'example/project');assert.equal(row.cwd,f.repo);assert.equal(row.owner,'owner@s.whatsapp.net');assert.equal(row.destination,row.owner);assert.equal(row.binding_id,f.binding.id);assert.equal(row.attempt_id,f.store.job(f.id)?.attempt_id);assert.equal(row.tracked_untracked_clean,1);assert.ok(row.approved_hash);}
  }finally{f.close();}
});

test('dirty tracked and untracked files are recorded, not mistaken for committed proof',async()=>{
  const f=await fixture();try{
    f.store.jobState(f.id,'dispatched');writeFileSync(join(f.repo,'example.txt'),'dirty');
    assert.equal(await f.snapshots.capture(f.id,'before'),true);
    writeFileSync(join(f.repo,'new.txt'),'untracked');f.store.jobState(f.id,'completed',null,'done');
    assert.equal(await f.snapshots.capture(f.id,'after'),true);
    assert.deepEqual(f.rows().map(r=>r.tracked_untracked_clean),[0,0]);
  }finally{f.close();}
});

test('changed owner, session or attempt and missing earlier boundary fail closed',async()=>{
  for(const change of ['owner','session','attempt','missing-before']){
    const f=await fixture();try{
      f.store.jobState(f.id,'dispatched');if(change!=='missing-before')assert.equal(await f.snapshots.capture(f.id,'before'),true);
      if(change==='owner')f.store.set('whatsapp-owner','other@s.whatsapp.net');
      if(change==='session')f.store.db.prepare('UPDATE bindings SET native_id=? WHERE id=?').run(randomUUID(),f.binding.id);
      if(change==='attempt')f.store.jobState(f.id,'dispatched');
      f.store.jobState(f.id,'completed',null,'done');assert.equal(await f.snapshots.capture(f.id,'after'),false,change);
    }finally{f.close();}
  }
});

test('revocation while Git is reading prevents recording and unsupported remotes fail closed',async()=>{
  const f=await fixture();try{
    f.store.jobState(f.id,'dispatched');const pending=f.snapshots.capture(f.id,'before');f.store.set('whatsapp-owner','other@s.whatsapp.net');
    assert.equal(await pending,false);assert.equal(f.rows().length,0);
    f.store.set('whatsapp-owner','owner@s.whatsapp.net');git(f.repo,'remote','set-url','origin','https://example.invalid/project.git');
    assert.equal(await f.snapshots.capture(f.id,'before'),false);
  }finally{f.close();}
});

test('a symlinked workspace is not inspected',async()=>{
  const f=await fixture();try{
    const link=f.repo+'-link';symlinkSync(f.repo,link);f.store.db.prepare('UPDATE bindings SET cwd=? WHERE id=?').run(link,f.binding.id);
    f.store.jobState(f.id,'dispatched');assert.equal(await f.snapshots.capture(f.id,'before'),false);
  }finally{f.close();}
});

test('a symlinked Git directory and changed origin cannot establish the later boundary',async()=>{
  const f=await fixture();try{
    f.store.jobState(f.id,'dispatched');assert.equal(await f.snapshots.capture(f.id,'before'),true);
    git(f.repo,'remote','set-url','origin','https://github.com/example/other.git');
    f.store.jobState(f.id,'completed',null,'done');assert.equal(await f.snapshots.capture(f.id,'after'),false);
    git(f.repo,'remote','set-url','origin','https://github.com/example/project.git');
    renameSync(join(f.repo,'.git'),join(f.repo,'git-data'));symlinkSync(join(f.repo,'git-data'),join(f.repo,'.git'));
    assert.equal(await f.snapshots.capture(f.id,'after'),false);
  }finally{f.close();}
});

test('a repository clean filter cannot execute or cause a false clean capture',async()=>{
  const f=await fixture();try{
    const marker=join(f.repo,'filter-marker');
    writeFileSync(join(f.repo,'.gitattributes'),'*.txt filter=probe\n');git(f.repo,'add','.gitattributes','example.txt');
    git(f.repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','filter config');
    git(f.repo,'config','filter.probe.clean',`touch ${marker}; cat`);
    rmSync(marker,{force:true});const future=new Date(Date.now()+5000);utimesSync(join(f.repo,'example.txt'),future,future);
    f.store.jobState(f.id,'dispatched');assert.equal(await f.snapshots.capture(f.id,'before'),false);
    assert.equal(existsSync(marker),false);assert.equal(f.rows().length,0);
  }finally{f.close();}
});
