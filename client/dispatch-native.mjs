import {randomUUID} from 'node:crypto';
import {dispatchSpec} from '../server/shared/dispatch.mjs';
export function nativeDispatchPacket(mission,id){
 const spec=dispatchSpec(mission.spec);if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))throw Error('Invalid native request ID.');
 const packet=Buffer.alloc(544);packet.write('HMD1');packet.writeUInt32LE(1,4);packet.writeUInt32LE(spec.unitsCount,8);packet.writeUInt32LE(spec.distanceKm,12);Buffer.from(id.replaceAll('-',''),'hex').copy(packet,16);
 for(const [i,key]of ['cargo','source','destination','trailerDefinition'].entries())packet.write(spec[key],32+i*128,127,'ascii');return packet;
}
export function createNativeDispatch({send,timeoutMs=30000}){
 let pending=null;
 return {request(mission){if(pending)return Promise.reject(Error('A delivery is already being prepared.'));const id=randomUUID(),packet=nativeDispatchPacket(mission,id);return new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(pending?.timeout);clearInterval(pending?.retry);pending=null;};pending={id,resolve:value=>{stop();resolve(value);},reject:error=>{stop();reject(error);}};pending.timeout=setTimeout(()=>pending?.reject(Error('The game did not confirm the delivery. No save was created.')),timeoutMs);pending.retry=setInterval(()=>{try{send(packet);}catch(error){pending?.reject(error);}},300);try{send(packet);}catch(error){pending.reject(error);}});},receive(message){if(message.type!=='dispatch_result')return false;if(pending?.id===message.id&&typeof message.ok==='boolean'){message.ok?pending.resolve({id:message.id,method:'live',requiresLoad:false,market:message.market==='cargo_market'?'cargo_market':'freight_market',unitsCount:Number.isInteger(message.unitsCount)&&message.unitsCount>0&&message.unitsCount<=10000?message.unitsCount:null}):pending.reject(Error(typeof message.reason==='string'?message.reason.slice(0,240):'The game refused the delivery.'));}return true;},close(){pending?.reject(Error('Game client closed.'));}};
}
