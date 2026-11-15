// TCP/WebSocket retransmits lost packets: application sequence gaps are NOT packet loss.
export class NetworkMetrics {
 constructor(){this.lastAt=performance.now();this.lastCpu=process.cpuUsage();this.previous={};this.latest={};}
 sample(metrics,sessions,now=performance.now()){
  const elapsed=now-this.lastAt;if(elapsed<1000)return this.latest;
  const cpu=process.cpuUsage(),rates={};
  for(const key of ['incomingMessages','acceptedStates','throttledStates','sequenceGaps','statePackets','stateBytes','syncOutBytes','skippedTicks']){
   rates[key+'PerSecond']=Math.round(((metrics[key]??0)-(this.previous[key]??0))*1000/elapsed*100)/100;
   this.previous[key]=metrics[key]??0;
  }
  let synchronized=0,pings=[],pending=0;
  for(const s of sessions.values()){
   synchronized+=s.synchronizedPeers??0;if(Number.isFinite(s.rttMs))pings.push(s.rttMs);if(s.probeAt!==undefined)pending++;
  }
  pings.sort((a,b)=>a-b);
  this.latest={...rates,cpuPercentOfOneCore:Math.round(((cpu.user-this.lastCpu.user)+(cpu.system-this.lastCpu.system))/elapsed/10*100)/100,
   synchronizedVehicles:synchronized,pingSamples:pings.length,pingMedianMs:pings.length?Math.round(pings[Math.floor(pings.length*.5)]):null,
   pingP95Ms:pings.length?Math.round(pings[Math.min(pings.length-1,Math.floor(pings.length*.95))]):null,
   pendingProbes:pending,transportPacketLossPercent:null,packetLossNote:'Unavailable over reliable TCP/WSS; sequenceGaps count application messages, probeTimeouts count unanswered probes.'};
  this.lastAt=now;this.lastCpu=cpu;return this.latest;
 }
}
