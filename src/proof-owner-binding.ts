import {authenticatedOwner} from './owner-commands.js';
import {contractProofScope} from './proof-contract-scope.js';
import {proofScopeHash} from './proof-check.js';
import {githubCheckBindingHash} from './proof-github-check.js';
import type {Incoming,Router} from './router.js';

/**
 * Unwired bridge-only owner approval for a narrow check policy. This records
 * neither a target revision nor the origin of a run and cannot create proof.
 */
export class ProofOwnerBindings {
  constructor(private router:Router){
    router.store.db.exec(`CREATE TABLE IF NOT EXISTS proof_owner_bindings(
      scope_hash TEXT NOT NULL,check_id TEXT NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,
      channel TEXT NOT NULL,generation TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,
      repository TEXT NOT NULL,check_name TEXT NOT NULL,binding_hash TEXT NOT NULL,
      PRIMARY KEY(scope_hash,check_id));`);
  }

  /**
   * The complete direct owner command is the approval. The name must already
   * appear in the approved contract as "GitHub check NAME passed"; neither a
   * coordinator nor an external source can supply the check text.
   */
  approve(m:Incoming):{checkId:string;repository:string;checkName:string} {
    const s=this.router.store,origin=s.incomingOwnerContext.getStore();
    if(!origin||origin.owner!==origin.destination||s.destination()!==origin.destination||!s.incomingOwnerCurrent()||m.ownerCommand!==true||m.source==='voice'||m.quotedId||!authenticatedOwner(this.router,m))
      throw new Error('Send this as a new typed message in your direct owner chat.');
    const match=m.text.length<=1000?/^\/proof bind (\S+) ([1-3]) ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(m.text.trim()):null;
    if(!match)throw new Error('Use /proof bind #ITEM CHECK_NUMBER OWNER/REPO.');
    let root=match[1];
    if(/^#[1-9][0-9]{0,8}$/.test(root)){
      const candidates=s.db.prepare("SELECT dispatch_id FROM task_contracts WHERE item_id=? AND state='approved' AND dispatch_id IS NOT NULL LIMIT 21").all(Number(root.slice(1))) as {dispatch_id:string}[];
      if(candidates.length>20)throw new Error('This item has too many task approvals. Use its exact request ID.');
      const matches=candidates.filter(row=>{const candidate=contractProofScope(this.router,row.dispatch_id);return candidate?.scope.owner===origin.owner&&candidate.scope.destination===origin.destination;});
      if(matches.length!==1)throw new Error('This item does not identify one completed approved task. Use its exact request ID.');
      root=matches[0].dispatch_id;
    }
    const current=contractProofScope(this.router,root);
    if(!current||current.scope.owner!==origin.owner||current.scope.destination!==origin.destination)throw new Error('The approved task or owner is unavailable.');
    const check=current.checks[Number(match[2])-1],name=check&&/^GitHub check (.+) passed$/.exec(check.text)?.[1];
    if(!check||!name)throw new Error('The approved check must name the exact GitHub check and say it passed.');
    const repository=match[3],bindingHash=githubCheckBindingHash({repository,name}),scopeHash=proofScopeHash(current.scope,current.checks);
    s.db.exec('SAVEPOINT proof_bind_owner');
    try{
      const again=contractProofScope(this.router,root);
      if(!s.incomingOwnerCurrent()||!again||proofScopeHash(again.scope,again.checks)!==scopeHash)throw new Error('The approved task or owner changed.');
      s.recordIncomingInput(m.id);
      const recorded=s.recordedIncomingInput(m.id);
      if(!recorded||recorded.owner!==origin.owner||recorded.destination!==origin.destination||recorded.channel!==origin.channel||recorded.generation!==origin.generation)
        throw new Error('The owner request was already used by another connection.');
      const old=s.db.prepare('SELECT * FROM proof_owner_bindings WHERE scope_hash=? AND check_id=?').get(scopeHash,check.id) as any;
      if(old){
        if(old.request_id!==m.id||old.repository!==repository||old.check_name!==name||old.binding_hash!==bindingHash||old.generation!==origin.generation)throw new Error('This check already has an owner binding.');
      }else s.db.prepare('INSERT INTO proof_owner_bindings VALUES(?,?,?,?,?,?,?,?,?,?)').run(scopeHash,check.id,origin.owner,origin.destination,origin.channel,origin.generation,m.id,repository,name,bindingHash);
      s.db.exec('RELEASE proof_bind_owner');return {checkId:check.id,repository,checkName:name};
    }catch(e){s.db.exec('ROLLBACK TO proof_bind_owner; RELEASE proof_bind_owner');throw e;}
  }

  /** Recheck the original scope. Do not attach bindings to ProofChecks until
   * a separate bridge-owned adapter establishes task/run provenance. */
  approved(root:string):{checkId:string;repository:string;checkName:string;bindingHash:string}[] {
    const s=this.router.store,base=contractProofScope(this.router,root);if(!base)return [];
    const scopeHash=proofScopeHash(base.scope,base.checks);
    const rows=s.db.prepare('SELECT * FROM proof_owner_bindings WHERE scope_hash=?').all(scopeHash) as any[];
    return base.checks.flatMap(check=>{
      const row=rows.find(r=>r.check_id===check.id);
      if(!row||row.owner!==base.scope.owner||row.destination!==base.scope.destination||row.channel!==s.controlChannel()||row.generation!==(s.get('incoming-owner-generation')??'')||
        check.text!==`GitHub check ${row.check_name} passed`)return [];
      try{if(githubCheckBindingHash({repository:row.repository,name:row.check_name})!==row.binding_hash)return [];}catch{return [];}
      return [{checkId:check.id,repository:row.repository,checkName:row.check_name,bindingHash:row.binding_hash}];
    });
  }
}
