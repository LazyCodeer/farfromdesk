import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseSocialPlan,renderSocialPlan,socialRenderPlanSchema} from './engine/social-renderer.js';
const [command,input,output]=process.argv.slice(2);
if(command==='schema')console.log(JSON.stringify(socialRenderPlanSchema,null,2));
else if(command==='render'&&input&&output){
 const bytes=readFileSync(input);if(bytes.length>150000)throw Error('Plan exceeds 150 KB.');
 const plan=parseSocialPlan(JSON.parse(bytes));if(plan.mode!=='svg')throw Error('Use FarFromDesk request tools for Meta/hybrid artwork.');
 const dir=resolve(output);mkdirSync(dir,{recursive:false});
 const slides=await renderSocialPlan(plan);
 const manifest=[];
 for(const [i,s] of slides.entries()){
  const name=String(i+1).padStart(2,'0');writeFileSync(`${dir}/${name}.jpg`,Buffer.from(s.base64,'base64'));writeFileSync(`${dir}/${name}-phone.jpg`,Buffer.from(s.thumbnail,'base64'));
  manifest.push({file:name+'.jpg',width:1080,height:1350,sha256:s.sha256,alt:s.alt});
 }
 writeFileSync(`${dir}/manifest.json`,JSON.stringify(manifest,null,2));console.log(JSON.stringify({output:dir,slides:manifest.length}));
}else throw Error('Use: node scripts/render.mjs schema | render PLAN.json NEW_OUTPUT_DIR');
