import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createPhoneHub} from './phone-hub.mjs';

export async function start({env,send,WebSocket,WebSocketServer}) {
  const directory=resolve(env.PHONE_HUB_DATA_DIR??'./phone-data');
  await mkdir(directory,{recursive:true,mode:0o700});
  const hub=await createPhoneHub({
    host:env.PHONE_HUB_HOST??'127.0.0.1',port:Number(env.PHONE_HUB_PORT??30100),
    keys:JSON.parse(env.PHONE_HUB_KEYS??'{}'),database:join(directory,'phone.sqlite'),
    ice:env.PHONE_ICE_SERVERS,
    log:console.log,send,WebSocket,WebSocketServer,
  });
  console.log('HeavyMP phone hub: '+hub.address.address+':'+hub.address.port+'/phone-hub');
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await hub.close();};
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
}
