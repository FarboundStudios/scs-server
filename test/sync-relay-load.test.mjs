import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import {once} from 'node:events';
import {createRelay} from '../server/system/server.mjs';
import {createClient} from '../client/client.mjs';
import {GAME_VERSION} from '../server/shared/protocol.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async condition=>{const until=Date.now()+8000;while(!condition()){if(Date.now()>until)throw Error('load scenario timeout');await sleep(15);}};
const wheels=Array.from({length:16},()=>({rotation:.5,velocity:5,steering:0,suspension:.02,lift:0}));
const pose=x=>({x,y:0,z:0,heading:0,pitch:0,roll:0,connected:true,wheels});
const state=(x,n=0)=>({...pose(x),paused:false,speed:20,truck:{lights:1,wheels,controls:{engine:true,parkingBrake:false,wipers:true,rpm:1500,gear:5,brake:0,throttle:.5,steering:0}},...(n?{trailers:Array.from({length:n},(_,i)=>pose(x-15*(i+1)))}:{})});
test('real relay/client/UDP bridge preserves 32 peers and 128 trailer records during burst joins and disconnects',async t=>{
 const relay=await createRelay({host:'127.0.0.1',port:0,plaintext:true,log:()=>{}});t.after(()=>relay.close());
 const udp=dgram.createSocket('udp4');await new Promise(r=>udp.bind(0,'127.0.0.1',r));t.after(()=>udp.close());
 let maxVehicles=0,maxTrailers=0;const intervals=[];let last=0;
 udp.on('message',p=>{const kind=p.toString('ascii',0,4);if(kind==='HMV3'){maxVehicles=Math.max(maxVehicles,p.readUInt32LE(8));const now=performance.now();if(last)intervals.push(now-last);last=now;}if(kind==='HMT3')maxTrailers=Math.max(maxTrailers,p.readUInt32LE(8));});
 const viewer=await createClient({host:'127.0.0.1',port:relay.address.port,plaintext:true,name:'LoadViewer',telemetryPort:0,monitorPort:false,vehiclePort:udp.address().port});t.after(()=>viewer.close());
 await wait(()=>viewer.status.connected);
 const peers=[];const errors=[];
 for(let i=0;i<32;++i){const socket=net.connect(relay.address.port,'127.0.0.1');t.after(()=>socket.destroy());socket.setNoDelay(true);let data='';const peer={socket,welcome:false,seq:0};peers.push(peer);
  socket.on('data',b=>{data+=b;let newline;while((newline=data.indexOf('\n'))>=0){const line=data.slice(0,newline);data=data.slice(newline+1);if(!line)continue;const message=JSON.parse(line);if(message.type==='welcome')peer.welcome=true;if(message.type==='error')errors.push(message.code);}});
  await once(socket,'connect');socket.write(JSON.stringify({type:'join',protocol:1,gameVersion:GAME_VERSION,name:'Load'+i,room:'HeavyMP',capabilities:{deltaSnapshots:1,trailerConfiguration:1,trailerChainConfiguration:1}})+'\n');
 }
 await wait(()=>peers.every(p=>p.welcome));
 const feed=()=>udp.send(Buffer.from(JSON.stringify({protocol:1,gameId:'eut2',type:'telemetry',state:state(0)})),viewer.telemetryAddress.port,'127.0.0.1');
 const heartbeat=setInterval(feed,100);t.after(()=>clearInterval(heartbeat));feed();
 for(let frame=0;frame<20;++frame){
  for(let i=0;i<peers.length;++i){if(i%4===0&&frame>=8&&frame<=11)continue;const p=peers[i];p.socket.write(JSON.stringify({type:'state',seq:p.seq++,state:state(100+i*10+frame,4)})+'\n');}
  await sleep(frame%5===0?130:60);
 }
 t.diagnostic(JSON.stringify({maxVehicles,maxTrailers,viewerPeers:viewer.status.players.length,errors}));
 await wait(()=>maxVehicles===32&&maxTrailers===128);assert.deepEqual(errors,[]);
 peers.slice(16).forEach(p=>p.socket.destroy());await wait(()=>viewer.status.players.length===16);
 assert(intervals.length>10);intervals.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({scenario:'localhost relay-to-client UDP intervals, not engine FPS',packets:intervals.length,p95Ms:intervals[Math.floor(intervals.length*.95)],maxMs:intervals.at(-1),peakPeers:maxVehicles,peakTrailers:maxTrailers}));
});
