import {TrafficRelay} from './traffic-relay.mjs';
import {validTrafficPopulation} from '../shared/traffic.mjs';
import {SpatialIndex} from './spatial.mjs';
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]);
const bounded=(v,min,max,name)=>{if(!Number.isInteger(v)||v<min||v>max)throw Error('Invalid '+name+'.');return v;};
export function trafficCoordinationSettings(env={}){return {
 trafficSourceGraceMs:bounded(Number(env.TRAFFIC_SOURCE_GRACE_MS??750),0,1500,'TRAFFIC_SOURCE_GRACE_MS'),
 trafficSourceTimeoutMs:bounded(Number(env.TRAFFIC_SOURCE_TIMEOUT_MS??3000),1500,15000,'TRAFFIC_SOURCE_TIMEOUT_MS'),
 trafficSourceWarmupMs:bounded(Number(env.TRAFFIC_SOURCE_WARMUP_MS??15000),3000,60000,'TRAFFIC_SOURCE_WARMUP_MS')
};}
// ETS2 owns driving decisions. Node assigns sources and relays validated poses;
// it cannot migrate the engine's internal driver state to another PC.
export class NativeTrafficGroups {
 constructor({limit=8,radius=750,maxActors=128,now=()=>performance.now(),sourceGraceMs=750,sourceTimeoutMs=3000,sourceWarmupMs=15000,cellSize=250}={}){
  if(!validTrafficPopulation(limit)||!validTrafficPopulation(maxActors))throw Error('invalid_traffic_limits');
  bounded(radius,100,1500,'traffic_radius');bounded(sourceGraceMs,0,1500,'source_grace');bounded(sourceTimeoutMs,1500,15000,'source_timeout');bounded(sourceWarmupMs,3000,60000,'source_warmup');
  limit=Math.min(limit,maxActors);Object.assign(this,{limit,radius,maxActors,now,sourceGraceMs,sourceTimeoutMs,sourceWarmupMs});
  this.sessions=new Map();this.groups=new Map();this.assignments=new Map();this.epoch=0;this.serial=0;
  this.actorIndex=new SpatialIndex(cellSize);this.indexedActors=new Map();this.actorCandidatesChecked=0;
  this.metrics={elections:0,releases:0,merges:0,sourceTimeouts:0,teleportResets:0,assignmentChanges:0};
 }
 updateSession(id,position,ready){
  if(typeof id!=='string'||!id||id.length>64||!Array.isArray(position)||position.length!==3||position.some(v=>!Number.isFinite(v)||Math.abs(v)>1e7)||!this.sessions.has(id)&&this.sessions.size>=5000)return false;
  const old=this.sessions.get(id),at=this.now(),isReady=ready===true;
  this.sessions.set(id,{id,position:[...position],ready:isReady,at,unreadySince:isReady?null:old?.unreadySince??at,cooldownUntil:old?.cooldownUntil??0,reset:old?.reset===true||!!(old&&this.groups.has(id)&&distance(old.position,position)>this.radius*2)});return true;
 }
 removeSession(id){this.sessions.delete(id);this.tick();}
 tick(){
  const time=this.now();for(const [id,s]of this.sessions)if(time-s.at>1200)this.sessions.delete(id);
  const owners=[],old=this.groups,groups=new Map(),separation=this.radius*2+200,retentionSeparation=separation-Math.min(100,this.radius*.2),capacity=Math.max(1,Math.floor(this.maxActors/this.limit));
  const add=(s,retained=false)=>{
   if(!s||s.cooldownUntil>time||owners.length>=capacity)return;
   let g=old.get(s.id);
   if(retained&&g){
    const silent=time-(g.lastCaptureAt??g.createdAt)>(g.lastCaptureAt===null?this.sourceWarmupMs:this.sourceTimeoutMs);
    if(silent){s.cooldownUntil=time+Math.max(5000,this.sourceTimeoutMs*2);this.metrics.sourceTimeouts++;return;}
    if(!s.ready&&(s.unreadySince===null||time-s.unreadySince>this.sourceGraceMs))return;
   }else if(!s.ready)return;
   if(owners.some(o=>distance(o.position,s.position)<(retained?retentionSeparation:separation)))return;
   if(s.reset){g=null;s.reset=false;this.metrics.teleportResets++;}
   if(!g){g={owner:s.id,epoch:++this.epoch,createdAt:time,lastCaptureAt:null,relay:new TrafficRelay({limit:this.limit,radius:this.radius,bodyFactor:4,now:this.now}),ids:new Map()};this.metrics.elections++;}
   owners.push(s);groups.set(s.id,g);
  };
  for(const g of [...old.values()].sort((a,b)=>a.epoch-b.epoch))add(this.sessions.get(g.owner),true);
  for(const s of this.sessions.values())if(!groups.has(s.id))add(s);
  for(const [id]of old)if(!groups.has(id)){this.metrics.releases++;const s=this.sessions.get(id);if(s?.ready&&s.cooldownUntil<=time&&owners.some(o=>distance(o.position,s.position)<retentionSeparation))this.metrics.merges++;}
  const assignments=new Map();let uncovered=0;
  for(const s of this.sessions.values()){
   const closest=owners.reduce((a,b)=>!a||distance(s.position,b.position)<distance(s.position,a.position)?b:a,null);
   if(closest){const g=groups.get(closest.id);assignments.set(s.id,g);g.relay.updateSession(s.id,s.position,s.id===g.owner);if(distance(s.position,closest.position)>this.radius)uncovered++;}else uncovered++;
   if(this.assignments.get(s.id)?.epoch!==assignments.get(s.id)?.epoch)this.metrics.assignmentChanges++;
  }
  this.assignments=assignments;this.uncovered=uncovered;
  for(const g of groups.values()){for(const id of g.relay.sessions.keys())if(assignments.get(id)!==g)g.relay.sessions.delete(id);g.relay.tick();}
  this.groups=groups;
  for(const [id,e]of this.indexedActors)if(time-e.stateAt>1000||groups.get(e.owner)?.epoch!==e.epoch){this.actorIndex.remove(id);this.indexedActors.delete(id);}
 }
 role(id){const g=this.assignments.get(id);return {owner:g?.owner===id,epoch:g?.epoch??0,limit:this.limit,active:true,mode:'native',scope:'proximity'};}
 publish(id,message){
  const g=this.groups.get(id);if(!g||message.epoch!==g.epoch)throw Error('not_traffic_authority');
  const count=g.relay.publish(id,{...message,epoch:g.relay.epoch}),next=new Map();g.lastCaptureAt=this.now();
  for(const a of g.relay.actors.values()){
   const globalId=g.ids.get(a.id)??++this.serial;next.set(a.id,globalId);
   if(a.globalId!==globalId||!a.stateJson){a.globalId=globalId;a.state={id:globalId,model:a.model,position:a.sample.position,quaternion:a.sample.quaternion,vehicleType:a.sample.vehicleType,lights:a.sample.lights,lookSeed:a.sample.lookSeed};a.stateJson=JSON.stringify(a.state);a.stateBytes=Buffer.byteLength(a.stateJson)+1;}
   let e=this.indexedActors.get(globalId);if(!e){e={id:globalId,owner:id,epoch:g.epoch,lastState:{x:0,z:0}};this.indexedActors.set(globalId,e);}e.actor=a;e.stateAt=a.at;e.lastState.x=a.sample.position[0];e.lastState.z=a.sample.position[2];this.actorIndex.update(e);
  }
  for(const [localId,globalId]of g.ids)if(!next.has(localId)){this.actorIndex.remove(globalId);this.indexedActors.delete(globalId);}
  g.ids=next;return count;
 }
 snapshot(id){const viewer=this.sessions.get(id);if(!viewer)return [];
  const position={x:viewer.position[0],z:viewer.position[2]},actors=[];for(const bucket of this.actorIndex.buckets(position,this.radius))for(const e of bucket){
   this.actorCandidatesChecked++;if(e.owner===id||this.groups.get(e.owner)?.epoch!==e.epoch)continue;const a=e.actor;
   const d2=(viewer.position[0]-a.sample.position[0])**2+(viewer.position[2]-a.sample.position[2])**2;
   if(this.now()-a.at>1000||d2>this.radius**2)continue;
   actors.push({id:e.id,model:a.model,sample:a.sample,wireBytes:a.wireBytes,ageMs:this.now()-a.at,d2,state:a.state,stateJson:a.stateJson,stateBytes:a.stateBytes});
  }
  return actors.sort((a,b)=>a.d2-b.d2).slice(0,this.limit*4);
 }
 diagnostics(){return {mode:'native-coordinated',groups:this.groups.size,actors:[...this.groups.values()].reduce((n,g)=>n+g.relay.actors.size,0),sessions:this.sessions.size,owner:this.groups.size?'assigned':null,uncoveredSessions:this.uncovered??0,spatial:{cellSize:this.actorIndex.cellSize,occupied:this.actorIndex.cells.size,actors:this.indexedActors.size,candidatesChecked:this.actorCandidatesChecked},coordination:{...this.metrics,sourceGraceMs:this.sourceGraceMs,sourceTimeoutMs:this.sourceTimeoutMs,sourceWarmupMs:this.sourceWarmupMs}};}
}
