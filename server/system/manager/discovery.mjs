import release from '../../../package.json' with {type:'json'};
import {canonicalRoom,WEBSOCKET_PATH} from '../../shared/branding.mjs';
import {DISCOVERY_SCHEMA} from '../../shared/discovery.mjs';
import {GAME_VERSION,PROTOCOL} from '../../shared/protocol.mjs';

export function describeInstance(supervisor,configured,env){
 const status=supervisor.state;
 const online=status==='running';
 const identity=supervisor.meta;
 const health=online?supervisor.snapshot?.health:null;
 const capacity=Number(env.MAX_PLAYERS??5000);
 const room=canonicalRoom(env.ROOM);
 return {
  schema:DISCOVERY_SCHEMA,
  service:'HeavyMP',
  edition:'community',
  id:identity?.serverId??configured.id,
  name:identity?.name??configured.name,
  status,
  online,
  serverVersion:release.version,
  gameVersion:health?.gameVersion??GAME_VERSION,
  protocol:PROTOCOL,
  playerCount:health?.players??0,
  maxPlayers:health?.maxPlayers??(Number.isInteger(capacity)&&capacity>=2&&capacity<=5000?capacity:null),
  map:health?{module:health.map?.module??'europe',revision:health.map?.revision??null}:null,
  connection:{
   auth:'guest',
   room:/^[A-Za-z0-9_-]{1,32}$/.test(room)?room:'HeavyMP',
   transport:'websocket',
   path:WEBSOCKET_PATH,
  },
  endpoints:{health:'/health',players:'/players',manifest:'/content/manifest'},
 };
}
