import {vectorSceneSchema} from '../src/social-vector.js';
import './brain-fixture-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseSocialPlan,renderSocialPlan} from '../src/social-renderer.js';
import {socialCreativeGuide} from '../src/social-creative-skill.js';
import {assertCreativeRequest,renderSessionSocialCarousel} from '../src/social-session-render.js';
import {Store} from '../src/store.js';
import {Router} from '../src/router.js';
import {Approvals} from '../src/approvals.js';
import {SocialAssistant} from '../src/social-assistant.js';
import {saveSessionSocialDrafts} from '../src/social-session-drafts.js';
const plan={mode:'svg',brand:{name:'Sample brand',accent:'#FF682B',background:'#10191D',foreground:'#F5EFE7'},slides:[{layout:'cover',headline:'One useful idea.',body:'A specific promise.'},{layout:'steps',headline:'Make it practical.',points:['Understand the question','Prepare a useful answer','Review the next step']}]};
async function fixture(provider:'codex'|'claude',imageProvider:'local'|'meta'='local'){
 const root=mkdtempSync(join(tmpdir(),'creative-tools-')),s=new Store(':memory:'),a=new Approvals(s),r=new Router(s,{run:async()=>{},stop:()=>{}} as any,a);r.pump=()=>{};
 const owner='tg:123',id=owner+':1';s.set('control-channel','telegram');s.set('telegram-owner',owner);const b=s.register('creative',provider,randomUUID(),root).binding;s.set('active',b.id);
 await s.destinationContext.run(owner,()=>r.receive({id,text:`/social create an Instagram carousel about developer workflows using ${imageProvider==='meta'?'Meta API':'SVG'}`,ownerCommand:true,ownerIntent:true}));s.jobState(id,'dispatched');
 const social=new SocialAssistant(s.db,()=>{throw Error('SVG must not read an API key');});
 const draftId=saveSessionSocialDrafts(s,b,id,'creative-test-01',[{platform:'Instagram',format:'Carousel',title:'One useful idea',caption:'A useful example.'}]).draftIds[0];
 return {s,a,r,b,id,social,draftId,close(){a.cancel();s.close();rmSync(root,{recursive:true,force:true});}};
}
test('creative schema rejects executable inputs, external images and incompatible modes',()=>{
 assert.throws(()=>parseSocialPlan({...plan,url:'https://example.com/image'}));
 assert.throws(()=>parseSocialPlan({...plan,slides:[{layout:'cover',headline:'Hello',svg:'<script/>'}]}));
 assert.throws(()=>parseSocialPlan({...plan,slides:[{layout:'cover',headline:'Hello',artwork:true}]}));
 assert.throws(()=>parseSocialPlan({...plan,mode:'hybrid'}));
 assert.throws(()=>parseSocialPlan({...plan,slides:Array(9).fill(plan.slides[0])}));
 assert.throws(()=>parseSocialPlan({...plan,slides:[{layout:'conversation',headline:'Hello'}]}));
 assert.throws(()=>parseSocialPlan({...plan,brand:{...plan.brand,accent:'url(https://example.com)'}}));
 assert.ok(socialCreativeGuide().schema);assert.equal(socialCreativeGuide().capabilities.svg,true);
});
test('rendered slides have actual ordered JPEGs, escaped copy and valid thumbnails',async()=>{
 const p=parseSocialPlan({...plan,slides:[{layout:'cover',headline:'<b>Literal & safe</b>'},plan.slides[1]]});
 const images=await renderSocialPlan(p);assert.equal(images.length,2);assert.notEqual(images[0].sha256,images[1].sha256);
 for(const i of images){const m=await sharp(Buffer.from(i.base64,'base64')).metadata();assert.equal(m.width,1080);assert.equal(m.height,1350);assert.equal(m.format,'jpeg');const t=await sharp(Buffer.from(i.thumbnail,'base64')).metadata();assert.equal(t.width,360);assert.equal(t.height,450);}
 assert.match(images[0].alt,/<b>Literal & safe<\/b>/);
});
test('hybrid requires saved valid artwork and renders without another provider call',async()=>{
 const p=parseSocialPlan({...plan,mode:'hybrid',slides:[{layout:'cover',headline:'Context, composed.',artwork:true}]});
 await assert.rejects(()=>renderSocialPlan(p),/artwork/);
 const image=await sharp({create:{width:100,height:100,channels:3,background:'#224466'}}).jpeg().toBuffer();
 assert.equal((await renderSocialPlan(p,image)).length,1);
});
for(const provider of ['codex','claude'] as const)test(`${provider} saves a complete SVG carousel, retries idempotently and refuses stale revisions`,async()=>{
 const f=await fixture(provider);try{
  const result=await renderSessionSocialCarousel(f.s,f.b,f.social,f.id,f.draftId,1,plan);assert.equal(result.slideCount,2);assert.equal(result.revision,2);
  const saved=f.social.get(f.draftId);assert.equal(saved.carousel?.slides.length,2);assert.ok((f.social.list().drafts[0] as any).thumbnail);
  assert.equal((await renderSessionSocialCarousel(f.s,f.b,f.social,f.id,f.draftId,1,plan)).duplicate,true);
  await assert.rejects(()=>renderSessionSocialCarousel(f.s,f.b,f.social,f.id,f.draftId,1,{...plan,slides:[{layout:'cover',headline:'Changed'}]}),/changed/i);
  f.social.update(f.draftId,2,{caption:'Owner revision'});
  await assert.rejects(()=>renderSessionSocialCarousel(f.s,f.b,f.social,f.id,f.draftId,1,plan),/changed/i);
 }finally{f.close();}
});
test('rendering cannot cross sessions, survive a changed owner or save after completion',async()=>{
 const f=await fixture('codex');try{
  const other=f.s.register('other','claude',randomUUID(),f.b.cwd).binding;
  assert.throws(()=>assertCreativeRequest(f.s,other,f.id),/no longer active/);
  const pending=renderSessionSocialCarousel(f.s,f.b,f.social,f.id,f.draftId,1,plan);
  await assert.rejects(()=>renderSessionSocialCarousel(f.s,f.b,f.social,f.id,f.draftId,1,plan),/rendering/);
  f.s.jobState(f.id,'completed');
  await assert.rejects(()=>pending,/no longer active/);assert.equal(f.social.get(f.draftId).carousel,undefined);
 }finally{f.close();}
});


test('illustration library and original drawing render real, distinct media without keys',async()=>{
 const scene={gradients:[{id:'g0',x1:0,y1:0,x2:1,y2:1,stops:[{offset:0,color:'#c4b5fd'},{offset:.3,color:'#8b5cf6'},{offset:.7,color:'#4f46e5'},{offset:1,color:'#312e81'}]}],shapes:[{type:'ellipse',cx:500,cy:560,rx:250,ry:35,fill:'#4338ca',opacity:.2},{type:'path',d:'M250 180L570 100L760 240L430 340Z',fill:'url(#g0)'},{type:'path',d:'M430 340L760 240L760 460L430 580Z',fill:'#4338ca'}]};
 const p=parseSocialPlan({...plan,slides:[{layout:'illustration',illustration:'cart',headline:'Recover thoughtfully.',tone:'dark'},{layout:'illustration',drawing:scene,headline:'Create an original scene.',tone:'light'}]});
 const out=await renderSocialPlan(p);assert.equal(out.length,2);assert.notEqual(out[0].sha256,out[1].sha256);
 for(const s of out){const m=await sharp(Buffer.from(s.base64,'base64')).metadata();assert.equal(m.width,1080);assert.equal(m.height,1350);}
});
test('original drawing schema blocks markup, external references and unbounded work',()=>{
 const valid={shapes:[{type:'path',d:'M0 0L100 100Z',fill:'#4f46e5'}]};
 assert.ok(vectorSceneSchema.parse(valid));
 for(const shape of [{type:'path',d:'M0 0<script/>',fill:'#4f46e5'},{type:'path',d:'M999999 0',fill:'#4f46e5'},{type:'rect',x:0,y:0,width:100,height:100,fill:'url(https://example.com)'},{type:'path',d:'M0 0L10 20',fill:'url(#g0)'},{type:'image',href:'file:///private'}])assert.throws(()=>vectorSceneSchema.parse({shapes:[shape]}));
 assert.throws(()=>vectorSceneSchema.parse({shapes:Array(221).fill(valid.shapes[0])}));
 assert.throws(()=>parseSocialPlan({...plan,slides:[{layout:'illustration',illustration:'cart',drawing:valid,headline:'Mixed'}]}));
 assert.throws(()=>parseSocialPlan({...plan,brand:{...plan.brand,logo:'spliceai'}}));
});

test('Meta-selected requests cannot silently render SVG or hybrid without saved artwork',async()=>{
 const f=await fixture('codex','meta');try{
  await assert.rejects(()=>renderSessionSocialCarousel(f.s,f.b,f.social,f.id,f.draftId,1,plan),/Meta/);
  await assert.rejects(()=>renderSessionSocialCarousel(f.s,f.b,f.social,f.id,f.draftId,1,{...plan,mode:'hybrid',slides:[{layout:'cover',headline:'Hello',artwork:true}]}),/artwork|image/i);
  assert.equal(f.social.get(f.draftId).carousel,undefined);
 }finally{f.close();}
});
