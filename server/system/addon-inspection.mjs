import {open,readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {MAX_ADDON_ORDER_BYTES,optionalSlots} from '../shared/optional-order.mjs';

export const addonName=name=>typeof name==='string'&&/^[\p{L}\p{N}][^/\\\u0000-\u001f\u007f:]{0,179}\.(?:scs|zip)$/iu.test(name);
// Keep the public .scs contract understood by installed clients. Bytes are not
// converted or extracted: ETS2 detects ZIP/HashFS from the archive itself.
export function publicAddonName(name){
 const result=/\.zip$/i.test(name)?name+'.scs':name;
 if(/^[A-Za-z0-9][A-Za-z0-9._-]{0,90}\.scs$/i.test(result))return result;
 const stem=name.replace(/\.(?:scs|zip)$/i,'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9._-]/g,'_').replace(/^[^A-Za-z0-9]+/,'')||'addon';
 return stem.slice(0,65)+'-'+createHash('sha256').update(name).digest('hex').slice(0,12)+'.scs';
}
export async function addonOrder(directory,names,log=()=>{}){
 let config={};try{const file=join(directory,'order.json'),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>MAX_ADDON_ORDER_BYTES)throw Error('Invalid order.json.');config=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(k=>!['schema','order','disabled','optional'].includes(k))||config.schema!==undefined&&config.schema!==1)throw Error('Invalid addons/order.json configuration.');
 const lists={};for(const key of ['order','disabled']){const values=config[key]??[];if(!Array.isArray(values)||values.length>256||values.some(n=>!addonName(n))||new Set(values.map(n=>n.toLowerCase())).size!==values.length)throw Error('Liste '+key+' is invalid in addons/order.json.');lists[key]=values;}
 const existing=new Map(names.map(n=>[n.toLowerCase(),n]));if(existing.size!==names.length)throw Error('Duplicate add-on names ignoring case.');
 for(const name of [...lists.order,...lists.disabled])if(!existing.has(name.toLowerCase()))log('Add-ons: skipped missing entry in order.json: '+name);
 const disabled=new Set(lists.disabled.map(n=>n.toLowerCase())),specified=new Set(lists.order.map(n=>n.toLowerCase()));
 const selected=[...names.filter(n=>!specified.has(n.toLowerCase())),...lists.order.map(n=>existing.get(n.toLowerCase())).filter(Boolean)].filter(n=>!disabled.has(n.toLowerCase()));
 return {selected,disabled:names.filter(n=>disabled.has(n.toLowerCase())),optional:optionalSlots(config.optional??[])};
}
async function exact(file,offset,size){const b=Buffer.alloc(size);const result=await file.read(b,0,size,offset);if(result.bytesRead!==size)throw Error('Truncated add-on index.');return b;}
async function archiveIndex(path){
 const file=await open(path,'r');try{
  const {size}=await file.stat(),signature=await exact(file,0,4);
  if(signature.toString('ascii')==='SCS#')return {format:'hashfs',complete:false,reason:'native_index_not_inspected',paths:[]};
  if(signature.readUInt32LE()!==0x04034b50&&signature.readUInt32LE()!==0x06054b50)return {format:'opaque',complete:false,reason:'unrecognized_archive_index',paths:[]};
  const length=Math.min(size,65557),tail=await exact(file,size-length,length);let end=-1;
  for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
  if(end<0)throw Error('Incomplete ZIP archive.');
  if(tail.readUInt32LE(end+4)!==0)throw Error('Multi-volume ZIP archives are unsupported.');
  const count=tail.readUInt16LE(end+10),bytes=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
  if(count===65535||offset===0xffffffff||bytes===0xffffffff||bytes>16*1024*1024)return {format:'zip',complete:false,reason:'zip64_or_index_budget',paths:[]};
  if(offset+bytes>size-length+end)throw Error('ZIP index outside the archive.');
  const directory=await exact(file,offset,bytes),paths=[];let at=0,nested=0,resources=0;
  for(let i=0;i<count;i++){
   if(at+46>directory.length||directory.readUInt32LE(at)!==0x02014b50)throw Error('Invalid ZIP index.');
   const n=directory.readUInt16LE(at+28),next=at+46+n+directory.readUInt16LE(at+30)+directory.readUInt16LE(at+32);
   if(next>directory.length||n>1024)throw Error('Invalid ZIP path.');
   const name=directory.toString('utf8',at+46,at+46+n);
   if(!name||name.includes('\0')||name.includes('\\')||name.startsWith('/')||name.split('/').some(p=>p==='..'||p==='.')||/^[A-Za-z]:/.test(name))throw Error('Unsafe path in add-on archive.');
   const external=directory.readUInt32LE(at+38);if((external>>>16&0xf000)===0xa000)throw Error('Symbolic link in add-on archive.');
   if(!name.endsWith('/')){
    if(/\.(?:scs|zip)$/i.test(name))nested++;
    if(/^(def|vehicle|material|model|map|sound|ui|font|unit|locale|prefab|automat|effect|system)\//i.test(name))resources++;
    paths.push({path:name.toLowerCase(),crc:directory.readUInt32LE(at+16),size:directory.readUInt32LE(at+24)});
   }
   at=next;
  }
  if(at!==directory.length)throw Error('Ambiguous ZIP index.');
  if(nested&&!resources)throw Error('This ZIP contains other archives. Extract its add-ons into addons/ before starting.');
  return {format:'zip',complete:true,paths};
 }finally{await file.close();}
}
export async function inspectAddons(files,{disabled=[],maxPaths=200000,maxConflicts=200}={}){
 const owners=new Map(),archives=[],conflicts=[],archiveHashes=new Map(),duplicateArchives=[];let conflictCount=0,indexedFiles=0,complete=true;
 const mapModules=new Set();
 for(const file of files){
  if(file.sha256){if(archiveHashes.has(file.sha256))duplicateArchives.push({first:archiveHashes.get(file.sha256),duplicate:file.sourceName,sha256:file.sha256});else archiveHashes.set(file.sha256,file.sourceName);}
  let index;try{index=await archiveIndex(file.path);}catch(e){throw Error('Addon '+file.sourceName+' : '+e.message);}
  archives.push({name:file.sourceName,publishedName:file.name,format:index.format,complete:index.complete,reason:index.reason??null,entries:index.paths.length});
  if(!index.complete){complete=false;owners.clear();continue;} // Later opaque archive may override every known path.
  for(const entry of index.paths){
   const module=/^map\/([a-z0-9_][a-z0-9_-]{0,63})\.mbd$/.exec(entry.path);
   if(module)mapModules.add(module[1]);
   indexedFiles++;const previous=owners.get(entry.path);
   if(previous){conflictCount++;if(conflicts.length<maxConflicts)conflicts.push({path:entry.path,overridden:previous.name,winner:file.sourceName,sameSizeAndCrc:previous.crc===entry.crc&&previous.size===entry.size});}
   if(owners.size<maxPaths||previous)owners.set(entry.path,{...entry,name:file.sourceName});else complete=false;
  }
 }
 return {schema:1,order:files.map(f=>f.sourceName),disabled,archives,indexedFiles,mapModules:[...mapModules].sort(),conflictCount,conflicts,duplicateArchives,conflictsTruncated:conflictCount>conflicts.length,complete,
  note:'Later addons have higher priority. File overrides are not necessarily errors. HashFS/ZIP64 and budget-limited indexes are reported as incomplete.'};
}
