import {join} from 'node:path';
import {createHmac,randomBytes} from 'node:crypto';
import {readJson,atomicJson,safeDirectory,revision} from './storage.mjs';
import {profileChanges,PROFILES} from './assets/advice-model.mjs';
const validActor=actor=>{if(!/^\d{17}$/.test(actor))throw Error('invalid_guidance');};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const only=(data,keys)=>{if(!object(data)||Object.keys(data).some(k=>!keys.includes(k)))throw Error('invalid_guidance');};
const initial=()=>({schema:1,setup:{startedAt:null,completedAt:null,step:0,profileId:'keep',slots:null},users:{}});
export class ManagerGuidance{
 constructor({directory,supervisor,settings,operations,logs}){Object.assign(this,{directory,supervisor,settings,operations,logs});this.file=join(directory,'guidance.json');this.secret=randomBytes(32);this.context=null;}
 async open(){await safeDirectory(this.directory);this.state=await readJson(this.file,initial(),524288);const s=this.state;
  if(s.schema!==1||!object(s.setup)||!object(s.users)||Object.keys(s.users).length>256||!Number.isInteger(s.setup.step)||s.setup.step<0||s.setup.step>3||!PROFILES.some(p=>p.id===s.setup.profileId)||s.setup.completedAt!==null&&!Number.isFinite(Date.parse(s.setup.completedAt)))throw Error('invalid_guidance_store');
  for(const [actor,pref]of Object.entries(s.users)){if(!/^\d{17}$/.test(actor)||!object(pref)||typeof pref.advanced!=='boolean'||typeof pref.tourSeen!=='boolean'||pref.navigation!==undefined&&!['vertical','horizontal'].includes(pref.navigation)||pref.sidebarCompact!==undefined&&typeof pref.sidebarCompact!=='boolean')throw Error('invalid_guidance_store');const f=pref.workflow;if(f!==null&&f!==undefined&&(!object(f)||f.id!=='addon'||!Number.isInteger(f.stage)||f.stage<0||f.stage>3||!Array.isArray(f.baseline)||f.baseline.length>512||f.baseline.some(name=>typeof name!=='string'||name.length>180)))throw Error('invalid_guidance_store');}
  if(s.lastProfileChange&&(!object(s.lastProfileChange)||!Array.isArray(s.lastProfileChange.changes)||s.lastProfileChange.changes.length>64||s.lastProfileChange.changes.some(c=>!object(c)||typeof c.key!=='string'||typeof c.before!=='string'||typeof c.after!=='string')))throw Error('invalid_guidance_store');
  if(!s.createdAt){s.createdAt=new Date().toISOString();await atomicJson(this.file,s);}
 }
 get token(){return revision(this.state);}
 user(actor){validActor(actor);const {locale:legacyLocale,...stored}=this.state.users[actor]??{};return {advanced:false,tourSeen:false,workflow:null,navigation:'vertical',sidebarCompact:false,...stored};}
 invalidate(){this.context=null;this.contextGeneration=(this.contextGeneration??0)+1;}
 async getContext(){if(this.context&&Date.now()-this.context.at<30000)return this.context.value;if(this.contextPromise&&this.promiseGeneration===(this.contextGeneration??0))return this.contextPromise;const generation=this.contextGeneration??0;this.promiseGeneration=generation;
  const pending=(async()=>{const tasks={settings:()=>this.settings?.get(),backups:()=>this.operations.backups.list(),addons:()=>this.operations.addons.get(),diagnostics:()=>this.operations.diagnostics()},context={at:new Date().toISOString(),unavailable:[]};
   await Promise.all(Object.entries(tasks).map(async([key,task])=>{try{const result=await task();if(!result){context.unavailable.push(key);return;}
    context[key]=key==='settings'?result:key==='backups'?{count:result.items.length,latestAt:result.items.map(b=>b.createdAt).sort().at(-1)??null}:key==='addons'?{count:result.files.length,enabled:result.order.length,conflicts:result.inspection?.conflictCount??null,complete:result.inspection?.complete??false}:result;
   }catch{context.unavailable.push(key);}}));if(generation===(this.contextGeneration??0))this.context={at:Date.now(),value:context};return context;
  })();this.contextPromise=pending;try{return await pending;}finally{if(this.contextPromise===pending)this.contextPromise=null;}
 }
 async view(actor){return {serverTime:Date.now(),revision:this.token,setup:structuredClone(this.state.setup),preferences:structuredClone(this.user(actor)),undoAvailable:!!this.state.lastProfileChange&&!this.state.lastProfileChange.undoneAt,context:await this.getContext()};}
 async mutate(actor,data,keys,task){validActor(actor);only(data,['revision',...keys]);return this.operations.lock.run(async()=>{if(data.revision!==this.token)throw Error('guidance_conflict');const next=structuredClone(this.state);const result=await task(next);if(Buffer.byteLength(JSON.stringify(next))>524288)throw Error('guidance_limit');await atomicJson(this.file,next);this.state=next;this.invalidate();return {ok:true,...result,...await this.view(actor)};});}
 async preferences(data,actor){return this.mutate(actor,data,['advanced','tourSeen','navigation','sidebarCompact'],async next=>{
  if(data.advanced!==undefined&&typeof data.advanced!=='boolean'||data.tourSeen!==undefined&&typeof data.tourSeen!=='boolean'||data.navigation!==undefined&&!['vertical','horizontal'].includes(data.navigation)||data.sidebarCompact!==undefined&&typeof data.sidebarCompact!=='boolean')throw Error('invalid_guidance');
  if(!Object.hasOwn(next.users,actor)&&Object.keys(next.users).length>=256)throw Error('guidance_limit');
  next.users[actor]={...this.user(actor),...Object.fromEntries(['advanced','tourSeen','navigation','sidebarCompact'].filter(k=>data[k]!==undefined).map(k=>[k,data[k]]))};
 });}
 async draft(data,actor){return this.mutate(actor,data,['step','profileId','slots'],async next=>{
  if(next.setup.completedAt)throw Error('onboarding_closed');
  if(!Number.isInteger(data.step)||data.step<0||data.step>3||!PROFILES.some(p=>p.id===data.profileId)||data.slots!==null&&(!Number.isInteger(data.slots)||data.slots<2||data.slots>5000))throw Error('invalid_guidance');
  next.setup={...next.setup,step:data.step,profileId:data.profileId,slots:data.slots,startedAt:next.setup.startedAt??new Date().toISOString()};
 });}
 playerCount(){const s=this.supervisor.status();return s.state==='running'&&Number.isFinite(s.sampledAt)&&Date.now()-s.sampledAt<10000?s.snapshot?.health?.players??null:null;}
 sign(plan){return createHmac('sha256',this.secret).update(JSON.stringify(plan)).digest('hex');}
 async preview(data){only(data,['profileId','slots']);if(!this.settings)throw Error('settings_unavailable');const settings=await this.settings.get();const plan={...profileChanges(data.profileId,settings.fields,data.slots),settingsRevision:settings.revision};return {...plan,previewToken:this.sign(plan),connectedPlayers:this.playerCount(),restartRequired:settings.restartRequired||plan.changes.length>0,privateConfigBackup:true};}
 async applyPlan(data,actor){const plan=await this.preview({profileId:data.profileId,slots:data.slots});if(data.previewToken!==plan.previewToken)throw Error('guidance_preview_changed');if(plan.blocked.length)throw Error('guidance_hosting_override');
  await this.logs.audit(actor,'guidance.profile',{profile:data.profileId,keys:plan.changes.map(c=>c.key)});
  if(plan.changes.length)await this.settings.save({revision:plan.settingsRevision,changes:Object.fromEntries(plan.changes.map(c=>[c.key,c.after]))},actor);
  return plan;
 }
 recordProfile(next,plan,actor){if(plan.changes.length)next.lastProfileChange={id:randomBytes(16).toString('hex'),at:new Date().toISOString(),actor,changes:plan.changes.map(({key,before,after})=>({key,before,after})),undoneAt:null};}
 async apply(data,actor){return this.mutate(actor,data,['profileId','slots','previewToken','confirm'],async next=>{if(data.confirm!==true)throw Error('confirmation_required');const plan=await this.applyPlan(data,actor);this.recordProfile(next,plan,actor);return {restartAutomatically:false};});}
 async finish(data,actor){return this.mutate(actor,data,['profileId','slots','previewToken','confirm'],async next=>{
  if(next.setup.completedAt)throw Error('onboarding_closed');if(data.confirm!==true)throw Error('confirmation_required');const plan=await this.applyPlan(data,actor);
  this.recordProfile(next,plan,actor);next.setup={...next.setup,step:3,profileId:data.profileId,slots:data.slots??null,startedAt:next.setup.startedAt??new Date().toISOString(),completedAt:new Date().toISOString(),completedBy:actor,appliedKeys:plan.changes.map(c=>c.key)};await this.logs.audit(actor,'guidance.setup.complete',{profile:data.profileId});
  return {restartAutomatically:false};
 });}
 async undoPreview(data){only(data,[]);const last=this.state.lastProfileChange;if(!last||last.undoneAt)throw Error('guidance_no_undo');if(!this.settings)throw Error('settings_unavailable');const settings=await this.settings.get(),changes=[],blocked=[];
  for(const item of last.changes){const field=settings.fields.find(f=>f.key===item.key);if(!field||field.overridden||String(field.value)!==item.after){blocked.push({key:item.key,reason:'changed_since'});continue;}changes.push({key:item.key,label:field.label,before:String(field.value),after:item.before});}
  const plan={undoId:last.id,settingsRevision:settings.revision,changes,blocked};return {...plan,previewToken:this.sign(plan),connectedPlayers:this.playerCount()};
 }
 async undo(data,actor){return this.mutate(actor,data,['previewToken','confirm'],async next=>{if(data.confirm!==true)throw Error('confirmation_required');const plan=await this.undoPreview({});if(plan.previewToken!==data.previewToken)throw Error('guidance_preview_changed');if(plan.blocked.length)throw Error('guidance_undo_conflict');await this.settings.save({revision:plan.settingsRevision,changes:Object.fromEntries(plan.changes.map(c=>[c.key,c.after]))},actor);next.lastProfileChange.undoneAt=new Date().toISOString();await this.logs.audit(actor,'guidance.profile.undo',{keys:plan.changes.map(c=>c.key)});return {restartAutomatically:false};});}
 async workflow(data,actor){return this.mutate(actor,data,['action'],async next=>{
  if(!['start','next','cancel'].includes(data.action))throw Error('invalid_guidance');
  if(!Object.hasOwn(next.users,actor)&&Object.keys(next.users).length>=256)throw Error('guidance_limit');const pref={...this.user(actor)};next.users[actor]=pref;
  if(data.action==='cancel'){pref.workflow=null;return;}
  if(data.action==='start'){if(pref.workflow)return;const addons=await this.operations.addons.get();pref.workflow={id:'addon',stage:0,startedAt:new Date().toISOString(),baseline:addons.files.map(f=>f.name).slice(0,512)};return;}
  const flow=pref.workflow;if(flow?.id!=='addon')throw Error('invalid_guidance');if(flow.stage<3&&!['stopped','crashed'].includes(this.supervisor.state))throw Error('guidance_step_not_ready');
  if(flow.stage===0&&!['stopped','crashed'].includes(this.supervisor.state))throw Error('guidance_step_not_ready');
  if(flow.stage===1&&!(await this.operations.backups.list()).items.length)throw Error('guidance_step_not_ready');
  if(flow.stage===2){const addons=await this.operations.addons.get();const added=addons.files.filter(f=>!flow.baseline.includes(f.name)&&addons.order.includes(f.name));if(!added.length)throw Error('guidance_step_not_ready');flow.added=added.map(f=>f.publicName??f.name);}
  if(flow.stage===3){const status=this.supervisor.status(),published=status.meta?.addons?.map(a=>a.name)??[];if(status.state!=='running'||!status.snapshot?.health||Date.now()-(status.sampledAt??0)>10000||!flow.added.every(n=>published.includes(n)))throw Error('guidance_step_not_ready');}
  if(flow.stage>=3){pref.workflow=null;pref.lastWorkflow={id:'addon',completedAt:new Date().toISOString()};await this.logs.audit(actor,'guidance.workflow.complete',{kind:'addon',resources:flow.added.length});}else flow.stage++;
 });}
}
