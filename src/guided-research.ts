import type {Router,Incoming} from './router.js';
import {captureGuidedResearchRequest,researchCommand} from './agent-reach-request.js';
import {authenticatedOwner} from './owner-commands.js';
import {hash} from './store.js';
import {brainPolicy} from './meta-brain-config.js';
import {writeResearchDraft} from './guided-research-draft.js';

/** Called only for an owner follow-up in the bridge's active research mode. */
export async function guidedResearch(router:Router,m:Incoming,text:string,writeDraft=writeResearchDraft):Promise<{kind:'reply';text:string}|{kind:'done';text:string}|{kind:'pass'}> {
  if(text!==m.text||router.stopped)return {kind:'reply',text:'Please send a new typed research topic in your own chat.'};
  if(/(?:^|[,;\n.!?]\s*|\b(?:and|then|please|to)\s+)(?:post|publish|send|share|email|message|upload|submit|tweet|forward|dm)\b/i.test(text))return {kind:'reply',text:'Research mode can prepare a draft for your review. Please send a public topic without a request to publish or send it.'};
  const store=router.store,context=store.incomingOwnerContext.getStore(),command=researchCommand(text,true);
  const current=()=>!!context&&!router.stopped&&m.text===text&&store.incomingOwnerCurrent()&&authenticatedOwner(router,m)&&!store.seen(m.id);
  if(!command||!current())return {kind:'reply',text:'Please send a short public web or GitHub topic in a new typed message. Do not include private details or credentials.'};
  try{
    if(!captureGuidedResearchRequest(store,router,m))return {kind:'reply',text:'Please send a short public web or GitHub topic in a new typed message. Do not include private details or credentials.'};
    const claim=store.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(`reach-guided-claim:${m.id}`,'started');
    if(!claim.changes)return {kind:'done',text:'This research request was already used or interrupted. Send a new topic to try again.'};
    let result:string;
    try{result=await router.reach(command,current);}finally{try{store.set(`reach-guided-claim:${m.id}`,'finished');}catch{}}
    if(!current())return {kind:'done',text:'Research stopped because the owner connection changed.'};
    if(result.startsWith('Agent-Reach is not installed.')||result==='No usable public results were returned.')return {kind:'done',text:result};
    const wantsDraft=/\b(?:draft|write|compose|summari[sz]e|prepare|create)\b/i.test(text);
    if(!wantsDraft)return {kind:'done',text:result};
    const policy=brainPolicy(store),key=router.brain.secret.read();
    if(!policy.enabled||!key)return {kind:'done',text:`${result}\n\nDraft unavailable. Enable Brain and add a Meta key in the desktop app.`};
    if(text.length>1500||result.length>8192||/\b(?:my|our|private|personal|confidential|proprietary)\b/i.test(text)||/(?:\b(?:password|api[ _-]?key|token|secret)\s*[:=]|\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{16,}))/i.test(text))return {kind:'done',text:`${result}\n\nDraft unavailable. Send a shorter request without private details or credentials.`};
    const fingerprint=hash(JSON.stringify(policy)),keyHash=hash(key);
    const authorized=()=>current()&&hash(JSON.stringify(brainPolicy(store)))===fingerprint&&hash(router.brain.secret.read()??'')===keyHash;
    try{
      if(!authorized())return {kind:'done',text:'Research stopped because the owner connection or Brain settings changed.'};
      const draft=await writeDraft(key,text,result,authorized);
      if(!authorized())return {kind:'done',text:'Research stopped because the owner connection or Brain settings changed.'};
      return {kind:'done',text:`Draft for review. Verify the claims before use.\n\n${draft}\n\n${result}`};
    }catch{return {kind:'done',text:current()?`${result}\n\nDraft unavailable. Check Brain settings and try a new request.`:'Research stopped because the owner connection changed.'};}
  }catch{
    return {kind:'done',text:current()?'Public research could not be completed. Send a new request to try again.':'Research stopped because the owner connection changed.'};
  }
}
