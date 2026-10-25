import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { claudeHistory } from '../src/session-catalog.js';
import { speechAssetHash } from '../src/speech-bundle.js';

const uuid=(n:number)=>`44444444-4444-4444-a444-${String(n).padStart(12,'0')}`;
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'tether-bounded-reads-')),project=join(root,'project');mkdirSync(project);
  return {root,project,path:(n:number)=>join(project,uuid(n)+'.jsonl'),close:()=>rmSync(root,{recursive:true,force:true})};
}

test('history metadata uses the first and final 64 KiB windows across oversized partial lines',async()=>{
  const f=fixture();
  try {
    const head=JSON.stringify({sessionId:uuid(1),cwd:'/tmp/fixture-first',timestamp:'2026-10-25T10:00:00Z'});
    const middle=JSON.stringify({type:'custom-title',customTitle:'PRIVATE MIDDLE MUST NOT APPEAR',cwd:'/tmp/unread-middle'});
    const tail=JSON.stringify({sessionId:uuid(1),type:'custom-title',customTitle:'Recent title',timestamp:'2026-10-25T11:00:00Z'});
    writeFileSync(f.path(1),head+'\n'+'x'.repeat(70_000)+'\n'+middle+'\n'+'x'.repeat(70_000)+'\n'+tail+'\n');
    const rows=await claudeHistory(f.root);
    assert.equal(rows.length,1);assert.equal(rows[0].cwd,'/tmp/fixture-first');assert.equal(rows[0].name,'Recent title');
    assert.equal(rows[0].updatedAt,Date.parse('2026-10-25T11:00:00Z'));
    assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|unread-middle|xxxxxxxx/);
  }finally{f.close();}
});

test('reused history windows never leak preceding file bytes into short or empty files',async()=>{
  const f=fixture();
  try {
    // Mix large, short and empty files. Expected results are independent of directory order.
    for(let i=1;i<=24;i++) {
      const id=uuid(i),data=i%3===1
        ?JSON.stringify({cwd:`/tmp/fixture-${i}`,type:'custom-title',customTitle:`Long ${i}`})+'\n'+'x'.repeat(80_000)+'\n'+JSON.stringify({timestamp:'2026-10-25T12:00:00Z'})+'\n'
        :i%3===2?JSON.stringify({sessionId:id,timestamp:'2026-10-25T12:00:00Z'})+'\n':'';
      writeFileSync(f.path(i),data);
    }
    const rows=await claudeHistory(f.root);
    assert.deepEqual(rows.map(r=>r.id).sort(),Array.from({length:8},(_,i)=>uuid(1+i*3)).sort());
    assert.ok(rows.every(r=>r.name.startsWith('Long ')&&r.cwd.startsWith('/tmp/fixture-')));
    // Cache reuse must produce the same metadata, without retaining shared scan buffers.
    assert.deepEqual(await claudeHistory(f.root),rows);
  }finally{f.close();}
});

test('history reads final records correctly immediately around the 64 KiB boundary',async()=>{
  const f=fixture();
  try {
    for(const [i,size] of [65_535,65_536,65_537].entries()) {
      const id=uuid(i+1),head=JSON.stringify({sessionId:id,cwd:`/tmp/boundary-${size}`})+'\n';
      const tail='\n'+JSON.stringify({sessionId:id,type:'custom-title',customTitle:`Boundary ${size}`})+'\n';
      writeFileSync(f.path(i+1),head+'x'.repeat(size-Buffer.byteLength(head)-Buffer.byteLength(tail))+tail);
    }
    const rows=await claudeHistory(f.root);
    assert.deepEqual(rows.map(r=>r.name).sort(),[65_535,65_536,65_537].map(n=>`Boundary ${n}`).sort());
  }finally{f.close();}
});

test('fixed-window speech hashing matches SHA-256 for empty, exact-block and partial-final-block files',()=>{
  const f=fixture();
  try {
    for(const size of [0,65_536,65_536*3+17]) {
      const data=Buffer.alloc(size);for(let i=0;i<size;i++)data[i]=(i*31+Math.floor(i/65_536))%256;
      const file=join(f.root,`hash-${size}.bin`);writeFileSync(file,data);
      assert.equal(speechAssetHash(file),createHash('sha256').update(data).digest('hex'));
    }
  }finally{f.close();}
});

test('speech hashing rejects symlink and directory assets',()=>{
  const f=fixture();
  try {
    const target=join(f.root,'model.bin'),link=join(f.root,'linked-model.bin');writeFileSync(target,'fixture');symlinkSync(target,link);
    assert.throws(()=>speechAssetHash(link));assert.throws(()=>speechAssetHash(f.project),/regular files/);
    assert.equal(speechAssetHash(target),createHash('sha256').update('fixture').digest('hex'));
  }finally{f.close();}
});
