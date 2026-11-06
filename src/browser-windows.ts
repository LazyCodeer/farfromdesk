import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsPowerShell } from './power.js';

/**
 * The owner's already-open Chromium tabs on Windows, through UI Automation (native/browser-windows.ps1).
 *
 * Why UI Automation and not the DevTools protocol: Chrome 136 and later ignore
 * --remote-debugging-port on the default profile, so DevTools cannot reach the owner's real
 * tabs without moving them to another profile. UI Automation reads the running browser as it
 * is, with no extension, flag or restart. What it cannot give: the address of a tab that is
 * not the selected one in its window (its title is known), and Firefox, which publishes no
 * comparable tab strip. Nothing here types, presses keys or moves the pointer.
 */
export type BrowserHelperExec=(file:string,args:string[],options:{timeout:number;maxBuffer:number;signal?:AbortSignal;windowsHide:boolean})=>Promise<string>;
export type BrowserHelper=(action:string,args?:Record<string,unknown>,signal?:AbortSignal)=>Promise<any>;

/** Owner-facing browser names to the process the helper reads. */
export const windowsBrowsers:Record<string,string>={comet:'comet',chrome:'chrome',edge:'msedge',brave:'brave'};

const execText:BrowserHelperExec=(file,args,options)=>new Promise((resolve,reject)=>{
  execFile(file,args,{...options,encoding:'utf8'},(error,stdout,stderr)=>{
    if(String(stdout).trim())resolve(String(stdout));else reject(Object.assign(new Error(String(stderr||'').trim()||error?.message||'no answer'),{killed:(error as any)?.killed}));
  });
});

export function windowsBrowserHelper(exec:BrowserHelperExec=execText):BrowserHelper{
  return async(action,args={},signal)=>{
    const payload=Buffer.from(JSON.stringify(args)).toString('base64');
    const script=fileURLToPath(new URL('../native/browser-windows.ps1',import.meta.url));
    let raw:string;
    try{raw=await exec(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,action,payload],{timeout:action==='read'?45000:20000,maxBuffer:64*1024*1024,signal,windowsHide:true});}
    catch(e){
      if(signal?.aborted)throw new Error('DESKTOP_STOPPED');
      if((e as any)?.killed)throw new Error('BROWSER_TIMEOUT: The browser did not answer in time. No automatic retry; list the tabs again to see the current state.');
      throw new Error('BROWSER_HELPER_FAILED: The browser helper could not run: '+String((e as Error)?.message??e).slice(0,200));
    }
    let result:any;
    try{result=JSON.parse(raw);}catch{throw new Error('BROWSER_HELPER_FAILED: The browser helper gave an unreadable answer.');}
    if(result?.ok!==true)throw new Error(String(result?.error??'BROWSER_HELPER_FAILED: no answer'));
    return result;
  };
}

/** The coordinator browser tool's native contract (src/browser-tabs.ts), on Windows. */
export function windowsBrowserNative(helper:BrowserHelper=windowsBrowserHelper()){
  return async(q:Record<string,unknown>):Promise<any>=>{
    const target={browser:q.browser,pid:q.pid,window_id:q.windowId,tab_id:q.tabId,expected_url:q.expectedUrl};
    switch(q.action){
      case 'inventory':return (await helper('inventory')).browsers;
      case 'tabs':{
        const r=await helper('tabs',{browser:q.browser,pid:q.pid});
        return (r.windows as any[]).flatMap(w=>(w.tabs as any[]).map(t=>({windowId:String(w.window_id),tabId:String(t.tab_id),title:String(t.title??''),url:String(t.url??'')})));
      }
      case 'select':{const r=await helper('focus',{...target,foreground:true});return {selected:true,url:String(r.url??''),title:String(r.title??'')};}
      case 'read':{
        const r=await helper('read',{...target,visible_only:true,links:true,limit:12000});
        return {url:r.url,title:r.title,text:r.text,links:r.links??[],controls:[],viewport:r.viewport,scrollY:0};
      }
      case 'scroll':return {scrolled:(await helper('scroll',{...target,direction:q.direction})).scrolled===true};
      case 'follow':{await helper('follow',{...target,link_id:q.linkId,href:q.href,label:q.label});return {navigationRequested:true};}
      default:throw new Error('BROWSER_ACTION_UNSUPPORTED: Unknown browser action.');
    }
  };
}

/** The desktop-control browser contract (operation-based, like native/desktop-browser.js), on Windows. */
export function windowsDesktopBrowser(helper:BrowserHelper=windowsBrowserHelper()){
  return async(q:Record<string,unknown>,signal?:AbortSignal):Promise<any>=>{
    const target={browser:q.bundle,window_id:q.window_id,tab_id:q.tab_id};
    switch(q.operation){
      case 'inventory':return (await helper('inventory',{},signal)).browsers;
      case 'list_tabs':return {windows:(await helper('tabs',{browser:q.bundle},signal)).windows};
      case 'focus_tab':return helper('focus',{...target,foreground:q.foreground===true},signal);
      case 'close_tab':return helper('close',target,signal);
      case 'new_tab':return helper('open',{browser:q.bundle,url:q.url},signal);
      case 'read_tab':return helper('read',{...target,limit:60000,screenshot:q.screenshot===true},signal);
      case 'navigate_tab':throw new Error('DESKTOP_PLATFORM_UNSUPPORTED: On Windows I can open a page in a new tab, but not send an open tab to another address without typing into it.');
      default:throw new Error('BROWSER_ACTION_UNSUPPORTED: Unknown browser operation.');
    }
  };
}
