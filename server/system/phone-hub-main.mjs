import {loadEnvFile} from 'node:process';
import {resolve} from 'node:path';
import {WebSocket,WebSocketServer} from 'ws';
import {send} from '../shared/protocol.mjs';
import {createModulesRuntime,readModules} from './modules.mjs';

try {
 try{loadEnvFile('.env');}catch(error){if(error.code!=='ENOENT')throw error;}
 const modules=createModulesRuntime(await readModules(resolve(process.env.DATA_DIR??'./data')),console.error);
 const started=await modules.activateService('phone',async entry=>{
  await entry.startHub({env:process.env,send,WebSocket,WebSocketServer});
  return true;
 });
 if(!started){console.error('Phone hub unavailable. Check the scripts/phone module.');process.exitCode=1;}
}catch(error){console.error('Phone hub: '+error.message);process.exitCode=1;}
