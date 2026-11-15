import {readFile,stat} from 'node:fs/promises';
import {validateZones,vehicleBodies,bodyInZone,bodiesOverlap,zoneSetting} from '../shared/no-collision-zones.mjs';
const cellSize=256;
export async function loadZoneCatalogue(path){if((await stat(path)).size>16*1024*1024)throw Error('No-collision zone catalogue too large.');return parseZoneCatalogue(await readFile(path));}
export function parseZoneCatalogue(bytes){if(bytes.length>16*1024*1024)throw Error('No-collision zone catalogue too large.');const raw=JSON.parse(bytes);if(raw.geometry==='bounded-facility-spawn-circles')throw Error('Ancien catalogue de cercles automatiques : remplacer par les contours de terrains regeneres.');validateZones(raw);return raw;}
export function createCollisionZones({enabled=true,catalogue={schema:1,zones:[]},stateTtl=1500}={}){
 enabled=zoneSetting(enabled);const zones=enabled?validateZones(catalogue):[],grid=new Map(),pairs=new Map();let heldPairs=0,capacityGhostMode=false;
 for(const zone of zones){const xs=zone.shape==='circle'?[zone.x-zone.radius,zone.x+zone.radius]:zone.points.map(p=>p[0]),zs=zone.shape==='circle'?[zone.z-zone.radius,zone.z+zone.radius]:zone.points.map(p=>p[1]);for(let x=Math.floor((Math.min(...xs)-20)/cellSize);x<=Math.floor((Math.max(...xs)+20)/cellSize);x++)for(let z=Math.floor((Math.min(...zs)-20)/cellSize);z<=Math.floor((Math.max(...zs)+20)/cellSize);z++){const key=x+':'+z;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(zone);}}
 function update(session,now){
  if(session.zoneAt===now)return;session.zoneAt=now;
  const fresh=!!session.lastState&&now-session.stateAt<=stateTtl;
  session.zoneBodies=fresh?vehicleBodies(session.lastState):[];let inside=false;
  // Safety capsules only control re-arming after overlap. They must never
  // inflate a facility footprint into an adjacent public road.
  if(enabled)for(const body of session.zoneBodies){const candidates=grid.get(Math.floor(body.x/cellSize)+':'+Math.floor(body.z/cellSize))??[],probe={y:body.y,ax:body.x,az:body.z,bx:body.x,bz:body.z,radius:0};if(candidates.some(zone=>bodyInZone(probe,zone,0))){inside=true;break;}}
  session.zoneInside=inside;session.zoneFresh=fresh;
 }
 function policy(session,peers,now){
  if(!enabled)return undefined;update(session,now);const blocked=[];
  if(now-(session.zonePruneAt??-Infinity)>=1000){session.zonePruneAt=now;let budget=64;const links=pairs.get(session.id);session.zonePruneIterator??=links?.entries();while(budget--&&session.zonePruneIterator){const entry=session.zonePruneIterator.next();if(entry.done){session.zonePruneIterator=null;break;}const [other,pair]=entry.value;if(now>pair.until+5000&&pair.sessions.every(s=>s.lastState&&now-s.stateAt<=stateTtl)&&!bodiesOverlap(...pair.sessions.map(s=>vehicleBodies(s.lastState))))remove(session.id,other);}}
  for(const peer of peers){update(peer,now);const prior=pairs.get(session.id)?.get(peer.id);let ghost=capacityGhostMode||session.zoneInside||peer.zoneInside;
   if(ghost){if(prior)prior.until=now+1000;else if(heldPairs>=200000){capacityGhostMode=true;}else{const pair={until:now+1000,sessions:[session,peer]};for(const [id,other] of [[session.id,peer.id],[peer.id,session.id]]){if(!pairs.has(id))pairs.set(id,new Map());pairs.get(id).set(other,pair);}++heldPairs;}}
   else if(prior){ghost=now<prior.until||!session.zoneFresh||!peer.zoneFresh||bodiesOverlap(session.zoneBodies,peer.zoneBodies);if(!ghost)remove(session.id,peer.id);}
   if(ghost)blocked.push(peer.id);
  }
  return {enabled:true,inside:session.zoneInside,blocked:blocked.slice(0,32)};
 }
 function remove(a,b){if(!pairs.get(a)?.delete(b))return;--heldPairs;pairs.get(b)?.delete(a);if(!pairs.get(a)?.size)pairs.delete(a);if(!pairs.get(b)?.size)pairs.delete(b);}
 function forget(id){for(const other of [...(pairs.get(id)?.keys()??[])])remove(id,other);}
 return {enabled,count:zones.length,policy,forget,diagnostics:()=>({enabled,zones:zones.length,heldPairs,capacityGhostMode})};
}
