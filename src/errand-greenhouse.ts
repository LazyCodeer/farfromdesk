import {createHash} from 'node:crypto';
import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpsRequest,type RequestOptions} from 'node:https';
import {BlockList,isIP} from 'node:net';
import type {ErrandScope,Listing,VerifiedListingReader} from './errand-missions.js';

// Internal, unwired source adapter. It only considers exact Greenhouse IDs
// supplied by a bridge-owned request-bound source. It does not perform search,
// open a browser, follow redirects, authenticate or submit anything.
const HOSTS=new Set(['boards-api.greenhouse.io','boards.greenhouse.io','job-boards.greenhouse.io']);
const MAX_BYTES=512*1024,MAX_IDS=10,TIMEOUT_MS=8000;
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
  if(!HOSTS.has(host)||!/^\/[a-zA-Z0-9_/-]+$/.test(path)||path.includes('//')||path.includes('..')||!publicGreenhouseAddress(address)){reject(new Error('Invalid pinned Greenhouse request.'));return;}
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
export async function greenhouseGet(host:string,path:string,signal:AbortSignal,transport:Transport=productionTransport) {
  if(!HOSTS.has(host)||!/^\/[a-zA-Z0-9_/-]+$/.test(path)||path.includes('//')||path.includes('..'))throw new Error('Invalid Greenhouse request.');
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(TIMEOUT_MS)]);
  if(bounded.aborted)throw new Error('Listing verification cancelled.');
  let abort:()=>void=()=>{};
  try {
    const interrupted=new Promise<never>((_,reject)=>{abort=()=>reject(new Error('Listing verification cancelled or timed out.'));bounded.addEventListener('abort',abort,{once:true});if(bounded.aborted)abort();});
    const addresses=await Promise.race([transport.resolve(host),interrupted]);
    if(!addresses.length||addresses.some(address=>!publicGreenhouseAddress(address)))throw new Error('Greenhouse DNS returned an unsafe address.');
    const response=await Promise.race([transport.request(host,path,addresses[0],bounded),interrupted]);
    if(response.status!==200||Buffer.byteLength(response.body)>MAX_BYTES)throw new Error('Public listing could not be verified.');
    return response;
  } finally {bounded.removeEventListener('abort',abort);}
}

type Input={jobs:{board:string;id:string}[]};
function parseInput(input:unknown):Input {
  if(!input||typeof input!=='object'||!Array.isArray((input as Input).jobs)||(input as Input).jobs.length>MAX_IDS)throw new Error('Provide bounded Greenhouse listing IDs.');
  const jobs=(input as Input).jobs;
  if(jobs.some(x=>!x||typeof x.board!=='string'||! /^[a-z0-9][a-z0-9_-]{0,49}$/.test(x.board)||typeof x.id!=='string'||! /^[1-9][0-9]{0,17}$/.test(x.id))||new Set(jobs.map(x=>`${x.board}/${x.id}`)).size!==jobs.length)throw new Error('Invalid Greenhouse listing IDs.');
  return {jobs};
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
      const api=await greenhouseGet('boards-api.greenhouse.io',apiPath,signal,transport);
      if(signal.aborted||!current(scope))throw new Error('The owner request changed.');
      if(!/^application\/json\b/i.test(api.contentType))throw new Error('Unexpected Greenhouse response.');
      let data:any;try{data=JSON.parse(api.body);}catch{throw new Error('Unexpected Greenhouse response.');}
      if(String(data?.id)!==job.id||typeof data.title!=='string'||!data.title.trim()||data.title.length>160||typeof data.absolute_url!=='string')throw new Error('The public listing did not match the request.');
      let link:URL;try{link=new URL(data.absolute_url);}catch{throw new Error('Invalid Greenhouse listing link.');}
      if(link.protocol!=='https:'||link.username||link.password||link.port||link.search||link.hash||!['boards.greenhouse.io','job-boards.greenhouse.io'].includes(link.hostname)||link.pathname!==`/${job.board}/jobs/${job.id}`)throw new Error('Unsupported Greenhouse listing link.');
      const page=await greenhouseGet(link.hostname,link.pathname,signal,transport);
      if(signal.aborted||!current(scope))throw new Error('The owner request changed.');
      // Avoid accepting a generic HTTP-200 error page. Strict matching may
      // reject valid HTML-escaped titles; such cases fail closed for now.
      if(!/^text\/html\b/i.test(page.contentType)||!page.body.includes(job.id)||!page.body.includes(data.title.trim()))throw new Error('The public listing page is unavailable or does not match.');
      const observedAt=now();
      result.push({sourceUrl:`https://boards-api.greenhouse.io${apiPath}`,url:link.href,title:data.title.trim(),excerpt:data.title.trim(),observedAt,
        sourceHash:createHash('sha256').update(api.body).update('\0').update(page.body).digest('hex'),workplace:'unknown',verification:'public-listing-verified'});
    }
    return result;
  };
}
