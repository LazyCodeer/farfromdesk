import {networkInterfaces,tmpdir} from 'node:os';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {X509Certificate} from 'node:crypto';
import {EmbeddedDesktopDriver,type DesktopDriver} from '../desktop-driver.js';
import {NativeOwnerBackend} from '../owner-view/native.js';
import type {AccessStore} from './access.js';
import {RemotePasswordAccess} from './access.js';
import {phoneServer} from './phone-server.js';

const exec=promisify(execFile),nativeRoot=fileURLToPath(new URL('../../native/',import.meta.url));
// 100.64.0.0/10 is Tailscale's private range, so the phone can reach the Mac away from home.
export const privateIPv4=(address:string)=>/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address)&&address.split('.').length===4&&address.split('.').every(n=>/^\d{1,3}$/.test(n)&&+n<=255);
export function phoneAddresses(){return Object.entries(networkInterfaces()).flatMap(([name,entries])=>(entries??[]).filter(e=>!e.internal&&e.family==='IPv4'&&privateIPv4(e.address)).map(e=>({name,address:e.address})));}
export async function localPhoneCertificate(address:string){
 if(!privateIPv4(address)&&address!=='127.0.0.1')throw Error('PRIVATE_NETWORK_REQUIRED');
 const directory=await mkdtemp(join(tmpdir(),'ffd-phone-tls-'));
 try{
  await writeFile(join(directory,'openssl.cnf'),`[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=FarFromDesk local phone preview\n[extensions]\nsubjectAltName=IP:${address}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,{mode:0o600});
  await exec('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-config',join(directory,'openssl.cnf'),'-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem')],{timeout:15000});
  const [key,cert]=await Promise.all([readFile(join(directory,'key.pem')),readFile(join(directory,'cert.pem'))]);
  return {key,cert,fingerprint:new X509Certificate(cert).fingerprint256};
 }finally{await rm(directory,{recursive:true,force:true});}
}
/** Local app owns Start, selection, password and Stop. The phone cannot choose targets. */
export class PhoneRemoteService {
 readonly access:RemotePasswordAccess;
 private viewer?:ReturnType<typeof phoneServer>;private driver?:DesktopDriver;
 private starting=false;private generation=0;private url?:string;private fingerprint?:string;
 private error?:string;private selected?:{pid:number;windowId:number};
 constructor(store:AccessStore){this.access=new RemotePasswordAccess(store);this.access.stop();}
 get status(){return {supported:process.platform==='darwin',...this.access.status,running:!!this.viewer,url:this.url,fingerprint:this.fingerprint,selected:this.selected,error:this.error,addresses:phoneAddresses(),mode:'selected-window',networkScope:'same-wifi',capture:'refreshed-images'};}
 private getDriver(){return this.driver??=new EmbeddedDesktopDriver();}
 async command(d:Record<string,unknown>){
  if(d.action==='stop'){this.stop();return this.status;}
  if(process.platform!=='darwin')throw Error('MAC_ONLY');
  if(d.action==='password'){this.stop();await this.access.setPassword(d.password as string);return this.status;}
  if(d.action==='check')return {...this.status,permissions:await this.getDriver().call('check_permissions',{})};
  if(d.action==='apps'){
   const result=await this.getDriver().call('list_apps',{});
   return {apps:result.apps.filter((a:any)=>a.running&&a.pid&&a.bundle_id).map((a:any)=>({pid:a.pid,name:a.name??a.bundle_id,bundleId:a.bundle_id}))};
  }
  if(d.action==='windows'){
   if(!Number.isInteger(d.pid))throw Error('SELECT_APP');
   const result=await this.getDriver().call('list_windows',{pid:d.pid});
   return {windows:result.windows.filter((w:any)=>w.is_on_screen&&w.layer===0).map((w:any)=>({id:w.window_id,title:w.title||'Untitled window',bounds:w.bounds}))};
  }
  if(d.action==='start'){
   if(this.starting)throw Error('START_IN_PROGRESS');
   this.stop();this.starting=true;const generation=this.generation;
   try{
    if(!Number.isInteger(d.pid)||!Number.isInteger(d.windowId))throw Error('SELECT_WINDOW');
    if(typeof d.address!=='string'||!phoneAddresses().some(a=>a.address===d.address))throw Error('SELECT_LOCAL_NETWORK');
    this.access.enable(true);
    const selected={pid:d.pid as number,windowId:d.windowId as number};
    const createBackend=()=>new NativeOwnerBackend(selected.pid,selected.windowId,join(nativeRoot,'session-state'));
    const probe=createBackend();
    try{if(!await probe.ready())throw Error(probe.lastReadiness.reason);}finally{probe.stop();}
    const tls=await localPhoneCertificate(d.address);
    if(generation!==this.generation)throw Error('START_CANCELLED');
    this.access.setReady(true);
    const viewer=phoneServer({tls,address:d.address,access:this.access,backend:createBackend,onStop:()=>this.stop()});
    this.viewer=viewer;
    const url=await viewer.listen();
    if(generation!==this.generation){viewer.stop();throw Error('START_CANCELLED');}
    this.url=url;this.fingerprint=tls.fingerprint;this.selected=selected;this.error=undefined;
   }catch(e){if(generation===this.generation){this.stop();this.error=(e as Error).message;}throw e;}finally{this.starting=false;}
   return this.status;
  }
  throw Error('UNKNOWN_PHONE_ACTION');
 }
 stop(){this.generation++;const viewer=this.viewer;this.viewer=undefined;viewer?.stop();this.access.stop();this.driver?.stop();this.driver=undefined;this.url=undefined;this.fingerprint=undefined;this.selected=undefined;}
}
