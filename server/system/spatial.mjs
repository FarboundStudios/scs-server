// Incremental grid: O(1) movement/removal, bounded candidate work per observer.
export class SpatialIndex {
 constructor(cellSize=250){this.cellSize=cellSize;this.cells=new Map();this.entries=new Map();this.offsets=new Map();this.bucketCache=new Map();this.structureVersion=0;}
 key(x,z){return Math.floor(x/this.cellSize)+','+Math.floor(z/this.cellSize);}
 update(s){const key=this.key(s.lastState.x,s.lastState.z),prior=this.entries.get(s.id);if(prior?.key===key)return false;this.remove(s.id);let bucket=this.cells.get(key);if(!bucket){this.cells.set(key,bucket=[]);this.structureVersion++;}this.entries.set(s.id,{key,at:bucket.length});bucket.push(s);return true;}
 remove(id){const entry=this.entries.get(id);if(!entry)return;const bucket=this.cells.get(entry.key),last=bucket.pop();if(entry.at<bucket.length){bucket[entry.at]=last;this.entries.get(last.id).at=entry.at;}if(!bucket.length){this.cells.delete(entry.key);this.structureVersion++;}this.entries.delete(id);}
 rings(radius){const n=Math.ceil(radius/this.cellSize)+1;if(!this.offsets.has(n)){const offsets=[];for(let x=-n;x<=n;x++)for(let z=-n;z<=n;z++)offsets.push({x,z,d:x*x+z*z});offsets.sort((a,b)=>a.d-b.d);this.offsets.set(n,offsets);}return this.offsets.get(n);}
 // Cache a conservative union for the entire observer cell, then filter exact distances.
 // Existing bucket arrays mutate in place; only creation/deletion invalidates this cache.
 buckets(position,radius){
  const cx=Math.floor(position.x/this.cellSize),cz=Math.floor(position.z/this.cellSize),key=cx+','+cz+':'+radius,cached=this.bucketCache.get(key);
  if(cached?.version===this.structureVersion)return cached.buckets;
  const result=[];
  for(const o of this.rings(radius)){
   const dx=Math.max(0,Math.abs(o.x)-1)*this.cellSize,dz=Math.max(0,Math.abs(o.z)-1)*this.cellSize;
   if(dx*dx+dz*dz>radius*radius)continue;
   const bucket=this.cells.get((cx+o.x)+','+(cz+o.z));if(bucket)result.push(bucket);
  }
  if(this.bucketCache.size>=4096)this.bucketCache.delete(this.bucketCache.keys().next().value);
  this.bucketCache.set(key,{version:this.structureVersion,buckets:result});return result;
 }
 nearest(viewer,radius,limit,now,ttl,known=new Set(),budget=512){
  if(!viewer.lastState||now-viewer.stateAt>ttl)return [];
  const p=viewer.lastState,best=[],seen=new Set();let checked=0;if(known.size>=limit)budget=Math.min(budget,128);
  const consider=s=>{if(!s||seen.has(s.id)||s.id===viewer.id||!s.lastState||now-s.stateAt>ttl)return;seen.add(s.id);const dx=s.lastState.x-p.x,dz=s.lastState.z-p.z,d2=dx*dx+dz*dz,extra=0;if(d2>(radius+extra)**2)return;const score=d2*(known.has(s.id)?.85:1);if(best.length===limit&&score>=best[best.length-1].score)return;let at=0;while(at<best.length&&(best[at].score<score||(best[at].score===score&&best[at].session.id<s.id)))at++;best.splice(at,0,{session:s,d2,score});if(best.length>limit)best.pop();};
  for(const id of known){const entry=this.entries.get(id);if(entry)consider(this.cells.get(entry.key)[entry.at]);}
  // Rotate through ALL candidate buckets; a fixed hash permanently hides peers in dense cells.
  const buckets=this.buckets(p,radius),total=buckets.reduce((n,b)=>n+b.length,0);
  let cursor=(viewer.spatialCursor??0)%Math.max(1,total),skip=cursor;
  for(let pass=0;pass<2&&checked<Math.min(budget,total);pass++){
   for(const bucket of buckets){if(skip>=bucket.length){skip-=bucket.length;continue;}
    for(let i=skip;i<bucket.length&&checked<Math.min(budget,total);i++,checked++)consider(bucket[i]);skip=0;
    if(checked>=Math.min(budget,total))break;
   }skip=0;
  }
  viewer.spatialCursor=(cursor+checked)%Math.max(1,total);
  return best.map(item=>item.session);
 }
 within(position,radius,now,ttl){const result=[];if(!position)return result;for(const bucket of this.buckets(position,radius))for(const s of bucket){if(!s.lastState||now-s.stateAt>ttl)continue;const dx=s.lastState.x-position.x,dz=s.lastState.z-position.z;if(dx*dx+dz*dz<=radius*radius)result.push(s);}return result;}
}
