import test from 'node:test';import assert from 'node:assert/strict';
import {SectorScheduler,sectorLabel,sectorSettings} from '../server/system/sectors.mjs';import {SpatialIndex} from '../server/system/spatial.mjs';
import {NativeTrafficGroups} from '../server/system/traffic-native.mjs';
const player=(id,x=0,z=0)=>({id,lastState:{x,z,paused:false},stateAt:0});
test('sector labels are deterministic and distinct for positive and negative coordinates',()=>{assert.equal(sectorLabel(0,0),'A1');assert.equal(sectorLabel(1,0),'B1');assert.equal(sectorLabel(26,0),'AA1');const all=new Set();for(let x=-30;x<=30;x++)for(let z=-5;z<=5;z++)all.add(sectorLabel(x,z));assert.equal(all.size,61*11);});
test('sector membership is incremental, empty cells disappear and moves force a fresh job',()=>{
 const index=new SpatialIndex(250),scheduler=new SectorScheduler({index}),s=player('s');scheduler.register(s);assert.equal(scheduler.cells.size,1);let jobs=scheduler.plan(0);assert.equal(jobs.length,1);scheduler.commit(jobs[0],0,1);assert.equal(scheduler.plan(0).length,0);
 s.lastState.x=251;scheduler.update(s,1);assert.equal(scheduler.cells.size,1);assert.equal(scheduler.plan(1).length,1);scheduler.forget('s');assert.equal(scheduler.cells.size,0);assert.equal(scheduler.entries.size,0);
});
test('a hot sector adapts its own policy while a cold sector keeps its cadence and neighbors',()=>{
 const scheduler=new SectorScheduler({index:new SpatialIndex(250),budgetMs:4}),hot=player('hot'),cold=player('cold',5000);scheduler.register(hot);scheduler.register(cold);
 for(let time=0;time<=2000;time+=100){for(const j of scheduler.plan(time))scheduler.commit(j,time,j.entry.s===hot?10:.1);scheduler.finish(time,20);}
 const h=scheduler.cells.get('0,0'),c=scheduler.cells.get('20,0');assert.equal(h.hz,10);assert.equal(h.limit,32);assert.equal(c.hz,20);assert.equal(c.limit,32);
 // Nearby visibility shrinks only under real global overload, and only here.
 for(let time=2100;time<=4200;time+=100){for(const j of scheduler.plan(time))scheduler.commit(j,time,j.entry.s===hot?50:.1);scheduler.finish(time,80);}
 assert(h.limit<32);assert.equal(c.hz,20);assert.equal(c.limit,32);
});
test('jobs interleave sectors, a dense cell does not push an isolated player behind the whole cell',()=>{
 const scheduler=new SectorScheduler({index:new SpatialIndex(250)});for(let i=0;i<100;i++)scheduler.register(player('dense'+i));const solo=player('solo',5000);scheduler.register(solo);
 assert(scheduler.plan(0).findIndex(j=>j.entry.s===solo)<=1);
});
test('paused and not-yet-driving players get low-frequency control jobs and resume immediately',()=>{
 const scheduler=new SectorScheduler({index:new SpatialIndex()}),s=player('menu');s.lastState=null;scheduler.register(s);let j=scheduler.plan(0)[0];assert.equal(j.policy.hz,1);scheduler.commit(j,0,.1);assert.equal(scheduler.plan(100).length,0);s.lastState={x:0,z:0,paused:false};scheduler.update(s,100);assert.equal(scheduler.plan(100)[0].policy.hz,20);
});
test('existing spatial grid keeps players visible across a sector boundary',()=>{
 const index=new SpatialIndex(250),a=player('a',249),b=player('b',251);index.update(a);index.update(b);assert.equal(index.nearest(a,100,32,0,1500)[0].id,'b');assert.equal(index.nearest(b,100,32,0,1500)[0].id,'a');
});
const sample=(nativeId,x)=>({nativeId,vehicleType:0,position:[x,10,0],quaternion:[1,0,0,0],accessories:[{kind:1,path:'/def/vehicle/ai/golf/chassis.sii'}]});
test('AI index filters distant regions, keeps boundary visibility and removes replaced or stale actors',()=>{
 let now=0;const r=new NativeTrafficGroups({now:()=>now,limit:8,maxActors:32});for(const [id,x]of [['a',0],['viewer',251],['c',5000],['d',10000]])r.updateSession(id,[x,10,0],true);r.tick();for(const [id,x]of [['a',249],['c',5000],['d',10000]])r.publish(id,{epoch:r.role(id).epoch,sequence:0,samples:[sample(1,x)]});
 const before=r.actorCandidatesChecked;assert.equal(r.snapshot('viewer').length,1);assert.equal(r.actorCandidatesChecked-before,1);now=600;r.publish('a',{epoch:r.role('a').epoch,sequence:1,samples:[]});assert.equal(r.snapshot('viewer').length,0);now=1100;assert.equal(r.snapshot('viewer').length,0);
});
test('AI source remains stable when crossing a grid boundary and old epochs are purged on teleport',()=>{
 const r=new NativeTrafficGroups();r.updateSession('a',[249,10,0],true);r.updateSession('b',[260,10,0],true);r.tick();const epoch=r.role('a').epoch;r.publish('a',{epoch,sequence:0,samples:[sample(1,250)]});r.updateSession('a',[251,10,0],true);r.tick();assert.equal(r.role('a').epoch,epoch);assert.equal(r.snapshot('b').length,1);r.updateSession('a',[5000,10,0],true);r.tick();assert.equal(r.snapshot('b').length,0);
});
test('sector configuration supports explicit rollback and rejects invalid work budgets',()=>{assert.equal(sectorSettings().sectorScheduling,true);assert.equal(sectorSettings({SECTOR_SCHEDULING:'false'}).sectorScheduling,false);assert.throws(()=>sectorSettings({SECTOR_WORK_BUDGET_MS:'NaN'}));});
