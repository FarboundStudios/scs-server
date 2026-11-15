// Real local WebSocket clients, synthetic identities and a separate server
// process. The test contacts only its local worker.
import {fork} from 'node:child_process';import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,rm,realpath} from 'node:fs/promises';import {resolve,dirname,join,sep} from 'node:path';import {fileURLToPath} from 'node:url';import {once} from 'node:events';
import WebSocket from 'ws';import {GAME_VERSION} from '../shared/protocol.mjs';
import {appearanceChunks,acceptAppearancePart} from '../shared/appearance.mjs';
import {mapZip} from './load/zip-fixture.mjs';
import {encodeCompact} from '../shared/compact.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2),value=(flag,fallback)=>{const i=args.indexOf(flag);return i<0?fallback:args[i+1];};
const legacyState=args.includes('--legacy-state');
const layout=value('--layout','spread');if(!['spread','dense','mixed'].includes(layout))throw Error('Invalid layout');
const baseX=index=>layout==='dense'?0:layout==='mixed'?(index%10===0?4500:0):(index%4)*4500;
const players=String(value('--players','32,128,500')).split(',').map(Number),seconds=Number(value('--seconds','20')),maxRss=Number(value('--max-rss-mb','1024'))*1024**2;
if(players.some(n=>!Number.isInteger(n)||n<2||n>2000)||!Number.isFinite(seconds)||seconds<6||seconds>90||!Number.isFinite(maxRss)||maxRss<128*1024**2)throw Error('Invalid load-test bounds.');
const modulePath=resolve(value('--module',join(root,'server/system/server.mjs'))),output=resolve(value('--out',join(root,'data/load-tests/results-'+Date.now()+'.json')));
const appearance=JSON.parse(await readFile(join(root,'server/scripts/load/fixtures/native-traffic-appearance.json'),'utf8')).samples;
const truckParts=appearanceChunks(JSON.parse(await readFile(join(root,'server/scripts/load/fixtures/stock-player-truck.json'),'utf8')));if(!truckParts.length)throw Error('Load fixture vehicle is invalid.');
const tempParent=join(root,'data/load-tests');await mkdir(tempParent,{recursive:true});
if(!(await realpath(tempParent)).startsWith((await realpath(root))+sep))throw Error('Load-test directory outside project.');
const contentFolder=await mkdtemp(join(tempParent,'assets-'));await writeFile(join(contentFolder,'load-skin.scs'),mapZip([['vehicle/load/skin.dds',Buffer.alloc(2*1024*1024,42)]]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const percentile=(values,p)=>{if(!values.length)return null;const a=[...values].sort((a,b)=>a-b);return Math.round(a[Math.min(a.length-1,Math.floor(a.length*p))]*100)/100;};
async function scenario(count){
 const worker=fork(join(root,'server/scripts/load/relay-worker.mjs'),[],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
 const identities=new Map();const peers=[],metrics=[],errors={},receiveGaps=[],coldGaps=[],poseAges=[],lateFrames=[],downloads=[];let bytesIn=0,bytesOut=0,downloadBytes=0,configurations=0,frames=0,trafficFrames=0,models=0,maxActors=0,timer,stopping=false,fatal=null,readyResolve;
 const ready=new Promise(r=>readyResolve=r),started=performance.now();
 worker.on('message',m=>{if(m.type==='ready')readyResolve(m);if(m.type==='metrics'){metrics.push(m);if(m.rss>maxRss)fatal='server_memory_guard';}if(m.type==='failure')fatal=m.message;});
 let workerErrors='';worker.stderr.on('data',b=>{if(workerErrors.length<4096)workerErrors+=b;});
 worker.on('exit',code=>{if(!stopping&&code!==0)fatal='worker_exit_'+code;});
 const wait=async(predicate,timeout=15000)=>{const until=performance.now()+timeout;while(!predicate()){if(fatal)throw Error(fatal);if(performance.now()>until)throw Error('load_scenario_timeout');await sleep(20);}};
 const write=(p,msg)=>{if(p.socket?.readyState!==WebSocket.OPEN)return;const line=JSON.stringify(msg)+"\n";if(p.socket.bufferedAmount>262144)return;bytesOut+=Buffer.byteLength(line);p.socket.send(line);};
 const wheels=Array.from({length:16},()=>({rotation:.5,velocity:10,steering:0,suspension:.02,lift:0}));
 const pose=(x,z)=>({x,y:10,z,heading:0,pitch:0,roll:0,connected:true,wheels});
 function feed(){const time=performance.now(),elapsed=(time-started)/1000;
  for(const p of peers){if(!p.welcome||p.socket?.readyState!==WebSocket.OPEN)continue;if(p.index%11===0&&Math.floor(elapsed*10)%17<2)continue; // intermittent 100-200ms publication gaps
   const x=baseX(p.index)+(p.index%13)*6+elapsed*8,z=Math.floor(p.index/4)%7*7;p.x=x;p.z=z;
   const state={...pose(x,z),paused:false,speed:8,truck:{lights:1,wheels,controls:{engine:true,parkingBrake:false,wipers:true,rpm:1400,gear:5,brake:0,throttle:.3,steering:0}},...(p.index%3===0?{trailers:[pose(x-15,z),pose(x-30,z)]}:{})};
   if(time-p.stateAt>=1000/(p.uploadHz??20)-5){p.stateAt=time;write(p,legacyState?{type:'state',seq:p.seq++,state}:{type:'state_compact',seq:p.seq++,state:encodeCompact(state,true)});}
   if(time-p.readyAt>400){p.readyAt=time;write(p,{type:'traffic_ready',ready:true,diagnostics:{nativeCount:p.owner?32:0,replicas:p.owner?0:48}});}
   if(p.owner&&time-p.captureAt>105){p.captureAt=time;const samples=Array.from({length:4},(_,g)=>appearance.map((s,i)=>({...s,nativeId:g*1000+s.nativeId,position:[x+20+g*35+i*4,10,z+10]}))).flat();write(p,{type:'traffic_capture',epoch:p.epoch,sequence:p.trafficSeq++,samples});}
  }
 }
 async function connect(p){
  p.lastFrame=0;p.suppressUntil=performance.now()+1000;p.welcome=false;p.owner=false;p.seq=0;p.trafficSeq=0;p.readyAt=-Infinity;p.captureAt=-Infinity;p.stateAt=-Infinity;p.uploadHz=20;p.assemblies=new Map();
  const socket=p.socket=new WebSocket('ws://127.0.0.1:'+port+'/heavymp');
  socket.on('error',()=>{});socket.on('message',b=>{
   bytesIn+=b.length;let msg;try{msg=JSON.parse(b);}catch{fatal='invalid_server_json';return;}
   if(msg.type==='welcome'){p.welcome=true;p.everWelcomed=true;identities.set(msg.id,p.index);for(const part of truckParts)write(p,part);}
   if(msg.type==='network_probe')write(p,{type:'network_probe_ack',token:msg.token});
   if(msg.type==='vehicle_configuration_part'||msg.type==='trailer_configuration_part'){
    const key=msg.id+msg.revision,received=acceptAppearancePart(p.assemblies.get(key),msg,performance.now(),msg.type==='trailer_configuration_part');if(!received){fatal='invalid_configuration_received';return;}
    if(received.appearance){p.assemblies.delete(key);configurations++;write(p,{type:msg.type==='vehicle_configuration_part'?'vehicle_config_ack':'trailer_config_ack',id:msg.id,revision:msg.revision});}else p.assemblies.set(key,received.pending);
   }
   if(msg.type==='error')errors[msg.code]=(errors[msg.code]??0)+1;
   if(msg.type==='traffic_role'){if(msg.epoch!==p.epoch||msg.owner!==p.owner)p.trafficSeq=0;p.owner=msg.owner;p.epoch=msg.epoch;}
   if(msg.type==='traffic_models')models+=msg.models.length;
   if(msg.type==='traffic_state'){trafficFrames++;maxActors=Math.max(maxActors,msg.actors.length);}
   if(['snapshot','snapshot_delta'].includes(msg.type)){if(!legacyState&&Number.isInteger(msg.uploadHz)&&msg.uploadHz>=10&&msg.uploadHz<=30)p.uploadHz=msg.uploadHz;frames++;p.frames=(p.frames??0)+1;const time=performance.now();
    if(time>p.suppressUntil){if(p.lastFrame&&p.index<8)receiveGaps.push(time-p.lastFrame);if(p.lastFrame&&layout==='mixed'&&p.index%10===0)coldGaps.push(time-p.lastFrame);
     // Infer publication age from deterministic 8m/s trajectories, independent of server clocks.
     if(p.index<8)for(const [id,encoded] of msg.updates??[]){const index=identities.get(id);if(index===undefined)continue;const b=Buffer.from(encoded,'base64');if(b.length<29)continue;const sentElapsed=(b.readInt32LE(2)/100-baseX(index)-(index%13)*6)/8;poseAges.push(Math.max(0,time-started-sentElapsed*1000));}
    }p.lastFrame=time;}
  });
  await Promise.race([once(socket,'open'),sleep(5000).then(()=>{throw Error('WebSocket connect timeout');})]);
  write(p,{type:'join',protocol:1,gameVersion:GAME_VERSION,room:'HeavyMP',name:'Load'+p.index,identity:p.identity??=randomBytes(32).toString('hex'),mapRevision:contentRevision,capabilities:{traffic:6,deltaSnapshots:1,networkMetrics:1,trailerConfiguration:1,trailerChainConfiguration:1,configurationChunks:1,vehicleConfiguration:1}});
 }
 let port,contentRevision,assetUrl;
 try{
  worker.send({type:'start',module:modulePath,players:count,contentFolder});const startup=await Promise.race([ready,sleep(10000).then(()=>{throw Error('Worker startup timeout');})]);port=startup.port;contentRevision=startup.revision;assetUrl=startup.assetUrl;
  timer=setInterval(feed,50);let scheduled=performance.now();const cadence=setInterval(()=>{const at=performance.now();lateFrames.push(Math.max(0,at-scheduled-50));scheduled=at;},50);timer.cadence=cadence;
  for(let start=0;start<count;start+=40){const batch=Array.from({length:Math.min(40,count-start)},(_,j)=>({index:start+j,epoch:0,lastFrame:0}));peers.push(...batch);await Promise.all(batch.map(connect));if(start+40<count)await sleep(450);}
  await wait(()=>peers.every(p=>p.welcome));
  for(let i=0;i<8;i++)downloads.push((async()=>{await sleep(i*400);const response=await fetch('http://127.0.0.1:'+port+assetUrl,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('addon_download_'+response.status);const bytes=await response.arrayBuffer();downloadBytes+=bytes.byteLength;})().catch(e=>{fatal=e.message;}));
  const runningAt=performance.now();let churned=false,resumed=false,slow=false,slowResumed=false;
  while(performance.now()-runningAt<seconds*1000){
   if(fatal)throw Error(fatal);if(process.memoryUsage().rss>maxRss*1.5)throw Error('generator_memory_guard');
   const elapsed=performance.now()-runningAt;
   if(!churned&&elapsed>seconds*250){churned=true;for(const p of peers.filter(p=>p.index%10===0))p.socket.terminate();}
   if(churned&&!resumed&&elapsed>seconds*250+1000){resumed=true;await Promise.all(peers.filter(p=>p.index%10===0).map(connect));}
   if(!slow&&elapsed>seconds*550){slow=true;for(const p of peers.filter(p=>p.index%50===1)){p.suppressUntil=performance.now()+2500;p.socket?._socket?.pause();}}
   if(slow&&!slowResumed&&elapsed>seconds*550+1500){slowResumed=true;for(const p of peers.filter(p=>p.index%50===1)){p.lastFrame=0;p.socket?._socket?.resume();}}
   await sleep(50);
  }
  await sleep(500);
  await Promise.all(downloads);
  const report={players:count,seconds,layout,everWelcomed:peers.filter(p=>p.everWelcomed).length,connectedAtEnd:peers.filter(p=>p.socket.readyState===WebSocket.OPEN).length,frames,trafficFrames,models,configurations,downloadBytes,maxTrafficBodies:maxActors,
   serverTickMs:{p50:percentile(metrics.map(m=>m.health.metrics.lastTickMs),.5),p95:percentile(metrics.map(m=>m.health.metrics.lastTickMs),.95),max:Math.max(0,...metrics.map(m=>m.health.metrics.maxTickMs))},
   serverEventLoopP95MsMax:Math.max(0,...metrics.map(m=>m.health.metrics.eventLoopP95Ms)),serverCpuOneCorePercent:{average:Math.round(metrics.reduce((sum,m)=>sum+m.cpuOneCorePercent,0)/Math.max(1,metrics.length)*100)/100,peak:Math.max(0,...metrics.map(m=>m.cpuOneCorePercent))},
   serverRssPeakMb:Math.round(Math.max(0,...metrics.map(m=>m.rss))/1024**2),generatorRssMb:Math.round(process.memoryUsage().rss/1024**2),generatorDelayMs:{p95:percentile(lateFrames,.95),max:Math.max(0,...lateFrames)},
   finalSectors:metrics.at(-1)?.health.sectors,minimumFramesPerClient:Math.min(...peers.map(p=>p.frames??0)),poseAgeMs:{p50:percentile(poseAges,.5),p95:percentile(poseAges,.95),max:Math.max(0,...poseAges)},coldSectorFrameGapMs:{p50:percentile(coldGaps,.5),p95:percentile(coldGaps,.95)},observerFrameGapMs:{p50:percentile(receiveGaps,.5),p95:percentile(receiveGaps,.95),max:Math.max(0,...receiveGaps)},bytesSentToServer:bytesOut,bytesReceivedFromServer:bytesIn,protocolErrors:errors,
   finalTraffic:metrics.at(-1)?.health.traffic,finalMetrics:metrics.at(-1)?.health.metrics,churned,resumed,slowReaderTested:slow,passed:peers.every(p=>p.everWelcomed)&&frames>0&&trafficFrames>0&&maxActors>0&&configurations>0&&downloadBytes>0&&Object.keys(errors).length===0};
  report.performance={tickBudgetMs:1000/(report.finalMetrics?.effectiveTickHz??20),withinTickBudget:report.serverTickMs.p95<=1000/(report.finalMetrics?.effectiveTickHz??20)};
  return report;
 }catch(error){return {players:count,seconds,passed:false,error:error.message,everWelcomed:peers.filter(p=>p.everWelcomed).length,workerErrors};}
 finally{stopping=true;clearInterval(timer);clearInterval(timer?.cadence);for(const p of peers){p.socket?._socket?.resume();p.socket?.terminate();}worker.send?.({type:'stop'});await Promise.race([once(worker,'exit'),sleep(5000)]);if(worker.exitCode===null)worker.kill();}
}
const report={schema:1,kind:'local-production-WebSocket-load-test',layout,stateMode:legacyState?'full-JSON-fixed-20Hz':'production-compact-adaptive-Hz',module:modulePath,node:process.version,startedAt:new Date().toISOString(),limitations:['Synthetic trajectories and native appearance fixtures, not ETS2 simulation or FPS.','Application-level publication jitter and slow readers; no physical WAN or packet-loss emulator.','Generator and server are separate processes on the same PC; these figures do not certify the hosted server capacity.'],scenarios:[]};
try{for(const count of players){const result=await scenario(count);report.scenarios.push(result);await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({players:count,passed:result.passed,tickP95:result.serverTickMs?.p95,rssMb:result.serverRssPeakMb,error:result.error}));if(result.error)break;await sleep(1000);}}
finally{if((await realpath(contentFolder)).startsWith((await realpath(tempParent))+sep)&&resolve(contentFolder).startsWith(resolve(tempParent,'assets-')))await rm(contentFolder,{recursive:true,force:true});}
process.exitCode=report.scenarios.every(s=>s.passed)?0:1;
