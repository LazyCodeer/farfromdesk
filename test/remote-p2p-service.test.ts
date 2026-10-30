import test from 'node:test';
import assert from 'node:assert/strict';
import {RemotePasswordAccess,type PasswordRecord} from '../src/remote-desktop/access.js';
import {RemoteControlService} from '../src/remote-p2p/service.js';

function fakeHost(){
 const calls:string[]=[];let fail:string|undefined;
 return {calls,failWith:(f:string)=>{fail=f;},host:{createOffer:async()=>({link:'https://ffd.codecylabs.com/remote/#OFFER',code:'OFFER'}),acceptAnswer:async(c:string)=>{calls.push(c);if(fail)throw Error(fail);},stop:(r:string)=>{calls.push('stop:'+r);},status:{state:'offered'}}};
}

test('remote control chat: command, password gate, answer intake and errors',{skip:process.platform!=='darwin'},async()=>{
 let record:PasswordRecord|undefined;
 const access=new RemotePasswordAccess({load:()=>record,save:r=>{record=r;}});
 const fake=fakeHost();let made=0,reconnect:((link:string)=>void)|undefined;const notes:string[]=[];
 const service=new RemoteControlService(access,(_a,onReconnect)=>{made++;reconnect=onReconnect;return fake.host as any;},t=>notes.push(t));
 assert.equal(await service.chat('hello'),undefined);
 assert.match(await service.chat('FFD-ANSWER '+'a'.repeat(30))??'',/does not match your latest link/);
 const setup=await service.chat('control my screen')??'';
 assert.match(setup,/Settings > Remote control/);
 assert.doesNotMatch(setup,/same Wi-Fi|Remote Desktop settings/);
 await access.setPassword('service test password 123');
 const reply=await service.chat('Control my Mac')??'';
 assert.match(reply,/https:\/\/ffd\.codecylabs\.com\/remote\/#OFFER/);
 assert.equal(access.status.enabled,true);
 assert.match(await service.chat('FFD-ANSWER '+'b'.repeat(30))??'',/Code received/);
 assert.deepEqual(fake.calls,['b'.repeat(30)]);
 // A new link reuses the same host, so a login kept after a dropped connection survives it.
 fake.failWith('OFFER_EXPIRED');
 await service.chat('/remote');assert.equal(made,1);
 assert.match(await service.chat('FFD-ANSWER '+'c'.repeat(30))??'',/expired/);
 for(const t of ['I want to control my mac','Give me screen access i will create it my self','can I access my mac?','remote access'])assert.ok(await service.chat(t),t);
 for(const t of ['take a screenshot of chrome','open chrome on my mac','control my mac and open chrome'])assert.equal(await service.chat(t),undefined,t);
 reconnect!('https://ffd.codecylabs.com/remote/#NEXT',false);
 assert.match(notes[0],/lost the connection[\s\S]*no password[\s\S]*#NEXT/);
 reconnect!('https://ffd.codecylabs.com/remote/#AGAIN',true);
 assert.match(notes[1],/enter your remote password[\s\S]*#AGAIN/);assert.doesNotMatch(notes[1],/no password/);
 service.stop();assert.deepEqual(fake.calls.at(-1),'stop:STOPPED');
 assert.equal(service.status.state,'idle');
});
