import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { channelChosen, switchControlChannel } from '../src/control-channel.js';

function fixture(){const store=new Store(':memory:');let wa=0,tg=0;const channels={whatsapp:{disconnectForSwitch:async()=>{wa++;}},telegram:{disconnect:()=>{tg++;}}};return {store,channels,counts:()=>({wa,tg})};}
test('first connection choice does not disconnect or require a previous selection',async()=>{const f=fixture();try{assert.equal(channelChosen(f.store),false);await switchControlChannel(f.store,f.channels,{channel:'telegram'});assert.equal(f.store.controlChannel(),'telegram');assert.equal(channelChosen(f.store),true);assert.deepEqual(f.counts(),{wa:0,tg:0});}finally{f.store.close();}});
test('switch requires exact confirmation and finishes WhatsApp logout before changing selection',async()=>{const f=fixture();try{f.store.set('whatsapp-owner','owner@s.whatsapp.net');assert.equal(channelChosen(f.store),true);
 await assert.rejects(switchControlChannel(f.store,f.channels,{channel:'telegram'}),/Confirm/);
 await assert.rejects(switchControlChannel(f.store,f.channels,{channel:'telegram',confirmed:true,expectedChannel:'telegram'}),/selection changed/);
 f.channels.whatsapp.disconnectForSwitch=async()=>{assert.equal(f.store.controlChannel(),'whatsapp');};
 f.store.output(undefined,'old reply','reply','owner@s.whatsapp.net');
 await switchControlChannel(f.store,f.channels,{channel:'telegram',confirmed:true,expectedChannel:'whatsapp'});
 assert.equal(f.store.controlChannel(),'telegram');assert.equal(f.store.outbound().destination,'owner@s.whatsapp.net');
 }finally{f.store.close();}});
test('failed logout preserves current selection and pending requests',async()=>{const f=fixture();try{f.store.set('control-channel','whatsapp');f.channels.whatsapp.disconnectForSwitch=async()=>{throw new Error('offline logout');};await assert.rejects(switchControlChannel(f.store,f.channels,{channel:'telegram',confirmed:true,expectedChannel:'whatsapp'}),/offline/);assert.equal(f.store.controlChannel(),'whatsapp');}finally{f.store.close();}});
test('Telegram switch disconnects the bot once; repeating the same choice is a no-op',async()=>{const f=fixture();try{f.store.set('control-channel','telegram');f.store.set('telegram-bot-id','123456');const input={channel:'whatsapp',confirmed:true,expectedChannel:'telegram'};await switchControlChannel(f.store,f.channels,input);await switchControlChannel(f.store,f.channels,input);assert.deepEqual(f.counts(),{wa:0,tg:1});}finally{f.store.close();}});
test('concurrent switches cannot race the native logout',async()=>{const f=fixture();try{f.store.set('control-channel','whatsapp');let finish!:()=>void;let begun!:()=>void;const started=new Promise<void>(r=>{begun=r;});f.channels.whatsapp.disconnectForSwitch=()=>new Promise<void>(r=>{finish=r;begun();});const input={channel:'telegram',confirmed:true,expectedChannel:'whatsapp'};const one=switchControlChannel(f.store,f.channels,input);await started;await assert.rejects(switchControlChannel(f.store,f.channels,input),/in progress/);assert.equal(f.store.controlChannel(),'whatsapp');finish();await one;assert.equal(f.store.controlChannel(),'telegram');}finally{f.store.close();}});


test('choosing Telegram without configuring a bot switches immediately without consent',async()=>{const f=fixture();try{await switchControlChannel(f.store,f.channels,{channel:'telegram'});await switchControlChannel(f.store,f.channels,{channel:'whatsapp',expectedChannel:'telegram'});assert.equal(f.store.controlChannel(),'whatsapp');}finally{f.store.close();}});
test('offline saved Telegram bot still requires consent, and stale empty UI cannot remove it',async()=>{const f=fixture();try{f.store.set('control-channel','telegram');f.store.set('telegram-bot-id','123456');await assert.rejects(switchControlChannel(f.store,f.channels,{channel:'whatsapp',expectedChannel:'telegram'}),/Confirm/);assert.equal(f.counts().tg,0);assert.equal(f.store.controlChannel(),'telegram');}finally{f.store.close();}});
test('historical WhatsApp owner does not imply an active login after logout',async()=>{const f=fixture();try{f.store.set('control-channel','whatsapp');f.store.set('whatsapp-owner','old@s.whatsapp.net');const channels={...f.channels,whatsapp:{...f.channels.whatsapp,switchState:async()=>'none' as const}};await switchControlChannel(f.store,channels,{channel:'telegram',expectedChannel:'whatsapp'});assert.equal(f.store.controlChannel(),'telegram');assert.equal(f.store.get('whatsapp-owner'),'old@s.whatsapp.net');}finally{f.store.close();}});


test('disconnect requires current-channel confirmation and preserves selection and background preference',async()=>{
  const {disconnectControlChannel}=await import('../src/control-channel.js');
  const store=new Store(':memory:');let disconnected=0;
  try {
    store.set('control-channel','telegram');store.set('background-enabled','true');
    const channels={whatsapp:{disconnectForSwitch:async()=>{throw new Error('Wrong app');}},telegram:{disconnect:()=>{disconnected++;}}};
    await assert.rejects(disconnectControlChannel(store,channels,{expectedChannel:'telegram'}),/Confirm/);
    await assert.rejects(disconnectControlChannel(store,channels,{confirmed:true,expectedChannel:'whatsapp'}),/Confirm/);
    assert.equal(disconnected,0);
    assert.deepEqual(await disconnectControlChannel(store,channels,{confirmed:true,expectedChannel:'telegram'}),{channel:'telegram',disconnected:true});
    assert.equal(disconnected,1);assert.equal(store.controlChannel(),'telegram');assert.equal(store.get('background-enabled'),'true');
  }finally{store.close();}
});
