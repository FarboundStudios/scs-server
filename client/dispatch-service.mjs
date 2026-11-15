import {createDispatchSaves} from './dispatch-save.mjs';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

export function createDispatchService({native,transport,home,directory,scope,getData,notify=()=>{},log=()=>{},acceptTimeoutMs=8000}){
 const saves=home?createDispatchSaves({home}):null;
 const file=directory?join(directory,'dispatch-active-'+createHash('sha256').update(scope).digest('hex').slice(0,16)+'.json'):null;
 let active=null,checking=false,lastCheck=0,lastEvent='',closed=false,draining=null,nextRetryAt=0,syncError='',storageError=null,persistTail=Promise.resolve();const pending=new Map();
 const ready=file?readFile(file,'utf8').then(s=>{const a=JSON.parse(s);if(a?.schema===2){active=a.active??null;for(const [key,value] of (a.pending??[]).slice(0,32))pending.set(key,value);}else if(typeof a?.id==='string'&&a.spec)active=a;}).catch(e=>{if(e.code!=='ENOENT')storageError=Error('Mission tracking could not be read. Restore its local state before continuing.');}):Promise.resolve();
 async function persist(){if(!file)return;const body=JSON.stringify({schema:2,active,pending:[...pending]});const write=async()=>{await mkdir(directory,{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,body,{flag:'wx',mode:0o600});await rename(temp,file);};persistTail=persistTail.catch(()=>{}).then(write);return persistTail;}
 async function mutation(action,data){const {requestId,...fields}=data??{},key=createHash('sha256').update(JSON.stringify(action==='telemetry'&&requestId?{action,id:fields.id,requestId}:{action,data:fields})).digest('hex');let item=pending.get(key);if(!item){if(pending.size>=32)throw Error('Too many pending mission actions. Reconnect and retry.');item={action,data:{...fields,requestId:requestId??randomUUID()}};pending.set(key,item);await persist();}try{const result=await transport.request(item.action,item.data);pending.delete(key);await persist();return result;}catch(e){if(!e.retryable){pending.delete(key);await persist();}throw e;}}
 const matches=(job,spec)=>job?.cargo===spec.cargo.slice(6)&&job.source===spec.source&&job.destination===spec.destination;
 async function finish(row,event){for(const [key,item] of pending)if(item.data.id===row.id&&['prepared','telemetry'].includes(item.action))pending.delete(key);const title=event==='job.delivered'?'Delivery complete':'Delivery cancelled',text=row.spec.title;active=null;await persist();notify({id:randomUUID(),app:'missions',title,text,at:Date.now()});}
 async function doDrain(){
  if(closed||checking||Date.now()<nextRetryAt||!transport.available())return false;await ready;if(storageError)return false;if(checking||!active)return !active;checking=true;
  try{
   let row=await transport.request('get',{id:active.id});
   if(['delivered','cancelled'].includes(row.membership)){await finish(row,row.membership==='delivered'?'job.delivered':'job.cancelled');return true;}
   if(row.membership==='left'){log('Missions: delivery updates retained because this participant left the mission.');return false;}
   if(row.membership==='accepted'&&active.proofHash){row=await mutation('prepared',{id:row.id,revision:row.revision,proofHash:active.proofHash,saveHash:active.proofHash,method:'live',attemptId:active.attemptId});}
   active.events??=[];
   while(active?.events.length){const event=active.events[0];row=await mutation('telemetry',{id:row.id,revision:row.revision,attemptId:active.attemptId,requestId:event.requestId,job:event.job});active.events.shift();await persist();if(event.job.event){lastEvent=event.job.eventId;await finish(row,event.job.event);break;}}
   syncError='';nextRetryAt=0;return true;
  }catch(e){syncError=e.message;nextRetryAt=Date.now()+Math.max(e.retryAfterMs??0,e.retryable?5000:30000);log('Missions: '+e.message);return false;}finally{checking=false;}
 }
 const drain=()=>{if(draining)return draining;draining=doDrain().finally(()=>{draining=null;});return draining;};
 const retryTimer=setInterval(()=>{void drain().catch(e=>log('Missions storage: '+e.message));},5000);retryTimer.unref?.();
 return {async request(action,data={}){
  await ready;if(storageError)throw storageError;
  if(action==='profiles')return {profiles:saves?await saves.profiles():[],available:transport.available(),nativeJobs:true};
  if(action==='catalogue'){if(!saves)throw Error('ETS2 Documents folder unavailable.');const catalogue=await saves.catalogue(data.profile,data.query),excluded=new Set(getData().unavailableCompanies??[]);return {...catalogue,companies:catalogue.companies.filter(c=>!excluded.has(c.id)),companyCount:Math.max(0,catalogue.companyCount-excluded.size)};}
  if(action==='route'){if(!saves)throw Error('ETS2 Documents folder unavailable.');return saves.route(data.profile,data.source,data.destination);}
  if(action==='prepare'){
   const local=getData();
   if(!local.connected||!local.telemetry||!Number.isFinite(local.speedKmh)||local.speedKmh>0.01)throw Error('Stop your truck before preparing a delivery.');
   if(!local.job?.supported||!local.job.liveCreation)throw Error('Live freight creation requires the updated HeavyMP game plugin. Restart HeavyMP and ETS2 after installing the update.');if(local.job.active)throw Error('Finish or cancel your current ETS2 job first.');
   const mission=await transport.request('get',{id:data.id});if(!['accepted','prepared'].includes(mission.membership)||mission.state!=='open')throw Error('Join this mission before preparing it.');
   if(!native)throw Error('Live delivery creation requires the updated game client.');
   const excluded=new Set(local.unavailableCompanies??[]);if(excluded.has(mission.spec.source)||excluded.has(mission.spec.destination))throw Error('This company is unavailable in your active map. Choose another route.');
   const receipt=await native.request(mission);
   const until=Date.now()+acceptTimeoutMs;let accepted=false;while(Date.now()<until){const job=getData().job;if(job?.active&&job.cargo===mission.spec.cargo.slice(6)&&job.source===mission.spec.source&&job.destination===mission.spec.destination){accepted=true;break;}await new Promise(resolve=>setTimeout(resolve,Math.min(100,acceptTimeoutMs)));}if(!accepted)throw Error('ETS2 did not report an accepted delivery. The mission was not marked as started.');
   const proofHash=createHash('sha256').update(JSON.stringify({id:receipt.id,spec:mission.spec,method:'live'})).digest('hex');
   active={id:mission.id,spec:mission.spec,proofHash,attemptId:randomUUID(),events:[{requestId:randomUUID(),job:{...getData().job,vehicle:getData().vehicle??null}}]};await persist();
   const synced=await drain();
   notify({id:randomUUID(),app:'missions',title:'Delivery started',text:mission.spec.title+(synced?'':' · Synchronisation pending'),at:Date.now()});return {...receipt,started:true,syncPending:!synced,source:mission.spec.source,destination:mission.spec.destination};
  }
  if(action==='list'){const result=await transport.request(action,data);return {...result,clientPending:(active?.events?.length??0)+pending.size,syncError};}if(action==='get')return transport.request(action,data);
  return mutation(action,data);
 },async observe(job){
  await ready;if(storageError||closed||!active)return;
  if(job?.supported&&matches(job,active.spec)&&(job.active||job.event)){
   if(job.event&&job.eventId===lastEvent)return;
   active.events??=[];active.attemptId??=randomUUID();
   if(job.event&&!active.events.some(e=>e.job.eventId===job.eventId)){
    // Persist terminal telemetry before any network request. A disconnected
    // server or a closed phone must not lose the one-shot SDK delivery event.
    if(active.events.length>=64)throw Error('Pending delivery event storage is full.');
    active.events.push({requestId:randomUUID(),job:{...job,vehicle:getData().vehicle??null}});await persist();
   }else if(!job.event&&!checking&&Date.now()-lastCheck>=5000&&!active.events.length){lastCheck=Date.now();active.events.push({requestId:randomUUID(),job:{...job,vehicle:getData().vehicle??null}});await persist();}
  }
  await drain();
 },async close(){closed=true;clearInterval(retryTimer);await draining?.catch(()=>{});await persistTail;}};
}
