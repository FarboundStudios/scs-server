import {readdir,lstat,copyFile,rename,unlink,rm,rmdir,readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,basename,dirname,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {safeDirectory,atomicJson,readJson} from './storage.mjs';
import {addonName} from '../addon-inspection.mjs';
import {MAX_ADDON_BYTES} from '../../shared/content.mjs';
import {exportBackup,importBackup,maxBackupManifest,maxFullBackupBytes} from './backup-archive.mjs';
import {serverPage} from '../../shared/server-page.mjs';
import {readDelegatedUsers} from './members.mjs';
import {readSchedules} from './automation.mjs';
import {loadManagerRules} from './moderation.mjs';
import {isBundledModule} from '../modules.mjs';

const ID=/^[a-f0-9-]{36}$/;
const DATA=['world.json','vtcs.json','missions.sqlite','phone.sqlite','depots.json','manager-map.json','addons.json','addons-report.json'];
const MANAGER=['server-page.json','server-logo.json','dealer-branding.json','modules.json'];
const INSTANCE_MANAGER=['schedules.json','moderation.json'];
const MAX_DATA_FILE=128*1024**2, MAX_DATA_BACKUP=256*1024**2;
const MAX_FILES=4096;
const safeAddon=name=>addonName(name)&&!/[<>"|?*]/.test(name)&&!/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\./i.test(name);
const digest=async file=>{const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');};

const key=(group,name)=>group==='scripts'?group+'-'+createHash('sha256').update(name.toLowerCase()).digest('hex'):group+'-'+name;
function scriptPath(name){
 if(typeof name!=='string'||Buffer.byteLength(name)>240)return false;
 const parts=name.split('/');
 return parts.length>=2&&parts.length<=12&&/^[a-z][a-z0-9-]{1,31}$/.test(parts[0])&&!isBundledModule(parts[0])&&
  parts.slice(1).every(part=>part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&
   /^[^<>:"/\\|?*\u0000-\u001f\u007f]{1,120}$/.test(part)&&
   !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
}

function allowedFile(group,name,schema){
 if(schema>=3&&group==='scripts')return scriptPath(name);
 if(typeof name!=='string'||basename(name)!==name)return false;
 if(group==='data')return DATA.includes(name);
 if(group==='addons')return name==='order.json'||(schema>=2&&safeAddon(name));
 if(group==='manager')return (schema>=2&&MANAGER.includes(name))||(schema>=3&&INSTANCE_MANAGER.includes(name));
 if(group==='users')return schema>=3&&name==='manager-users.json';
 return schema>=2&&group==='settings'&&name==='game-settings.json';
}

async function pruneScriptFolders(root,file){
 for(let parent=dirname(file);parent!==root;parent=dirname(parent)){
  const child=relative(root,parent);
  if(!child||isAbsolute(child)||child==='..'||child.startsWith('..'+(process.platform==='win32'?'\\':'/')))return;
  try{await rmdir(parent);}
  catch(error){if(error.code!=='ENOENT')return;}
 }
}

async function regular(path){
 try{
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink>1)throw Error('unsafe_file');
  return stat;
 }catch(error){if(error.code==='ENOENT')return null;throw error;}
}

export function validateManifest(value,id){
 if(![1,2,3].includes(value?.schema))throw Error('invalid_backup');
 if(!ID.test(value.id??'')||(id&&value.id!==id)||!Array.isArray(value.files)||
    typeof value.label!=='string'||value.label.length>80||typeof value.createdAt!=='string'||
    !Number.isFinite(Date.parse(value.createdAt)))throw Error('invalid_backup');
 const full=value.schema>=2;
 if(value.files.length>(full?MAX_FILES:10))throw Error('invalid_backup');
 const seen=new Set();let bytes=0;
 for(const file of value.files){
  const storageKey=typeof file?.path==='string'?file.path.toLowerCase():null;
  if(!file||!allowedFile(file.group,file.name,value.schema)||file.path!==key(file.group,file.name)||
     seen.has(storageKey)||!Number.isSafeInteger(file.size)||file.size<0||!/^([a-f0-9]{64})$/.test(file.sha256??'')||
     file.size>(['settings','users'].includes(file.group)?32768:file.group==='manager'?2*1024**2:
      full&&file.group==='addons'&&file.name!=='order.json'?MAX_ADDON_BYTES:MAX_DATA_FILE))throw Error('invalid_backup');
  seen.add(storageKey);
  bytes+=file.size;
 }
 if(bytes!==value.bytes||bytes>(full?maxFullBackupBytes:MAX_DATA_BACKUP))throw Error('invalid_backup');
 return value;
}

export function receiveServerBackup(stream,folder,complete=false){
 if(Number(stream.headers?.['content-length'])>maxFullBackupBytes+maxBackupManifest+12)throw Error('backup_too_large');
 return importBackup(stream,folder,value=>{
  const manifest=validateManifest(value);
  if(complete&&manifest.schema<2)throw Error('full_pack_required');
  return manifest;
 });
}

export class ManagerBackups{
 constructor({directory,dataDirectory,addonsDirectory,scriptsDirectory,supervisor,logs,lock,settings,logo,reloadState,identity}){
  Object.assign(this,{directory,dataDirectory,addonsDirectory,scriptsDirectory,supervisor,logs,lock,settings,logo,reloadState,identity});
 }
 get journal(){return join(this.directory,'restore-pending.json');}
 base(group){
  if(group==='data')return this.dataDirectory;
  if(group==='addons')return this.addonsDirectory;
  if(group==='manager')return join(this.dataDirectory,'manager');
  if(group==='scripts'&&this.scriptsDirectory)return this.scriptsDirectory;
  if(group==='users')return this.dataDirectory;
  if(group==='settings'&&this.settings)return dirname(this.settings.envFile);
  throw Error('invalid_backup');
 }
 destination(group,name){
  return group==='settings'?this.settings.envFile:join(this.base(group),name);
 }
 async recover(){
  const transaction=await readJson(this.journal,null,maxBackupManifest);
  if(!transaction)return;
  if(!['pending','committed'].includes(transaction.state)||!Array.isArray(transaction.entries)||
     transaction.entries.length>MAX_FILES*2)throw Error('restore_recovery_required');
  for(const entry of [...transaction.entries].reverse()){
   if(!allowedFile(entry.group,entry.name,3)||
      (entry.temp!==null&&!/^\.restore-[a-f0-9-]{36}$/.test(entry.temp))||
      !/^\.rollback-[a-f0-9-]{36}$/.test(entry.old)||typeof entry.hadOriginal!=='boolean')throw Error('restore_recovery_required');
   const dest=this.destination(entry.group,entry.name),base=dirname(dest);
   await safeDirectory(base);
   const old=join(base,entry.old),temp=entry.temp&&join(base,entry.temp);
   if(transaction.state==='pending'){
    if(await regular(old)){if(await regular(dest))await unlink(dest);await rename(old,dest);}
    else if(!entry.hadOriginal&&temp&&!await regular(temp)&&await regular(dest))await unlink(dest);
   }else if(await regular(old))await unlink(old);
   if(temp&&await regular(temp))await unlink(temp);
  }
  await unlink(this.journal);
  if(transaction.state==='pending')this.logs.record('Interrupted restore transaction recovered before game startup.','warn','manager');
 }
 stopped(){
  if(this.supervisor.child||!['stopped','crashed'].includes(this.supervisor.state)||this.supervisor.busy)throw Error('stop_required');
 }
 async manifest(id){
  if(!ID.test(id??''))throw Error('invalid_backup');
  const folder=join(this.directory,id);
  try{
   const stat=await lstat(folder);
   if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('unsafe_path');
  }catch(error){if(error.code==='ENOENT')throw Error('backup_not_found');throw error;}
  const value=await readJson(join(folder,'manifest.json'),null,maxBackupManifest);
  if(!value)throw Error('backup_not_found');
  return {folder,value:validateManifest(value,id)};
 }
 async list(){
  await safeDirectory(this.directory);
  const items=[];
  for(const id of await readdir(this.directory)){
   if(!ID.test(id))continue;
   try{
    const {value}=await this.manifest(id);
    items.push({id,createdAt:value.createdAt,label:value.label,bytes:value.bytes,files:value.files.length,full:value.schema>=2,complete:value.schema>=3});
   }catch{}
  }
  return {items:items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),limit:10,busy:this.lock.busy};
 }
 create(data,actor){return this.lock.run(()=>this.createUnlocked(data,actor));}
 async scriptFiles(){
  if(!this.scriptsDirectory)return [];
  await safeDirectory(this.scriptsDirectory);
  const names=[];
  const scan=async prefix=>{
   for(const entry of await readdir(join(this.scriptsDirectory,prefix),{withFileTypes:true})){
    if(/^\.(?:restore|rollback)-[a-f0-9-]{36}$/.test(entry.name))continue;
    const name=prefix+'/'+entry.name;
    if(!scriptPath(name)||entry.isSymbolicLink())throw Error('unsafe_file');
    if(entry.isDirectory())await scan(name);
    else if(entry.isFile()){
     names.push(name);
     if(names.length>MAX_FILES)throw Error('backup_too_large');
    }else throw Error('unsafe_file');
   }
  };
  for(const entry of await readdir(this.scriptsDirectory,{withFileTypes:true})){
   if(!/^[a-z][a-z0-9-]{1,31}$/.test(entry.name)||isBundledModule(entry.name))continue;
   if(entry.isSymbolicLink())throw Error('unsafe_file');
   if(entry.isDirectory())await scan(entry.name);
  }
  return names;
 }
 async sources(schema){
  const groups=[['data',DATA],['addons',['order.json']]];
  if(schema>=2){
   const addons=(await readdir(this.addonsDirectory)).filter(safeAddon).sort();
   if(addons.length>256)throw Error('addon_limit');
   groups[1][1].push(...addons);
   groups.push(['manager',MANAGER]);
  }
  if(schema>=3)groups.push(['manager',INSTANCE_MANAGER],['users',['manager-users.json']],['scripts',await this.scriptFiles()]);
  return groups.flatMap(([group,names])=>names.map(name=>({group,name})));
 }
 async createUnlocked({label='Manual backup',full=false}={},actor='scheduler',safety=false){
  this.stopped();
  if(typeof full!=='boolean')throw Error('invalid_backup');
  if(typeof label!=='string'||label.length>80||/[\x00-\x1f]/.test(label))throw Error('invalid_label');
  if((await this.list()).items.length>=(safety?11:10))throw Error('backup_limit');
  for(const group of ['data','addons',...(full?['manager']:[])])await safeDirectory(this.base(group));
  const id=randomUUID(),folder=join(this.directory,'.creating-'+id),files=[];
  await safeDirectory(folder);
  const schema=full?3:1;
  let bytes=0;
  try{
   await this.logs.audit(actor,'backup.create',{id,label,full});
   for(const {group,name} of await this.sources(schema)){
    const src=this.destination(group,name),stat=await regular(src);
    if(!stat)continue;
    bytes+=stat.size;
    if(bytes>(full?maxFullBackupBytes:MAX_DATA_BACKUP)||(!full&&stat.size>MAX_DATA_FILE))throw Error('backup_too_large');
    const path=key(group,name),dest=join(folder,path);
    await copyFile(src,dest,1);
    const after=await regular(src);
    if(!after||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('data_changed');
    files.push({group,name,path,size:stat.size,sha256:await digest(dest)});
   }
   if(full&&this.settings){
    const name='game-settings.json',path='settings-'+name,payload=Buffer.from(JSON.stringify(await this.settings.backupValues()));
    await writeFile(join(folder,path),payload,{flag:'wx',mode:0o600});
    bytes+=payload.length;
    files.push({group:'settings',name,path,size:payload.length,sha256:createHash('sha256').update(payload).digest('hex')});
   }
   for(const name of ['phone.sqlite-wal','missions.sqlite-wal']){
    if((await regular(join(this.dataDirectory,name)))?.size>0)throw Error('sqlite_not_checkpointed');
   }
   const manifest=validateManifest({schema,id,createdAt:new Date().toISOString(),label,bytes,files,
    ...(full&&this.identity?{server:this.identity}:{})});
   await atomicJson(join(folder,'manifest.json'),manifest);
   await rename(folder,join(this.directory,id));
   return {ok:true,id,...await this.list()};
  }catch(error){await rm(folder,{recursive:true,force:true});throw error;}
 }
 async download(id){
  const {folder,value}=await this.manifest(id);
  for(const file of value.files){
   if((await regular(join(folder,file.path)))?.size!==file.size)throw Error('backup_corrupt');
  }
  return exportBackup(folder,value);
 }
 async upload(stream,actor){
  return this.lock.run(async()=>{
   if((await this.list()).items.length>=10)throw Error('backup_limit');
   const folder=join(this.directory,'.creating-'+randomUUID());
   await safeDirectory(folder);
   try{
    const manifest=await receiveServerBackup(stream,folder);
    const id=await this.installVerified(folder,manifest,actor);
    return {ok:true,id,...await this.list()};
   }catch(error){await rm(folder,{recursive:true,force:true});throw error;}
  });
 }
 async installVerified(folder,manifest,actor){
  await safeDirectory(this.directory);
  const id=randomUUID();
  await this.logs.audit(actor,'backup.import',{id,source:manifest.id});
  await atomicJson(join(folder,'manifest.json'),{...manifest,id});
  await rename(folder,join(this.directory,id));
  return id;
 }
 async restore(data,actor,owner=true,{fresh=false}={}){
  return this.lock.run(async()=>{
   this.stopped();
   if(data.confirm!==true||!ID.test(data.id??''))throw Error('confirmation_required');
   const {folder,value}=await this.manifest(data.id);
   const full=value.schema>=2;
   if(full&&!owner)throw Error('permission_denied');
   if(value.schema>=3&&data.trusted!==true)throw Error('confirmation_required');
   const staged=[],seen=new Set();
   let journalCreated=false;
   const stage=async(group,name,load)=>{
    const dest=this.destination(group,name),base=dirname(dest);
    await safeDirectory(base);
    const hadOriginal=Boolean(await regular(dest));
    if(!load&&!hadOriginal)return;
    const temp=load?join(base,'.restore-'+randomUUID()):null,old=join(base,'.rollback-'+randomUUID());
    staged.push({dest,temp,old,group,name,hadOriginal});
    if(load)await load(temp);
   };
   try{
    for(const file of value.files){
     const src=join(folder,file.path);
     if((await regular(src))?.size!==file.size||await digest(src)!==file.sha256)throw Error('backup_corrupt');
     seen.add(file.path.toLowerCase());
     if(file.group==='settings'){
      if(file.size>32768||!this.settings)throw Error('invalid_backup');
      const updated=await this.settings.restoreBackupText(JSON.parse(await readFile(src,'utf8')));
      await stage(file.group,file.name,temp=>writeFile(temp,updated,{flag:'wx',mode:0o600}));
     }else{
      if(file.group==='manager'){
       if(file.size>2*1024*1024)throw Error('invalid_backup');
       if(file.name==='server-page.json')serverPage(JSON.parse(await readFile(src,'utf8')));
       if(file.name==='server-logo.json'&&this.logo){
        const logo=await readJson(src,null,512*1024);
        if(logo?.schema!==1||(logo.png!==null&&typeof logo.png!=='string'))throw Error('invalid_backup');
        if(logo.png!==null)this.logo.validate(Buffer.from(logo.png,'base64'));
       }
       if(file.name==='schedules.json')await readSchedules(src);
       if(file.name==='moderation.json')await loadManagerRules(src);
      }
      if(file.group==='users')await readDelegatedUsers(src);
      await stage(file.group,file.name,temp=>copyFile(src,temp,1));
     }
    }
    if(full)for(const {group,name} of await this.sources(value.schema)){
     if(!seen.has(key(group,name).toLowerCase()))await stage(group,name,null);
    }
    const safety=fresh?null:await this.createUnlocked({label:'Before restore '+data.id.slice(0,8),full},actor,true);
    await this.logs.audit(actor,'backup.restore',{id:data.id,safety:safety?.id??null,full});
    this.stopped();
    const entries=staged.map(s=>({group:s.group,name:s.name,temp:s.temp&&basename(s.temp),old:basename(s.old),hadOriginal:s.hadOriginal}));
    await atomicJson(this.journal,{state:'pending',entries});journalCreated=true;
    for(const s of staged){
     if(s.hadOriginal)await rename(s.dest,s.old);
     if(s.temp)await rename(s.temp,s.dest);
    }
    await atomicJson(this.journal,{state:'committed',entries});
    await this.recover();journalCreated=false;
    for(const item of staged){
     if(item.group==='scripts'&&!item.temp)await pruneScriptFolders(this.scriptsDirectory,item.dest);
    }
    if(full&&this.logo)await this.logo.open();
    if(value.schema>=3)await this.reloadState?.();
    this.logs.record('Backup restored. Start the game server when ready.','warn','manager');
    return {ok:true,safetyBackup:safety?.id??null};
   }catch(error){if(journalCreated)await this.recover();throw error;}
   finally{if(!journalCreated)for(const s of staged)if(s.temp)await unlink(s.temp).catch(()=>{});}
  });
 }
 async remove(data,actor,owner=true){
  return this.lock.run(async()=>{
   if(data.confirm!==true||!ID.test(data.id??''))throw Error('confirmation_required');
   const {folder,value}=await this.manifest(data.id);
   if(value.schema>=2&&!owner)throw Error('permission_denied');
   await this.logs.audit(actor,'backup.delete',{id:data.id});
   await rm(folder,{recursive:true,force:true});
   return this.list();
  });
 }
}
