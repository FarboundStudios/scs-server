import {atomicJson,readJson,revision} from './storage.mjs';
const fingerprint=/^[a-f0-9]{64}$/;
export function validRules(value){if(value?.schema!==1||!Array.isArray(value.rules)||value.rules.length>1000||value.rules.some(r=>!r||!(fingerprint.test(r.identity??'')||(r.identity==null&&/^\d{17}$/.test(r.steamId??'')))||!['ban','mute'].includes(r.kind)||!Number.isFinite(r.until)||typeof r.reason!=='string'||r.reason.length>160))throw Error('invalid_moderation_file');return value.rules;}
export async function loadManagerRules(file){return validRules(await readJson(file,{schema:1,rules:[]}));}
export class ManagerModeration{
 constructor({file,supervisor,logs,lock,now=Date.now}){Object.assign(this,{file,supervisor,logs,lock,now});}
 async open(){this.rules=await loadManagerRules(this.file);}
 get(){return {rules:this.rules.filter(r=>r.identity&&r.until>this.now()),revision:revision(this.rules),scope:'this server only'};}
 async apply(data,actor){return this.lock.run(async()=>{
  if(data.revision!==revision(this.rules))throw Error('revision_conflict');const {identity,action,reason='',minutes=60}=data;
  if(!fingerprint.test(identity??'')||!['warn','kick','ban','mute','unban','unmute'].includes(action)||typeof reason!=='string'||reason.length>160||/[\x00-\x1f\x7f]/.test(reason))throw Error('invalid_moderation');
  if(['warn','kick','ban','mute'].includes(action)&&!reason.trim())throw Error('reason_required');if(['ban','mute'].includes(action)&&(!Number.isInteger(minutes)||minutes<1||minutes>43200))throw Error('invalid_duration');
  await this.logs.audit(actor,'moderation.'+action,{target:identity,reason,minutes});
  if(['warn','kick'].includes(action))return {result:await this.supervisor.command('moderate',{identity,action,reason}),...this.get()};
  const kind=action.includes('ban')?'ban':'mute',previous=this.rules;this.rules=this.rules.filter(r=>r.until>this.now()&&!(r.identity===identity&&r.kind===kind));if(!action.startsWith('un'))this.rules.push({identity,kind,until:this.now()+minutes*60000,reason,actor,createdAt:new Date(this.now()).toISOString()});if(this.rules.length>1000){this.rules=previous;throw Error('moderation_limit');}
  try{await atomicJson(this.file,{schema:1,rules:this.rules});}catch(e){this.rules=previous;throw e;}
  let applied=this.supervisor.state!=='running';if(!applied)try{await this.supervisor.command('rules',{rules:this.rules});applied=true;}catch{}
  return {...this.get(),applied,note:applied?'Saved and applied.':'Saved; worker update pending. Restart the game server to apply.'};
 });}
}
