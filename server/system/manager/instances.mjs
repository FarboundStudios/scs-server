import {join,resolve,dirname} from 'node:path';
import {freemem,totalmem} from 'node:os';
import {randomUUID} from 'node:crypto';
import {lstat,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {managerOrigin} from './config.mjs';
import {atomicJson,readJson,revision,safeDirectory,SerialStore} from './storage.mjs';
import {receiveServerBackup} from './backups.mjs';

const MAX_INSTANCES=32;
const defaultConfig={schema:1,entries:[]};
const instanceId=/^[a-z0-9][a-z0-9_-]{0,31}$/;
const storageIdPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const osKeys=['PATH','SystemRoot','ComSpec','PATHEXT','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA'];

function definition(value){
 const {id,game,name,port,publicOrigin=null,storageId=null}=value??{};
 if(game!=='ets2')throw Error('unsupported_game');
 if(typeof id!=='string'||!instanceId.test(id)||typeof name!=='string'||!name.trim()||name.trim().length>80||
    /[\x00-\x1f\x7f]/.test(name)||!Number.isInteger(port)||port<1024||port>65535||
    (storageId!==null&&(typeof storageId!=='string'||!storageIdPattern.test(storageId))))throw Error('invalid_instance');
 let origin=null;
 if(publicOrigin){
  if(typeof publicOrigin!=='string'||publicOrigin.length>256)throw Error('invalid_instance');
  try{origin=managerOrigin(publicOrigin);}catch{throw Error('invalid_instance');}
  if(!origin.startsWith('https://'))throw Error('invalid_instance');
 }
 return {id,game,name:name.trim(),port,publicOrigin:origin,...(storageId?{storageId}:{})};
}

const originOf=entry=>entry.publicOrigin??'http://127.0.0.1:'+entry.port;
const storageName=entry=>'instance-'+entry.id+(entry.storageId?'-'+entry.storageId:'');
const idle=supervisor=>!supervisor||(!supervisor.child&&!supervisor.busy&&['stopped','crashed'].includes(supervisor.state));
const importName=manifest=>{
 const original=typeof manifest.server?.name==='string'?manifest.server.name:'';
 const fallback=manifest.label.replace(/(?:\bfull\s+)?(?:server\s+)?(?:pack|backup)$/i,'').trim();
 return (original||fallback).replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,80)||'Imported server';
};

async function instanceEnvFile(path,id){
 try{
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144)throw Error('unsafe_file');
 }catch(e){
  if(e.code!=='ENOENT')throw e;
  await writeFile(path,'ROOM='+id+'\nALLOW_OPTIONAL_MODS=false\n',{flag:'wx',mode:0o600});
 }
 return parseEnv(await readFile(path,'utf8'));
}

export class ManagerInstances{
 constructor({directory,owners,primary,logs,startManager,childHost='127.0.0.1'}){
  this.directory=join(directory,'instances');
  this.file=join(this.directory,'instances.json');
  Object.assign(this,{owners,primary,logs,startManager,childHost});
  this.entries=new Map();
  this.managers=new Map();
  this.lock=new SerialStore();
  this.importLock=new SerialStore();
 }
 checkUnique(entry){
  if((!this.primaryDeleted&&entry.id===this.primary.id)||this.entries.has(entry.id))throw Error('instance_id_in_use');
  if(entry.port===this.primary.port||[...this.entries.values()].some(item=>item.port===entry.port))throw Error('instance_port_in_use');
  const origin=originOf(entry);
  if(origin===this.primary.origin||[...this.entries.values()].some(item=>originOf(item)===origin))throw Error('instance_origin_in_use');
 }
 async open(){
  await safeDirectory(this.directory);
  const data=await readJson(this.file,defaultConfig,65536);
  if(data?.schema!==1||!Array.isArray(data.entries)||data.entries.length>MAX_INSTANCES||
     (data.primaryDeleted!==undefined&&typeof data.primaryDeleted!=='boolean'))throw Error('invalid_instance_registry');
  const entries=data.entries.map(definition);
  const ids=new Set(data.primaryDeleted?[]:[this.primary.id]),ports=new Set([this.primary.port]),origins=new Set([this.primary.origin]);
  for(const entry of entries){
   const origin=originOf(entry);
   if(ids.has(entry.id)||ports.has(entry.port)||origins.has(origin))throw Error('invalid_instance_registry');
   ids.add(entry.id);ports.add(entry.port);origins.add(origin);
  }
  this.primaryDeleted=data.primaryDeleted===true;
  if(this.primaryDeleted)this.primary.supervisor.shuttingDown=true;
  for(const entry of entries)this.entries.set(entry.id,entry);
  for(const entry of this.entries.values()){
   try{await this.ensureManager(entry);}catch{
    this.logs.record('Could not open the Manager for '+entry.id+'. Check its port and instance configuration.','warn','manager');
   }
  }
  this.ready=true;
 }
 async ensureManager(entry){
  const existing=this.managers.get(entry.id);
  if(existing)return existing;
  const root=await safeDirectory(join(this.directory,storageName(entry)));
  for(const folder of ['data','addons','logs','scripts'])await safeDirectory(join(root,folder));
  const envFile=join(root,'.env');
  const config=await instanceEnvFile(envFile,entry.id);
  const origin=originOf(entry),publicUrl=entry.publicOrigin?new URL(entry.publicOrigin):null;
  const env=Object.fromEntries(osKeys.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
  Object.assign(env,config,{
   SERVER_ID:entry.id,SERVER_NAME:entry.name,HOST:this.childHost,PORT:String(entry.port),
   DATA_DIR:join(root,'data'),LOG_DIR:join(root,'logs'),ADDONS_DIR:join(root,'addons'),INSTANCE_SCRIPTS_DIR:join(root,'scripts'),
   MANAGER_PUBLIC_URL:origin,MANAGER_ADMIN_STEAM_IDS:[...this.owners].join(','),
   PUBLIC_HOST:publicUrl?.hostname??'localhost',PUBLIC_PORT:publicUrl?.port||String(publicUrl?443:entry.port)
  });
  let manager;
  try{manager=await this.startManager(env,{envFile,cookieScope:entry.id});}
  catch(e){if(e.code==='EADDRINUSE')throw Error('instance_port_in_use');throw e;}
  this.managers.set(entry.id,manager);
  return manager;
 }
 list(){
  const current=this.primary;
  const status=supervisor=>{
   const snapshot=supervisor?.state==='running'?supervisor.snapshot:null;
   return {
    state:supervisor?.state??'manager_unavailable',players:snapshot?.health?.players??0,canDelete:idle(supervisor),
    cpuPercent:snapshot?.process?.cpuPercent??null,rssMb:snapshot?.process?.rssMb??null,
    tickMs:snapshot?.health?.metrics?.lastTickMs??null,startedAt:supervisor?.state==='running'?supervisor.startedAt:null,
   };
  };
  const items=this.primaryDeleted?[]:[{id:current.id,name:current.name,port:current.port,game:'ets2',primary:true,folder:current.folder,managerUrl:current.origin+'/manager/#overview',...status(current.supervisor)}];
  for(const entry of this.entries.values()){
   const manager=this.managers.get(entry.id);
   const {id,name,port,game}=entry;
   items.push({id,name,port,game,folder:join(this.directory,storageName(entry)),managerUrl:manager?originOf(entry)+'/manager/':null,...status(manager?.supervisor)});
  }
  const ports=new Set([current.port,...items.map(item=>item.port)]);
  let nextPort=30007;
  while(ports.has(nextPort))nextPort++;
  const memoryTotalMb=Math.round(totalmem()/1048576),memoryAvailableMb=Math.round(freemem()/1048576);
  return {items,nextPort,revision:revision(this.registry()),host:{memoryTotalMb,memoryAvailableMb,managerRssMb:Math.round(process.memoryUsage.rss()/1048576)}};
 }
 registry(entries=this.entries,primaryDeleted=this.primaryDeleted){
  return {schema:1,...(primaryDeleted?{primaryDeleted:true}:{}),entries:[...entries.values()]};
 }
 async create(data,actor){
  return this.lock.run(async()=>{
   if(!this.ready)throw Error('instance_registry_unavailable');
   const entry=definition({...data,storageId:randomUUID()});
   this.checkUnique(entry);
   if(this.entries.size>=MAX_INSTANCES)throw Error('instance_limit');
   const manager=await this.ensureManager(entry);
   try{
    await this.logs.audit(actor,'instance.create',{id:entry.id,game:entry.game,port:entry.port});
    const entries=new Map(this.entries).set(entry.id,entry);
    await atomicJson(this.file,this.registry(entries));
    this.entries.set(entry.id,entry);
   }catch(e){
    this.managers.delete(entry.id);
    await manager.close().catch(()=>{});
    throw e;
   }
   return this.list();
  });
 }
 async importPack(stream,actor,allowed){
  return this.importLock.run(async()=>{
   if(!this.ready)throw Error('instance_registry_unavailable');
   if(this.entries.size>=MAX_INSTANCES)throw Error('instance_limit');
   const directory=await safeDirectory(this.directory);
   const staging=await mkdtemp(join(directory,'.importing-pack-'));
   try{
    const manifest=await receiveServerBackup(stream,staging,true);
    return await this.lock.run(async()=>{
     if(!allowed())throw Error('permission_denied');
     if(this.entries.size>=MAX_INSTANCES)throw Error('instance_limit');
     const name=importName(manifest);
     const declared=manifest.server?.id;
     const slug=typeof declared==='string'&&instanceId.test(declared)?declared:
      name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,32)||'imported-server';
     const taken=id=>this.entries.has(id)||(!this.primaryDeleted&&id===this.primary.id);
     let id=slug;
     for(let n=2;taken(id);n++){
      const suffix='-'+n;
      id=slug.slice(0,32-suffix.length)+suffix;
     }
     const registered=new Set([this.primary.port,...[...this.entries.values()].map(entry=>entry.port)]);
     const storageId=randomUUID();
     const removeFolder=async path=>{
      if(dirname(resolve(path))!==resolve(directory))throw Error('unsafe_path');
      await rm(path,{recursive:true,force:true});
     };
     let port=this.list().nextPort, entry, manager;
     for(let tries=0;tries<32&&port<=65535;port++){
      if(registered.has(port))continue;
      tries++;
      entry=definition({id,name,port,game:'ets2',storageId});
      try{manager=await this.ensureManager(entry);break;}
      catch(error){
       if(error.message!=='instance_port_in_use'){
        await removeFolder(join(directory,storageName(entry)));
        throw error;
       }
      }
     }
     const folder=entry&&join(directory,storageName(entry));
     if(!manager||!folder){
      if(folder)await removeFolder(folder);
      throw Error('instance_port_in_use');
     }
     try{
      if(!manager.backups)throw Error('instance_registry_unavailable');
      const backup=await manager.backups.installVerified(staging,manifest,actor);
      await manager.backups.restore({id:backup,confirm:true,trusted:true},actor,true,{fresh:true});
      const entries=new Map(this.entries).set(id,entry);
      await this.logs.audit(actor,'instance.import',{id,port:entry.port,pack:manifest.id});
      await atomicJson(this.file,this.registry(entries));
      this.entries=entries;
      return {instance:this.list().items.find(item=>item.id===id)};
     }catch(error){
      this.managers.delete(id);
      await manager.close().catch(()=>{});
      await removeFolder(folder);
      throw error;
     }
    });
   }finally{await rm(staging,{recursive:true,force:true});}
  });
 }
 async power({id,action,confirm},actor){
  if(confirm!==true||!['start','stop','restart'].includes(action))throw Error('invalid_action');
  return this.lock.run(async()=>{
   if(!this.ready)throw Error('instance_registry_unavailable');
   if(!this.primaryDeleted&&id===this.primary.id)await this.primary.power(action,actor);
   else{
    const entry=this.entries.get(id);
    if(!entry)throw Error('instance_not_found');
    await this.logs.audit(actor,'instance.'+action,{id});
    const manager=this.managers.get(id)??(action==='stop'?null:await this.ensureManager(entry));
    await manager?.web.power(action,actor);
   }
   return this.list();
  });
 }
 async remove({id,confirm},actor){
  if(confirm!==true)throw Error('confirmation_required');
  return this.lock.run(async()=>{
   if(!this.ready)throw Error('instance_registry_unavailable');
   const isPrimary=!this.primaryDeleted&&id===this.primary.id;
   if(!isPrimary&&!this.entries.has(id))throw Error('instance_not_found');
   await this.removeStopped(isPrimary,isPrimary?[]:[id],actor,'instance.remove');
   return this.list();
  });
 }
 async removeAll({revision:expected,confirm},actor){
  if(confirm!==true)throw Error('confirmation_required');
  return this.lock.run(async()=>{
   if(!this.ready)throw Error('instance_registry_unavailable');
   if(expected!==revision(this.registry()))throw Error('revision_conflict');
   await this.removeStopped(!this.primaryDeleted,[...this.entries.keys()],actor,'instance.remove_all');
   return this.list();
  });
 }
 async removeStopped(removePrimary,ids,actor,event){
  const managers=ids.map(id=>this.managers.get(id)).filter(Boolean);
  const supervisors=managers.map(manager=>manager.supervisor);
  if(removePrimary)supervisors.push(this.primary.supervisor);
  if(!supervisors.every(idle))throw Error('stop_required');
  for(const supervisor of supervisors)supervisor.shuttingDown=true;
  const remaining=new Map(this.entries),primaryDeleted=this.primaryDeleted||removePrimary;
  for(const id of ids)remaining.delete(id);
  try{
   const removed=ids.map(id=>({id,storage:storageName(this.entries.get(id))}));
   if(removePrimary)removed.unshift({id:this.primary.id});
   await this.logs.audit(actor,event,{instances:removed});
   await atomicJson(this.file,this.registry(remaining,primaryDeleted));
  }catch(error){
   for(const supervisor of supervisors)supervisor.shuttingDown=false;
   throw error;
  }
  this.entries=remaining;
  this.primaryDeleted=primaryDeleted;
  for(const id of ids)this.managers.delete(id);
  if(removePrimary)this.primary.supervisor.touch();
  await Promise.allSettled(managers.map(manager=>manager.close()));
 }
 async rename({id,name},actor){
  return this.lock.run(async()=>{
   const entry=this.editableEntry(id),next=definition({...entry,name});
   if(next.name!==entry.name)await this.renameStopped(entry,next,actor);
   return this.list();
  });
 }
 editableEntry(id){
  if(!this.ready)throw Error('instance_registry_unavailable');
  if(!this.primaryDeleted&&id===this.primary.id)throw Error('instance_primary_protected');
  const entry=this.entries.get(id);
  if(!entry)throw Error('instance_not_found');
  return entry;
 }
 async renameStopped(entry,replacement,actor){
  const {id}=entry,manager=this.managers.get(id),supervisor=manager?.supervisor;
  if(!idle(supervisor))throw Error('stop_required');
  // Prevent requests from the individual Manager from starting its game during
  // the update. Storage is retained even when the registry entry is removed.
  if(supervisor)supervisor.shuttingDown=true;
  try{
   await this.logs.audit(actor,'instance.rename',{id,name:replacement.name});
  }catch(error){
   if(supervisor)supervisor.shuttingDown=false;
   throw error;
  }
  const entries=new Map(this.entries).set(id,replacement);
  try{
   this.managers.delete(id);
   await manager?.close();
   await this.ensureManager(replacement);
   await atomicJson(this.file,this.registry(entries));
  }catch(error){
   const opened=this.managers.get(id);
   this.managers.delete(id);
   await opened?.close().catch(()=>{});
   if(manager)await this.ensureManager(entry).catch(()=>{});
   throw error;
  }
  this.entries=entries;
 }
 async close(){
  await this.importLock.tail;
  await this.lock.tail;
  await Promise.allSettled([...this.managers.values()].map(manager=>manager.close()));
  this.managers.clear();
 }
}
