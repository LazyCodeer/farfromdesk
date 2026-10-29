import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {BrowserTabs} from './browser-tabs.js';
import {publicListingUrl,type ErrandScope,type Listing} from './errand-missions.js';

const Query=z.object({tabRefs:z.array(z.string().uuid()).min(1).max(40)}).strict();

/**
 * Internal adapter for tabs already selected for the exact owner request.
 * It reads the actual selected page through BrowserTabs, never opens a browser,
 * follows links, fills a form or submits anything. It does not prove that a
 * page is a live job posting; the owner must inspect each link before acting.
 * The guard must be bridge-owned, and revalidate current owner/request/session.
 */
export type ObservedPage=Omit<Listing,'verification'>&{evidence:'selected-page'};
export type ObservedPageReader=(scope:ErrandScope,query:unknown,signal:AbortSignal)=>Promise<ObservedPage[]>;
export function existingTabListingReader(browser:Pick<BrowserTabs,'run'>,current:(scope:ErrandScope)=>boolean,now=()=>Date.now()):ObservedPageReader {
  return async(scope,query,signal)=>{
    const {tabRefs}=Query.parse(query);if(new Set(tabRefs).size!==tabRefs.length)throw new Error('Choose each tab once.');
    const results:ObservedPage[]=[];
    for(const tabRef of tabRefs){
      if(signal.aborted||!current(scope))throw new Error('The owner request changed.');
      const raw=await browser.run(`${scope.bindingId}:${scope.requestId}`,{action:'read',tabRef});
      if(signal.aborted||!current(scope))throw new Error('The owner request changed.');
      if(!raw||raw.untrustedPageEvidence!==true||typeof raw.url!=='string'||typeof raw.title!=='string'||typeof raw.text!=='string')throw new Error('The selected page could not be read.');
      const url=publicListingUrl(raw.url),title=raw.title.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,160);
      if(!title)throw new Error('The selected page has no visible title.');
      // Only an exact selected-page title is used for ranking. Full page text can
      // contain private account details and is not sent to the model or stored.
      const excerpt=title,sourceHash=createHash('sha256').update(JSON.stringify([url,title,raw.text])).digest('hex');
      results.push({url,sourceUrl:url,title,excerpt,observedAt:now(),sourceHash,evidence:'selected-page'});
    }
    return results;
  };
}
