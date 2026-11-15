// DEVELOPMENT CORE ONLY: deliberately not connected to the live relay until
// the native traffic capture/spawn/despawn bridge has been verified in ETS2.
const finite=v=>Number.isFinite(v)&&Math.abs(v)<=1e7;
const integer=(v,low,high)=>Number.isInteger(v)&&v>=low&&v<=high;
const cellFor=(x,z,size)=>`${Math.floor(x/size)}:${Math.floor(z/size)}`;
const validPose=p=>p&&[p.x,p.y,p.z].every(finite)&&Number.isFinite(p.heading)&&Math.abs(p.heading)<=10&&Number.isFinite(p.speed)&&Math.abs(p.speed)<=50&&integer(p.lights,0,0xffff);
export class TrafficCoordinator {
 constructor({models=[],cellSize=512,maxRegions=32,maxActors=128,perRegion=8,perViewer=16,viewRadius=800,minPlayerDistance=25,maxSessions=5000,now=()=>performance.now()}={}){
  if(!integer(cellSize,256,2048)||!integer(maxRegions,1,64)||!integer(maxActors,1,512)||!integer(perRegion,1,16)||!integer(perViewer,1,32)||!integer(viewRadius,100,1500)||!integer(minPlayerDistance,10,100)||!integer(maxSessions,1,5000))throw Error('invalid_traffic_limits');
  if(!Array.isArray(models)||models.length>256||models.some(v=>typeof v!=='string'||!/^[a-z0-9_.-]{1,64}$/.test(v)))throw Error('invalid_traffic_models');
  Object.assign(this,{cellSize,maxRegions,maxActors,perRegion,perViewer,viewRadius,minPlayerDistance,maxSessions,now});this.models=new Set(models);this.sessions=new Map();this.regions=new Map();this.actors=new Map();this.serial=0;this.epoch=0;
 }
 updateSession(id,p,{canSimulate=false,paused=false}={}){
  if(typeof id!=='string'||!id||id.length>64||!p||![p.x,p.y,p.z].every(finite))return false;
  if(!this.sessions.has(id)&&this.sessions.size>=this.maxSessions)return false;
  this.sessions.set(id,{id,x:p.x,y:p.y,z:p.z,canSimulate:canSimulate===true,paused:paused===true,at:this.now()});return true;
 }
 removeSession(id){this.sessions.delete(id);this.tick();}
 tick(){
  const now=this.now(),groups=new Map();
  for(const [id,p]of this.sessions){if(now-p.at>=2000){this.sessions.delete(id);continue;}if(p.paused)continue;
   const cell=cellFor(p.x,p.z,this.cellSize);if(!groups.has(cell)&&groups.size>=this.maxRegions)continue;
   if(!groups.has(cell))groups.set(cell,[]);groups.get(cell).push(p);
  }
  for(const [cell,region]of this.regions)if(!groups.has(cell)){for(const id of region.ids)this.actors.delete(id);this.regions.delete(cell);}
  for(const [cell,players]of groups){
   let region=this.regions.get(cell);if(!region){region={cell,owner:null,epoch:0,until:0,ids:new Set()};this.regions.set(cell,region);}
   const capable=players.filter(p=>p.canSimulate),kept=capable.find(p=>p.id===region.owner),owner=kept??capable[0]??null;
   if(region.owner!==owner?.id&&!(region.owner===null&&!owner)){
    region.owner=owner?.id??null;region.epoch=++this.epoch;region.sequence=-1;
    for(const id of region.ids){const actor=this.actors.get(id);if(actor)actor.ghost=true;}
   }
   region.until=owner?owner.at+2000:0;
   for(const id of region.ids){const actor=this.actors.get(id);if(!actor||now-actor.at>=2000){region.ids.delete(id);this.actors.delete(id);}}
  }
 }
 authority(id,cell,epoch){const region=this.regions.get(cell);if(!region||region.owner!==id||region.epoch!==epoch||this.now()>=region.until)throw Error('not_traffic_authority');return region;}
 leasesFor(id){return [...this.regions.values()].filter(r=>r.owner===id&&this.now()<r.until).map(r=>({cell:r.cell,epoch:r.epoch,until:r.until,limit:this.perRegion,actors:[...r.ids].map(key=>({...this.actors.get(key)}))}));}
 reserve(id,cell,epoch,{model,pose}){
  const region=this.authority(id,cell,epoch);
  if(!this.models.has(model)||!validPose(pose)||cellFor(pose.x,pose.z,this.cellSize)!==cell)throw Error('invalid_traffic_spawn');
  if(this.actors.size>=this.maxActors||region.ids.size>=this.perRegion)throw Error('traffic_capacity');
  for(const p of this.sessions.values())if(this.now()-p.at<2000&&Math.abs(p.y-pose.y)<6&&Math.hypot(p.x-pose.x,p.z-pose.z)<this.minPlayerDistance)throw Error('traffic_spawn_near_player');
  const key=++this.serial,actor={id:key,model,cell,...Object.fromEntries(['x','y','z','heading','speed','lights'].map(k=>[k,pose[k]])),at:this.now(),ghost:true};
  this.actors.set(key,actor);region.ids.add(key);return {...actor};
 }
 apply(id,cell,epoch,sequence,updates){
  const region=this.authority(id,cell,epoch);
  if(!Number.isSafeInteger(sequence)||sequence<0||sequence<=(region.sequence??-1))throw Error('traffic_sequence');
  if(!Array.isArray(updates)||updates.length>this.perRegion)throw Error('invalid_traffic_batch');
  const now=this.now(),seen=new Set();
  for(const update of updates){const actor=this.actors.get(update?.id);
   if(!actor||!region.ids.has(actor.id)||seen.has(actor.id)||!validPose(update)||cellFor(update.x,update.z,this.cellSize)!==cell)throw Error('invalid_traffic_update');seen.add(actor.id);
   const elapsed=Math.max(0,now-actor.at)/1000;if(Math.hypot(actor.x-update.x,actor.z-update.z)>Math.max(10,elapsed*100+3))throw Error('traffic_discontinuity');
  }
  region.sequence=sequence;
  for(const update of updates){const actor=this.actors.get(update.id);for(const key of ['x','y','z','heading','speed','lights'])actor[key]=update[key];actor.at=now;actor.ghost=false;}
 }
 release(id,cell,epoch,actorId){const region=this.authority(id,cell,epoch);if(!region.ids.delete(actorId))return false;return this.actors.delete(actorId);}
 snapshot(id){const p=this.sessions.get(id),now=this.now();if(!p||now-p.at>=2000)return [];
  const radius=this.viewRadius**2;return [...this.actors.values()].filter(a=>now-a.at<1500&&(a.x-p.x)**2+(a.z-p.z)**2<=radius).sort((a,b)=>(a.x-p.x)**2+(a.z-p.z)**2-((b.x-p.x)**2+(b.z-p.z)**2)).slice(0,this.perViewer).map(a=>({...a}));
 }
 diagnostics(){return {developmentOnly:true,nativeBridgeReady:false,sessions:this.sessions.size,regions:this.regions.size,actors:this.actors.size,maxActors:this.maxActors,perViewer:this.perViewer};}
}
