// Traffic schema is separate from player trucks: AI definitions have no cabin,
// engine or transmission accessories and must not pass the player-truck loader.
import {createHash} from 'node:crypto';
const integer=(v,a,b)=>Number.isInteger(v)&&v>=a&&v<=b;
// Only the numeric representation bounds population; no gameplay ceiling of 16/32.
export const validTrafficPopulation=v=>integer(v,1,0x3fffffff);
const finite=(v,b)=>Number.isFinite(v)&&Math.abs(v)<=b;
const asset=p=>typeof p==='string'&&p.length<=256&&/^\/def\/vehicle\/[a-zA-Z0-9_.\/-]+\.sii$/.test(p)&&!p.includes('..')&&!p.includes('//');
export function validTrafficSample(input){
 if(!input||!finite(input.lookSeed??0,1)||(input.lookSeed??0)<0||!integer(input.nativeId,0,0xffffffff)||!integer(input.vehicleType,0,255)||!integer(input.lights??0,0,0xffff))return null;
 if(!Array.isArray(input.position)||input.position.length!==3||!input.position.every(v=>finite(v,1e7)))return null;
 if(!Array.isArray(input.quaternion)||input.quaternion.length!==4||!input.quaternion.every(v=>finite(v,1.01)))return null;
 const norm=input.quaternion.reduce((sum,v)=>sum+v*v,0);if(norm<.9||norm>1.1)return null;
 if(!Array.isArray(input.accessories)||input.accessories.length<1||input.accessories.length>16)return null;
 const accessories=[];
 const paintColor=input.paintColor??null;if(paintColor!==null&&(input.vehicleType===255||!Array.isArray(paintColor)||paintColor.length!==3||!paintColor.every(v=>finite(v,16)&&v>=0)))return null;
 for(const part of input.accessories){
  if(!part||![1,3,4,5].includes(part.kind)||!asset(part.path)||!integer(part.flags??0,0,0xffffffff))return null;
  const colors=part.colors??[0,0,0];if(!Array.isArray(colors)||colors.length!==(part.kind===4?18:3)||!colors.every(v=>finite(v,16)))return null;
  accessories.push({kind:part.kind,path:part.path,flags:part.flags??0,colors:[...colors]});
 }
 if(accessories[0].kind!==1||!(input.vehicleType===255?accessories[0].path.startsWith('/def/vehicle/trailer/'):accessories[0].path.startsWith('/def/vehicle/ai/')))return null;
 return {nativeId:input.nativeId,vehicleType:input.vehicleType,position:[...input.position],quaternion:input.quaternion.map(v=>v/Math.sqrt(norm)),lights:input.lights??0,lookSeed:input.lookSeed??0,paintColor:paintColor===null?null:[...paintColor],accessories};
}
export function trafficModelKey(sample){return createHash('sha256').update(JSON.stringify({accessories:sample.accessories,lookSeed:sample.lookSeed??0,vehicleType:sample.vehicleType??0,paintColor:sample.paintColor??null})).digest('hex');}
// Local game bridge for the isolated one-replica network test. No credentials,
// author identities, native pointers or engine offsets are transmitted.
export function trafficLabPacket(input,sequence=0){
 const sample=validTrafficSample(input);if(!sample||!integer(sequence,0,0xffffffff))throw Error('invalid_traffic_sample');
 const lengths=sample.accessories.map(p=>Buffer.byteLength(p.path)),packet=Buffer.alloc(76+lengths.reduce((n,v,i)=>n+(sample.accessories[i].kind===4?84:24)+v,0));
 packet.write('HIL3');packet.writeUInt32LE(sequence,4);packet.writeUInt32LE(sample.nativeId,8);packet.writeUInt32LE((sample.accessories.length|(sample.vehicleType===255?0x80000000:0)|(sample.paintColor?0x40000000:0))>>>0,12);
 sample.position.forEach((v,i)=>packet.writeDoubleLE(v,16+i*8));sample.quaternion.forEach((v,i)=>packet.writeFloatLE(v,40+i*4));packet.writeUInt32LE(sample.lights,56);packet.writeFloatLE(sample.lookSeed,60);
 sample.paintColor?.forEach((v,i)=>packet.writeFloatLE(v,64+i*4));let offset=76;for(let i=0;i<sample.accessories.length;i++){
  const part=sample.accessories[i];packet.writeUInt32LE(part.kind,offset);packet.writeUInt32LE(part.flags,offset+4);packet.writeUInt32LE(lengths[i],offset+8);part.colors.forEach((v,j)=>packet.writeFloatLE(v,offset+12+j*4));const header=part.kind===4?84:24;packet.write(part.path,offset+header);offset+=header+lengths[i];
 }return packet;
}
export function trafficControlPacket(role,sequence=0){
 const limit=role?.limit??32;if(!validTrafficPopulation(limit))throw Error('invalid_traffic_limit');const packet=Buffer.alloc(24);packet.write('HIA1');packet.writeUInt32LE(sequence>>>0,4);packet.writeUInt32LE(role?.active?(role.owner?2:1):0,8);packet.writeUInt32LE((role?.epoch??0)>>>0,12);packet.writeUInt32LE(limit,16);return packet;
}
export function trafficViewerPacket(actors,sequence,epoch){
 if(!Array.isArray(actors))throw Error('invalid_traffic_snapshot');
 const ids=new Set(),records=[];let bytes=16;
 for(const actor of actors){if(!integer(actor.id,1,0xffffffff)||ids.has(actor.id))throw Error('invalid_traffic_id');ids.add(actor.id);const record=trafficLabPacket({...actor.sample,nativeId:actor.id},sequence>>>0);if(bytes+4+record.length>60000)continue;records.push(record);bytes+=4+record.length;}
 const packet=Buffer.alloc(bytes);
 packet.write('HIV1');packet.writeUInt32LE(sequence>>>0,4);packet.writeUInt32LE(records.length,8);packet.writeUInt32LE(epoch>>>0,12);let offset=16;for(const record of records){packet.writeUInt32LE(record.length,offset);record.copy(packet,offset+4);offset+=4+record.length;}return packet;
}
export function trafficSettings(env={}){
 const flag=String(env.TRAFFIC_ENABLED??'false').trim().toLowerCase();if(!['true','false','1','0'].includes(flag))throw Error('TRAFFIC_ENABLED must be true or false');
 const limit=Number(env.TRAFFIC_MAX_VEHICLES??32),radius=Number(env.TRAFFIC_VIEW_RADIUS??750),hz=Number(env.TRAFFIC_HZ??10);
 if(!validTrafficPopulation(limit)||!integer(radius,100,1500)||!integer(hz,2,10))throw Error('Invalid traffic settings (positive integer population, radius 100..1500m, Hz 2..10)');
 const maxActors=Number(env.TRAFFIC_GLOBAL_MAX_VEHICLES??128);if(!validTrafficPopulation(maxActors))throw Error('TRAFFIC_GLOBAL_MAX_VEHICLES must be a positive integer');
 return {trafficMaxActors:maxActors,trafficEnabled:['true','1'].includes(flag),trafficLimit:limit,trafficRadius:radius,trafficHz:hz};
}
