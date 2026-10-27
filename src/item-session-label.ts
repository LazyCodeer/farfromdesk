import type { Binding, Store } from './store.js';

/** Presentation only. Native titles, aliases and routing IDs are never rewritten. */
export function itemSessionLabel(store:Store,binding:Binding) {
  const base=(b:Binding)=>{
    const provider=b.provider==='claude'?'Claude':'Codex';
    const mode=store.get(`execution-mode:${b.id}`);
    const runtime=mode==='desktop'?' Desktop':mode==='cli'?' CLI':'';
    if(b.id===store.get('master')||store.get(`role-kind:${b.id}`)==='master')return `${provider}${runtime} proxy`;
    const workspace=b.cwd.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/[\x00-\x1f\x7f*_`]/g,' ').trim().slice(0,60)||'workspace';
    return `${provider}${runtime} · ${workspace}`;
  };
  const label=base(binding);
  return store.bindings().filter(b=>base(b)===label).length>1?`${label} · session ${binding.id.slice(0,8)}`:label;
}
