import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
export const STEAM_ID=/^\d{17}$/;
export function managerOrigin(value){
 const u=new URL(value);if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw Error('MANAGER_PUBLIC_URL must be an HTTPS origin (HTTP only on loopback).');return u.origin;
}
export async function managerConfig(env=process.env){
 const directory=resolve(env.DATA_DIR??'./data');let admins;
 if(env.MANAGER_ADMIN_STEAM_IDS!==undefined)admins=env.MANAGER_ADMIN_STEAM_IDS.split(',').map(v=>v.trim()).filter(Boolean);
 else{try{const a=JSON.parse(await readFile(join(directory,'manager-access.json'),'utf8'));if(a.schema!==1||!Array.isArray(a.admins))throw Error('Invalid manager-access.json format.');admins=a.admins;}catch(e){if(e.code!=='ENOENT')throw e;admins=[];}}
 if(admins.length>100||admins.some(s=>typeof s!=='string'||!STEAM_ID.test(s)))throw Error('Invalid Manager SteamID list.');
 const stopTimeoutMs=Number(env.MANAGER_STOP_TIMEOUT_MS??10000);if(!Number.isInteger(stopTimeoutMs)||stopTimeoutMs<1000||stopTimeoutMs>30000)throw Error('MANAGER_STOP_TIMEOUT_MS must be between 1000 and 30000.');
 return {admins:new Set(admins),directory,origin:env.MANAGER_PUBLIC_URL?managerOrigin(env.MANAGER_PUBLIC_URL):null,stopTimeoutMs};
}
