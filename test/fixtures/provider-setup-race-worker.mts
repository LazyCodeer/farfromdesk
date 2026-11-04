import {Store} from '../../src/store.js';
import {CollaborationHarness} from '../../src/collaboration-harness.js';
import {withProviderSetup} from '../../src/provider-setup-barrier.js';
import {Approvals} from '../../src/approvals.js';
import {Router} from '../../src/router.js';
import {ManagedCollaboration} from '../../src/managed-collaboration.js';

const [db,mode,owner,root,item,binding]=process.argv.slice(2);
const store=new Store(db),scope={owner,destination:owner,rootRequestId:root,itemId:Number(item),contractId:'contract-a',revision:1,approvedHash:'a'.repeat(64)};
const ledger=new CollaborationHarness(store,{approved:()=>scope,mayWork:()=>true});
process.send?.({ready:true});
process.once('message',()=>{
  let ok=false;
  try {
    if(mode==='setup')withProviderSetup(store,'synthetic-race',()=>{});
    else if(mode==='migration'){
      const approvals=new Approvals(store),native:any={connections:{route:()=>undefined},stop:()=>{},run:async()=>{}};
      const router=new Router(store,native,approvals);new ManagedCollaboration(router,{authorize:()=> 'synthetic'});router.stopped=true;approvals.cancel();
    }else ledger.claim(root,Number(item),binding,'race-claim');
    ok=true;
  }catch{/* A concurrent reservation or claim must lose. */}
  process.send?.({ok});store.close();
});
