import { request } from 'node:http';
import type { FileHandle } from 'node:fs/promises';
import { streamHandle } from './large-file.js';
import { PREPARATION_TIMEOUT_MS } from './disk-artifacts.js';

/** Use Node's HTTP backpressure, avoiding whole-body JSON/base64 or fetch buffering. */
export function uploadArtifact(url:string,token:string,handle:FileHandle,bytes:number,signal?:AbortSignal):Promise<any> {
  const target=new URL(url);
  if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password)throw new Error('Artifact preparation requires the local bridge endpoint.');
  return new Promise((resolve,reject)=>{
    const stream=streamHandle(handle,bytes);
    let settled=false;
    const finish=(error?:Error,data?:any)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);stream.destroy();error?reject(error):resolve(data);};
    const req=request(target,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream','Content-Length':bytes},timeout:30000},res=>{
      let body='';res.on('data',chunk=>{body+=chunk;if(body.length>64000){finish(new Error('Unexpected artifact preparation response.'));res.destroy();req.destroy();}});
      res.on('error',e=>finish(e));res.on('end',()=>{let data:any;try{data=JSON.parse(body);}catch{return finish(new Error('Invalid artifact preparation response.'));}finish(res.statusCode===200?undefined:new Error(data.error??'Document preparation failed.'),data);});
    });
    const abort=()=>req.destroy(new Error('Document preparation cancelled.'));
    const timer=setTimeout(()=>req.destroy(new Error('Document preparation timed out.')),PREPARATION_TIMEOUT_MS);
    req.on('timeout',()=>req.destroy(new Error('Document preparation stalled.')));req.on('error',e=>finish(e));stream.on('error',e=>req.destroy(e));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();else stream.pipe(req);
  });
}
