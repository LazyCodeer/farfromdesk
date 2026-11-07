import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';

const QUERY='query{search(query:"is:pr is:open author:@me",type:ISSUE,first:20){nodes{...on PullRequest{number title url repository{nameWithOwner} reviewDecision isDraft commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:30){nodes{...on CheckRun{name conclusion} ...on StatusContext{context state}}}}}}}}}}}';
// A GUI app's PATH often lacks Homebrew, so look in the usual places too.
const gh=()=>['/opt/homebrew/bin/gh','/usr/local/bin/gh','/usr/bin/gh'].find(existsSync)??'gh';

type Node={number:number;title:string;url:string;repository:{nameWithOwner:string};reviewDecision:string|null;isDraft:boolean;commits:{nodes:{commit:{statusCheckRollup:{state:string;contexts?:{nodes:{name?:string;conclusion?:string|null;context?:string;state?:string}[]}}|null}}[]}};
export function formatPrs(nodes:Node[]):string{
  if(!nodes.length)return 'No open pull requests by the owner.';
  const checks:Record<string,string>={SUCCESS:'green',FAILURE:'failing',ERROR:'failing',PENDING:'running',EXPECTED:'running'};
  const review:Record<string,string>={APPROVED:'approved',CHANGES_REQUESTED:'changes requested',REVIEW_REQUIRED:'needs review'};
  return nodes.map(n=>{const r=n.commits.nodes[0]?.commit.statusCheckRollup,s=r?.state;
    // Owners asked "which check failed, and the link?" and the brain had neither (sim, 7 Nov 2026).
    const failed=(r?.contexts?.nodes??[]).filter(c=>/^(?:FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED)$/.test(c.conclusion??c.state??'')).map(c=>c.name??c.context).filter(Boolean);
    return `${n.repository.nameWithOwner.split('/').pop()} PR ${n.number}, ${n.title}: checks ${s?checks[s]??s.toLowerCase():'none'}${failed.length?` (${failed.join(', ')})`:''}, ${n.isDraft?'draft':review[n.reviewDecision??'']??'no review needed'}${n.url?` ${n.url}`:''}`;}).join('\n');
}
/** The owner's open PRs with checks and review state, read with their own gh login. Read-only. */
export function openPrStatus():Promise<string>{
  return new Promise(resolve=>execFile(gh(),['api','graphql','-f',`query=${QUERY}`],{timeout:20000},(e,out)=>{
    if(e)return resolve('GitHub could not be read: the gh command is missing or not logged in on this laptop.');
    try{resolve(formatPrs(JSON.parse(out).data.search.nodes.filter((n:Node)=>n?.number)));}catch{resolve('GitHub returned something unreadable.');}
  }));
}
