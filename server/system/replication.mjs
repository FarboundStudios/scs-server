import {encodeCompact} from '../shared/compact.mjs';
const rosterRefreshMs=2000;
export function updateEncodedState(session){const t=session.lastState.truck,c=t?.controls,critical=t?[t.lights,c.engine,c.parkingBrake,c.wipers,c.wiperMode??0,t.horn?.normal??false,t.horn?.air??false].join(':'):'';if(critical!==session.criticalEncoded){session.criticalEncoded=critical;session.criticalVersion=(session.criticalVersion??0)+1;}const audio=JSON.stringify(session.lastState.truck?.audio??null);if(audio!==session.audioEncoded){session.audioEncoded=audio;session.audioVersion=(session.audioVersion??0)+1;session.audioFragment="["+JSON.stringify(session.id)+","+audio+"]";}const full=JSON.stringify(encodeCompact(session.lastState,true)),coarse=JSON.stringify(encodeCompact(session.lastState,false));if(full!==session.fullEncoded){session.fullEncoded=full;session.fullVersion=(session.fullVersion??0)+1;session.fullFragment='['+JSON.stringify(session.id)+','+full+']';}if(coarse!==session.coarseEncoded){session.coarseEncoded=coarse;session.coarseVersion=(session.coarseVersion??0)+1;session.coarseFragment='['+JSON.stringify(session.id)+','+coarse+']';}}
export class Replicator {
 constructor({sessions,index,radius=1000,limit=32,stateTtl=1500,interestMs=200,candidateBudget=512,world,sendRaw,metrics={},collisionZones}){Object.assign(this,{sessions,index,radius,limit,stateTtl,interestMs,candidateBudget,world,sendRaw,metrics,collisionZones});this.effectiveHz=20;}
 initialize(s){s.nearbyIds=new Set();s.watchers=new Set();s.knownPeers=new Set();s.sentStates=new Map();s.interestAt=-Infinity;s.interestPhase=[...s.id].reduce((v,c)=>(Math.imul(v,31)+c.charCodeAt(0))>>>0,0)%this.interestMs;s.snapshotSeq=0;s.worldAt=-Infinity;s.metaAt=-Infinity;s.sentAudio=new Map();s.ackedConfigs=new Map();s.ackedTrailers=new Map();}
 forget(s){for(const id of s.nearbyIds){this.sessions.get(id)?.watchers.delete(s.id);}for(const id of s.watchers){const viewer=this.sessions.get(id);if(viewer)viewer.interestAt=-Infinity;}this.index.remove(s.id);}
 refresh(s,now,{limit:policyLimit=this.limit}={}){
  const limit=s.supportsDelta?policyLimit:Math.min(2,policyLimit);if(s.nearbyIds.size>limit){let kept=0;for(const id of s.nearbyIds){if(kept++<limit)continue;this.sessions.get(id)?.watchers.delete(s.id);s.nearbyIds.delete(id);s.pendingConfigs.delete(id);s.pendingTrailers.delete(id);s.ackedConfigs.delete(id);s.ackedTrailers.delete(id);}}
  const forced=s.interestAt===-Infinity;if(!forced&&now<(s.nextInterestAt??0))return;s.interestAt=now;s.nextInterestAt=now+(forced?Math.max(50,s.interestPhase):this.interestMs);
  const peers=this.index.nearest(s,this.radius,s.supportsDelta?policyLimit:Math.min(2,policyLimit),now,this.stateTtl,s.nearbyIds,this.candidateBudget);
  const next=new Set(peers.map(p=>p.id));for(const id of s.nearbyIds)if(!next.has(id)){const p=this.sessions.get(id);p?.watchers.delete(s.id);s.pendingConfigs.delete(id);s.pendingTrailers.delete(id);s.ackedConfigs.delete(id);s.ackedTrailers.delete(id);}
  for(const p of peers){p.watchers.add(s.id);if(p.appearance&&s.supportsAppearance&&s.ackedConfigs.get(p.id)!==p.revision)s.pendingConfigs.set(p.id,p.revision);if(p.trailer&&s.supportsTrailer){const view=p.trailerViews?.[s.supportsCargo?(s.supportsChain?0:1):(s.supportsChain?2:3)];if(view&&s.ackedTrailers.get(p.id)!==view.revision)s.pendingTrailers.set(p.id,view.revision);}}
  s.nearbyIds=next;
 }
 send(s,now,{limit=this.limit,hz=this.effectiveHz}={}){
  this.refresh(s,now,{limit});const peers=[];for(const id of s.nearbyIds){const p=this.sessions.get(id);if(s.lastState&&p?.lastState&&now-p.stateAt<=this.stateTtl&&(p.lastState.x-s.lastState.x)**2+(p.lastState.z-s.lastState.z)**2<=this.radius**2)peers.push(p);}
  s.synchronizedPeers=peers.length;const zoneValue=this.collisionZones?.policy(s,peers,now),zoneText=zoneValue?JSON.stringify(zoneValue):null,collisionZones=zoneText&&(zoneText!==s.zoneSent||now-(s.zoneSentAt??-Infinity)>=500)?zoneValue:undefined;
  const present=new Set(peers.map(p=>p.id)),removed=[...s.knownPeers].filter(id=>!present.has(id));
  if(!s.supportsDelta){const list=[s,...peers].map(p=>({id:p.id,name:p.name,pingMs:Number.isFinite(p.rttMs)?Math.round(p.rttMs):null,ageMs:p.lastState?Math.max(0,Math.round(now-p.stateAt)):null,state:p.lastState&&now-p.stateAt<=this.stateTtl?Object.fromEntries(Object.entries(p.lastState).filter(([key])=>s.supportsTrailer?(key!=='trailers'||s.supportsChain):!['trailer','trailers'].includes(key))):null}));return this.sendRaw(s.socket,JSON.stringify({type:'snapshot',time:Date.now(),players:list,playerCount:this.sessions.size,...(collisionZones?{collisionZones}:{}),...(s.supportsWorld?{world:this.world()}: {})}));}
  const entered=[],fragments=[],ages=[],alive=[],audio=[],audioCommits=[],commits=[];let bytes=1024;const px=s.lastState?.x??0,pz=s.lastState?.z??0;
  let rank=0;for(const p of peers){const priority=rank++<Math.max(2,Math.min(8,Math.ceil(limit/4))),known=s.knownPeers.has(p.id),last=s.sentStates.get(p.id),d2=(p.lastState.x-px)**2+(p.lastState.z-pz)**2,criticalDue=p.criticalVersion!==last?.criticalVersion,animationDue=!last||now-(last.fullAt??-Infinity)>=(d2<=350**2?200:500),rosterDue=!known||now-(last?.rosterAt??-Infinity)>=rosterRefreshMs,full=rosterDue||criticalDue||(priority&&d2<=350**2&&now-(last?.fullAt??-Infinity)>=100)||animationDue,interval=Math.max(1000/hz,d2<=250**2?(priority?50:100):d2<=700**2?100:200);
   if(s.sentAudio.get(p.id)!==p.audioVersion&&p.audioFragment){audio.push(p.audioFragment);audioCommits.push([p.id,p.audioVersion]);}
   const version=p.coarseVersion,fullVersion=p.fullVersion,fragment=full?p.fullFragment:p.coarseFragment;
   if(last&&now-last.at<interval&&!criticalDue&&!rosterDue)continue;
   if(rosterDue||version!==last?.version||(full&&fullVersion!==last?.fullVersion)){
    if(!fragment)continue;
    const entry=rosterDue?{id:p.id,name:p.name}:null;
    const size=Buffer.byteLength(fragment)+(entry?Buffer.byteLength(JSON.stringify(entry))+1:0);
    if(bytes+size>48000)continue;
    bytes+=size;fragments.push(fragment);ages.push(Math.max(0,Math.min(this.stateTtl,Math.round(now-p.stateAt))));
    if(entry)entered.push(entry);
    commits.push({id:p.id,version,fullVersion:full?fullVersion:last?.fullVersion,fullAt:full?now:last?.fullAt,criticalVersion:full?p.criticalVersion:last?.criticalVersion,rosterAt:rosterDue?now:last?.rosterAt,at:now});
   }
   else if(now-last.at>=500){alive.push(p.id);commits.push({...last,id:p.id,version,at:now});}
  }
  const worldDue=s.supportsWorld&&now-s.worldAt>=1000,metaDue=now-s.metaAt>=1000,infoDue=now-(s.peerInfoAt??-Infinity)>=1000;
  if(!collisionZones&&!fragments.length&&!audio.length&&!alive.length&&!removed.length&&!worldDue&&!metaDue&&!infoDue)return true;
  const line='{"type":"snapshot_delta","time":'+Date.now()+',"sequence":'+(s.snapshotSeq+1)+',"ages":'+JSON.stringify(ages)+',"entered":'+JSON.stringify(entered)+',"updates":['+fragments.join(',')+'],"audio":['+audio.join(',')+'],"removed":'+JSON.stringify(removed)+',"alive":'+JSON.stringify(alive)+',"uploadHz":'+hz+',"playerCount":'+this.sessions.size+(collisionZones?',"collisionZones":'+JSON.stringify(collisionZones):'')+(infoDue?',"peerInfo":'+JSON.stringify(peers.map(p=>({id:p.id,name:p.name,pingMs:Number.isFinite(p.rttMs)?Math.round(p.rttMs):null}))):'')+(worldDue?',"world":'+JSON.stringify(this.world()):'')+'}';
  const accepted=this.sendRaw(s.socket,line);
  if(accepted){if(collisionZones){s.zoneSent=zoneText;s.zoneSentAt=now;}s.snapshotSeq++;for(const [id,version] of audioCommits)s.sentAudio.set(id,version);for(const id of removed){s.knownPeers.delete(id);s.sentStates.delete(id);s.sentAudio.delete(id);}for(const update of commits){s.knownPeers.add(update.id);s.sentStates.set(update.id,update);}if(worldDue)s.worldAt=now;if(infoDue)s.peerInfoAt=now;s.metaAt=now;this.metrics.statePackets=(this.metrics.statePackets??0)+1;this.metrics.stateBytes=(this.metrics.stateBytes??0)+Buffer.byteLength(line)+1;}
  return accepted;
 }
}
