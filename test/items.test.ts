import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Items, itemOperation } from '../src/items.js';
import { runFfd } from '../src/ffd.js';
import { namedItem } from '../src/owner-routing.js';

const uuid=(n:number)=>`11111111-1111-4111-a111-${String(n).padStart(12,'0')}`;

test('items keep shared numbering, statuses, sessions and dated notes',()=>{
  const store=new Store(':memory:');
  try {
    const billing=store.register('billing-api','codex',uuid(1),'/tmp/b').binding;store.set(`name:${billing.id}`,'Billing API');
    const items=new Items(store),again=new Items(store);
    const a=itemOperation(items,{op:'add',title:'Fix invoice export',eventId:'e1'},'master').item!;
    assert.equal(itemOperation(again,{op:'add',title:'Fix invoice export',eventId:'e1'},'master').item!.id,a.id);
    const b=itemOperation(again,{op:'add',title:'Mac control check',session:'billing api'},'claude-master').item!;
    assert.equal(b.id,a.id+1);assert.equal(b.status,'in progress');assert.equal(b.binding_id,billing.id);
    itemOperation(items,{op:'set',id:a.id,status:'waiting-on-owner'},'master');
    itemOperation(items,{op:'set',id:a.id,session:'billing-api'},'master');
    itemOperation(items,{op:'set',id:a.id,note:'Owner must pick a date format.',eventId:'n1'},'master');
    itemOperation(items,{op:'set',id:a.id,note:'Owner must pick a date format.',eventId:'n1'},'master');
    const shown=itemOperation(items,{op:'show',id:a.id},'master').text;
    assert.match(shown,/⚠️ Fix invoice export · waiting on owner · Codex · b/);
    assert.match(shown,/Original chat title: Billing API/);
    assert.equal(shown.match(/date format/g)?.length,1);
    assert.match(itemOperation(items,{op:'list'},'master').text,/^0 to do, 2 in progress \(1 need the owner or are blocked\), 0 done\./);
    itemOperation(items,{op:'set',id:b.id,status:'done'},'master');
    assert.match(itemOperation(items,{op:'list'},'master').text,/\*Done\*\nD1 ✅ Mac control check/);
    assert.match(itemOperation(items,{op:'list',all:true},'master').text,/✅ Mac control check/);
    assert.throws(()=>itemOperation(items,{op:'set',id:a.id,status:'finished'},'master'),/one of/);
    assert.throws(()=>itemOperation(items,{op:'show',id:99},'master'),/no item 99/);
    assert.throws(()=>itemOperation(items,{op:'add',title:'x',session:'nobody'},'master'),/No session/);
  }finally{store.close();}
});

test('ffd item commands and item:N on send link the hand-off to the item',async()=>{
  const calls:{path:string;data:any}[]=[];
  const call=async(path:string,data?:any)=>{calls.push({path,data});
    if(path==='/api/master/selected')return {sessions:[{id:'b1',alias:'billing-api',name:'Billing API'}]};
    return {text:'ok',jobs:[]};};
  const none=()=>'';
  await runFfd(['items','all'],{id:'me'},call,none);
  assert.deepEqual(calls.at(-1),{path:'/api/master/items',data:{op:'list',all:true}});
  await runFfd(['item','set','3','status','in','progress'],{id:'me'},call,none);
  assert.deepEqual(calls.at(-1)!.data,{op:'set',id:3,status:'in progress'});
  await runFfd(['item','add','Fix export'],{id:'me'},call,none);
  assert.match(calls.at(-1)!.data.eventId,/^item-/);
  calls.length=0;
  const out=await runFfd(['send','tg:1','Billing API','item:3','Fix the export'],{id:'me'},call,none);
  assert.match(out,/for item 3/);
  const dispatch=calls.find(c=>c.path==='/api/master/dispatch')!;assert.equal(dispatch.data.text,'Fix the export');assert.equal(dispatch.data.itemId,3);
  assert.equal(calls.filter(c=>c.path==='/api/master/items').length,0);
  await assert.rejects(runFfd(['item','set','3','colour','red'],{id:'me'},call,none),/ffd item set/);
});

test('the list has To do, In progress and Done sections with codes that route follow-ups',()=>{
  const store=new Store(':memory:');
  try {
    const items=new Items(store);
    for(let n=1;n<=9;n++)items.add(`Task ${n}`);
    items.setStatus(2,'in progress');items.setStatus(3,'blocked');
    for(const id of [4,5,6,7,8,9])items.setStatus(id,'done');
    const text=items.text();
    assert.match(text,/^1 to do, 2 in progress \(1 need the owner or are blocked\), 6 done\./);
    assert.match(text,/\*To do\*\nT1 ⚪ Task 1 · no session \(#1\)/);
    assert.match(text,/\*In progress\*\nP1 ⛔ Task 3 · blocked · no session \(#3\)\nP2 🛠️ Task 2/);
    assert.match(text,/\*Done, latest 5 of 6\*\nD1 ✅ Task 9[\s\S]*…and 1 older/);
    const codes=JSON.parse(store.get('item-codes')!);
    assert.equal(codes.P2,2);assert.equal(codes.D1,9);assert.equal(codes.D6,undefined);
    assert.equal(JSON.parse((items.text(true),store.get('item-codes')!)).D6,4);
    assert.deepEqual(namedItem('P2 any news?',codes),{id:2,rest:'any news?'});
    assert.deepEqual(namedItem('progress task one, status',codes),{id:3,rest:'status'});
    assert.equal(namedItem('D9 hello',codes),undefined);
  }finally{store.close();}
});
