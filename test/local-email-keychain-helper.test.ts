import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MailKeychainHelper} from '../src/local-email/keychain-helper.js';
const dir=mkdtempSync(join(tmpdir(),'ffd-mail-helper-'));test.after(()=>rmSync(dir,{recursive:true,force:true}));
const slot='0123456789abcdef0123456789abcdef';
function helper(name:string,body:string){const path=join(dir,name);writeFileSync(path,`#!${process.execPath}\n${body}`,{mode:0o700});return path;}
test('helper passes a synthetic credential via stdin, without command-line secrets',async()=>{
  const executable=helper('success',`process.stdout.write('{"ready":true}\\n');let s='';process.stdin.on('data',c=>{s+=c;let i;while((i=s.indexOf('\\n'))>=0){const v=JSON.parse(s.slice(0,i));s=s.slice(i+1);if(process.argv.length!==3||v.slot!=='${slot}')process.exit(1);process.stdout.write(JSON.stringify({ok:true,value:v.action==='read'?'synthetic-password':null})+'\\n');}});`);
  const vault=new MailKeychainHelper(executable,join(dir,'fake.lock'));await vault.start();try{await vault.write(slot,'synthetic-password');assert.equal(await vault.read(slot),'synthetic-password');await vault.remove(slot);await assert.rejects(vault.write('invalid','synthetic-password'));}finally{await vault.close();}
});
test('timeout kills and reaps the helper before a failed write settles',async()=>{
  const marker=join(dir,'must-not-exist');const executable=helper('hang',`process.stdout.write('{"ready":true}\\n');process.stdin.resume();setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),1800);setInterval(()=>{},1000);`);
  const vault=new MailKeychainHelper(executable,join(dir,'fake2.lock'),1000);await vault.start();await assert.rejects(vault.write(slot,'synthetic-password'));await new Promise(r=>setTimeout(r,2000));assert.equal(existsSync(marker),false);
});
test('the native broker retains its exclusive lock until the process exits',async()=>{
  if(process.platform!=='darwin')return;
  const executable=join(dir,'broker');execFileSync('/usr/bin/swiftc',['native/local-mail-keychain.swift','-o',executable],{stdio:'ignore'});
  const lock=join(dir,'broker.lock'),first=new MailKeychainHelper(executable,lock),second=new MailKeychainHelper(executable,lock);await first.start();
  try{await assert.rejects(second.start());assert.equal(first.isLocked(),true);}finally{await first.close();}
  const replacement=new MailKeychainHelper(executable,lock);await replacement.start();await replacement.close();
});
test('Keychain broker stores and deletes only synthetic credentials in an isolated temporary keychain',async()=>{
 if(process.platform!=='darwin')return;
 const creator=join(dir,'create-keychain.swift'),creatorBin=join(dir,'create-keychain'),broker=join(dir,'fixture-broker'),keychain=join(dir,'fixture.keychain'),wrapper=join(dir,'fixture-wrapper');
 writeFileSync(creator,`import Security\nimport Foundation\nvar k: SecKeychain?\nlet p="synthetic-fixture-password"\nlet status=SecKeychainCreate(CommandLine.arguments[1], UInt32(p.utf8.count), p, false, nil, &k)\nexit(status == errSecSuccess ? 0 : 1)\n`);
 execFileSync('/usr/bin/swiftc',[creator,'-o',creatorBin],{stdio:'ignore'});execFileSync(creatorBin,[keychain],{stdio:'ignore'});
 execFileSync('/usr/bin/swiftc',['-D','MAIL_SYNTHETIC_TEST','native/local-mail-keychain.swift','-o',broker],{stdio:'ignore'});
 writeFileSync(wrapper,`#!/bin/sh\nexec '${broker}' "$1" '${keychain}'\n`,{mode:0o700});
 const vault=new MailKeychainHelper(wrapper,join(dir,'fixture-lock'));await vault.start();try{
   assert.equal(await vault.read(slot),undefined);await vault.write(slot,'synthetic-secret');assert.equal(await vault.read(slot),'synthetic-secret');await vault.remove(slot);assert.equal(await vault.read(slot),undefined);await vault.remove(slot);
 }finally{await vault.close();}
});
