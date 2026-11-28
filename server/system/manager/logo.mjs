import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {SERVER_LOGO_LIMIT,validLogoPng} from '../../shared/discovery.mjs';
import {atomicJson,readJson,SerialStore} from './storage.mjs';

export class ManagerLogo{
 constructor(directory,logs){
  this.file=join(directory,'manager','server-logo.json');
  this.logs=logs;
  this.lock=new SerialStore();
  this.image=null;
 }
 async open(){
  const value=await readJson(this.file,{schema:1,png:null},Math.ceil(SERVER_LOGO_LIMIT*4/3)+256);
  if(value?.schema!==1)throw Error('invalid_server_logo');
  if(value.png===null){this.image=null;return;}
  if(typeof value.png!=='string')throw Error('invalid_server_logo');
  this.image=this.validate(Buffer.from(value.png,'base64'));
 }
 validate(bytes){
  if(!validLogoPng(bytes))throw Error('invalid_server_logo');
  return {bytes,hash:createHash('sha256').update(bytes).digest('hex')};
 }
 async set(bytes,actor){
  const image=bytes===null?null:this.validate(bytes);
  return this.lock.run(async()=>{
   if(image?.hash===this.image?.hash)return this.metadata();
   await this.logs.audit(actor,image?'branding.logo.set':'branding.logo.remove');
   await atomicJson(this.file,{schema:1,png:image?.bytes.toString('base64')??null});
   this.image=image;
   return this.metadata();
  });
 }
 metadata(){return {logo:this.image?.hash??null};}
}
