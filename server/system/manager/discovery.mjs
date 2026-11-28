import release from '../../../package.json' with {type:'json'};
import {canonicalRoom,WEBSOCKET_PATH} from '../../shared/branding.mjs';
import {DISCOVERY_SCHEMA,optionalModsEnabled} from '../../shared/discovery.mjs';
import {GAME_VERSION,PROTOCOL} from '../../shared/protocol.mjs';
import {collisionSetting} from '../../shared/collisions.mjs';

export function describeInstance(supervisor,configured,env){
 const status=supervisor.state;
 const online=status==='running';
 const identity=supervisor.meta;
 const health=online?supervisor.snapshot?.health:null;
 const applied=supervisor.env??env;
 const capacity=Number(applied.MAX_PLAYERS??5000);
 const room=canonicalRoom(applied.ROOM);
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
  allowOptionalMods:online&&optionalModsEnabled(applied),
  collisions:online?(health?.capabilities?.collisions??collisionSetting(applied.PLAYER_COLLISIONS)):null,
  traffic:online?(health?.traffic?.enabled??['true','1'].includes(String(applied.TRAFFIC_ENABLED??'').trim().toLowerCase())):null,
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
