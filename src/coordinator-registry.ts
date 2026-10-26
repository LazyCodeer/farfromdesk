import { createHash } from 'node:crypto';
import type { Store, Binding } from './store.js';
import type { SessionRoute } from './connections.js';

export type CoordinatorEntry={key:string;bindingId:string;generation:number;provider:string;executionMode:string;profileId?:string;accountScope?:string;accountKey?:string};
/** The legacy master pointer is retained as the default, never as request ownership. */
export class CoordinatorRegistry {
  constructor(private store:Store) {
    const version=Number(store.get('coordinator-schema')??0);
    if(version>1)throw new Error('This coordinator database requires a newer FarFromDesk version.');
    if(!version){
      store.db.exec('SAVEPOINT coordinator_migration');
      try{const legacy=store.binding(store.get('master')??'');if(legacy)this.register(legacy);store.set('coordinator-schema','1');store.db.exec('RELEASE coordinator_migration');}
      catch(e){store.db.exec('ROLLBACK TO coordinator_migration; RELEASE coordinator_migration');throw e;}
    }
  }
  identity(b:Binding):Omit<CoordinatorEntry,'bindingId'|'generation'> {
    const route=JSON.parse(this.store.get(`session-route:${b.id}`)??'null') as SessionRoute|null;
    const executionMode=route?.executionMode??this.store.get(`execution-mode:${b.id}`)??'cli';
    const profileId=route?.profileId,accountScope=route?.accountScope,accountKey=route?.accountKey;
    const key=createHash('sha256').update(JSON.stringify([b.provider,executionMode,profileId??null,accountScope??accountKey??null])).digest('hex').slice(0,24);
    return {key,provider:b.provider,executionMode,profileId,accountScope,accountKey};
  }
  entries():CoordinatorEntry[] {
    const rows=JSON.parse(this.store.get('coordinator-registry')??'[]') as CoordinatorEntry[];
    // Allows existing integrations to set the legacy master before first setup.
    const legacy=this.store.binding(this.store.get('master')??'');
    if(legacy&&!rows.some(r=>r.bindingId===legacy.id)&&!this.store.get(`coordinator-retired:${legacy.id}`))rows.push({...this.identity(legacy),bindingId:legacy.id,generation:1});
    return rows;
  }
  entry(id:string){return this.entries().find(r=>r.bindingId===id);}
  isCoordinator(id:string){return !!this.entry(id);}
  bindingFor(b:Binding){const key=this.identity(b).key;return this.store.binding(this.entries().find(r=>r.key===key)?.bindingId??'');}
  register(b:Binding) {
    const identity=this.identity(b),entries=this.entries(),old=entries.find(r=>r.key===identity.key);
    if(entries.some(r=>r.bindingId===b.id&&r.key!==identity.key))throw new Error('Coordinator account or runtime changed. Create or select a separate coordinator.');
    const entry={...identity,bindingId:b.id,generation:old?.bindingId===b.id?old.generation:(old?.generation??0)+1};
    this.store.set('coordinator-registry',JSON.stringify([...entries.filter(r=>r.key!==identity.key),entry]));
    this.store.set(`role-kind:${b.id}`,'master');
    if(old&&old.bindingId!==b.id)this.store.set(`coordinator-retired:${old.bindingId}`,'true');
    const defaultId=this.store.get('master');
    if(!defaultId||defaultId===old?.bindingId){this.store.set('master',b.id);this.store.set('active',b.id);}
    return entry;
  }
  /** Gives a provider's Desktop coordinator saved without an account the account of its own session in that provider's catalog; when that proves it duplicates another coordinator of the same account, keeps the default and retires the idle other one. */
  adoptAccounts(provider:string,sessions:{id:string;desktopId?:string;executionMode?:string;accountScope?:string}[]) {
    for(const entry of this.entries()) {
      const b=this.store.binding(entry.bindingId),route=b&&JSON.parse(this.store.get(`session-route:${b.id}`)??'null');
      // Session IDs are provider-local: never let one provider's catalog name another provider's binding.
      if(entry.provider!==provider||b?.provider!==provider||entry.executionMode!=='desktop'||entry.accountScope||entry.accountKey||!b.native_id||!route)continue;
      const scope=sessions.find(s=>s.executionMode==='desktop'&&(s.id===b.native_id||s.desktopId===b.native_id))?.accountScope;
      if(!scope)continue;
      this.store.db.exec('SAVEPOINT adopt_account');
      try {
        const rows=this.entries();
        this.store.set(`session-route:${b.id}`,JSON.stringify({...route,accountScope:scope}));
        const identity=this.identity(b),twin=rows.find(r=>r.bindingId!==b.id&&r.key===identity.key);
        const loser=twin&&(this.store.get('master')===twin.bindingId?b.id:twin.bindingId);
        // An unfinished request keeps both until the owner resolves it.
        if(loser&&this.store.pendingJobs().some(j=>j.binding_id===loser)){this.store.db.exec('ROLLBACK TO adopt_account; RELEASE adopt_account');continue;}
        const others=rows.filter(r=>r.bindingId!==b.id&&r.bindingId!==loser);
        this.store.set('coordinator-registry',JSON.stringify(loser===b.id?others:[...others,{...identity,bindingId:b.id,generation:Math.max(entry.generation,twin?.generation??0)}]));
        if(loser){this.store.set(`coordinator-retired:${loser}`,'true');this.store.enable(loser,false);this.store.audit('master-replaced',loser,JSON.stringify({replacement:loser===b.id?twin!.bindingId:b.id,closedRequests:0,reason:'same account'}));}
        this.store.db.exec('RELEASE adopt_account');
      }catch(e){this.store.db.exec('ROLLBACK TO adopt_account; RELEASE adopt_account');throw e;}
    }
  }
  setDefault(id:string) {
    if(!this.isCoordinator(id)||!this.store.binding(id)?.enabled)throw new Error('Choose an enabled coordinator as the default.');
    this.store.set('master',id);this.store.set('active',id);
  }
  matches(id:string,s:{provider:string;executionMode?:string;accountScope?:string}) {
    const entry=this.entry(id);
    return !!entry&&entry.provider===s.provider&&entry.executionMode===(s.executionMode??'cli')&&(!entry.accountScope||entry.accountScope===s.accountScope);
  }
  choose(provider:string,mode?:string) {
    let entries=this.entries().filter(r=>r.provider===provider&&(!mode||r.executionMode===mode));
    if(!mode&&entries.length>1){const p=JSON.parse(this.store.get(`platform-preference:${provider}`)??'null');if(p?.executionMode)entries=entries.filter(r=>r.executionMode===p.executionMode&&(!p.route?.accountScope||r.accountScope===p.route.accountScope));}
    if(entries.length!==1)throw new Error(entries.length?'Choose the exact Desktop/CLI connection and account in Coding platforms.':`No ${provider==='claude'?'Claude':'Codex'} coordinator is set up. Add one in FarFromDesk, Coding platforms.`);
    const b=this.store.binding(entries[0].bindingId);
    if(!b?.enabled)throw new Error('That coordinator is paused. Resume it in Coding platforms; no other platform was selected.');
    return b;
  }
  view() {return this.entries().map(({accountKey,accountScope,...e})=>{
    const b=this.store.binding(e.bindingId);
    const error=b?this.store.get(`native-history-error:${b.id}`)||undefined:undefined;
    return {...e,name:b?this.store.get(`name:${b.id}`)??b.alias:'Missing session',nativeId:b?.native_id,enabled:!!b?.enabled,isDefault:e.bindingId===this.store.get('master'),error,state:!b?.enabled?'paused':error?'needs_attention':'connected'};
  });}
}
