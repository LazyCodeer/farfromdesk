import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import {launchServicesNative} from './owner-view/launch-services.js';
import { createMacNative } from './mac-native.js';

export type DesktopDriver={readonly revision?:number;call(name:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<any>;stop():void};
const nativeRoot=fileURLToPath(new URL('../native/',import.meta.url));
/** A native app helper parents the vendor daemon so normal macOS TCC attribution applies. */
export class EmbeddedDesktopDriver implements DesktopDriver {
  private host:ReturnType<typeof createMacNative>;
  constructor(private nativeDirectory=nativeRoot, helperBundle="FarFromDesk Accessibility.app", viaLaunchServices=false){
    this.host=viaLaunchServices?launchServicesNative(nativeDirectory+helperBundle):createMacNative(nativeDirectory+helperBundle+'/Contents/MacOS/ffd-accessibility',new Set(['DESKTOP_DRIVER_MISSING','DESKTOP_DRIVER_HASH_MISMATCH','DESKTOP_DRIVER_FAILED']));
  }
  private client?:Client; private transport?:StdioClientTransport; private starting?:Promise<Client>;
  private generation=0; private directory?:string; private idle?:ReturnType<typeof setTimeout>;
  get revision(){return this.generation;}
  private async connect():Promise<Client> {
    if(this.client)return this.client;
    if(this.starting)return this.starting;
    const generation=this.generation;
    const start=async()=>{
      const ready=await this.host({action:'desktopDriverStart'});
      if(generation!==this.generation)throw new Error('DESKTOP_STOPPED');
      this.directory=ready.directory;
      const env=Object.fromEntries(Object.entries(process.env).filter(([k,v])=>v!==undefined&&!k.startsWith('CUA_DRIVER_'))) as Record<string,string>;
      Object.assign(env,{CUA_DRIVER_EMBEDDED:'1',CUA_DRIVER_RS_TELEMETRY_ENABLED:'0',CUA_DRIVER_RS_UPDATE_CHECK:'0'});
      const transport=new StdioClientTransport({command:this.nativeDirectory+'cua-driver/cua-driver',args:['mcp','--embedded','--socket',ready.socket],env,stderr:'ignore'});
      this.transport=transport;
      const client=new Client({name:'farfromdesk-desktop',version:'1.0'},{capabilities:{}});
      await client.connect(transport);
      if(generation!==this.generation){await client.close();throw new Error('DESKTOP_STOPPED');}
      this.client=client;return client;
    };
    this.starting=start().catch(e=>{this.stop();throw e;}).finally(()=>{this.starting=undefined;});
    return this.starting;
  }
  async call(name:string,args:Record<string,unknown>,signal?:AbortSignal){
    if(signal?.aborted)throw new Error('DESKTOP_STOPPED');
    clearTimeout(this.idle);
    const abort=()=>this.stop();signal?.addEventListener('abort',abort,{once:true});
    try{
      const client=await this.connect();
      if(signal?.aborted)throw new Error('DESKTOP_STOPPED');
      const result=await client.callTool({name,arguments:args},undefined,{signal,timeout:12000});
      if(result.isError)throw new Error('DESKTOP_NATIVE_REFUSED: '+JSON.stringify(result.content));
      const text=(result.content as any[])?.find(c=>c.type==='text')?.text;
      const value=result.structuredContent??(text?JSON.parse(text):{});
      if((value as any).refusal||(value as any).error)throw new Error('DESKTOP_NATIVE_REFUSED: '+JSON.stringify(value));
      return value;
    }catch(e){this.stop();throw e;}
    finally{signal?.removeEventListener('abort',abort);this.idle=setTimeout(()=>this.stop(),60000);this.idle.unref();}
  }
  stop(){
    this.generation++;clearTimeout(this.idle);this.host.stop?.();
    const c=this.client,t=this.transport,dir=this.directory;
    this.client=undefined;this.transport=undefined;this.directory=undefined;
    void (c?.close()??t?.close())?.catch(()=>{});
    if(dir?.startsWith('/tmp/ffd-cua-'))void rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
