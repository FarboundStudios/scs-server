import {validTrafficSample,trafficModelKey,trafficControlPacket,trafficViewerPacket,validTrafficPopulation} from '../server/shared/traffic.mjs';
export function createTrafficTransport({send,native,getPosition=()=>null,now=()=>performance.now()}={}){
 let supported=false,role=null,roleAt=-Infinity,active=false,nativeAt=-Infinity,ready=false,readyAt=-Infinity,controlAt=-Infinity,controlSeq=0;
 let frame=null,frameAt=-Infinity,frameSent=-1;const models=new Map(),sources=new Map();let uploadAt=-Infinity,uploadSeq=0,serial=0,nativeCount=0,replicas=0,readyVehicles=0,readyTrailers=0,failedModels=0,filteredSamples=0;
 return {
  diagnostics(){return {enabled:supported,nativeReady:ready&&now()-nativeAt<=1000,role:role?(role.owner?'source':'viewer'):null,epoch:role?.epoch??null,mode:'native',limit:role?.limit??null,captured:sources.size,nativeCount,replicas,readyVehicles,readyTrailers,failedModels,filteredSamples,receivedActors:frame&&now()-frameAt<=1000?frame.actors.length:0,nativeAgeMs:Number.isFinite(nativeAt)?Math.max(0,Math.round(now()-nativeAt)):null};},
  capabilities(c){supported=c?.traffic===6;role=null;roleAt=-Infinity;frame=null;frameAt=-Infinity;ready=false;models.clear();sources.clear();},
  disconnect(){supported=false;role=null;frame=null;models.clear();if(active){native(trafficControlPacket(null,controlSeq++));active=false;}},
  handle(msg){
   if(msg.type==='traffic_models'){
    if(!supported||!Array.isArray(msg.models)||msg.models.length<1||msg.models.length>32)return true;
    const next=new Map();for(const model of msg.models){if(!(/^[a-f0-9]{64}$/.test(model.id))||next.has(model.id))return true;const sample=validTrafficSample({nativeId:1,vehicleType:model.vehicleType??0,lookSeed:model.lookSeed??0,paintColor:model.paintColor,position:[0,0,0],quaternion:[1,0,0,0],accessories:model.accessories});if(!sample)return true;next.set(model.id,{accessories:sample.accessories,lookSeed:sample.lookSeed,paintColor:sample.paintColor});}
    for(const [id,parts] of next){models.set(id,parts);if(models.size>1024)models.delete(models.keys().next().value);}return true;
   }
   if(msg.type==='traffic_role'){
    if(supported&&msg.active===false){role=null;frame=null;ready=false;}
    if(supported&&typeof msg.owner==='boolean'&&msg.mode==='native'&&msg.active!==false&&Number.isInteger(msg.epoch)&&msg.epoch>=0&&msg.epoch<=0xffffffff&&validTrafficPopulation(msg.limit)){
     if(role?.epoch!==msg.epoch){sources.clear();frame=null;frameAt=-Infinity;frameSent=-1;}role={owner:msg.owner,epoch:msg.epoch,limit:msg.limit};roleAt=now();
    }return true;
   }
   if(msg.type==='traffic_state'){
    if(!supported||!role||msg.epoch!==role.epoch||!Number.isInteger(msg.sequence)||msg.sequence<0||msg.sequence>0xffffffff||!Array.isArray(msg.actors)||msg.actors.length>role.limit*4)return true;
    try{const actors=msg.actors.map(a=>({id:a.id,sample:validTrafficSample({nativeId:a.id,vehicleType:a.vehicleType??0,position:a.position,quaternion:a.quaternion,lights:a.lights,accessories:models.get(a.model)?.accessories,lookSeed:a.lookSeed??models.get(a.model)?.lookSeed??0,paintColor:models.get(a.model)?.paintColor})}));trafficViewerPacket(actors,msg.sequence,msg.epoch);if(frame&&now()-frameAt<=1000&&((msg.sequence-frame.sequence)|0)<=0)return true;frame={actors,sequence:msg.sequence,epoch:msg.epoch};frameAt=now();}catch{}return true;
   }return false;
  },
  receive(msg){
   if(msg.type!=='traffic_native')return false;
   if(!supported)return true;ready=msg.ready===true;nativeAt=now();const counter=v=>Number.isInteger(v)&&v>=0&&v<=0xffffffff?v:0;nativeCount=counter(msg.nativeCount);replicas=counter(msg.replicas);readyVehicles=counter(msg.readyVehicles);readyTrailers=counter(msg.readyTrailers);failedModels=counter(msg.failedModels);
   if(!ready||!role?.owner||msg.epoch!==role.epoch||now()-roleAt>1000||now()-uploadAt<95)return true;
   if(msg.captureCoherent===false||!Array.isArray(msg.samples)||msg.samples.length>role.limit*4)return true;
   const samples=[],seen=new Set();
   const origin=getPosition();for(const item of msg.samples){const sample=validTrafficSample(item);if(!sample){filteredSamples++;continue;}if(seen.has(sample.nativeId))return true;seen.add(sample.nativeId);if(origin&&Math.hypot(sample.position[0]-origin[0],sample.position[2]-origin[2])>1500){filteredSamples++;continue;}const model=trafficModelKey(sample),old=sources.get(sample.nativeId),elapsed=old?Math.max(0,now()-old.at)/1000:0;
    const reset=!old||old.model!==model||Math.hypot(sample.position[0]-old.position[0],sample.position[2]-old.position[2])>Math.max(15,elapsed*80+5);
    const id=reset?++serial:old.id;if(id>0xffffffff)return true;sources.set(sample.nativeId,{id,model,position:sample.position,at:now()});samples.push({...sample,nativeId:id});
   }
   for(const [id,source] of sources)if(now()-source.at>750)sources.delete(id);
   uploadAt=now();send({type:'traffic_capture',epoch:role.epoch,sequence:uploadSeq++,samples});return true;
  },
  tick(){
   const on=supported&&role&&now()-roleAt<=1000;
   if((supported||active)&&now()-controlAt>=200){controlAt=now();native(trafficControlPacket(on?{...role,active:true}:null,controlSeq++));active=!!on;}
   if(supported&&now()-readyAt>=500){readyAt=now();send({type:'traffic_ready',ready:ready&&now()-nativeAt<=1000,diagnostics:{nativeCount,replicas,readyVehicles,readyTrailers,failedModels,filteredSamples}});}
   if(on&&!role.owner&&frame&&now()-frameAt<=1000&&frameSent!==frame.sequence){native(trafficViewerPacket(frame.actors,frame.sequence,frame.epoch));frameSent=frame.sequence;}
  }
 };
}
