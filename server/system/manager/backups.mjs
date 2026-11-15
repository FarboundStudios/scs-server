import {readdir,lstat,copyFile,rename,unlink,rm,readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,basename} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {safeDirectory,atomicJson,readJson} from './storage.mjs';
const ID=/^[a-f0-9-]{36}$/;
// Explicit data files, never API keys, .env, sessions, logs or uploaded executable code.
const DATA=new Set(['world.json','vtcs.json','missions.sqlite','phone.sqlite','depots.json','manager-map.json','addons.json','addons-report.json']);
const digest=async file=>{const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');};
export class ManagerBackups{
 constructor({directory,dataDirectory,addonsDirectory,supervisor,logs,lock}){Object.assign(this,{directory,dataDirectory,addonsDirectory,supervisor,logs,lock});}
 get journal(){return join(this.directory,'restore-pending.json');}
 async recover(){const transaction=await readJson(this.journal,null,65536);if(!transaction)return;
  if(!['pending','committed'].includes(transaction.state)||!Array.isArray(transaction.entries)||transaction.entries.length>10)throw Error('restore_recovery_required');
  for(const entry of [...transaction.entries].reverse()){
   if(!['data','addons'].includes(entry.group)||(entry.group==='data'?!DATA.has(entry.name):entry.name!=='order.json')||!/^\.restore-[a-f0-9-]{36}$/.test(entry.temp)||!/^\.rollback-[a-f0-9-]{36}$/.test(entry.old)||typeof entry.hadOriginal!=='boolean')throw Error('restore_recovery_required');
   const base=entry.group==='data'?this.dataDirectory:this.addonsDirectory;await safeDirectory(base);const dest=join(base,entry.name),old=join(base,entry.old),temp=join(base,entry.temp);
   const exists=async p=>{try{const s=await lstat(p);if(!s.isFile()||s.isSymbolicLink())throw Error('unsafe_file');return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
   if(transaction.state==='pending'){if(await exists(old)){if(await exists(dest))await unlink(dest);await rename(old,dest);}else if(!entry.hadOriginal&&!await exists(temp)&&await exists(dest))await unlink(dest);}
   else if(await exists(old))await unlink(old);
   if(await exists(temp))await unlink(temp);
  }
  await unlink(this.journal);if(transaction.state==='pending')this.logs.record('Interrupted restore transaction recovered before game startup.','warn','manager');
 }
 stopped(){if(this.supervisor.child||!['stopped','crashed'].includes(this.supervisor.state)||this.supervisor.busy)throw Error('stop_required');}
 async list(){await safeDirectory(this.directory);const items=[];for(const id of await readdir(this.directory)){if(!ID.test(id))continue;try{const p=join(this.directory,id);await safeDirectory(p);const m=await readJson(join(p,'manifest.json'),null,65536);if(m?.schema===1&&m.id===id)items.push({id,createdAt:m.createdAt,label:m.label,bytes:m.bytes,files:m.files.length});}catch{}}
  return {items:items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),limit:10,busy:this.lock.busy};}
 create(data,actor){return this.lock.run(()=>this.createUnlocked(data,actor));}
 async createUnlocked({label='Manual backup'}={},actor='scheduler'){
  this.stopped();if(typeof label!=='string'||label.length>80||/[\x00-\x1f]/.test(label))throw Error('invalid_label');const list=await this.list();if(list.items.length>=10)throw Error('backup_limit');
  await safeDirectory(this.dataDirectory);await safeDirectory(this.addonsDirectory);const id=randomUUID(),folder=join(this.directory,'.creating-'+id);await safeDirectory(folder);const files=[];let bytes=0;
  try{await this.logs.audit(actor,'backup.create',{id,label});for(const [group,base,names]of [['data',this.dataDirectory,await readdir(this.dataDirectory)],['addons',this.addonsDirectory,['order.json']]])for(const name of names){if(group==='data'&&!DATA.has(name))continue;const src=join(base,name);let s;try{s=await lstat(src);}catch(e){if(e.code==='ENOENT')continue;throw e;}if(!s.isFile()||s.isSymbolicLink()||s.nlink>1)throw Error('unsafe_file');bytes+=s.size;if(s.size>128*1024*1024||bytes>256*1024*1024)throw Error('backup_too_large');
    const path=group+'-'+name,dest=join(folder,path);await copyFile(src,dest,1);const after=await lstat(src);if(after.size!==s.size||after.mtimeMs!==s.mtimeMs)throw Error('data_changed');files.push({group,name,path,size:s.size,sha256:await digest(dest)});
   }
   // Closed SQLite databases must not have outstanding WAL data.
   for(const n of ['phone.sqlite-wal','missions.sqlite-wal'])try{if((await lstat(join(this.dataDirectory,n))).size>0)throw Error('sqlite_not_checkpointed');}catch(e){if(e.code!=='ENOENT')throw e;}
   await atomicJson(join(folder,'manifest.json'),{schema:1,id,createdAt:new Date().toISOString(),label,bytes,files});await rename(folder,join(this.directory,id));return {ok:true,id,...await this.list()};
  }catch(e){await rm(folder,{recursive:true,force:true});throw e;}
 }
 async restore(data,actor){return this.lock.run(async()=>{this.stopped();if(data.confirm!==true||!ID.test(data.id??''))throw Error('confirmation_required');const folder=join(this.directory,data.id);await safeDirectory(folder);const m=await readJson(join(folder,'manifest.json'),null,65536);
   if(m?.schema!==1||m.id!==data.id||!Array.isArray(m.files)||m.files.length>10)throw Error('invalid_backup');
   const staged=[],rollback=[];const seen=new Set();let journalCreated=false;try{for(const f of m.files){if(!['data','addons'].includes(f.group)||typeof f.name!=='string'||basename(f.name)!==f.name||(f.group==='data'?!DATA.has(f.name):f.name!=='order.json')||f.path!==f.group+'-'+f.name||seen.has(f.path))throw Error('invalid_backup');seen.add(f.path);
     const src=join(folder,f.path),s=await lstat(src);if(!s.isFile()||s.isSymbolicLink()||s.size!==f.size||s.size>128*1024*1024||await digest(src)!==f.sha256)throw Error('backup_corrupt');
     const base=f.group==='data'?this.dataDirectory:this.addonsDirectory;await safeDirectory(base);const dest=join(base,f.name);let hadOriginal=false;try{const d=await lstat(dest);if(!d.isFile()||d.isSymbolicLink()||d.nlink>1)throw Error('unsafe_file');hadOriginal=true;}catch(e){if(e.code!=='ENOENT')throw e;}const temp=join(base,'.restore-'+randomUUID()),old=join(base,'.rollback-'+randomUUID());await copyFile(src,temp,1);staged.push({dest,temp,old,group:f.group,name:f.name,hadOriginal});
    }
    // A complete, separately visible safety backup is mandatory before touching live data.
    const safety=await this.createUnlocked({label:'Before restore '+data.id.slice(0,8)},actor);await this.logs.audit(actor,'backup.restore',{id:data.id,safety:safety.id});this.stopped();
    const entries=staged.map(s=>({group:s.group,name:s.name,temp:basename(s.temp),old:basename(s.old),hadOriginal:s.hadOriginal}));await atomicJson(this.journal,{state:'pending',entries});journalCreated=true;
    for(const s of staged){if(s.hadOriginal)await rename(s.dest,s.old);await rename(s.temp,s.dest);}
    await atomicJson(this.journal,{state:'committed',entries});await this.recover();journalCreated=false;this.logs.record('Backup restored. Start the game server when ready.','warn','manager');return {ok:true,safetyBackup:safety.id};
   }catch(e){if(journalCreated)await this.recover();throw e;}finally{if(!journalCreated)for(const s of staged)await unlink(s.temp).catch(()=>{});}
  });}
 async remove(data,actor){return this.lock.run(async()=>{if(data.confirm!==true||!ID.test(data.id??''))throw Error('confirmation_required');const item=(await this.list()).items.find(i=>i.id===data.id);if(!item)throw Error('backup_not_found');await this.logs.audit(actor,'backup.delete',{id:data.id});await rm(join(this.directory,item.id),{recursive:true,force:true});return this.list();});}
}
