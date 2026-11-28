import {ManagerGuidance} from './guidance.mjs';
import {join,resolve} from 'node:path';
import {readFile,lstat,statfs,readdir} from 'node:fs/promises';
import {readInstanceModules, maxCustomModules} from '../modules.mjs';
import {SerialStore,safeDirectory,atomicJson,revision} from './storage.mjs';
import {ChatArchive} from './history.mjs';
import {ManagerAddons} from './addons.mjs';
import {ManagerBackups} from './backups.mjs';
import {ManagerAutomation} from './automation.mjs';
import {ManagerModeration} from './moderation.mjs';
export class ManagerOperations{
 constructor({directory,env,supervisor,logs,settings,logo,identity}){Object.assign(this,{directory,env,supervisor,logs,settings,logo,identity});this.lock=new SerialStore();this.root=join(directory,'manager');}
 async open(){await safeDirectory(this.root);const common={supervisor:this.supervisor,logs:this.logs,lock:this.lock},addonsDirectory=resolve(this.env.ADDONS_DIR??'./addons');
  this.chat=new ChatArchive({directory:join(this.root,'chat')});await this.chat.open();this.onLog=e=>this.chat.record(e);this.logs.on('entry',this.onLog);
  this.addons=new ManagerAddons({...common,directory:addonsDirectory,privateDirectory:join(this.root,'addon-quarantine')});
  this.backups=new ManagerBackups({...common,directory:join(this.root,'backups'),dataDirectory:this.directory,addonsDirectory,
   scriptsDirectory:resolve(this.env.INSTANCE_SCRIPTS_DIR??'scripts'),settings:this.settings,logo:this.logo,identity:this.identity,
   reloadState:async()=>{
    await this.moderation.open();
    await this.automation.open();
    await this.reloadMembers?.();
   }});
  await this.backups.recover();
  this.moderation=new ManagerModeration({...common,file:join(this.root,'moderation.json')});await this.moderation.open();
  this.automation=new ManagerAutomation({...common,file:join(this.root,'schedules.json'),settings:this.settings});await this.automation.open();this.automation.start();
  this.lock.blocked=()=>this.automation.executing;
  try{this.guidance=new ManagerGuidance({directory:join(this.root,'guidance'),...common,settings:this.settings,operations:this});await this.guidance.open();}catch{this.guidance=null;this.logs.record('Guided setup unavailable: existing state was preserved. Check Manager storage permissions.','warn','manager');}
  this.rulesSync=()=>{void this.supervisor.command('rules',{rules:this.moderation.rules}).catch(()=>this.logs.record('Local moderation synchronization pending.','warn','manager'));};this.supervisor.on('ready',this.rulesSync);
 }
 async scripts() {
  const { modules, settings, truncated } = await readInstanceModules(this.directory,this.env);
  const snapshot = this.supervisor.status();
  const running = snapshot.state === 'running' ? snapshot.snapshot?.modules ?? [] : [];
  const items = modules.map(({ entry, announce, missionCreators, ...item }) => ({
   ...item, state: running.find(record => record.id === item.id)?.state ?? null,
  }));
  return { items, revision: revision({ settings, modules }), truncated, editable: snapshot.state === 'stopped' };
 }
 async setScript(data, actor) {
  return this.lock.run(async () => {
   if (this.supervisor.state !== 'stopped') throw Error('stop_required');
   if (typeof data?.id !== 'string' || typeof data.enabled !== 'boolean') throw Error('invalid_module');
   const { modules, settings, settingsFile } = await readInstanceModules(this.directory,this.env);
   if (revision({ settings, modules }) !== data.revision) throw Error('revision_conflict');
   const item = modules.find(module => module.id === data.id);
   if (!item || item.error) throw Error('invalid_module');
   if (data.enabled && !item.enabled && !item.service &&
       modules.filter(module => module.enabled && !module.service).length >= maxCustomModules) throw Error('module_limit');
   await this.logs.audit(actor, 'script.' + (data.enabled ? 'enable' : 'disable'), { id: item.id });
   const overrides = Object.fromEntries(modules.filter(module => module.id !== item.id &&
       Object.hasOwn(settings.overrides, module.id)).map(module => [module.id, settings.overrides[module.id]]));
   overrides[item.id] = data.enabled;
   await atomicJson(settingsFile, { schema: 1, overrides });
   return { ok: true };
  });
 }
 async audit(){const directory=this.logs.directory??join(this.root,'logs'),entries=[];for(const name of ['audit.jsonl.1','audit.jsonl'])try{const file=join(directory,name),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>3*1024*1024)continue;for(const line of (await readFile(file,'utf8')).split('\n')){try{entries.push(JSON.parse(line));}catch{}}}catch(e){if(e.code!=='ENOENT')throw e;}return {entries:entries.slice(-500).reverse()};}
 async diagnostics(){let storage=null;try{const s=await statfs(this.directory);storage={freeBytes:Number(s.bavail)*Number(s.bsize),totalBytes:Number(s.blocks)*Number(s.bsize)};}catch{}const s=this.supervisor.status();return {node:process.versions.node,platform:process.platform,storage,managerMemoryMb:s.managerMemoryMb,droppedLogs:s.droppedLogs,droppedChat:this.chat.dropped,performanceSamples:s.history.length,uptimeSeconds:Math.floor(process.uptime()),timestamp:new Date().toISOString()};}
 async close(){if(this.onLog)this.logs.off('entry',this.onLog);if(this.rulesSync)this.supervisor.off('ready',this.rulesSync);await this.automation?.close();await this.lock.tail;await this.chat?.close();}
}
