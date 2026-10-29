import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,linkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readErrandProfile,readOwnedErrandProfile,selectErrandProfileNotes} from '../src/errand-profile.js';
import {Store,hash} from '../src/store.js';
import {OwnerMemory,ABOUT_ME} from '../src/owner-memory.js';

test('profile notes preserve whole owner lines and never invent experience',()=>{
  const profile=['# Synthetic About you','- Name: Synthetic Flutter','- I have not used Flutter.','- Built a synthetic Flutter prototype.','- Unrelated private note.','- Flutter password: synthetic','- My Flutter secret token is synthetic','- Flutter\u202ereversed'].join('\n');
  assert.deepEqual(selectErrandProfileNotes(profile,{role:'Senior Flutter Engineer',location:'Bangalore'}),['- I have not used Flutter.','- Built a synthetic Flutter prototype.']);
  assert.deepEqual(selectErrandProfileNotes(profile,{role:'Designer',location:'Bangalore'}),[]);
  assert.deepEqual(selectErrandProfileNotes('- I used C++ for a synthetic project.\n- C+++ is different.',{role:'Engineer',location:'Bangalore',skills:['C++']}),['- I used C++ for a synthetic project.']);
  assert.deepEqual(selectErrandProfileNotes('- Email: synthetic@example.test\n- Flutter **not** used.',{role:'Flutter',location:'Bangalore'}),['- Flutter **not** used.']);
});

test('fixed About-you reader rejects symlinks, hard links and oversized or invalid files',()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-profile-source-')),dir=join(root,'memory'),path=join(dir,'about-me.md');
  try{
    mkdirSync(dir);writeFileSync(path,'- Synthetic Flutter work.\n');
    if(process.platform==='win32'){assert.equal(readErrandProfile(dir),undefined);return;}
    assert.equal(readErrandProfile(dir)?.text,'- Synthetic Flutter work.\n');
    linkSync(path,join(root,'hardlink'));assert.equal(readErrandProfile(dir),undefined);rmSync(join(root,'hardlink'));
    rmSync(path);symlinkSync(join(root,'missing'),path);assert.equal(readErrandProfile(dir),undefined);rmSync(path);
    writeFileSync(path,'x'.repeat(8001));assert.equal(readErrandProfile(dir),undefined);
    writeFileSync(path,Buffer.from([0xff]));assert.equal(readErrandProfile(dir),undefined);
    symlinkSync(dir,join(root,'alias'));assert.equal(readErrandProfile(join(root,'alias')),undefined);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('owner provenance and file revisions fail closed across owner changes and file changes',()=>{
  const root=mkdtempSync(join(tmpdir(),'ffd-profile-owner-')),store=new Store(':memory:'),owner='123@s.whatsapp.net';
  try{
    const memory=new OwnerMemory(store,root),text='# About you\n- Synthetic Flutter work.\n- Old Flutter item two.\n- Old Flutter item three.\n';store.set('whatsapp-owner',owner);
    store.db.exec('CREATE TABLE brain_tasks(id TEXT PRIMARY KEY,original TEXT NOT NULL,source TEXT NOT NULL,destination TEXT)');
    store.db.exec('CREATE TABLE errand_profile_inputs(request_id TEXT PRIMARY KEY,owner TEXT NOT NULL,destination TEXT NOT NULL,generation TEXT NOT NULL,body_hash TEXT NOT NULL,eligible INTEGER NOT NULL)');
    const record=(id:string,original:string,context:{owner:string;destination:string;generation:string})=>{store.db.prepare('INSERT INTO errand_profile_inputs VALUES(?,?,?,?,?,1)').run(id,context.owner,context.destination,context.generation,hash(original));store.recordOwnerOrigin(id,context.destination,context.owner);};
    store.db.prepare('INSERT INTO brain_tasks VALUES(?,?,?,?)').run('wa:memory','Synthetic Flutter work.','text',owner);
    const context=store.captureIncomingOwner(owner,'whatsapp')!;
    store.incomingOwnerContext.run(context,()=>{record('wa:memory','Synthetic Flutter work.',context);memory.write(ABOUT_ME,text,'brain:wa:memory');});
    const scope={requestId:'wa:job',owner,destination:owner,bindingId:'binding',bindingIdentity:'identity'};
    const contract={role:'Flutter',location:'Bangalore'};
    if(process.platform==='win32'){assert.equal(readOwnedErrandProfile(store,scope,memory.dir,contract),undefined);return;}
    const first=readOwnedErrandProfile(store,scope,memory.dir,contract);assert.equal(first?.text,'- Synthetic Flutter work.');
    writeFileSync(join(memory.dir,ABOUT_ME),'# About you\n- Different Flutter work.\n');assert.equal(readOwnedErrandProfile(store,scope,memory.dir,contract),undefined);
    writeFileSync(join(memory.dir,ABOUT_ME),text);const restored=readOwnedErrandProfile(store,scope,memory.dir,contract);assert.equal(restored?.text,'- Synthetic Flutter work.');assert.notEqual(restored?.revision,first?.revision);
    const other='other@s.whatsapp.net';store.set('whatsapp-owner',other);const otherScope={...scope,owner:other,destination:other};
    assert.equal(readOwnedErrandProfile(store,otherScope,memory.dir,contract)?.text,'');
    const otherContext=store.captureIncomingOwner(other,'whatsapp')!;
    store.db.prepare('INSERT INTO brain_tasks VALUES(?,?,?,?)').run('wa:other','Name: Other','text',other);
    store.incomingOwnerContext.run(otherContext,()=>{record('wa:other','Name: Other',otherContext);memory.write(ABOUT_ME,text+'- Name: Other\n','brain:wa:other');});
    assert.equal(readOwnedErrandProfile(store,otherScope,memory.dir,contract)?.text,'');
    store.db.prepare('INSERT INTO brain_tasks VALUES(?,?,?,?)').run('wa:invented','I enjoy design.','text',other);
    store.incomingOwnerContext.run(otherContext,()=>{record('wa:invented','I enjoy design.',otherContext);memory.write(ABOUT_ME,text+'- Name: Other\n- I have 10 years of Flutter experience.\n','brain:wa:invented');});
    assert.equal(readOwnedErrandProfile(store,otherScope,memory.dir,contract)?.text,'');
    store.db.prepare('INSERT INTO brain_tasks VALUES(?,?,?,?)').run('wa:context','This is false:\nI have 20 years of Flutter experience.','text',other);
    store.incomingOwnerContext.run(otherContext,()=>{record('wa:context','This is false:\nI have 20 years of Flutter experience.',otherContext);memory.write(ABOUT_ME,text+'- Name: Other\n- I have 10 years of Flutter experience.\n- I have 20 years of Flutter experience.\n','brain:wa:context');});
    assert.equal(readOwnedErrandProfile(store,otherScope,memory.dir,contract)?.text,'');
    store.db.prepare('INSERT INTO brain_tasks VALUES(?,?,?,?)').run('wa:other-fact','I built a synthetic Flutter app.','text',other);
    store.incomingOwnerContext.run(otherContext,()=>{record('wa:other-fact','I built a synthetic Flutter app.',otherContext);memory.write(ABOUT_ME,text+'- Name: Other\n- I have 10 years of Flutter experience.\n- I have 20 years of Flutter experience.\n- I built a synthetic Flutter app.\n','brain:wa:other-fact');});
    assert.equal(readOwnedErrandProfile(store,otherScope,memory.dir,contract)?.text,'- I built a synthetic Flutter app.');
    store.set('whatsapp-owner',owner);assert.equal(readOwnedErrandProfile(store,scope,memory.dir,contract)?.text,'');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
