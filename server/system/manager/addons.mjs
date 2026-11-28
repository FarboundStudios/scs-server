import {readdir,lstat,rename,unlink,open} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {addonName,addonOrder,inspectAddons,publicAddonName} from '../addon-inspection.mjs';
import {MAX_ADDON_BYTES} from '../../shared/content.mjs';
import {MAX_ADDON_ORDER_BYTES,optionalSlots} from '../../shared/optional-order.mjs';
import {safeDirectory,atomicJson,readJson,revision} from './storage.mjs';
export class ManagerAddons{
 constructor({directory,privateDirectory,supervisor,logs,lock,maxUpload=MAX_ADDON_BYTES}){Object.assign(this,{directory,privateDirectory,supervisor,logs,lock,maxUpload});}
 stopped(){if(this.supervisor.child||!['stopped','crashed'].includes(this.supervisor.state)||this.supervisor.busy)throw Error('stop_required');}
 async get(){await safeDirectory(this.directory);const names=(await readdir(this.directory)).filter(addonName).sort();if(names.length>256)throw Error('addon_limit');const files=[];
  for(const name of names){const s=await lstat(join(this.directory,name));files.push({name,publicName:publicAddonName(name),size:s.size,modifiedAt:s.mtimeMs,safe:s.isFile()&&!s.isSymbolicLink()&&s.size>=22&&s.size<=MAX_ADDON_BYTES});}
  const order=await addonOrder(this.directory,names),raw=await readJson(join(this.directory,'order.json'),{schema:1,order:[],disabled:[]},MAX_ADDON_ORDER_BYTES);
  const published=this.supervisor.status().meta?.addons??[];
  const payload={files:files.map(f=>({...f,enabled:order.selected.includes(f.name),order:order.selected.indexOf(f.name),published:published.some(p=>p.name===f.publicName&&p.size===f.size)})),order:order.selected,disabled:order.disabled,optional:order.optional};
  await safeDirectory(this.privateDirectory);const quarantine=[];for(const n of await readdir(this.privateDirectory)){const match=/^([a-f0-9-]{36})-(.+)$/.exec(n);if(!match||!addonName(match[2]))continue;const s=await lstat(join(this.privateDirectory,n));if(s.isFile()&&!s.isSymbolicLink())quarantine.push({id:match[1],name:match[2],size:s.size});}
  return {...payload,quarantine,revision:revision({files,raw,quarantine}),maxUpload:this.maxUpload,restartRequired:this.supervisor.state==='running',inspection:this.supervisor.status().meta?.addonsReport??null};
 }
 async save(data,actor,{canEditOptional=false}={}){return this.lock.run(async()=>{this.stopped();const current=await this.get();if(data.revision!==current.revision)throw Error('revision_conflict');
  if(!Array.isArray(data.order)||!Array.isArray(data.disabled)||[...data.order,...data.disabled].some(n=>!current.files.some(f=>f.name===n&&f.safe))||new Set([...data.order,...data.disabled]).size!==current.files.length||data.order.length+data.disabled.length!==current.files.length)throw Error('invalid_addon_order');
  if(data.optional!==undefined&&!canEditOptional)throw Error('permission_denied');
  const optional=data.optional===undefined?current.optional:optionalSlots(data.optional);
  if(data.optional!==undefined&&optional.some(slot=>slot.after!==null&&!data.order.includes(slot.after)))throw Error('invalid_optional_order');
  await this.logs.audit(actor,'addons.order',{order:data.order,disabled:data.disabled,...(data.optional!==undefined?{optional}: {})});
  await atomicJson(join(this.directory,'order.json'),{schema:1,order:data.order,disabled:data.disabled,...(optional.length?{optional}:{})});return this.get();
 });}
 async upload(req,{name,expected},actor){return this.lock.run(async()=>{this.stopped();if(!addonName(name))throw Error('invalid_addon_name');const current=await this.get();if(expected!==current.revision)throw Error('revision_conflict');if(current.files.length>=256||current.files.some(f=>f.name.toLowerCase()===name.toLowerCase()||f.publicName.toLowerCase()===publicAddonName(name).toLowerCase()))throw Error('addon_exists');
  if(Number(req.headers['content-length'])>this.maxUpload)throw Error('upload_too_large');
  await this.logs.audit(actor,'addons.upload.begin',{name});const temp=join(this.directory,'.upload-'+randomUUID()),file=await open(temp,'wx',0o600);let size=0,signature=Buffer.alloc(0);const hash=createHash('sha256');
  try{for await(const b of req){size+=b.length;if(size>this.maxUpload)throw Error('upload_too_large');if(signature.length<4)signature=Buffer.concat([signature,b.subarray(0,4-signature.length)]);hash.update(b);await file.writeFile(b);}await file.close();
   if(size<22||!['SCS#','PK\x03\x04','PK\x05\x06'].includes(signature.toString('latin1')))throw Error('invalid_archive');
   const digest=hash.digest('hex');try{await inspectAddons([{name:publicAddonName(name),sourceName:name,path:temp,sha256:digest}]);}catch{throw Error('invalid_archive');}
   this.stopped();const latest=await this.get();if(latest.revision!==expected)throw Error('revision_conflict');
   // Publish using exclusive creation, preventing replacement of a concurrent SFTP upload.
   const destination=join(this.directory,name);const {link}=await import('node:fs/promises');await link(temp,destination);await unlink(temp);
   await this.logs.audit(actor,'addons.upload.complete',{name,size});this.logs.record('Addon uploaded: '+name+'. Restart the game server to publish it.','info','manager');return this.get();
  }finally{await file.close().catch(()=>{});await unlink(temp).catch(()=>{});}
 });}
 async remove(data,actor){return this.lock.run(async()=>{this.stopped();if(data.confirm!==true)throw Error('confirmation_required');const current=await this.get();if(current.revision!==data.revision)throw Error('revision_conflict');const entry=current.files.find(f=>f.name===data.name&&f.safe);if(!entry)throw Error('invalid_addon_name');
  if(current.quarantine.length>=20)throw Error('quarantine_limit');await safeDirectory(this.privateDirectory);await this.logs.audit(actor,'addons.quarantine',{name:entry.name});await rename(join(this.directory,entry.name),join(this.privateDirectory,randomUUID()+'-'+entry.name));
  await atomicJson(join(this.directory,'order.json'),{schema:1,order:current.order.filter(n=>n!==entry.name),disabled:current.disabled.filter(n=>n!==entry.name),...(current.optional.length?{optional:current.optional.map(slot=>slot.after===entry.name?{...slot,after:null}:slot)}:{})});return this.get();
 });}
 async quarantine(data,actor){return this.lock.run(async()=>{this.stopped();const current=await this.get();if(data.confirm!==true||data.revision!==current.revision)throw Error('revision_conflict');const item=current.quarantine.find(f=>f.id===data.id);if(!item||!['restore','delete'].includes(data.action))throw Error('invalid_addon_name');const src=join(this.privateDirectory,item.id+'-'+item.name);
  if(data.action==='restore'&&current.files.some(f=>f.name.toLowerCase()===item.name.toLowerCase()||f.publicName.toLowerCase()===publicAddonName(item.name).toLowerCase()))throw Error('addon_exists');
  await this.logs.audit(actor,'addons.quarantine.'+data.action,{name:item.name});if(data.action==='delete')await unlink(src);else{const {link}=await import('node:fs/promises');await link(src,join(this.directory,item.name));await unlink(src);}return this.get();
 });}
}
