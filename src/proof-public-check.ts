/**
 * An owner-requested, public GitHub observation. This is not task proof: it
 * neither links a run or commit to a session attempt nor authorizes a fix.
 */
export type PublicCheckRequest={repository:string;runId:number;revision:string;name:string};
const repository=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const revision=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const name=/^[A-Za-z0-9][A-Za-z0-9 _./()\[\]-]{0,99}$/;
const maxBytes=512*1024;
const usage='Use /checkrun OWNER/REPO RUN_ID COMMIT_SHA CHECK_NAME. This checks one public GitHub run; it does not verify a task.';
class ObservationError extends Error {}

export function parsePublicCheck(args:string):PublicCheckRequest {
  const match=/^(\S+)\s+([1-9][0-9]{0,15})\s+([a-f0-9]{40}|[a-f0-9]{64})\s+(.+)$/.exec(args.trim());
  if(!match||!repository.test(match[1])||match[1].split('/').some(s=>s==='.'||s==='..')||!revision.test(match[3])||
    !Number.isSafeInteger(Number(match[2]))||!name.test(match[4])||match[4]!==match[4].trim())throw new Error(usage);
  return {repository:match[1],runId:Number(match[2]),revision:match[3],name:match[4]};
}

/** `current` must recheck the captured owner and channel at every await. */
export async function publicCheckObservation(input:PublicCheckRequest,current:()=>boolean,fetcher:typeof fetch=fetch,now=()=>Date.now()):Promise<string> {
  const request=Object.freeze({...input});
  // Revalidate constructed objects too; only the owner's exact parsed values may reach the network.
  parsePublicCheck(`${request.repository} ${request.runId} ${request.revision} ${request.name}`);
  if(!current())throw new ObservationError('The owner connection changed.');
  const [owner,repo]=request.repository.split('/');
  const url=new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${request.runId}`);
  const signal=AbortSignal.timeout(5000);
  let stop!:()=>void;
  const timeout=new Promise<undefined>(resolve=>{stop=()=>resolve(undefined);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});
  try {
    const response=await Promise.race([Promise.resolve().then(()=>fetcher(url,{method:'GET',headers:{accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'},redirect:'error',signal})).catch(()=>undefined),timeout]);
    if(!current())throw new ObservationError('The owner connection changed.');
    if(!response||signal.aborted||response.status!==200||!response.body||!/^application\/json\b/i.test(response.headers.get('content-type')??''))throw new ObservationError('The public GitHub check could not be verified.');
    const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
    try {
      for(;;){
        const part=await Promise.race([reader.read().catch(()=>undefined),timeout]);
        if(!current())throw new ObservationError('The owner connection changed.');
        if(!part||signal.aborted)throw new ObservationError('The public GitHub check could not be verified.');
        if(part.done)break;bytes+=part.value.length;if(bytes>maxBytes)throw new ObservationError('The public GitHub check could not be verified.');chunks.push(part.value);
      }
    }finally{try{void reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
    let run:any;try{run=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ObservationError('The public GitHub check could not be verified.');}
    if(!current())throw new ObservationError('The owner connection changed.');
    if(!run||run.id!==request.runId||run.name!==request.name||run.head_sha!==request.revision)throw new ObservationError('The public GitHub check did not match the requested run, commit and name.');
    const statuses:Record<string,string>={queued:'queued',in_progress:'in progress',waiting:'waiting',pending:'pending',requested:'requested',completed:'completed'};
    const conclusions:Record<string,string>={success:'success',failure:'failure',neutral:'neutral',cancelled:'cancelled',timed_out:'timed out',action_required:'action required',skipped:'skipped',stale:'stale',startup_failure:'startup failure'};
    if(!Object.hasOwn(statuses,run.status))throw new ObservationError('The public GitHub check has an unrecognized status.');
    let description=statuses[run.status];
    const observedAt=now();if(!Number.isSafeInteger(observedAt))throw new ObservationError('The observation time is unavailable.');
    if(run.status==='completed'){
      if(!Object.hasOwn(conclusions,run.conclusion)||typeof run.completed_at!=='string')throw new ObservationError('The public GitHub check has an unrecognized conclusion.');
      const completedAt=Date.parse(run.completed_at);if(!Number.isSafeInteger(completedAt)||completedAt>observedAt)throw new ObservationError('The public GitHub check has an invalid completion time.');
      description+=` with conclusion ${conclusions[run.conclusion]} at ${new Date(completedAt).toISOString()}`;
    }else if(run.conclusion!=null)throw new ObservationError('The public GitHub check has an inconsistent status.');
    return [`Public GitHub observation, checked ${new Date(observedAt).toISOString()}`,
      `${request.repository} · run ${request.runId} · ${request.name}`,
      `Commit: ${request.revision}`,
      `GitHub reported: ${description}.`,
      'This does not verify your task, its changes, or merge readiness.'].join('\n');
  } catch(e) {
    // Never expose a transport, stream, or other unexpected runtime error to chat.
    if(e instanceof ObservationError)throw e;
    throw new ObservationError('The public GitHub check could not be verified.');
  } finally {signal.removeEventListener('abort',stop);}
}
