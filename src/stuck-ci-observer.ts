import {createHash} from 'node:crypto';

/**
 * Unwired experimental adapter. The bridge does not currently provide an
 * owner-approved PR/run binding or a production transport for this function.
 * Never derive either from a session reply, model output or arbitrary URL.
 */
export type ApprovedCiRun={owner:string;destination:string;ownerGeneration:string;rootRequestId:string;itemId:number;
  repository:string;prNumber:number;headSha:string;checkRunId:number;checkName:string};
export type ApprovedCiWatch=Omit<ApprovedCiRun,'headSha'|'checkRunId'|'checkName'>;
export type CiFailure={kind:'approved-ci-run-failure-observed';repository:string;prNumber:number;headSha:string;checkRunId:number;checkName:string;completedAt:number;observedAt:number;incident:string};
type TrustedAuthority=(binding:Readonly<ApprovedCiRun>)=>boolean;
type TrustedFetch=typeof fetch;

const repo=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const sha=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const checkName=/^[A-Za-z0-9][A-Za-z0-9 _./()\[\]-]{0,99}$/;
const maxBytes=512*1024,maximumAge=24*60*60_000;

/** Only an explicit public GitHub pull request URL is accepted, without query, fragments or credentials. */
export function parseCiPullRequest(value:string):{repository:string;prNumber:number}|undefined {
  const match=/^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,8})\/?$/.exec(value);
  if(!match||[match[1],match[2]].some(v=>v==='.'||v==='..'))return;
  return {repository:`${match[1]}/${match[2]}`,prNumber:Number(match[3])};
}

/** Fetch only the fixed GitHub API origin. No credentials, redirects or URL supplied by an agent. */
async function readJson(url:URL,signal:AbortSignal,fetcher:TrustedFetch,current:()=>boolean):Promise<any|undefined>{
  if(signal.aborted||!current())return;
  let stop!:()=>void;
  const cancelled=new Promise<undefined>(resolve=>{stop=()=>resolve(undefined);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});
  try{
    const response=await Promise.race([fetcher(url,{method:'GET',headers:{accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'},redirect:'error',signal}).catch(()=>undefined),cancelled]);
    if(response?.status!==200||signal.aborted||!current()||!response.body||!/^application\/json\b/i.test(response.headers.get('content-type')??''))return;
    const reader=response.body.getReader();let total=0;const chunks:Uint8Array[]=[];
    try{
      for(;;){
        const part=await Promise.race([reader.read().catch(()=>undefined),cancelled]);
        if(!part||signal.aborted||!current()){void reader.cancel().catch(()=>{});return;}
        if(part.done)break;total+=part.value.length;if(total>maxBytes){void reader.cancel().catch(()=>{});return;}chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }finally{reader.releaseLock();}
  }catch{return;}finally{signal.removeEventListener('abort',stop);}
}

/** Discover at most one failure on the current head of the explicitly watched public PR. */
export async function discoverApprovedCiFailure(watch:ApprovedCiWatch,signal:AbortSignal,
  authority:(watch:Readonly<ApprovedCiWatch>)=>boolean,fetcher:TrustedFetch,now=()=>Date.now(),
  alreadyReported?:(headSha:string,checkRunId:number,checkName:string,completedAt:number)=>boolean,afterRunId=0,
  selected?:(checkRunId:number)=>void):Promise<{binding:ApprovedCiRun;failure:CiFailure}|undefined>{
  try{
    const w=Object.freeze({...watch}),current=()=>!signal.aborted&&authority(w)===true;
    if(!w.owner||!w.destination||!w.ownerGeneration||!w.rootRequestId||!Number.isSafeInteger(w.itemId)||w.itemId<1||
      !repo.test(w.repository)||w.repository.split('/').some(s=>s==='.'||s==='..')||!Number.isSafeInteger(w.prNumber)||w.prNumber<1||!current())return;
    const [owner,name]=w.repository.split('/'),prefix=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(5000)]);
    const pr=await readJson(new URL(`${prefix}/pulls/${w.prNumber}`),bounded,fetcher,current);
    if(bounded.aborted||!current()||!pr||pr.number!==w.prNumber||pr.state!=='open'||pr.merged_at!==null||
      pr.base?.repo?.private!==false||typeof pr.base?.repo?.full_name!=='string'||pr.base.repo.full_name.toLowerCase()!==w.repository.toLowerCase()||
      typeof pr.head?.sha!=='string'||!sha.test(pr.head.sha))return;
    const headSha=pr.head.sha;
    const list=await readJson(new URL(`${prefix}/commits/${headSha}/check-runs?per_page=100`),bounded,fetcher,current);
    if(bounded.aborted||!current()||!Array.isArray(list?.check_runs)||list.check_runs.length>100)return;
    const instant=now();if(!Number.isSafeInteger(instant))return;
    const candidates=list.check_runs.filter((r:any)=>{
      if(!Number.isSafeInteger(r?.id)||r.id<1||typeof r.name!=='string'||!checkName.test(r.name)||r.name!==r.name.trim()||r.head_sha!==headSha||r.status!=='completed'||r.conclusion!=='failure'||typeof r.completed_at!=='string')return false;
      const at=Date.parse(r.completed_at);return Number.isSafeInteger(at)&&at<=instant&&instant-at<=maximumAge&&!alreadyReported?.(headSha,r.id,r.name,at);
    });
    if(!candidates.length)return;
    const prior=candidates.findIndex((r:any)=>r.id===afterRunId),candidate=candidates[(prior+1)%candidates.length];
    if(!current())return;selected?.(candidate.id);if(!current())return;
    const binding:ApprovedCiRun={...w,headSha,checkRunId:candidate.id,checkName:candidate.name};
    const failure=await observeApprovedCiFailure(binding,bounded,b=>current()&&authority(w)&&b.headSha===headSha&&b.checkRunId===candidate.id&&b.checkName===candidate.name,fetcher,now);
    if(!failure||!current())return;
    return {binding,failure};
  }catch{return;}
}

/**
 * The synchronous authority must read a separately owner-approved exact
 * tuple and durable owner generation from the bridge's database. Both the
 * authority and the transport are bridge-owned trust boundaries, never
 * session/client callbacks. There is intentionally no default authority or
 * fetch implementation and no production caller. Results are timestamped
 * historical observations of one check run, not the PR's current aggregate CI
 * or merge readiness. Any later delivery must independently revalidate them.
 */
export async function observeApprovedCiFailure(input:ApprovedCiRun,signal:AbortSignal,
  authority:TrustedAuthority,fetcher:TrustedFetch,now=()=>Date.now()):Promise<CiFailure|undefined>{
  try{
    const binding=Object.freeze({...input});
    if(!binding.owner||!binding.destination||!binding.ownerGeneration||!binding.rootRequestId||
      [binding.owner,binding.destination,binding.ownerGeneration,binding.rootRequestId].some(v=>typeof v!=='string'||v.length>1000||/[\x00-\x1f\x7f]/.test(v))||
      !Number.isSafeInteger(binding.itemId)||binding.itemId<1||!repo.test(binding.repository)||
      binding.repository.split('/').some(s=>s==='.'||s==='..')||!Number.isSafeInteger(binding.prNumber)||binding.prNumber<1||
      !sha.test(binding.headSha)||!Number.isSafeInteger(binding.checkRunId)||binding.checkRunId<1||
      !checkName.test(binding.checkName)||binding.checkName!==binding.checkName.trim())return;
    const current=()=>!signal.aborted&&authority(binding)===true;
    if(!current())return;
    const [owner,name]=binding.repository.split('/'),prefix=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(5000)]);
    const prUrl=new URL(`${prefix}/pulls/${binding.prNumber}`);
    const matchesPr=(pr:any)=>!!pr&&pr.number===binding.prNumber&&pr.state==='open'&&pr.merged_at===null&&
      pr.base?.repo?.private===false&&typeof pr.base?.repo?.full_name==='string'&&pr.base.repo.full_name.toLowerCase()===binding.repository.toLowerCase()&&pr.head?.sha===binding.headSha;
    const pr=await readJson(prUrl,bounded,fetcher,current);
    if(bounded.aborted||!current()||!matchesPr(pr))return;
    const runUrl=new URL(`${prefix}/check-runs/${binding.checkRunId}`);
    const matchesRun=(run:any)=>!!run&&run.id===binding.checkRunId&&run.name===binding.checkName&&
      run.head_sha===binding.headSha&&run.status==='completed'&&run.conclusion==='failure'&&typeof run.completed_at==='string';
    const run=await readJson(runUrl,bounded,fetcher,current);
    if(bounded.aborted||!current()||!matchesRun(run))return;
    const completedAt=Date.parse(run.completed_at),time=now();
    if(!Number.isSafeInteger(time)||!Number.isSafeInteger(completedAt)||completedAt>time||time-completedAt>maximumAge)return;
    // Re-read both sources: the head or the same run may change mid-observation.
    if(!matchesPr(await readJson(prUrl,bounded,fetcher,current))||bounded.aborted||!current())return;
    const confirmedRun=await readJson(runUrl,bounded,fetcher,current);
    if(bounded.aborted||!current()||!matchesRun(confirmedRun)||Date.parse(confirmedRun.completed_at)!==completedAt)return;
    if(!matchesPr(await readJson(prUrl,bounded,fetcher,current))||bounded.aborted||!current())return;
    const observedAt=now();
    if(!Number.isSafeInteger(observedAt)||observedAt<completedAt||observedAt-completedAt>maximumAge)return;
    const incident=createHash('sha256').update(JSON.stringify(['approved-ci-run-failed-v1',binding.repository.toLowerCase(),binding.prNumber,binding.headSha,binding.checkRunId,binding.checkName,completedAt])).digest('hex');
    return {kind:'approved-ci-run-failure-observed',repository:binding.repository,prNumber:binding.prNumber,headSha:binding.headSha,checkRunId:binding.checkRunId,checkName:binding.checkName,completedAt,observedAt,incident};
  }catch{return;}
}
