import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {MotionBuffer} from '../client/smoothing.mjs';
const pose=x=>({x,y:0,z:0,heading:0,pitch:0,roll:0,connected:true,wheels:[]});
const state=(x,count=0)=>({...pose(x),speed:20,paused:false,...(count?{trailers:Array.from({length:count},(_,i)=>pose(x-(i+1)*15))}:{})});
test('delayed prediction corrections remain gradual and keep the trailer clock attached',()=>{
 const motion=new MotionBuffer();let sent=0,previous=-Infinity;
 // Delayed arrivals followed by bursts, including a 400 ms network silence.
 const arrivals=[0,50,100,150,200,250,300,350,750,755,760,765,800,850,900,950,1000,1050,1100,1150,1200,1250,1300,1350,1400];
 for(let now=0;now<1600;now+=10){
  while(sent<arrivals.length&&arrivals[sent]<=now){motion.update('a',state(sent++,2),arrivals[sent-1]);}
  const current=motion.render([{id:'a'}],now)[0].state;
  if(Number.isFinite(previous))assert(Math.abs(current.x-previous)<.6,`abrupt correction at ${now}: ${current.x} from ${previous}`);previous=current.x;
  assert(Math.abs(current.trailers[0].x-(current.x-15))<1e-9);
 }
});
test('32 peers and 128 trailer segments survive arrival storms, jitter, disconnect and teleports',t=>{
 const motion=new MotionBuffer();const peers=Array.from({length:32},(_,id)=>({id:String(id)}));const frames=[];
 for(let frame=0;frame<1200;++frame){const now=frame*16.6667,start=performance.now();
  if(frame%3===0)for(let i=0;i<32;++i){
   if(frame>=600&&frame<630&&i%2===0)continue;
   const x=frame/3+(frame>=900&&i===0?5000:0);motion.update(String(i),state(x,4),now+(i%3));
  }
  const rendered=motion.render(peers,now);
  for(const p of rendered){assert(Number.isFinite(p.state.x));assert.equal(p.state.trailers.length,4);assert(p.state.trailers.every(v=>Number.isFinite(v.x)));}
  if(frame===700){motion.remove('31');motion.update('31',state(frame/3,4),now+4);}
  frames.push(performance.now()-start);
 }
 assert(motion.stats.teleports>=1);assert.equal(motion.peers.size,32);
 frames.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({scenario:'CPU-only synthetic JS smoothing, not ETS2 FPS',frames:frames.length,peers:32,trailers:128,p50Ms:frames[600],p95Ms:frames[1140],p99Ms:frames[1188],maxMs:frames.at(-1)}));
});
