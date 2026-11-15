import {mkdir,lstat,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export const revision=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const inside=(root,path)=>{const rel=relative(resolve(root),resolve(path));if(rel.startsWith('..')||isAbsolute(rel))throw Error('unsafe_path');return resolve(path);};
// Refuse symlinks at every existing component. Paths are never supplied by a browser.
export async function safeDirectory(path){
 const absolute=resolve(path);let cursor=absolute;
 while(true){try{const s=await lstat(cursor);if(!s.isDirectory()||s.isSymbolicLink())throw Error('unsafe_path');}catch(e){if(e.code!=='ENOENT')throw e;}const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
 await mkdir(absolute,{recursive:true,mode:0o700});return absolute;
}
export async function readJson(file,fallback,max=1048576){
 try{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>max)throw Error('unsafe_file');return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return structuredClone(fallback);throw e;}
}
export async function atomicJson(file,value){
 await safeDirectory(dirname(file));try{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink())throw Error('unsafe_file');}catch(e){if(e.code!=='ENOENT')throw e;}
 const temp=join(dirname(file),'.hvmp-'+randomUUID()+'.tmp');
 try{await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}
}
export class SerialStore{
 constructor(){this.tail=Promise.resolve();this.busy=false;}
 run(work){if(this.busy||this.blocked?.())return Promise.reject(Error('operation_busy'));this.busy=true;const result=this.tail.then(work);this.tail=result.catch(()=>{}).finally(()=>{this.busy=false;});return result.finally(()=>{this.busy=false;});}
}
