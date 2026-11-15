// Authenticated-session core. Not activated in the production server yet.
// Initial implementation deliberately has one authority for the whole room.
import {validTrafficSample,trafficModelKey,validTrafficPopulation,trafficLabPacket} from '../shared/traffic.mjs';
export class TrafficRelay {
 constructor({now=()=>performance.now(),limit=16,radius=750,bodyFactor=1}={}){
  if(!validTrafficPopulation(limit)||!Number.isInteger(radius)||radius<100||radius>1500||![1,4].includes(bodyFactor))throw Error('invalid_traffic_limits');
  Object.assign(this,{now,limit,radius,bodyFactor});this.sessions=new Map();this.actors=new Map();this.owner=null;this.epoch=0;this.sequence=-1;this.serial=0;
 }
 updateSession(id,position,ready=true){
  if(typeof id!=='string'||!id||id.length>64||!Array.isArray(position)||position.length!==3||!position.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e7))return false;
  if(!this.sessions.has(id)&&this.sessions.size>=5000)return false;
  this.sessions.set(id,{id,position:[...position],ready:ready===true,at:this.now()});return true;
 }
 tick(){
  const now=this.now();for(const [id,s]of this.sessions)if(now-s.at>1500)this.sessions.delete(id);
  const current=this.sessions.get(this.owner),owner=current?.ready?current:[...this.sessions.values()].find(s=>s.ready);
  if(this.owner!==(owner?.id??null)){this.owner=owner?.id??null;this.epoch++;this.sequence=-1;this.actors.clear();}
  for(const [id,a]of this.actors)if(now-a.at>1000)this.actors.delete(id);
 }
 removeSession(id){this.sessions.delete(id);this.tick();}
 role(id){this.tick();return {owner:this.owner===id,epoch:this.epoch,limit:this.limit,validForMs:1000};}
 publish(id,{epoch,sequence,samples}){
  this.tick();if(id!==this.owner||epoch!==this.epoch)throw Error('not_traffic_authority');
  if(!Number.isSafeInteger(sequence)||sequence<0||sequence<=this.sequence)throw Error('traffic_sequence');
  if(!Array.isArray(samples)||samples.length>this.limit*this.bodyFactor)throw Error('traffic_capacity');
  const validated=[],seen=new Set(),owner=this.sessions.get(id);let roots=0,trailers=0;
  for(const item of samples){const sample=validTrafficSample(item);
   if(!sample||seen.has(sample.nativeId)||Math.hypot(sample.position[0]-owner.position[0],sample.position[2]-owner.position[2])>1500)throw Error('invalid_traffic_sample');
   if(sample.vehicleType===255)trailers++;else roots++;
   if(roots>this.limit||trailers>this.limit*(this.bodyFactor-1))throw Error('traffic_capacity');
   seen.add(sample.nativeId);const model=trafficModelKey(sample),old=this.actors.get(sample.nativeId);
   if(old&&old.model===model){const elapsed=Math.max(0,this.now()-old.at)/1000;if(Math.hypot(sample.position[0]-old.sample.position[0],sample.position[2]-old.sample.position[2])>Math.max(15,elapsed*80+5))throw Error('traffic_discontinuity');}
   validated.push({sample,model});
  }
  const next=new Map();for(const {sample,model}of validated){const old=this.actors.get(sample.nativeId),same=old?.model===model;next.set(sample.nativeId,{id:same?old.id:++this.serial,model,sample,at:this.now(),wireBytes:same?old.wireBytes:trafficLabPacket(sample).length});}
  // One incomplete observation is not a despawn. Keep the previous identity
  // briefly, without exceeding either the motor-vehicle or trailer budget.
  for(const [nativeId,old]of this.actors)if(!next.has(nativeId)&&this.now()-old.at<=500){if(old.sample.vehicleType===255){if(trailers>=this.limit*(this.bodyFactor-1))continue;trailers++;}else{if(roots>=this.limit)continue;roots++;}next.set(nativeId,old);}
  this.actors=next;this.sequence=sequence;return validated.length;
 }
 snapshot(id,{includeOwner=false}={}){
  this.tick();const s=this.sessions.get(id);if(!s||(!includeOwner&&id===this.owner))return [];
  return [...this.actors.values()].filter(a=>Math.hypot(a.sample.position[0]-s.position[0],a.sample.position[2]-s.position[2])<=this.radius).slice(0,this.limit*this.bodyFactor).map(a=>({id:a.id,model:a.model,ageMs:Math.max(0,this.now()-a.at),sample:structuredClone(a.sample)}));
 }
 diagnostics(){return {experimental:true,scope:'single-authority',owner:this.owner,epoch:this.epoch,actors:this.actors.size,limit:this.limit};}
}
