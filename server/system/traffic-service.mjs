import {NativeTrafficGroups} from './traffic-native.mjs';
import {validTrafficPopulation} from '../shared/traffic.mjs';
export function createTrafficService({enabled=false,sessions,send,sendState=null,limit=8,radius=750,hz=10,maxActors=128,now=()=>performance.now(),sourceGraceMs=750,sourceTimeoutMs=3000,sourceWarmupMs=15000,cellSize=250}={}){
 if(!validTrafficPopulation(limit)||!Number.isInteger(hz)||hz<2||hz>10||!validTrafficPopulation(maxActors))throw Error('invalid_traffic_limits');
 const relay=new NativeTrafficGroups({limit,radius,maxActors,now,sourceGraceMs,sourceTimeoutMs,sourceWarmupMs,cellSize});let tickAt=-Infinity,sequence=0,lastTickMs=0,maxTickMs=0,periodWork=0;const metrics={acceptedBatches:0,rejectedBatches:0,acceptedSamples:0,rejectionReasons:{}};
 return {
  handle(s,msg){
   if(!['traffic_ready','traffic_capture'].includes(msg.type))return false;if(!enabled||!s.supportsTraffic)return true;
   if(msg.type==='traffic_ready'){if(typeof msg.ready==='boolean'){s.trafficReady=msg.ready;s.trafficReadyAt=now();const d=msg.diagnostics;s.trafficDiagnostics={};for(const key of ['nativeCount','replicas','readyVehicles','readyTrailers','failedModels','filteredSamples'])if(Number.isInteger(d?.[key])&&d[key]>=0&&d[key]<=0xffffffff)s.trafficDiagnostics[key]=d[key];}return true;}
   if(now()-(s.trafficUploadAt??-Infinity)<1000/hz-10)return true;s.trafficUploadAt=now();
   try{metrics.acceptedSamples+=relay.publish(s.id,msg);metrics.acceptedBatches++;s.trafficError=null;}catch(e){metrics.rejectedBatches++;s.trafficError=e.message;const code=['not_traffic_authority','traffic_sequence','traffic_capacity','invalid_traffic_sample','traffic_discontinuity'].includes(e.message)?e.message:'other';metrics.rejectionReasons[code]=(metrics.rejectionReasons[code]??0)+1;}return true;
  },
  tick(observers=null){
   const at=now();if(!enabled)return;const due=at-tickAt>=1000/hz;if(!due&&observers===null)return;const start=performance.now();
   if(due){tickAt=at;periodWork=0;sequence=sequence+1>>>0;
   for(const s of sessions.values())if(s.supportsTraffic){if(s.lastState&&at-s.stateAt<=1200)relay.updateSession(s.id,[s.lastState.x,s.lastState.y,s.lastState.z],!s.lastState.paused&&s.trafficReady===true&&at-(s.trafficReadyAt??-Infinity)<1500);else relay.sessions.delete(s.id);}
   relay.tick();}const frame=sequence;
   for(const s of observers??sessions.values())if(s.supportsTraffic&&at-(s.trafficStateAt??-Infinity)>=1000/hz){s.trafficStateAt=at;const role=relay.role(s.id);
    if(at-(s.trafficRoleAt??-Infinity)>=300||s.trafficEpoch!==role.epoch){s.trafficRoleAt=at;s.trafficEpoch=role.epoch;send(s.socket,{type:'traffic_role',...role});}
    // Population is configurable; each outgoing frame still respects the
    // websocket/UDP byte budgets. Prioritize the closest bodies in snapshot order.
    const actors=[];let frameBytes=100,wireBytes=16;for(const a of relay.snapshot(s.id)){const cost=a.stateBytes;if(frameBytes+cost>59000||wireBytes+4+a.wireBytes>60000)continue;actors.push(a);frameBytes+=cost;wireBytes+=4+a.wireBytes;}
    const known=s.trafficKnownModels??=new Map(),missing=[];
    for(const a of actors)if(!known.has(a.model)&&!missing.some(m=>m.id===a.model))missing.push({id:a.model,accessories:a.sample.accessories,lookSeed:a.sample.lookSeed,paintColor:a.sample.paintColor,vehicleType:a.sample.vehicleType});
    // Keep descriptors below the transport's 64 KiB limit, even with paint data.
    for(let offset=0;offset<missing.length;){const batch=[];let bytes=40;while(offset<missing.length&&batch.length<32){const m=missing[offset],cost=Buffer.byteLength(JSON.stringify(m))+1;if(batch.length&&bytes+cost>60000)break;batch.push(m);bytes+=cost;offset++;}if(send(s.socket,{type:'traffic_models',models:batch})===false)break;for(const m of batch){known.set(m.id,true);if(known.size>1024)known.delete(known.keys().next().value);}}
    const available=actors.filter(a=>known.has(a.model));
    if(sendState)sendState(s.socket,'{"type":"traffic_state","epoch":'+role.epoch+',"sequence":'+frame+',"actors":['+available.map(a=>a.stateJson).join(',')+']}');
    else send(s.socket,{type:'traffic_state',epoch:role.epoch,sequence:frame,actors:available.map(a=>a.state)});
   }
   periodWork+=performance.now()-start;lastTickMs=periodWork;maxTickMs=Math.max(maxTickMs,lastTickMs);
  },
  forget(id){relay.removeSession(id);},
  diagnostics(){const clients=[...sessions.values()].filter(s=>now()-(s.trafficReadyAt??-Infinity)<1500),visuals={reportingClients:clients.length,nativeCount:0,replicas:0,readyVehicles:0,readyTrailers:0,failedModels:0,filteredSamples:0};for(const s of clients)for(const key of ['nativeCount','replicas','readyVehicles','readyTrailers','failedModels','filteredSamples'])visuals[key]+=s.trafficDiagnostics?.[key]??0;return {...relay.diagnostics(),enabled,ready:enabled,hz,limit,maxActors,...metrics,visuals,lastTickMs:Math.round(lastTickMs*1000)/1000,maxTickMs:Math.round(maxTickMs*1000)/1000};}
 };
}
