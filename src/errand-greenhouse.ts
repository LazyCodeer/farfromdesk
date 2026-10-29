import {createHash} from 'node:crypto';
import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpsRequest,type RequestOptions} from 'node:https';
import {BlockList,isIP} from 'node:net';
import type {ErrandScope,Listing,VerifiedListingReader} from './errand-missions.js';
import {greenhousePageIdentity} from './errand-greenhouse-page.js';

// Internal, unwired source adapter. It only considers exact Greenhouse IDs
// supplied by a bridge-owned request-bound source. It does not perform search,
// open a browser, follow redirects, authenticate or submit anything.
const HOSTS=new Set(['boards-api.greenhouse.io','boards.greenhouse.io','job-boards.greenhouse.io']);
const MAX_BYTES=512*1024,MAX_IDS=10,TIMEOUT_MS=8000;
const BOARD=/^[a-z0-9][a-z0-9_-]{0,49}$/;
const CREDENTIAL=/^(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{12,}|akia[a-z0-9]{16})$/i;
function validPath(host:string,path:string) {
  const match=(host==='boards-api.greenhouse.io'?/^\/v1\/boards\/([^/]+)\/jobs(?:\/([1-9][0-9]{0,17}))?$/:/^\/([^/]+)\/jobs\/([1-9][0-9]{0,17})$/).exec(path);
  return HOSTS.has(host)&&!!match&&BOARD.test(match[1])&&!CREDENTIAL.test(match[1]);
}
const blocked=new BlockList();
for(const [network,prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],
  ['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],
  ['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
] as [string,number][])blocked.addSubnet(network,prefix,'ipv4');
export const publicGreenhouseAddress=(address:string)=>isIP(address)===4&&!blocked.check(address,'ipv4');

type Resolve=(hostname:string)=>Promise<string[]>;
type FetchPinned=(host:string,path:string,address:string,signal:AbortSignal)=>Promise<{status:number;body:string;contentType:string}>;
const resolve:Resolve=async host=>(await dnsLookup(host,{all:true,family:4,verbatim:true})).map(x=>x.address);

/** One HTTPS request to a fixed hostname and previously checked IPv4 address. */
export const requestPinned=(host:string,path:string,address:string,signal:AbortSignal,requestFn:typeof httpsRequest=httpsRequest):ReturnType<FetchPinned>=>new Promise((resolve,reject)=>{
  if(!validPath(host,path)||!publicGreenhouseAddress(address)){reject(new Error('Invalid pinned Greenhouse request.'));return;}
  let settled=false;const fail=(error:Error)=>{if(!settled){settled=true;reject(error);}};
  const options:RequestOptions={hostname:host,path,method:'GET',port:443,servername:host,family:4,agent:false,
    headers:{accept:'application/json, text/html','accept-encoding':'identity','user-agent':'FarFromDesk'},signal,
    // DNS is never repeated after validation. TLS still verifies the hostname.
    lookup:((_host:string,_options:unknown,callback:(error:NodeJS.ErrnoException|null,address:string,family:number)=>void)=>callback(null,address,4)) as RequestOptions['lookup']};
  const req=requestFn(options,res=>{
    const status=res.statusCode??0;
    if(status!==200){fail(new Error('Public listing could not be verified.'));req.destroy();return;}
    if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){fail(new Error('Compressed listing responses are unsupported.'));req.destroy();return;}
    const chunks:Buffer[]=[];let bytes=0;
    res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>MAX_BYTES){req.destroy(new Error('Listing response too large.'));return;}chunks.push(chunk);});
    res.on('error',fail);
    res.on('end',()=>{if(!settled){settled=true;resolve({status,body:Buffer.concat(chunks).toString('utf8'),contentType:String(res.headers['content-type']??'')});}});
  });
  req.on('error',fail);
  req.on('socket',socket=>socket.once('secureConnect',()=>{
    if(socket.remoteAddress!==address)req.destroy(new Error('Listing connection address changed.'));
  }));
  req.end();
});

type Transport={resolve:Resolve;request:FetchPinned};
const productionTransport:Transport={resolve,request:requestPinned};
/** The caller cannot supply a host, port, query, fragment, headers or redirect. */
export async function greenhouseGet(host:string,path:string,signal:AbortSignal,transport:Transport=productionTransport,current:()=>boolean=()=>false) {
  if(!validPath(host,path))throw new Error('Invalid Greenhouse request.');
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(TIMEOUT_MS)]);
  if(bounded.aborted||!current())throw new Error('Listing verification cancelled or owner request changed.');
  let abort:()=>void=()=>{};
  try {
    const interrupted=new Promise<never>((_,reject)=>{abort=()=>reject(new Error('Listing verification cancelled or timed out.'));bounded.addEventListener('abort',abort,{once:true});if(bounded.aborted)abort();});
    const addresses=await Promise.race([transport.resolve(host),interrupted]);
    if(bounded.aborted||!current())throw new Error('Listing verification cancelled or owner request changed.');
    if(!addresses.length||addresses.some(address=>!publicGreenhouseAddress(address)))throw new Error('Greenhouse DNS returned an unsafe address.');
    const response=await Promise.race([transport.request(host,path,addresses[0],bounded),interrupted]);
    if(bounded.aborted||!current())throw new Error('Listing verification cancelled or owner request changed.');
    if(response.status!==200||Buffer.byteLength(response.body)>MAX_BYTES)throw new Error('Public listing could not be verified.');
    return response;
  } finally {bounded.removeEventListener('abort',abort);}
}

type Input={jobs:{board:string;id:string}[]};
function parseInput(input:unknown):Input {
  if(!input||typeof input!=='object'||!Array.isArray((input as Input).jobs)||(input as Input).jobs.length>MAX_IDS)throw new Error('Provide bounded Greenhouse listing IDs.');
  const jobs=(input as Input).jobs;
  if(jobs.some(x=>!x||typeof x.board!=='string'||!BOARD.test(x.board)||CREDENTIAL.test(x.board)||typeof x.id!=='string'||! /^[1-9][0-9]{0,17}$/.test(x.id))||new Set(jobs.map(x=>`${x.board}/${x.id}`)).size!==jobs.length)throw new Error('Invalid Greenhouse listing IDs.');
  return {jobs};
}

// Date-only deadlines are treated conservatively as the start of that UTC
// day. An omitted or ambiguous timezone never extends the stated deadline.
function deadline(value:unknown,time:number):number {
  if(typeof value!=='string')throw new Error('The published listing has no verifiable deadline.');
  const m=/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if(!m)throw new Error('The published listing has no verifiable deadline.');
  const [year,month,day]=[Number(m[1]),Number(m[2]),Number(m[3])];
  const date=new Date(Date.UTC(year,month-1,day));
  if(year<2000||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||
    (m[4]!==undefined&&(Number(m[4])>23||Number(m[5])>59||Number(m[6])>59||
      (m[7]!=='Z'&&(Number(m[7].slice(1,3))>23||Number(m[7].slice(4,6))>59)))))throw new Error('The published listing has no verifiable deadline.');
  const valueMs=m[4]===undefined?date.getTime():Date.parse(value);
  if(!Number.isSafeInteger(valueMs)||valueMs<=time)throw new Error('The published listing deadline is unavailable or has passed.');
  return valueMs;
}
function explicitlyClosed(html:string) {
  const text=html.replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&#(?:x([a-f0-9]{1,6})|([0-9]{1,7}));/gi,(_s,hex:string|undefined,dec:string|undefined)=>{
    const code=hex?parseInt(hex,16):Number(dec);return code>0&&code<=0x10ffff&&(code<0xd800||code>0xdfff)?String.fromCodePoint(code):' ';
  }).replace(/\s+/g,' ');
  return /\b(?:no longer|not (?:currently )?)\s+accepting\s+(?:job\s+)?applications\b|\b(?:job posting|job|position|role|opening|posting|vacancy|applications?)\s+(?:(?:is|are|has been|have been|was|were|now|currently)\s+){0,3}(?:closed|filled|expired|removed|no longer available)\b/i.test(text);
}

/**
 * Independently GET each exact job from Greenhouse and its returned public
 * listing page. `current` must be bridge-owned; models cannot assert scope.
 * The transport injection is for offline tests and must never be session-owned.
 */
export function greenhouseListingReader(current:(scope:ErrandScope)=>boolean,now=()=>Date.now(),transport?:Transport):VerifiedListingReader {
  return async(scope,request,signal)=>{
    const {jobs}=parseInput(request);const result:Listing[]=[];
    for(const job of jobs){
      if(signal.aborted||!current(scope))throw new Error('The owner request changed.');
      const apiPath=`/v1/boards/${job.board}/jobs/${job.id}`;
      const api=await greenhouseGet('boards-api.greenhouse.io',apiPath,signal,transport,()=>current(scope));
      if(signal.aborted||!current(scope))throw new Error('The owner request changed.');
      if(!/^application\/json\b/i.test(api.contentType))throw new Error('Unexpected Greenhouse response.');
      let data:any;try{data=JSON.parse(api.body);}catch{throw new Error('Unexpected Greenhouse response.');}
      if(String(data?.id)!==job.id||typeof data.title!=='string'||!data.title.trim()||data.title.length>160||typeof data.absolute_url!=='string')throw new Error('The public listing did not match the request.');
      const applicationDeadline=deadline(data.application_deadline,now());
      let link:URL;try{link=new URL(data.absolute_url);}catch{throw new Error('Invalid Greenhouse listing link.');}
      if(link.protocol!=='https:'||link.username||link.password||link.port||link.search||link.hash||!['boards.greenhouse.io','job-boards.greenhouse.io'].includes(link.hostname)||link.pathname!==`/${job.board}/jobs/${job.id}`)throw new Error('Unsupported Greenhouse listing link.');
      const page=await greenhouseGet(link.hostname,link.pathname,signal,transport,()=>current(scope));
      if(signal.aborted||!current(scope))throw new Error('The owner request changed.');
      // A narrow parsed shape from an observed Greenhouse layout, not text in
      // scripts or comments. Unknown layouts fail closed; it is not a promise
      // that applications are open or that this layout is an API contract.
      if(!/^text\/html\b/i.test(page.contentType)||!greenhousePageIdentity(page.body,link.hostname,job.board,job.id,data.title.trim()))throw new Error('The public listing page is unavailable or does not match.');
      if(explicitlyClosed(page.body))throw new Error('The public listing page says applications are closed.');
      const observedAt=now();if(applicationDeadline<=observedAt)throw new Error('The published listing deadline has passed.');
      // The API establishes publication, not that applications are open. The
      // ledger preserves that distinction and displays availability as unknown.
      result.push({sourceUrl:`https://boards-api.greenhouse.io${apiPath}`,url:link.href,title:data.title.trim(),excerpt:data.title.trim(),observedAt,applicationDeadline,
        sourceHash:createHash('sha256').update(api.body).update('\0').update(page.body).digest('hex'),workplace:'unknown',verification:'public-listing-published'});
    }
    return result;
  };
}

/**
 * Narrow board-local search. The caller supplies an already-authorized board
 * and contract; filtering happens locally and never sends owner criteria.
 * It does not search the whole web or infer salary or workplace eligibility.
 */
export function greenhouseBoardReader(current:(scope:ErrandScope)=>boolean,now=()=>Date.now(),transport?:Transport):VerifiedListingReader {
  const exact=greenhouseListingReader(current,now,transport);
  return async(scope,raw,signal)=>{
    const q=raw as {board?:unknown;role?:unknown;location?:unknown}|null;
    if(!q||typeof q.board!=='string'||!BOARD.test(q.board)||CREDENTIAL.test(q.board)||typeof q.role!=='string'||!q.role.trim()||q.role.length>120||typeof q.location!=='string'||!q.location.trim()||q.location.length>120)throw new Error('A Greenhouse board, role and location are required.');
    if(signal.aborted||!current(scope))throw new Error('The owner request changed.');
    const response=await greenhouseGet('boards-api.greenhouse.io',`/v1/boards/${q.board}/jobs`,signal,transport,()=>current(scope));
    if(signal.aborted||!current(scope))throw new Error('The owner request changed.');
    if(!/^application\/json\b/i.test(response.contentType))throw new Error('Unexpected Greenhouse response.');
    let data:any;try{data=JSON.parse(response.body);}catch{throw new Error('Unexpected Greenhouse response.');}
    if(!Array.isArray(data?.jobs)||data.jobs.length>2000)throw new Error('The public job board is unavailable or too large.');
    const norm=(s:string)=>s.replace(/\s+/g,' ').trim().toLocaleLowerCase();
    const role=norm(q.role),location=norm(q.location),ids:string[]=[];
    for(const item of data.jobs){
      if(!item||typeof item.title!=='string'||typeof item.location?.name!=='string')continue;
      const id=typeof item.id==='number'&&Number.isSafeInteger(item.id)?String(item.id):typeof item.id==='string'?item.id:'';
      if(!/^[1-9][0-9]{0,17}$/.test(id)||ids.includes(id)||!norm(item.title).includes(role)||!norm(item.location.name).includes(location))continue;
      ids.push(id);if(ids.length===MAX_IDS)break;
    }
    const listings:Listing[]=[];
    for(const id of ids){
      if(signal.aborted||!current(scope))throw new Error('The owner request changed.');
      try{listings.push(...await exact(scope,{jobs:[{board:q.board,id}]},signal));}
      catch(error){
        if(signal.aborted||!current(scope))throw new Error('The owner request changed.');
        // Skip only a specifically unverifiable candidate; a transport error
        // must not be reported as an empty board.
        if(!/^(?:The published listing |The public listing |Unsupported Greenhouse listing link|Invalid Greenhouse listing link)/.test((error as Error).message))throw error;
      }
    }
    return listings;
  };
}
