import {join} from 'node:path';
import {createChat} from '../_shared/player-chat.mjs';
import {createPhoneHubClient} from './phone-hub-client.mjs';
import {createPhoneNetwork} from './phone.mjs';

export function create({options,sessions,send,WebSocket,log}) {
  const env=options.moduleEnvironment??{};
  const url=options.phoneHubUrl??env.PHONE_HUB_URL?.trim();
  const serverId=options.serverId??'eu1';
  if(url){
    return createPhoneHubClient({url,key:options.phoneHubKey??env.PHONE_HUB_KEY?.trim(),serverId,send,WebSocket,log});
  }

  return createPhoneNetwork({
    database:options.phoneDatabase??(options.dataDirectory?join(options.dataDirectory,'phone.sqlite'):undefined),
    ice:options.phoneIceServers??env.PHONE_ICE_SERVERS,
    scope:serverId,send,
  });
}

export {createChat};

export async function startHub({env,send,WebSocket,WebSocketServer}) {
  const {start}=await import('./hub-entry.mjs');
  return start({env,send,WebSocket,WebSocketServer});
}
