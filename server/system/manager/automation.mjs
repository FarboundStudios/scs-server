import {randomUUID} from 'node:crypto';
import {atomicJson,readJson,revision} from './storage.mjs';
export async function readSchedules(file){
 const saved=await readJson(file,{schema:1,jobs:[]});
 if(saved?.schema!==1||!Array.isArray(saved.jobs)||saved.jobs.length>50||saved.jobs.some(j=>!j||!/^[a-f0-9-]{36}$/.test(j.id??'')||!['announcement','restart'].includes(j.kind)||!Number.isFinite(Date.parse(j.at))||!['scheduled','paused','executing','interrupted','completed','failed'].includes(j.state)||typeof j.message!=='string'||j.message.length>240||!Number.isInteger(j.repeatMinutes)||j.repeatMinutes!==0&&(j.repeatMinutes<5||j.repeatMinutes>10080)))throw Error('invalid_schedule_file');
 return saved.jobs;
}
export class ManagerAutomation{
 constructor({file,supervisor,logs,lock,settings,now=Date.now}){Object.assign(this,{file,supervisor,logs,lock,settings,now});this.jobs=[];this.executing=false;this.warnings=new Set();}
 async open(){this.jobs=await readSchedules(this.file);
  // A process crash after claiming an action must never replay a restart/announcement.
  for(const job of this.jobs)if(job.state==='executing'){job.state='interrupted';job.lastError='Interrupted by Manager restart; review before rescheduling.';}await this.persist();}
 persist(){return atomicJson(this.file,{schema:1,jobs:this.jobs});}
 get(){return {jobs:this.jobs,revision:revision(this.jobs),serverTime:new Date(this.now()).toISOString(),timezone:'UTC',limit:50};}
 async save(data,actor){return this.lock.run(async()=>{if(data.revision!==revision(this.jobs))throw Error('revision_conflict');if(this.jobs.length>=50)throw Error('schedule_limit');
  const {kind,message='',repeatMinutes=0}=data,at=Date.parse(data.at);
  if(!['announcement','restart'].includes(kind)||!Number.isFinite(at)||at<this.now()+10000||at>this.now()+366*86400000||!Number.isInteger(repeatMinutes)||repeatMinutes!==0&&(repeatMinutes<5||repeatMinutes>10080)||typeof message!=='string'||/[\x00-\x1f\x7f]/.test(message)||message.length>240||kind==='announcement'&&!message.trim())throw Error('invalid_schedule');
  const job={id:randomUUID(),kind,message:message.trim(),at:new Date(at).toISOString(),repeatMinutes,state:'scheduled',actor,createdAt:new Date(this.now()).toISOString()};await this.logs.audit(actor,'schedule.create',{id:job.id,kind,at:job.at});this.jobs.push(job);try{await this.persist();}catch(e){this.jobs.pop();throw e;}return this.get();
 });}
 async remove(data,actor){return this.lock.run(async()=>{if(data.revision!==revision(this.jobs))throw Error('revision_conflict');if(this.executing)throw Error('operation_busy');const previous=this.jobs,job=previous.find(j=>j.id===data.id);if(!job)throw Error('schedule_not_found');await this.logs.audit(actor,'schedule.delete',{id:job.id});this.jobs=previous.filter(j=>j!==job);try{await this.persist();}catch(e){this.jobs=previous;throw e;}return this.get();});}
 async toggle(data,actor){return this.lock.run(async()=>{if(data.revision!==revision(this.jobs))throw Error('revision_conflict');const job=this.jobs.find(j=>j.id===data.id);if(!job||!['scheduled','paused'].includes(job.state))throw Error('schedule_not_found');await this.logs.audit(actor,'schedule.toggle',{id:job.id});const previous={...job};job.state=job.state==='scheduled'?'paused':'scheduled';if(job.state==='scheduled'&&Date.parse(job.at)<this.now()+10000)job.at=new Date(this.now()+60000).toISOString();try{await this.persist();}catch(e){Object.assign(job,previous);throw e;}return this.get();});}
 start(){this.timer=setInterval(()=>{void this.tick().catch(()=>this.logs.record('Scheduled task failed; inspect Automation for details.','error','manager'));},1000);this.timer.unref?.();}
 async tick(){if(this.supervisor.shuttingDown||this.executing||this.lock.busy)return;this.executing=true;try{const active=this.jobs.filter(j=>j.state==='scheduled').map(j=>j.id+j.at);for(const key of this.warnings)if(!active.some(prefix=>key.startsWith(prefix)))this.warnings.delete(key);for(const job of this.jobs){if(job.state!=='scheduled')continue;const remaining=Date.parse(job.at)-this.now();
   if(job.kind==='restart'&&remaining>0&&this.supervisor.state==='running')for(const seconds of [10,60])if(remaining<=seconds*1000){const key=job.id+job.at+seconds;if(!this.warnings.has(key)){this.warnings.add(key);if(seconds===10)this.warnings.add(job.id+job.at+60);const actual=Math.max(1,Math.ceil(remaining/1000));await this.supervisor.command('annonce',{message:`Server restart in ${actual} second${actual===1?'':'s'}. Please park safely.`}).catch(()=>{});break;}}
   if(remaining>0)continue;
   // Persist the claim before executing to avoid duplicates across crashes.
   job.state='executing';await this.persist();try{await this.logs.audit(job.actor,'schedule.execute',{id:job.id,kind:job.kind});if(remaining < -120000)throw Error('Missed while Manager was offline; not replayed.');if(this.supervisor.state!=='running')throw Error('Game server is not running.');
    if(job.kind==='announcement'){const result=await this.supervisor.command('annonce',{message:job.message});if(result.ok===false)throw Error('Announcement refused.');}
    else{await this.settings?.prepareStart();await this.supervisor.power('restart');}
    job.state='completed';job.lastError=null;
   }catch(e){job.state='failed';job.lastError=String(e.message).slice(0,180);this.logs.record('Scheduled '+job.kind+' failed: '+job.lastError,'warn','manager');}
   job.lastRunAt=new Date(this.now()).toISOString();if(job.repeatMinutes){const step=job.repeatMinutes*60000;const planned=Date.parse(job.at);job.at=new Date(planned+(Math.floor((this.now()-planned)/step)+1)*step).toISOString();job.state='scheduled';}await this.persist();
  }}finally{this.executing=false;}}
 async close(){clearInterval(this.timer);while(this.executing)await new Promise(r=>setTimeout(r,20));}
}
