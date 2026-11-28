import {join,resolve} from 'node:path';
import {prepareLogDirectory} from './runtime-logs.mjs';
import {managerConfig,managerOrigin} from './config.mjs';
import {ManagerAuth} from './auth.mjs';
import {loadSteamProfiles} from './steam-profile.mjs';
import {ManagerMembers} from './members.mjs';
import {ManagerLogs} from './logs.mjs';
import {ManagerLogo} from './logo.mjs';
import {GameSupervisor} from './supervisor.mjs';
import {createManagerHttp} from './http.mjs';
import {ManagerSettings} from './settings.mjs';
import {ManagerInstances} from './instances.mjs';
import {ManagerOperations} from './operations.mjs';
import {communityServer} from '../registry.mjs';
import {describeInstance} from './discovery.mjs';
import {dealerBrandingSupported} from '../dealer-branding.mjs';
import {port as validPort} from '../../shared/protocol.mjs';
export async function startServerManager(env=process.env,{steamFetch=fetch,manageInstances=true,envFile,cookieScope=''}={}){
 const config=await managerConfig(env),legacyLogs=join(config.directory,'manager','logs');
 const directory=await prepareLogDirectory(resolve(env.LOG_DIR??'logs'),legacyLogs);
 const logs=new ManagerLogs({directory});await logs.open();
 const logo=new ManagerLogo(config.directory,logs);
 try{await logo.open();}catch{logs.record('The server logo could not be read. Upload a new one in Settings.','warn','manager');}
 const advertised=communityServer(env);
 const listenPort=validPort(env.PORT??env.SERVER_PORT,30007);
 const origin=config.origin??managerOrigin(env.PUBLIC_HOST
  ? `https://${advertised.host}:${advertised.port}`
  : `http://127.0.0.1:${listenPort}`);
 const getOrigin=()=>origin;
 const supervisor=new GameSupervisor({env:{...env},logs,stopTimeoutMs:config.stopTimeoutMs,execArgv:manageInstances?undefined:[]});
 let settings=null;try{const store=new ManagerSettings({directory:config.directory,env,envFile,logs,supervisor,isOwner:steamId=>config.admins.has(steamId)});await store.initialize();settings=store;}catch{logs.record('Settings editor unavailable. Game startup and existing configuration are preserved.','warn','manager');}
 supervisor.on('ready',()=>{settings?.markApplied();operations?.guidance?.invalidate();});
 let operations=new ManagerOperations({directory:config.directory,env,supervisor,logs,settings,logo,identity:{id:advertised.id,name:advertised.name,game:'ets2'}});try{await operations.open();}catch{await operations.close().catch(()=>{});operations=null;logs.record('Advanced administration unavailable: inspect private Manager data and storage permissions. Existing console and settings remain accessible.','error','manager');}
 let members=new ManagerMembers({directory:config.directory,owners:config.admins});
 try{await members.open();}catch{members=null;logs.record('Delegated Manager access is disabled. Check data/manager-users.json. Configured owners can still sign in.','error','manager');}
 if(operations&&members)operations.reloadMembers=()=>members.open();
 const profiles=await loadSteamProfiles(join(config.directory,'manager-profiles.json')).catch(()=>{
  logs.record('Could not read manager-profiles.json. Check its format and permissions.','warn','manager');
  return new Map();
 });
 const auth=new ManagerAuth({admins:config.admins,members,getOrigin,fetchImpl:steamFetch,profiles,cookieScope,profileLog:line=>logs.record(line,'warn','manager')});
 const discovery=()=>({...describeInstance(supervisor,advertised,env),...(logo.image?logo.metadata():{})});
 let web;
 const instances=manageInstances?new ManagerInstances({
  directory:config.directory,owners:config.admins,logs,childHost:env.INSTANCE_BIND_HOST==='0.0.0.0'?'0.0.0.0':'127.0.0.1',
  primary:{...advertised,origin,port:listenPort,folder:resolve('.'),supervisor,power:(action,actor)=>web.power(action,actor)},
  startManager:(childEnv,options)=>startServerManager(childEnv,{...options,manageInstances:false,steamFetch})
 }):null;
 try{web=await createManagerHttp({host:env.HOST??'127.0.0.1',port:listenPort,auth,supervisor,logs,getOrigin,settings,operations,members,mapDirectory:config.directory,discovery,instances,logo,dealerEnabled:dealerBrandingSupported(env),identity:{id:advertised.id,name:advertised.name,port:listenPort}});}
 catch(error){await Promise.allSettled([operations?.close(),supervisor.close(),logs.close()]);throw error;}
 if(instances)try{await instances.open();}catch{
  logs.record('Instance registry could not be read. Check instances/instances.json.','error','manager');
 }
 logs.record('HVMP Server Manager listening. Game server stopped; use Start to launch it.','info','manager');if(!config.admins.size)console.warn('[HVMP Server Manager] Configure MANAGER_ADMIN_STEAM_IDS or data/manager-access.json to allow Steam sign-in.');
 logs.record('HVMP Server Manager available at '+origin+'/manager/','info','manager');
 const stdin=chunk=>{if(supervisor.child?.stdin.writable)supervisor.child.stdin.write(chunk);};if(manageInstances)process.stdin.on('data',stdin);
 let stopped=false;async function close(){if(stopped)return;stopped=true;if(manageInstances)process.stdin.off('data',stdin);await web.close();await instances?.close();await operations?.close();await supervisor.close();await logo.lock.tail;await logs.close();}
 return {web,supervisor,auth,logs,instances,backups:operations?.backups,close};
}
