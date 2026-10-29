import {createHash} from 'node:crypto';
import {proofScopeHash,type ProofCheck,type ProofObservation,type ProofScope} from './proof-check.js';

/** A binding names a public repository and one exact GitHub Actions check.
 * It is usable only when the owner has approved the matching binding hash for
 * the exact contract check. It is not derived from session-supplied PR text. */
export type GitHubCheckBinding={repository:string;name:string};
type RunAuthorization=Readonly<{scopeHash:string;checkId:string;bindingHash:string;checkRunId:number;targetRevision:string}>;
const repository=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const checkName=/^[A-Za-z0-9][A-Za-z0-9 _./()\[\]-]{0,99}$/;
const revision=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const maxResponse=512*1024;

export function githubCheckBindingHash(binding:GitHubCheckBinding):string {
  if(!binding||!repository.test(binding.repository)||binding.repository.split('/').some(part=>part==='.'||part==='..')||
     typeof binding.name!=='string'||!checkName.test(binding.name)||binding.name!==binding.name.trim())throw new Error('Invalid GitHub check binding.');
  return digest(JSON.stringify(['github-check-v1',binding.repository.toLowerCase(),binding.name]));
}

/**
 * Read one public GitHub check run for an explicitly approved stable criterion,
 * never arbitrary URLs or credentials. A trusted bridge-owned callback must
 * independently link the unique run ID to this exact owner/task/attempt; the
 * ID alone, a session report, or a matching commit is insufficient. There is
 * currently no production provenance adapter, so this remains unwired.
 * A missing, in-progress, ambiguous, private or malformed check is unverified.
 */
export async function observeGitHubCheck(scope:ProofScope,checks:ProofCheck[],checkId:string,binding:GitHubCheckBinding,
  reference:string,signal:AbortSignal,options:{authorizeRun:(authorization:RunAuthorization)=>boolean;fetcher?:typeof fetch;now?:()=>number}):Promise<ProofObservation|undefined> {
  try {
    scope=Object.freeze({...scope});binding=Object.freeze({...binding});
    checks=checks.map(check=>Object.freeze({...check,evidenceBindings:check.evidenceBindings&&Object.freeze(check.evidenceBindings.map(item=>Object.freeze({...item})))}));
    const scopeHash=proofScopeHash(scope,checks),bindingHash=githubCheckBindingHash(binding),check=checks.find(item=>item.id===checkId),now=options.now??Date.now;
    const id=/^check-run:([1-9]\d{0,15})$/.exec(reference),checkRunId=id?Number(id[1]):0;
    if(signal.aborted||!Number.isSafeInteger(checkRunId)||checkRunId<1||!check||!scope.targetRepository||!scope.targetRevision||!revision.test(scope.targetRevision)||
       scope.targetRepository.toLowerCase()!==binding.repository.toLowerCase()||
       check.text!==`GitHub check ${binding.name} passed`||
       !check.evidenceBindings?.some(item=>item.source==='github-check'&&item.bindingHash===bindingHash))return;
    const authorization:RunAuthorization=Object.freeze({scopeHash,checkId,bindingHash,checkRunId,targetRevision:scope.targetRevision});
    const allowed=()=>!signal.aborted&&options.authorizeRun(authorization)===true;
    if(!allowed())return;
    const [owner,repo]=binding.repository.split('/');
    const url=new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${checkRunId}`);
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(5000)]);
    const stopped=new Promise<undefined>(done=>{if(deadline.aborted)done(undefined);else deadline.addEventListener('abort',()=>done(undefined),{once:true});});
    if(!allowed())return;
    const response=await Promise.race([(options.fetcher??fetch)(url,{headers:{accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'},redirect:'error',signal:deadline}).catch(()=>undefined),stopped]);
    if(!response||deadline.aborted||!allowed()||!response.ok)return;
    const reader=response.body?.getReader();if(!reader)return;
    const cancel=()=>{try{void reader.cancel().catch(()=>{});}catch{}};
    deadline.addEventListener('abort',cancel,{once:true});
    let data:unknown;
    try {
      let size=0;const chunks:Uint8Array[]=[];
      for(;;){const chunk=await Promise.race([reader.read().catch(()=>undefined),stopped]);if(!chunk||deadline.aborted)return;if(chunk.done)break;size+=chunk.value.length;if(size>maxResponse){cancel();return;}chunks.push(chunk.value);}
      data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }finally{deadline.removeEventListener('abort',cancel);}
    if(deadline.aborted||!allowed()||!data||typeof data!=='object')return;
    const run=data as {id?:unknown;name?:unknown;head_sha?:unknown;status?:unknown;conclusion?:unknown;completed_at?:unknown};
    if(run.id!==checkRunId||run.name!==binding.name||run.head_sha!==scope.targetRevision||run.status!=='completed'||typeof run.completed_at!=='string')return;
    const at=Date.parse(run.completed_at);if(!Number.isSafeInteger(at)||at<scope.startedAt||at>now())return;
    if(run.conclusion!=='success'&&run.conclusion!=='failure')return;
    const verdict=run.conclusion==='success'?'pass':'fail';
    return {scopeHash,checkId,source:'github-check',bindingHash,verdict,observedAt:at,
      digest:digest(JSON.stringify(['github-check-v1',scopeHash,checkId,bindingHash,scope.targetRevision,run.id,at,verdict]))};
  } catch {return;}
}
