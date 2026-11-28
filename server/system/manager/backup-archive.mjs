import {createReadStream} from 'node:fs';
import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {Readable} from 'node:stream';

const magic=Buffer.from('HVMPBAK1');
export const maxBackupManifest=2*1024*1024;
export const maxFullBackupBytes=256*1024**3;

export function exportBackup(folder,manifest){
 const metadata=Buffer.from(JSON.stringify(manifest)),header=Buffer.alloc(12);
 magic.copy(header);
 header.writeUInt32LE(metadata.length,8);
 const stream=Readable.from((async function*(){
  yield header;
  yield metadata;
  for(const file of manifest.files){
   const hash=createHash('sha256');let bytes=0;
   for await(const chunk of createReadStream(join(folder,file.path))){
    bytes+=chunk.length;
    if(bytes>file.size)throw Error('backup_corrupt');
    hash.update(chunk);yield chunk;
   }
   if(bytes!==file.size||hash.digest('hex')!==file.sha256)throw Error('backup_corrupt');
  }
 })());
 return {stream,bytes:header.length+metadata.length+manifest.bytes};
}

export async function importBackup(stream,folder,validate){
 const input=stream.iterator({destroyOnReturn:false});
 let pending=Buffer.alloc(0);
 async function* take(length){
  while(length>0){
   if(!pending.length){
    const next=await input.next();
    if(next.done)throw Error('backup_corrupt');
    pending=next.value;
   }
   const size=Math.min(pending.length,length);
   yield pending.subarray(0,size);
   pending=pending.subarray(size);
   length-=size;
  }
 }
 async function metadata(length){
  const chunks=[];
  for await(const chunk of take(length))chunks.push(chunk);
  return Buffer.concat(chunks,length);
 }
 try{
  const header=await metadata(12);
  const size=header.readUInt32LE(8);
  if(!header.subarray(0,8).equals(magic)||size>maxBackupManifest||size<2)throw Error('invalid_backup');
  let manifest;
  try{manifest=validate(JSON.parse(await metadata(size)));}catch{throw Error('invalid_backup');}
  for(const file of manifest.files){
   const handle=await open(join(folder,file.path),'wx',0o600),hash=createHash('sha256');
   try{
    for await(const chunk of take(file.size)){
     hash.update(chunk);
     await handle.writeFile(chunk);
    }
    if(hash.digest('hex')!==file.sha256)throw Error('backup_corrupt');
    await handle.sync();
   }finally{await handle.close();}
  }
  if(pending.length||!(await input.next()).done)throw Error('invalid_backup');
  return manifest;
 }finally{await input.return?.();}
}
