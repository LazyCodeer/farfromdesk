import test from 'node:test';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

test('synthetic hanging test for cancellation',async()=>{
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(0),12000)"],{stdio:'ignore'});
  process.on('SIGTERM',()=>{});
  writeFileSync(join(process.env.WSB_STATE_DIR!,'started'),`${process.pid} ${child.pid}`);
  setInterval(()=>{},1000);
  setTimeout(()=>process.exit(0),12000);
  await new Promise(()=>{});
});
