import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {createMacNative} from '../src/mac-native.js';
function fixture(hang=false){let launches=0,kills=0;const calls:any[]=[];
 const native=createMacNative('/fixture',new Set(['WINDOW_STALE']),()=>{launches++;const child:any=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new Writable({write(chunk,_encoding,done){const q=JSON.parse(chunk.toString());calls.push(q);if(!(hang&&q.action==='click'))queueMicrotask(()=>child.stdout.write(JSON.stringify({commandId:q.commandId,trusted:true})+'\n'));done();}});child.kill=()=>{kills++;child.emit('exit');return true;};return child;},30);
 return {native,calls,count:()=>({launches,kills})};}
test('commands share one helper and responses are correlated; stop releases it',async()=>{const f=fixture();await f.native({action:'status'});await f.native({action:'discover'});assert.equal(f.count().launches,1);assert.notEqual(f.calls[0].commandId,f.calls[1].commandId);f.native.stop!();assert.equal(f.count().kills,1);});
test('uncertain action is not replayed; a later explicit command starts a new helper',async()=>{const f=fixture(true);await assert.rejects(f.native({action:'click'}),/UNCERTAIN/);assert.equal(f.calls.filter(x=>x.action==='click').length,1);await f.native({action:'status'});assert.equal(f.count().launches,2);assert.equal(f.calls.filter(x=>x.action==='click').length,1);f.native.stop!();});
test('cancellation kills active work and a cancelled queued command is never written',async()=>{const f=fixture(true),controller=new AbortController();const work=f.native({action:'click'},controller.signal);await new Promise(r=>setTimeout(r,2));const queued=f.native({action:'read'},controller.signal);controller.abort();await assert.rejects(work,/STOPPED/);await assert.rejects(queued,/STOPPED/);assert.deepEqual(f.calls.map(x=>x.action),['click']);});
