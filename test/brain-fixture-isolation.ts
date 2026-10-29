// Imported first by fixtures that exercise Meta Brain. Direct test invocations
// must never read the installed app's state or make an unmocked remote call.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const isolated=mkdtempSync(join(tmpdir(),'ffd-brain-fixture-'));
process.env.WSB_STATE_DIR=isolated;
process.once('exit',()=>{try{rmSync(isolated,{recursive:true,force:true});}catch{}});

const localFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  const raw=input instanceof Request?input.url:String(input);
  let url:URL;try{url=new URL(raw);}catch{throw new Error('Fixture requires a loopback URL or an injected fake fetch.');}
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Unmocked external fetch is disabled in Brain fixtures.');
  return localFetch(input,init);
};
