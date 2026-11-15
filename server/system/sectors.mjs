const letter=n=>{let out='';for(n++;n>0;n=Math.floor((n-1)/26))out=String.fromCharCode(65+(n-1)%26)+out;return out;};
export function sectorLabel(x,z){return (x<0?'-'+letter(-x-1):letter(x))+(z<0?'-'+(-z):String(z+1));}
export function sectorSettings(env={}){
 const value=String(env.SECTOR_SCHEDULING??'true').trim().toLowerCase(),budget=Number(env.SECTOR_WORK_BUDGET_MS??4);
 if(!['true','false','1','0'].includes(value)||!Number.isFinite(budget)||budget<.25||budget>25)throw Error('Invalid sector configuration.');
 return {sectorScheduling:['true','1'].includes(value),sectorWorkBudgetMs:budget};
}
export class SectorScheduler {
 constructor({index,hz=20,limit=32,budgetMs=4}={}){if(!index||!Number.isFinite(budgetMs)||budgetMs<.25||budgetMs>25)throw Error('invalid_sector_budget');Object.assign(this,{index,hz,limit,budgetMs});this.cells=new Map();this.entries=new Map();this.rotation=0;this.cycles=0;this.transitions=0;this.lastGlobalAdapt=-Infinity;}
 register(s,now=0){if(this.entries.has(s.id))return;let phase=0;for(const c of s.id)phase=(Math.imul(phase,31)+c.charCodeAt(0))>>>0;this.entries.set(s.id,{s,key:null,phase,nextAt:now});this.update(s,now);}
 update(s,now=0){const e=this.entries.get(s.id);if(!e){this.register(s,now);return;}const key=s.lastState&&!s.lastState.paused?this.index.key(s.lastState.x,s.lastState.z):'lobby';if(e.key===key)return;
  if(e.key!==null){const old=this.cells.get(e.key);old.members.delete(s.id);if(!old.members.size)this.cells.delete(e.key);this.transitions++;}
  let cell=this.cells.get(key);if(!cell){const [x,z]=key==='lobby'?[0,0]:key.split(',').map(Number);cell={key,label:key==='lobby'?'LOBBY':sectorLabel(x,z),x,z,members:new Map(),hz:key==='lobby'?1:this.hz,limit:this.limit,ewma:0,lastCost:0,lastAdapt:-Infinity,stable:0,processed:0};this.cells.set(key,cell);}
  cell.members.set(s.id,e);e.key=key;e.nextAt=now;
 }
 forget(id){const e=this.entries.get(id);if(!e)return;const c=this.cells.get(e.key);c?.members.delete(id);if(c&&!c.members.size)this.cells.delete(e.key);this.entries.delete(id);}
 plan(now){this.cycles++;const due=[];
  for(const c of this.cells.values()){const list=[];for(const e of c.members.values())if(e.nextAt<=now)list.push(e);if(list.length){c.cost=0;due.push({cell:c,list,at:0,policy:{hz:c.hz,limit:c.limit}});}}
  const jobs=[];if(!due.length)return jobs;const start=this.rotation++%due.length;let remaining=true;
  while(remaining){remaining=false;for(let i=0;i<due.length;i++){const item=due[(i+start)%due.length];if(item.at<item.list.length){jobs.push({entry:item.list[item.at++],cell:item.cell,policy:item.policy});remaining=true;}}}
  return jobs;
 }
 commit(job,now,cost){const e=this.entries.get(job.entry.s.id);if(!e||e.key!==job.cell.key)return;
  const period=1000/job.policy.hz,phase=e.phase%Math.max(1,Math.floor(period));let next=Math.floor(now/period)*period+phase;if(next<=now+.01)next+=period;e.nextAt=next;job.cell.cost=(job.cell.cost??0)+cost;job.cell.processed++;
 }
 finish(now,wallMs){
  const pressure=wallMs>1000/this.hz*.8;
  for(const c of this.cells.values())if(c.cost!==undefined){c.lastCost=c.cost;c.ewma=c.ewma?c.ewma*.8+c.cost*.2:c.cost;c.cost=undefined;
   if(c.key!=='lobby'&&(c.limit<this.limit?!pressure&&wallMs<1000/this.hz*.4:c.lastCost<this.budgetMs*.35))c.stable++;else c.stable=0;
  }
  const active=[...this.cells.values()].filter(c=>c.key!=='lobby');
  if(now-this.lastGlobalAdapt>=500){
   const hot=active.filter(c=>now-c.lastAdapt>=500&&(c.ewma>this.budgetMs||pressure&&c.ewma>=.5)).sort((a,b)=>b.ewma*b.hz-a.ewma*a.hz);
   const count=pressure?Math.max(1,Math.ceil(hot.length/4)):hot.length;
   // A soft local work budget may lower cadence, but never hide additional
   // neighbors unless the whole server cycle actually exceeds its budget.
   for(const c of hot.slice(0,count)){if(c.hz>10)c.hz=Math.max(10,c.hz-5);else if(pressure&&c.limit>Math.min(8,this.limit))c.limit=Math.max(Math.min(8,this.limit),Math.floor(c.limit*.75));c.lastAdapt=now;c.stable=0;}
   if(hot.length)this.lastGlobalAdapt=now;
  }
  if(!pressure)for(const c of active)if(c.stable>40&&now-c.lastAdapt>3000){if(c.limit<this.limit)c.limit++;else if(c.hz<this.hz)c.hz=Math.min(this.hz,c.hz+5);c.lastAdapt=now;c.stable=0;}
 }
 summary(){let occupied=0,minHz=this.hz,minNearbyLimit=this.limit;for(const c of this.cells.values())if(c.key!=='lobby'){occupied++;minHz=Math.min(minHz,c.hz);minNearbyLimit=Math.min(minNearbyLimit,c.limit);}return {minHz,minNearbyLimit,occupied};}
 diagnostics(){const cells=[...this.cells.values()];return {enabled:true,cellSize:this.index.cellSize,players:this.entries.size,cycles:this.cycles,transitions:this.transitions,...this.summary(),
  cells:cells.sort((a,b)=>b.ewma-a.ewma).slice(0,64).map(c=>({id:c.key,label:c.label,players:c.members.size,hz:c.hz,nearbyLimit:c.limit,workEwmaMs:Math.round(c.ewma*1000)/1000,processed:c.processed})),detailsTruncated:cells.length>64};}
}
