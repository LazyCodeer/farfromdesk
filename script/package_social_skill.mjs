import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),target=join(root,'skills/ffd-social-creative/scripts/engine');mkdirSync(target,{recursive:true});
for(const name of ['social-renderer','social-scene','social-vector','social-jpeg']){
 const code=readFileSync(join(root,'dist',name+'.js'),'utf8').replaceAll('../skills/ffd-social-creative/assets/','../../assets/');
 writeFileSync(join(target,name+'.js'),code);
}
console.log('Packaged portable Social render engine');
