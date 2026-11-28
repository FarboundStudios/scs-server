import {optionalModsEnabled} from '../shared/discovery.mjs';
import {describeOptionalOrder} from '../shared/optional-order.mjs';
import {addonOrder} from './addon-inspection.mjs';
import {sectorSettings} from './sectors.mjs';
import {trafficSettings} from '../shared/traffic.mjs';
import {trafficCoordinationSettings} from './traffic-native.mjs';
import {readServerAsset} from './runtime-assets.mjs';
import {loadZoneCatalogue,parseZoneCatalogue} from './no-collision-zones.mjs';
import {zoneSetting} from '../shared/no-collision-zones.mjs';
import {staffOnlySetting,staffIdentities} from './access.mjs';
import {collisionSetting} from '../shared/collisions.mjs';
import {loadMapContent,loadAddonContent} from './content.mjs';
import {dealerBrandingArchive,dealerBrandingSupported,readDealerBranding} from './dealer-branding.mjs';
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isIP } from 'node:net';
import { port } from '../shared/protocol.mjs';
import { canonicalRoom, WEBSOCKET_PATH } from '../shared/branding.mjs';
import {validServers,communityServer} from './registry.mjs';
async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function prepareServer(env = process.env, log = console.log, services = {}) {
  const directory = resolve(env.DATA_DIR ?? './data');
  const listenPort = port(env.PORT ?? env.SERVER_PORT, 30007);
  const room = canonicalRoom(env.ROOM);
  const staffOnly=staffOnlySetting(env.STAFF_ONLY);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(room)) throw new Error('Invalid ROOM.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const configured=communityServer(env);
  const serverId=configured.id;
  const registryPath=resolve(env.SERVERS_FILE??join(directory,'servers.json'));
  let registry;
  try{registry=JSON.parse(await readFile(registryPath,'utf8'));}
  catch(error){
    if(error.code!=='ENOENT'||env.SERVERS_FILE)throw Error('Invalid or unreadable servers.json.');
    registry=[configured];
  }
  const servers=validServers(registry);
  const selected=servers.find(server=>server.id===serverId);
  if(!selected)throw Error('SERVER_ID must exist in the local registry.');
  const publicHost=env.PUBLIC_HOST??selected.host,publicPort=port(env.PUBLIC_PORT,selected.port);
  if(!isIP(publicHost)&&!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(publicHost))throw Error('Invalid PUBLIC_HOST.');
  const maxPlayers=Number(env.MAX_PLAYERS??5000);
  if(!Number.isSafeInteger(maxPlayers)||maxPlayers<2||maxPlayers>5000)throw Error('MAX_PLAYERS must be an integer between 2 and 5000.');
  const localStaff=staffIdentities(env.STAFF_IDENTITIES);
  if(staffOnly&&!localStaff.length)throw Error('STAFF_ONLY requires at least one fingerprint in STAFF_IDENTITIES.');
  const worldPath=join(directory,'world.json');
  if(!await exists(worldPath))await writeFile(worldPath,JSON.stringify({epoch:Date.now(),minutes:720})+'\n',{flag:'wx',mode:0o600});
  const savedWorld=JSON.parse(await readFile(worldPath,'utf8'));
  const world={...savedWorld,timeScale:Number(env.TIME_SCALE??19),weather:savedWorld.weather??env.WEATHER??'dynamic'};
  const persistWorld=async settings=>{await writeFile(worldPath+'.tmp',JSON.stringify(settings)+'\n',{mode:0o600});await rename(worldPath+'.tmp',worldPath);};
  const vtcPath=join(directory,'vtcs.json');
  if(!await exists(vtcPath))await writeFile(vtcPath,JSON.stringify({version:1,companies:[]})+'\n',{flag:'wx',mode:0o600});
  const vtcs=JSON.parse(await readFile(vtcPath,'utf8'));
  const persistVtcs=async state=>{await writeFile(vtcPath+'.tmp',JSON.stringify(state)+'\n',{mode:0o600});await rename(vtcPath+'.tmp',vtcPath);};
  let addonsReport, optional=[];
  const mapModule=env.MAP_MODULE?.trim();
  const dealerBranding=!dealerBrandingSupported(env)?null:await readDealerBranding(directory).then(dealerBrandingArchive).catch(()=>{
    log('Dealer branding could not be read. Using the HeavyMP name and icon.');
    return null;
  });
  if(env.MAP_MANIFEST!=='none')services.onAddonScan?.();
  const content=env.MAP_MANIFEST==='none'?null:env.MAP_MANIFEST?await loadMapContent(resolve(env.MAP_MANIFEST)):await loadAddonContent(env.ADDONS_DIR??'./addons',{
    indexPath:join(directory,'addons.json'),mapModule,dealerBranding,log,onHash:services.onAddonHash,onReport:report=>{addonsReport=report;},onOptional:slots=>{optional=slots;},
  });
  if(env.MAP_MANIFEST&&optionalModsEnabled(env)){
    const names=content?.manifest.files.map(file=>file.name)??[];
    const order=await addonOrder(resolve(env.ADDONS_DIR??'./addons'),names,log);
    optional=order.optional.map(slot=>({...slot,after:names.includes(slot.after)?slot.after:null}));
  }
  const optionalOrder=optionalModsEnabled(env)?describeOptionalOrder(optional,content?.revision??null):null;
  if(mapModule!==undefined&&mapModule!==(content?.manifest.module??'europe'))throw Error('MAP_MODULE does not match the active map manifest.');
  if(content)log('Official map: '+content.manifest.id+' '+content.manifest.version+' ('+content.manifest.module+')');
  log(`Public connection: wss://${publicHost}:${publicPort}${WEBSOCKET_PATH} · no certificate import required`);
  // Dépôts pour /move : { "paris": { "x": 0, "y": 0, "z": 0, "heading": 0 } } (fichier facultatif, depots.json dans le dossier de données)
  const depotsPath=resolve(env.DEPOTS_FILE??join(directory,'depots.json')),depots={};
  if(await exists(depotsPath)){const raw=JSON.parse(await readFile(depotsPath,'utf8'));for(const [depot,p] of Object.entries(raw??{})){if(/^[\p{L}\p{N} _.-]{1,32}$/u.test(depot)&&p&&[p.x,p.y,p.z].every(Number.isFinite))depots[depot.toLowerCase()]={x:p.x,y:p.y,z:p.z,heading:Number.isFinite(p.heading)?p.heading:0};}}
  const noCollisionZonesEnabled=zoneSetting(env.NO_COLLISION_ZONES_ENABLED),zoneFile=env.NO_COLLISION_ZONES_FILE;
  let zoneCatalogue;if(noCollisionZonesEnabled){try{zoneCatalogue=zoneFile!==undefined?await loadZoneCatalogue(resolve(zoneFile)):parseZoneCatalogue(await readServerAsset('assets/no-collision-zones-'+(content?.revision??'europe')+'.json'));}catch(e){if(e.code==='ENOENT')throw Error('No zone catalogue for this map. Generate one or disable NO_COLLISION_ZONES_ENABLED.');throw e;}}
  if(zoneCatalogue&&(zoneCatalogue.contentRevision||content?.manifest.module&&content.manifest.module!=='europe')&&zoneCatalogue.contentRevision!==(content?.revision??null))throw Error('No-collision zone catalogue does not match the active map content. Regenerate it for this manifest.');
  log('Non-collision zones: '+(noCollisionZonesEnabled?zoneCatalogue.zones.length+' automatic zones.':'disabled.'));
  const traffic={...trafficSettings(env),...trafficCoordinationSettings(env),...sectorSettings(env)};log(traffic.trafficEnabled?'Traffic: native ETS2 AI with server-coordinated proximity groups.':'Traffic: disabled.');
  return { ...traffic,noCollisionZonesEnabled,zoneCatalogue,localStaff,allowOptionalMods:optionalModsEnabled(env),optionalOrder,dataDirectory:directory,dispatchDatabase:join(directory,'missions.sqlite'),staffOnly,collisions:collisionSetting(env.PLAYER_COLLISIONS),depots,host: env.HOST ?? '0.0.0.0', port: listenPort, room, maxPlayers,nearbyLimit:Number(env.MAX_NEARBY_PLAYERS??32),radius:Number(env.SYNC_RADIUS??1000),tickHz:Number(env.TICK_HZ??20),cellSize:Number(env.GRID_CELL_SIZE??250),interestMs:Number(env.INTEREST_INTERVAL_MS??200),candidateBudget:Number(env.INTEREST_CANDIDATE_BUDGET??512),chatRadius:Number(env.LOCAL_CHAT_RADIUS??500),globalChatRate:Number(env.GLOBAL_CHAT_RATE??6),maxConfigBytes:Number(env.MAX_CONFIG_MB??512)*1024*1024,world,servers,serverId,content,addonsReport,persistWorld,vtcs,persistVtcs };
}
