import {Store} from '../../src/store.js';
import {CollaborationHarness,type CollaborationScope} from '../../src/collaboration-harness.js';

const [file,owner,request,itemText,bindingId,eventId]=process.argv.slice(2),itemId=Number(itemText);
const store=new Store(file);
const scope:CollaborationScope={owner,destination:owner,rootRequestId:request,itemId,contractId:'contract-a',revision:1,approvedHash:'a'.repeat(64)};
const harness=new CollaborationHarness(store,{approved:(r,i)=>r===request&&i===itemId?scope:undefined,mayWork:()=>true},()=>1_000_000);
process.send?.({ready:true});
process.once('message',()=>{
  let ok=false;
  try{harness.claim(request,itemId,bindingId,eventId);ok=true;}catch{}
  store.close();process.send?.({ok},()=>process.disconnect());
});
