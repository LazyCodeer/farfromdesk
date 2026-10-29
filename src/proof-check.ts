import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.js';

/**
 * F4 foundation only: no route or production source is wired to this module.
 * A provider is trusted bridge code, never a response or assertion supplied by
 * a session. Until an actual evidence provider is installed, every check is
 * unverified. A coordinator's "done", a URL, and a test log are not proof.
 */
export type ProofScope={
  contractId:string;revision:number;approvedHash:string;approvedAt:number;
  owner:string;destination:string;rootRequestId:string;itemId:number;
  bindingId:string;bindingHash:string;attemptId:string;startedAt:number;
  targetRepository:string|null;targetRevision:string|null;
};
export type ProofEvidenceBinding={source:'independent-test'|'github-check'|'consented-screen';bindingHash:string};
export type ProofCheck={id:string;text:string;evidenceBindings?:readonly ProofEvidenceBinding[]};
export type ProofObservation={
  scopeHash:string;checkId:string;source:'independent-test'|'github-check'|'consented-screen';
  // Digest of the exact evidence policy explicitly approved for this check.
  // observedAt is the immutable trusted source event time, not retrieval time
  // or a timestamp supplied by the session/model. Adapters must reject evidence
  // when source ordering cannot be established.
  bindingHash:string;verdict:'pass'|'fail';observedAt:number;digest:string;
};
export type ProofResult={checkId:string;verdict:'pass'|'fail'|'unverified';reason:string;evidenceDigests:string[];expiresAt:number|null};
export type ProofRun={id:string;scope:ProofScope;checks:ProofResult[];createdAt:number};
export type ProofJudgeInput={index:number;category:'test'|'visual'|'repository'|'other';signals:{source:ProofObservation['source'];verdict:ProofObservation['verdict']}[]};
export type ProofJudgment={index:number;verdict:'pass'|'fail'|'unverified'};
export type ProofDependencies={
  // Synchronous same-connection reads of the current authenticated owner,
  // frozen contract and exact run. Called again inside the final transaction.
  current:()=>{scope:ProofScope;checks:ProofCheck[]}|undefined;
  // Internal adapter verifies the evidence independently. Do not implement this
  // from session-supplied claims, model output, or arbitrary client JSON.
  observe?:(reference:string,check:ProofCheck,scope:ProofScope,signal:AbortSignal)=>Promise<ProofObservation|undefined>;
  // The model is advisory and receives only bounded, sanitized categories and
  // independently verified signal codes, never an owner ID or raw transcript.
  judge?:(input:ProofJudgeInput[],signal:AbortSignal)=>Promise<ProofJudgment[]|undefined>;
};

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const hex64=/^[a-f0-9]{64}$/;
const commit=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const repository=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ref=/^[A-Za-z0-9:_-]{1,200}$/;
const ageLimit=30*60_000;
function category(text:string):ProofJudgeInput['category'] {
  if(/\b(screenshot|visual|layout|screen|ui)\b/i.test(text))return 'visual';
  if(/\b(test|tests|testing|suite)\b/i.test(text))return 'test';
  if(/\b(repo|repository|pull request|pr|commit|diff)\b/i.test(text))return 'repository';
  return 'other';
}

function validate(scope:ProofScope,checks:ProofCheck[]) {
  if(!/^[A-Za-z0-9-]{1,100}$/.test(scope.contractId)||!Number.isSafeInteger(scope.revision)||scope.revision<1||
     !hex64.test(scope.approvedHash)||!hex64.test(scope.bindingHash)||!scope.owner||!scope.destination||
     !scope.rootRequestId||!scope.bindingId||!scope.attemptId||!Number.isSafeInteger(scope.itemId)||scope.itemId<1||
     !Number.isSafeInteger(scope.startedAt)||!Number.isSafeInteger(scope.approvedAt)||scope.startedAt<scope.approvedAt||
     [scope.owner,scope.destination,scope.rootRequestId,scope.bindingId,scope.attemptId].some(s=>s.length>1000||/[\x00-\x1f]/.test(s))||
     scope.targetRepository!==null&&(!repository.test(scope.targetRepository)||scope.targetRepository.split('/').some(s=>s==='.'||s==='..'))||
     scope.targetRevision!==null&&!commit.test(scope.targetRevision))throw new Error('Invalid proof scope.');
  if(!Array.isArray(checks)||checks.length<1||checks.length>3||new Set(checks.map(c=>c.id)).size!==checks.length||
     checks.some((c,i)=>c.id!==`${scope.contractId}:${scope.revision}:${i+1}`||typeof c.text!=='string'||!c.text.trim()||c.text.length>1000||
       c.evidenceBindings!==undefined&&(!Array.isArray(c.evidenceBindings)||c.evidenceBindings.length>3||
         c.evidenceBindings.some(b=>!b||!['independent-test','github-check','consented-screen'].includes(b.source)||!hex64.test(b.bindingHash))||
         new Set(c.evidenceBindings.map(b=>`${b.source}:${b.bindingHash}`)).size!==c.evidenceBindings.length)))throw new Error('Invalid approved contract checks.');
}

/** A stable digest includes all owner, contract, session, attempt and revision fields. */
export function proofScopeHash(scope:ProofScope,checks:ProofCheck[]) {
  validate(scope,checks);
  return digest(JSON.stringify([scope.contractId,scope.revision,scope.approvedHash,scope.approvedAt,scope.owner,scope.destination,
    scope.rootRequestId,scope.itemId,scope.bindingId,scope.bindingHash,scope.attemptId,scope.startedAt,
    scope.targetRepository,scope.targetRevision,checks.map(c=>[c.id,c.text,(c.evidenceBindings??[]).map(b=>[b.source,b.bindingHash])])]));
}

export class ProofChecks {
  constructor(private store:Store,private clock:()=>number=Date.now){
    store.db.exec(`CREATE TABLE IF NOT EXISTS proof_evaluations(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,scope_hash TEXT NOT NULL,evaluation_id TEXT NOT NULL,
      reference_hash TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(scope_hash,evaluation_id));
      CREATE INDEX IF NOT EXISTS proof_evaluations_scope ON proof_evaluations(scope_hash,sequence);
      CREATE TABLE IF NOT EXISTS proof_runs(
      id TEXT PRIMARY KEY,scope_hash TEXT NOT NULL,evaluation_id TEXT NOT NULL,reference_hash TEXT NOT NULL,owner TEXT NOT NULL,destination TEXT NOT NULL,
      contract_id TEXT NOT NULL,revision INTEGER NOT NULL,results TEXT NOT NULL,created_at INTEGER NOT NULL,evaluation_sequence INTEGER NOT NULL REFERENCES proof_evaluations(sequence),
      UNIQUE(scope_hash,evaluation_id));
      CREATE TABLE IF NOT EXISTS proof_corrections(
      owner TEXT NOT NULL,destination TEXT NOT NULL,contract_id TEXT NOT NULL,revision INTEGER NOT NULL,
      proof_id TEXT NOT NULL,claimed_at INTEGER NOT NULL,PRIMARY KEY(owner,destination,contract_id,revision));
      CREATE TABLE IF NOT EXISTS proof_evidence_watermarks(
      scope_hash TEXT NOT NULL,check_id TEXT NOT NULL,source TEXT NOT NULL,binding_hash TEXT NOT NULL,
      observed_at INTEGER NOT NULL,verdict TEXT NOT NULL,digest TEXT NOT NULL,ambiguous INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(scope_hash,check_id,source,binding_hash));
      CREATE TABLE IF NOT EXISTS proof_run_evidence(
      run_id TEXT NOT NULL REFERENCES proof_runs(id),check_id TEXT NOT NULL,source TEXT NOT NULL,binding_hash TEXT NOT NULL,
      observed_at INTEGER NOT NULL,verdict TEXT NOT NULL,digest TEXT NOT NULL,
      PRIMARY KEY(run_id,check_id,source,binding_hash,observed_at,digest));`);
  }
  private visible(encoded:string):ProofResult[] {
    return (JSON.parse(encoded) as ProofResult[]).map(result=>result.verdict!=='unverified'&&(!result.expiresAt||result.expiresAt<=this.clock())
      ?{...result,verdict:'unverified',reason:'The independent evidence has expired. Check again.',evidenceDigests:[],expiresAt:null}
      :result);
  }
  private latest(scopeHash:string,sequence:number){
    const latest=this.store.db.prepare('SELECT sequence FROM proof_evaluations WHERE scope_hash=? ORDER BY sequence DESC LIMIT 1').get(scopeHash) as {sequence:number}|undefined;
    return latest?.sequence===sequence;
  }
  private recordObservation(scopeHash:string,observation:ProofObservation,current:ProofDependencies['current']) {
    this.store.db.exec('SAVEPOINT proof_observation');
    try {
      const actual=current();
      if(!actual||proofScopeHash(actual.scope,actual.checks)!==scopeHash)throw new Error('The approved task or session changed.');
      const prior=this.store.db.prepare(`SELECT observed_at,verdict,digest,ambiguous FROM proof_evidence_watermarks
        WHERE scope_hash=? AND check_id=? AND source=? AND binding_hash=?`).get(scopeHash,observation.checkId,observation.source,observation.bindingHash) as
        {observed_at:number;verdict:string;digest:string;ambiguous:number}|undefined;
      if(!prior)this.store.db.prepare('INSERT INTO proof_evidence_watermarks VALUES(?,?,?,?,?,?,?,0)').run(scopeHash,observation.checkId,observation.source,observation.bindingHash,observation.observedAt,observation.verdict,observation.digest);
      else if(observation.observedAt>prior.observed_at)this.store.db.prepare(`UPDATE proof_evidence_watermarks SET observed_at=?,verdict=?,digest=?,ambiguous=0
        WHERE scope_hash=? AND check_id=? AND source=? AND binding_hash=?`).run(observation.observedAt,observation.verdict,observation.digest,scopeHash,observation.checkId,observation.source,observation.bindingHash);
      else if(observation.observedAt===prior.observed_at&&(observation.verdict!==prior.verdict||observation.digest!==prior.digest))this.store.db.prepare(`UPDATE proof_evidence_watermarks SET ambiguous=1
        WHERE scope_hash=? AND check_id=? AND source=? AND binding_hash=?`).run(scopeHash,observation.checkId,observation.source,observation.bindingHash);
      this.store.db.exec('RELEASE proof_observation');
    }catch(e){this.store.db.exec('ROLLBACK TO proof_observation; RELEASE proof_observation');throw e;}
  }
  private evidenceCurrent(scopeHash:string,checkId:string,evidence:ProofObservation[]) {
    const marks=this.store.db.prepare(`SELECT source,binding_hash,observed_at,verdict,digest,ambiguous FROM proof_evidence_watermarks
      WHERE scope_hash=? AND check_id=?`).all(scopeHash,checkId) as {source:string;binding_hash:string;observed_at:number;verdict:string;digest:string;ambiguous:number}[];
    if(!marks.length||!evidence.length||marks.some(mark=>mark.ambiguous)||new Set(marks.map(mark=>mark.verdict)).size!==1)return false;
    const same=(mark:typeof marks[number],item:ProofObservation)=>mark.source===item.source&&mark.binding_hash===item.bindingHash&&mark.observed_at===item.observedAt&&mark.verdict===item.verdict&&mark.digest===item.digest;
    // Every previously observed source must be represented and no stale or
    // conflicting observation may be used. Source clocks are not compared.
    return marks.every(mark=>evidence.some(item=>same(mark,item)))&&evidence.every(item=>marks.some(mark=>same(mark,item)));
  }
  private visibleRun(runId:string,encoded:string,scopeHash:string,sequence:number):ProofResult[] {
    const latest=this.latest(scopeHash,sequence);
    return this.visible(encoded).map(result=>{
      if(result.verdict==='unverified')return result;
      if(!latest)return {...result,verdict:'unverified',reason:'A newer proof assessment has started.',evidenceDigests:[],expiresAt:null};
      const rows=this.store.db.prepare(`SELECT check_id,source,binding_hash,observed_at,verdict,digest FROM proof_run_evidence
        WHERE run_id=? AND check_id=?`).all(runId,result.checkId) as {check_id:string;source:ProofObservation['source'];binding_hash:string;observed_at:number;verdict:'pass'|'fail';digest:string}[];
      const evidence=rows.map(row=>({scopeHash,checkId:row.check_id,source:row.source,bindingHash:row.binding_hash,observedAt:row.observed_at,verdict:row.verdict,digest:row.digest}));
      if(!this.evidenceCurrent(scopeHash,result.checkId,evidence))return {...result,verdict:'unverified',reason:'Newer or conflicting independent evidence requires a new check.',evidenceDigests:[],expiresAt:null};
      return result;
    });
  }

  /**
   * References are opaque IDs. Sources must resolve them against independent,
   * run-bound evidence. A missing source, stale proof, self-report, mismatched
   * revision, or unverified target revision cannot establish pass OR fail.
   */
  async evaluate(scope:ProofScope,checks:ProofCheck[],references:Record<string,string[]>,evaluationId:string,deps:ProofDependencies):Promise<ProofRun> {
    // Caller-owned objects can otherwise change while evidence providers await.
    scope=Object.freeze({...scope});checks=checks.map(check=>Object.freeze({...check,evidenceBindings:check.evidenceBindings&&Object.freeze(check.evidenceBindings.map(binding=>Object.freeze({...binding})))}));
    const scopeHash=proofScopeHash(scope,checks),started=this.clock();
    if(!ref.test(evaluationId))throw new Error('Invalid proof evaluation ID.');
    if(scope.approvedAt>started||scope.startedAt>started)throw new Error('Proof timestamps are in the future.');
    const entries=Object.entries(references);
    if(entries.length>checks.length||entries.some(([key,ids])=>!checks.some(c=>c.id===key)||!Array.isArray(ids)||ids.length>10||ids.some(id=>typeof id!=='string'||!ref.test(id))))throw new Error('Invalid evidence references.');
    const frozenRefs=checks.map(check=>[check.id,[...new Set(references[check.id]??[])].sort()] as const);
    const referenceHash=digest(JSON.stringify(frozenRefs));
    let prior:any,sequence=0;
    this.store.db.exec('SAVEPOINT proof_existing');
    try {
      const current=deps.current();
      if(!current||proofScopeHash(current.scope,current.checks)!==scopeHash)throw new Error('The approved task or session changed.');
      const existing=this.store.db.prepare('SELECT * FROM proof_evaluations WHERE scope_hash=? AND evaluation_id=?').get(scopeHash,evaluationId) as {sequence:number;reference_hash:string;state:string}|undefined;
      if(existing){
        if(existing.reference_hash!==referenceHash)throw new Error('Proof evaluation ID was reused with different evidence.');
        if(existing.state!=='complete')throw new Error('Proof evaluation is still in progress. Use a new evaluation ID after interruption.');
        prior=this.store.db.prepare('SELECT * FROM proof_runs WHERE scope_hash=? AND evaluation_id=?').get(scopeHash,evaluationId);
        if(!prior)throw new Error('Proof evaluation is unavailable.');
        sequence=existing.sequence;
      } else {
        this.store.db.prepare('INSERT INTO proof_evaluations(scope_hash,evaluation_id,reference_hash,state) VALUES(?,?,?,?)').run(scopeHash,evaluationId,referenceHash,'started');
        sequence=Number((this.store.db.prepare('SELECT last_insert_rowid() AS id').get() as {id:number}).id);
      }
      this.store.db.exec('RELEASE proof_existing');
    }catch(e){this.store.db.exec('ROLLBACK TO proof_existing; RELEASE proof_existing');throw e;}
    if(prior)return {id:prior.id,scope,checks:this.visibleRun(prior.id,prior.results,scopeHash,sequence),createdAt:prior.created_at};
    const collected:ProofObservation[][]=[];
    const deadline=AbortSignal.timeout(30_000);
    for(const [index,check] of checks.entries()){
      const ids=frozenRefs[index][1];
      const valid:ProofObservation[]=[];
      if(deps.observe&&check.evidenceBindings?.length&&scope.targetRepository&&scope.targetRevision){
        for(const id of ids){
          if(deadline.aborted)break;
          const signal=AbortSignal.any([deadline,AbortSignal.timeout(2000)]);
          if(signal.aborted)break;
          const observation=await Promise.race([
            Promise.resolve().then(()=>deps.observe!(id,check,scope,signal)).catch(()=>undefined),
            new Promise<undefined>(done=>signal.addEventListener('abort',()=>done(undefined),{once:true})),
          ]);
          if(observation&&observation.scopeHash===scopeHash&&observation.checkId===check.id&&
             ['independent-test','github-check','consented-screen'].includes(observation.source)&&
             !!check.evidenceBindings?.some(binding=>binding.source===observation.source&&binding.bindingHash===observation.bindingHash)&&
             ['pass','fail'].includes(observation.verdict)&&hex64.test(observation.digest)&&
             Number.isSafeInteger(observation.observedAt)&&observation.observedAt>=scope.startedAt&&
             observation.observedAt<=this.clock()&&this.clock()-observation.observedAt<=ageLimit){
            const verified={...observation};this.recordObservation(scopeHash,verified,deps.current);valid.push(verified);
          }
        }
      }
      collected.push(valid);
    }
    // Wonder sees no check text, paths, personal identifiers, transcripts or
    // model-supplied claims. It cannot manufacture pass/fail without verified
    // evidence; a positive observation needs model agreement for a pass.
    const conflicts=collected.map(observations=>observations.some(x=>observations.some(y=>x.source===y.source&&x.bindingHash===y.bindingHash&&x.verdict!==y.verdict)));
    const input:ProofJudgeInput[]=checks.map((check,index)=>({index:index+1,category:category(check.text),signals:conflicts[index]?[]:collected[index].map(({source,verdict})=>({source,verdict}))}));
    let judgments:ProofJudgment[]|undefined;
    if(deps.judge&&collected.some(v=>v.length)&&!deadline.aborted){
      const signal=AbortSignal.any([deadline,AbortSignal.timeout(20_000)]);
      if(!signal.aborted)judgments=await Promise.race([
        Promise.resolve().then(()=>deps.judge!(input,signal)).catch(()=>undefined),
        new Promise<undefined>(done=>signal.addEventListener('abort',()=>done(undefined),{once:true})),
      ]);
    }
    const validJudgments=Array.isArray(judgments)&&judgments.length===checks.length&&new Set(judgments.map(j=>j?.index)).size===checks.length&&judgments.every(j=>Number.isSafeInteger(j?.index)&&j.index>=1&&j.index<=checks.length&&['pass','fail','unverified'].includes(j.verdict))?judgments:undefined;
    const results:ProofResult[]=checks.map((check,index)=>{
      const valid=collected[index],judgment=validJudgments?.find(j=>j.index===index+1);
      const verdict=conflicts[index]?'unverified':valid.some(x=>x.verdict==='fail')?'fail':valid.some(x=>x.verdict==='pass')&&judgment?.verdict==='pass'?'pass':'unverified';
      return {checkId:check.id,verdict,reason:conflicts[index]?'Conflicting independent evidence requires a new check.':verdict==='unverified'?'Independent evidence or a matching Wonder assessment is unavailable.':
        verdict==='fail'?'Independent evidence reports this check failed.':'Independent evidence and the assessment report this check passed.',
        evidenceDigests:verdict==='unverified'?[]:[...new Set(valid.map(x=>x.digest))],expiresAt:verdict==='unverified'?null:Math.min(...valid.map(x=>x.observedAt+ageLimit))};
    });
    this.store.db.exec('SAVEPOINT proof_finalize');
    try {
      const after=deps.current();
      if(!after||proofScopeHash(after.scope,after.checks)!==scopeHash)throw new Error('The approved task or session changed.');
      if(!this.latest(scopeHash,sequence))throw new Error('Proof evaluation was superseded by a newer assessment.');
      // Immutable per evaluation; an explicit new ID allows a later recheck.
      const id=randomUUID(),createdAt=this.clock();
      const currentResults=results.map((result,index)=>result.verdict!=='unverified'&&!this.evidenceCurrent(scopeHash,result.checkId,collected[index])
        ?{...result,verdict:'unverified',reason:'Newer or conflicting independent evidence requires a new check.',evidenceDigests:[],expiresAt:null}:result);
      this.store.db.prepare('INSERT OR IGNORE INTO proof_runs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,scopeHash,evaluationId,referenceHash,scope.owner,scope.destination,scope.contractId,scope.revision,JSON.stringify(currentResults),createdAt,sequence);
      for(const observations of collected)for(const observation of observations)this.store.db.prepare('INSERT OR IGNORE INTO proof_run_evidence VALUES(?,?,?,?,?,?,?)').run(id,observation.checkId,observation.source,observation.bindingHash,observation.observedAt,observation.verdict,observation.digest);
      this.store.db.prepare("UPDATE proof_evaluations SET state='complete' WHERE sequence=? AND state='started'").run(sequence);
      const saved=this.store.db.prepare('SELECT id,reference_hash,results,created_at,evaluation_sequence FROM proof_runs WHERE scope_hash=? AND evaluation_id=?').get(scopeHash,evaluationId) as any;
      if(saved.reference_hash!==referenceHash)throw new Error('Proof evaluation ID was reused with different evidence.');
      const visible=this.visibleRun(saved.id,saved.results,scopeHash,saved.evaluation_sequence);
      this.store.db.exec('RELEASE proof_finalize');
      return {id:saved.id,scope,checks:visible,createdAt:saved.created_at};
    }catch(e){this.store.db.exec('ROLLBACK TO proof_finalize; RELEASE proof_finalize');throw e;}
  }

  /** The current provider must verify the live owner and frozen scope on this DB connection. */
  get(id:string,scope:ProofScope,checks:ProofCheck[],current:ProofDependencies['current']) {
    const scopeHash=proofScopeHash(scope,checks);
    this.store.db.exec('SAVEPOINT proof_read');
    try {
      const actual=current();
      const row=actual&&proofScopeHash(actual.scope,actual.checks)===scopeHash
        ?this.store.db.prepare('SELECT id,results,created_at,evaluation_sequence FROM proof_runs WHERE id=? AND scope_hash=? AND owner=? AND destination=?').get(id,scopeHash,scope.owner,scope.destination) as any:undefined;
      const result=row?{id:row.id,checks:this.visibleRun(row.id,row.results,scopeHash,row.evaluation_sequence),createdAt:row.created_at}:undefined;
      this.store.db.exec('RELEASE proof_read');
      return result;
    }catch(e){this.store.db.exec('ROLLBACK TO proof_read; RELEASE proof_read');throw e;}
  }

  /** Persist the one-correction claim before dispatch; never auto-replay it. */
  claimCorrection(runId:string,scope:ProofScope,checks:ProofCheck[],current:ProofDependencies['current']):boolean {
    scope=Object.freeze({...scope});checks=checks.map(check=>Object.freeze({...check,evidenceBindings:check.evidenceBindings&&Object.freeze(check.evidenceBindings.map(binding=>Object.freeze({...binding})))}));
    const scopeHash=proofScopeHash(scope,checks);
    this.store.db.exec('SAVEPOINT proof_correction');
    try {
      const actual=current();
      if(!actual||proofScopeHash(actual.scope,actual.checks)!==scopeHash){this.store.db.exec('RELEASE proof_correction');return false;}
      // Do not act on an earlier failure after a newer evaluation has passed.
      const row=this.store.db.prepare('SELECT results,evaluation_sequence FROM proof_runs WHERE id=? AND scope_hash=? AND owner=? AND destination=?').get(runId,scopeHash,scope.owner,scope.destination) as {results:string;evaluation_sequence:number}|undefined;
      const changed=!!row&&this.visibleRun(runId,row.results,scopeHash,row.evaluation_sequence).some(r=>r.verdict==='fail')&&!!this.store.db.prepare('INSERT OR IGNORE INTO proof_corrections VALUES(?,?,?,?,?,?)').run(scope.owner,scope.destination,scope.contractId,scope.revision,runId,this.clock()).changes;
      this.store.db.exec('RELEASE proof_correction');return changed;
    }catch(e){this.store.db.exec('ROLLBACK TO proof_correction; RELEASE proof_correction');throw e;}
  }
}
