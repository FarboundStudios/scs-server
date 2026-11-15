// SDK rotations use turns; X/Z are ground coordinates in world metres.
const blendAngle=(a,b,t)=>a+((((b-a+.5)%1+1)%1)-.5)*t;
const mixPose=(a,b,t)=>({...b,x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t,heading:blendAngle(a.heading,b.heading,t),pitch:blendAngle(a.pitch,b.pitch,t),roll:blendAngle(a.roll,b.roll,t)});
// Preserve attach/detach and chain-length changes, and snap discontinuities.
// The wire format has no trailer identity; configuration revisions remain the
// responsibility of the native vehicle registry.
const mixTrailers=(state,a,b,t)=>{
 const compatible=(x,y)=>x&&y&&x.connected===y.connected&&Math.hypot(x.x-y.x,x.y-y.y,x.z-y.z)<=50;
 if(Array.isArray(b.trailers)){
  if(Array.isArray(a.trailers)&&a.trailers.length===b.trailers.length&&b.trailers.every((v,i)=>compatible(a.trailers[i],v))){
   state.trailers=b.trailers.map((v,i)=>mixPose(a.trailers[i],v,t));state.trailer=state.trailers[0]??null;
  }
 }else if(compatible(a.trailer,b.trailer))state.trailer=mixPose(a.trailer,b.trailer,t);
};
export class MotionBuffer {
 constructor(){this.peers=new Map();this.stats={teleports:0,staleSamples:0,extrapolations:0};}
 update(id,state,now){
  let entry=this.peers.get(id);if(!entry)this.peers.set(id,entry={samples:[],interval:50,jitter:0});
  const previous=entry.samples.at(-1);
  if(previous){
   const gap=now-previous.at;
   if(gap<=0){this.stats.staleSamples++;return;}
   const distance=Math.hypot(state.x-previous.state.x,state.z-previous.state.z);
   const plausible=Math.min(110,Math.max(Math.abs(state.speed),Math.abs(previous.state.speed),5));
   if(gap>1500||distance>Math.max(50,plausible*gap/1000*2+10)){
    entry.samples=[];entry.interval=50;entry.jitter=0;entry.playhead=undefined;entry.renderAt=undefined;entry.raw=undefined;entry.correction=undefined;this.stats.teleports++;
   }else if(gap>10&&gap<1000){
    entry.jitter=entry.jitter*.8+Math.abs(gap-entry.interval)*.2;
    entry.interval=entry.interval*.75+gap*.25;
   }
  }
  entry.samples.push({at:now,state});if(entry.samples.length>16)entry.samples.shift();
 }
 remove(id){this.peers.delete(id);}clear(){this.peers.clear();}
 render(players,now){return players.map(p=>{
  const entry=this.peers.get(p.id);if(!entry?.samples.length)return p;
  const list=entry.samples,delay=Math.max(100,Math.min(300,entry.interval*1.2+entry.jitter*2)),desired=now-delay;
  // Arrival jitter changes the desired buffer length. Moving the playhead
  // backwards to reach that length made a moving truck briefly reverse.
  // Slew the clock instead; native rendering still interpolates each frame.
  const elapsed=now-(entry.renderAt??now);
  if(entry.playhead===undefined||elapsed<0||elapsed>1000)entry.playhead=desired;
  else {
   const error=desired-(entry.playhead+elapsed),rate=Math.max(.8,Math.min(1.2,1+error/250));
   entry.playhead=Math.min(now,entry.playhead+elapsed*rate);
  }
  entry.renderAt=now;const target=entry.playhead;
  let a=list[0],b=a;
  for(const sample of list){if(sample.at<=target)a=sample;if(sample.at>=target){b=sample;break;}b=sample;}
  let state;
  if(b.at>a.at){
   const t=Math.max(0,Math.min(1,(target-a.at)/(b.at-a.at)));
   state=mixPose(a.state,b.state,t);
   mixTrailers(state,a.state,b.state,t);
  }else{
   state={...a.state};const last=list.at(-1),before=list.at(-2);
   if(target>last.at&&before&&!last.state.paused&&Math.abs(last.state.speed)>.1){
    const dt=last.at-before.at,extra=Math.min(100,target-last.at);
    if(dt>10&&dt<1000){
     const distance=Math.hypot(last.state.x-before.state.x,last.state.z-before.state.z);
     const maxSpeed=Math.min(110,Math.max(Math.abs(last.state.speed),Math.abs(before.state.speed))*1.5+5);
     const ratio=distance>0?Math.min(1,maxSpeed*dt/1000/distance):1;
     const t=1+extra/dt*ratio;state=mixPose(before.state,last.state,t);
     mixTrailers(state,before.state,last.state,t);this.stats.extrapolations++;
    }
   }
  }
  const raw={x:state.x,y:state.y,z:state.z},sampleAt=list.at(-1).at;
  let correction=entry.correction??{x:0,y:0,z:0};
  const decay=Math.exp(-Math.max(0,elapsed)/160);
  correction={x:correction.x*decay,y:correction.y*decay,z:correction.z*decay};
  if(entry.raw&&elapsed>=0&&elapsed<=250){
   const dx=entry.raw.x-raw.x,dy=entry.raw.y-raw.y,dz=entry.raw.z-raw.z;
   const distance=Math.hypot(dx,dy,dz),expected=Math.max(.5,Math.abs(state.speed)*elapsed/1000*2+.1);
   // Short prediction errors reconcile over time instead of snapping when
   // the first delayed packet arrives. Cap the extra visual displacement.
   if(distance>expected&&distance<5){correction.x+=dx;correction.y+=dy;correction.z+=dz;}
  }
  const length=Math.hypot(correction.x,correction.y,correction.z);
  if(length>2){const ratio=2/length;correction.x*=ratio;correction.y*=ratio;correction.z*=ratio;}
  entry.raw=raw;entry.rawSampleAt=sampleAt;entry.correction=correction;
  if(length>.001){
   const shift=v=>({...v,x:v.x+correction.x,y:v.y+correction.y,z:v.z+correction.z});
   state=shift(state);
   if(state.trailers){state.trailers=state.trailers.map(shift);state.trailer=state.trailers[0]??null;}
   else if(state.trailer)state.trailer=shift(state.trailer);
  }
  return {...p,state};
 });}
}
