import { join } from 'node:path';
import { stateDir } from './config.js';
import { Store } from './store.js';
import { syncNamedAgents } from './named-agents.js';

// Same packaged runtime and OS permissions as the parent; no credentials or
// permission overrides. This child never starts WhatsApp or takes its service lock.
const store=new Store(join(stateDir,'bridge.sqlite'));
try {const result=syncNamedAgents(store);if(result.some(a=>a.installation.some(p=>p.status==='unavailable')))process.exitCode=1;}
finally {store.close();}
