import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { AgentInstaller } from '../src/agent-installer.js';

function fixture(){
  const store=new Store(':memory:');let starts=0,kills=0;
  const child=Object.assign(new EventEmitter(),{kill:()=>{kills++;return true;}});
  const installer=new AgentInstaller(store,100,()=>{starts++;return child as any;});
  return {store,child,installer,counts:()=>({starts,kills}),status:()=>JSON.parse(store.get('agent-sync-status')!),close:()=>{installer.close();store.close();}};
}
test('permission-blocked agent file initialization cannot block the service and times out without retries',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();try {
    f.installer.start();f.installer.start();assert.equal(f.status().state,'pending');assert.equal(f.counts().starts,1);
    f.store.set('service-responsive','true');assert.equal(f.store.get('service-responsive'),'true');
    t.mock.timers.tick(101);assert.equal(f.status().state,'unavailable');assert.equal(f.counts().kills,1);
    f.child.emit('exit',0);assert.equal(f.status().state,'unavailable');assert.equal(f.counts().starts,1);
  }finally{f.close();}
});
test('successful sync cancels deadline, and shutdown never writes to a closed database',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();
  f.installer.start();f.child.emit('exit',0);assert.equal(f.status().state,'complete');
  t.mock.timers.tick(101);assert.equal(f.counts().kills,0);
  f.installer.start();f.close();assert.doesNotThrow(()=>f.child.emit('exit',0));t.mock.timers.tick(101);
});
