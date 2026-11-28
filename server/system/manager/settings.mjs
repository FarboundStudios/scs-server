import {open,lstat,rename,unlink,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';import {constants} from 'node:fs';
import {parseEnv} from 'node:util';import {createHash,createHmac,randomBytes} from 'node:crypto';
const number=(key,label,group,min,max,value,step=1)=>({key,label,group,type:'number',min,max,step,default:String(value)});
const flag=(key,label,group,value)=>({key,label,group,type:'select',options:['true','false'],default:String(value)});
export const SETTINGS=[
 {key:'ROOM',label:'Room name',group:'Access',type:'text',default:'HeavyMP',pattern:/^[A-Za-z0-9_-]{1,32}$/},
 number('MAX_PLAYERS','Maximum players','Access',2,5000,5000),flag('STAFF_ONLY','Staff-only access','Access',false),
 {...flag('ALLOW_OPTIONAL_MODS','Allow optional player mods','Access',false),ownerOnly:true},
 number('TICK_HZ','Tick rate (Hz)','Synchronization',10,1000,20),number('MAX_NEARBY_PLAYERS','Nearby players','Synchronization',1,32,32),
 number('SYNC_RADIUS','Synchronization radius (m)','Synchronization',200,3000,1000),number('GRID_CELL_SIZE','Sector size (m)','Synchronization',50,4000,250),
 number('INTEREST_INTERVAL_MS','Interest refresh (ms)','Synchronization',50,1000,200),number('INTEREST_CANDIDATE_BUDGET','Candidate budget','Synchronization',64,4096,512),
 number('MAX_CONFIG_MB','Vehicle configuration cache (MB)','Synchronization',1,2048,512),
 flag('SECTOR_SCHEDULING','Adaptive sectors','Synchronization',true),number('SECTOR_WORK_BUDGET_MS','Sector work budget (ms)','Synchronization',.25,25,4,.25),
 flag('PLAYER_COLLISIONS','Player collisions','World',true),flag('NO_COLLISION_ZONES_ENABLED','Non-collision zones','World',true),number('TIME_SCALE','Game minutes per real minute','World',1,60,19),
 number('LOCAL_CHAT_RADIUS','Nearby chat radius (m)','Chat',50,2000,500),number('GLOBAL_CHAT_RATE','Global chat rate','Chat',1,20,6),
 flag('TRAFFIC_ENABLED','Native traffic','Traffic',false),number('TRAFFIC_MAX_VEHICLES','Vehicles per source','Traffic',1,0x3fffffff,32),
 number('TRAFFIC_GLOBAL_MAX_VEHICLES','Global vehicle budget','Traffic',1,0x3fffffff,128),number('TRAFFIC_VIEW_RADIUS','View radius (m)','Traffic',100,1500,750),number('TRAFFIC_HZ','Traffic updates (Hz)','Traffic',2,10,10),
 number('TRAFFIC_SOURCE_GRACE_MS','Source grace period (ms)','Traffic',0,1500,750),number('TRAFFIC_SOURCE_TIMEOUT_MS','Source timeout (ms)','Traffic',1500,15000,3000),number('TRAFFIC_SOURCE_WARMUP_MS','Source warm-up (ms)','Traffic',3000,60000,15000),
 {key:'LOG_LEVEL',label:'Log level',group:'Console',type:'select',options:['debug','info','warn','error'],default:'info'},
 {key:'LOG_COLORS',label:'Terminal colors',group:'Console',type:'select',options:['true','false','auto'],default:'true'},flag('LOG_PLAYER_EVENTS','Player connection events','Console',false),number('LOG_REPEAT_INTERVAL_MS','Repeated log interval (ms)','Console',10000,3600000,60000)
];
const fields=new Map(SETTINGS.map(s=>[s.key,s]));const digest=b=>createHash('sha256').update(b).digest('hex');
function failure(code,field){return Object.assign(Error(code),{field});}
function normalize(s,value){if(!['string','number','boolean'].includes(typeof value))throw failure('invalid_setting',s.key);let v=String(value).trim();if(v.length>80||/[\r\n\x00-\x1f\x7f]/.test(v))throw failure('invalid_setting',s.key);
 if(s.type==='number'){const n=Number(v);if(!v||!Number.isFinite(n)||n<s.min||n>s.max||s.step===1&&!Number.isInteger(n))throw failure('invalid_setting',s.key);v=String(n);}
 else if(s.options){v=v.toLowerCase();if(s.options.includes('true')&&['0','1'].includes(v))v=v==='1'?'true':'false';if(!s.options.includes(v))throw failure('invalid_setting',s.key);}
 else if(!s.pattern.test(v))throw failure('invalid_setting',s.key);return v;
}
// Locate complete assignments, including quoted multiline values. Unknown lines,
// comments and credentials remain byte-for-byte intact outside edited values.
function patch(text,changes){const assignments=[];const re=/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/gm;let m;
 while((m=re.exec(text))){const start=re.lastIndex,quote=text[start];let end,suffix;
  if(['"',"'",'`'].includes(quote)){end=text.indexOf(quote,start+1);if(end<0)throw failure('env_invalid');end++;const lineEnd=text.indexOf('\n',end);suffix=lineEnd<0?text.length:lineEnd;}
  else{const lineEnd=text.indexOf('\n',start);suffix=lineEnd<0?text.length:lineEnd;const hash=text.indexOf('#',start);end=hash>=0&&hash<suffix?hash:suffix;while(end>start&&/[\t \r]/.test(text[end-1]))end--;}
  assignments.push({key:m[1],start,end});re.lastIndex=suffix;
 }
 const edits=assignments.filter(a=>Object.hasOwn(changes,a.key));for(const a of edits.reverse())text=text.slice(0,a.start)+changes[a.key]+text.slice(a.end);
 const present=new Set(assignments.map(a=>a.key)),newline=text.includes('\r\n')?'\r\n':'\n';const added=Object.entries(changes).filter(([key])=>!present.has(key));if(added.length){if(text&&!text.endsWith('\n'))text+=newline;text+=added.map(([k,v])=>k+'='+v).join(newline)+newline;}return text;
}
export class ManagerSettings{
 constructor({directory,env,envFile=resolve('.env'),logs,supervisor,isOwner=()=>false}){Object.assign(this,{directory,env:{...env},appliedEnv:{...env},envFile:resolve(envFile),logs,supervisor,isOwner});this.tokenKey=randomBytes(32);this.overrides=null;}
 async initialize(){if(this.overrides)return;const file=await this.read();this.overrides=new Set(SETTINGS.filter(s=>this.env[s.key]!==undefined&&String(this.env[s.key])!==file.values[s.key]).map(s=>s.key));}
 revision(file){return createHmac('sha256',this.tokenKey).update(file.exists?'1':'0').update(file.bytes).digest('hex');}
 async read(){let handle;try{const stat=await lstat(this.envFile);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||stat.size>262144)throw failure('env_unsafe');handle=await open(this.envFile,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const opened=await handle.stat();if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.nlink!==1)throw failure('env_unsafe');const bytes=await handle.readFile();if(bytes.length>262144)throw failure('env_unsafe');new TextDecoder('utf-8',{fatal:true}).decode(bytes);return {bytes,exists:true,mode:stat.mode&0o777,values:parseEnv(bytes.toString('utf8'))};}catch(e){if(e.code==='ENOENT')return {bytes:Buffer.alloc(0),exists:false,mode:0o600,values:{}};if(e.message.startsWith('env_'))throw e;throw failure('env_unavailable');}finally{await handle?.close();}}
 snapshot(file){const result={revision:this.revision(file),exists:file.exists,fields:SETTINGS.map(s=>{const fileValue=file.values[s.key]??null,effective=this.appliedEnv[s.key]??s.default;return {...s,pattern:undefined,value:fileValue??(this.overrides.has(s.key)?this.env[s.key]:s.default),effective,source:this.overrides.has(s.key)?'environment':fileValue===null?'default':'file',overridden:this.overrides.has(s.key)};})};result.restartRequired=result.fields.some(s=>!s.overridden&&String(s.value)!==String(s.effective));return result;}
 async get(){await this.initialize();return this.snapshot(await this.read());}
 async backupValues(){
  const {fields}=await this.get();
  return Object.fromEntries(fields.filter(field=>!field.overridden).map(field=>[field.key,field.value]));
 }
 async restoreBackupText(values){
  await this.initialize();
  if(!values||typeof values!=='object'||Array.isArray(values))throw failure('invalid_backup');
  const changes={};
  for(const [key,value]of Object.entries(values)){
   const field=fields.get(key);
   if(!field)throw failure('invalid_backup');
   const normalized=normalize(field,value);
   if(!this.overrides.has(key))changes[key]=normalized;
  }
  return patch((await this.read()).bytes.toString('utf8'),changes);
 }
 // Refresh only safe, declared game settings; inherited host/keys/access stay fixed.
 async prepareStart(){await this.initialize();const file=await this.read();for(const s of SETTINGS){if(this.overrides.has(s.key))this.supervisor.env[s.key]=this.env[s.key];else if(Object.hasOwn(file.values,s.key))this.supervisor.env[s.key]=file.values[s.key];else delete this.supervisor.env[s.key];}}
 markApplied(){this.appliedEnv={...this.supervisor.env};}
 async save({revision,changes},actor){if(this.busy)throw failure('settings_busy');this.busy=true;let lock,temp;
 try{await this.initialize();if(!changes||typeof changes!=='object'||Array.isArray(changes)||Object.keys(changes).length>SETTINGS.length||typeof revision!=='string')throw failure('invalid_settings');const normalized={};for(const [key,value]of Object.entries(changes)){const field=fields.get(key);if(!field)throw failure('setting_not_editable');if(field.ownerOnly&&!this.isOwner(actor))throw failure('permission_denied');normalized[key]=normalize(field,value);}
  try{lock=await open(this.envFile+'.hvmp-lock','wx',0o600);}catch(e){throw failure(e.code==='EEXIST'?'settings_busy':'env_unavailable');}
  const file=await this.read();if(revision!==this.revision(file))throw failure('settings_conflict');
  for(const key of Object.keys(normalized)){if(this.overrides.has(key))throw failure('setting_overridden',key);if(file.values[key]===normalized[key])delete normalized[key];}
  if(!Object.keys(normalized).length)return {ok:true,changed:0,...this.snapshot(file)};
  const text=patch(file.bytes.toString('utf8'),normalized),parsed=parseEnv(text);for(const [key,value]of Object.entries(normalized))if(parsed[key]!==value)throw failure('env_invalid');
  const backupDir=join(this.directory,'manager','env-backups');await mkdir(backupDir,{recursive:true,mode:0o700});
  const backup=join(backupDir,'env-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex')+'.bak');
  // Backups contain private values: never expose their contents through HTTP.
  if(file.exists){const copy=await open(backup,'wx',0o600);try{await copy.writeFile(file.bytes);await copy.sync();}finally{await copy.close();}}
  await this.logs.audit(actor,'settings.save',{keys:Object.keys(normalized)});
  const current=await this.read();if(current.exists!==file.exists||digest(current.bytes)!==digest(file.bytes))throw failure('settings_conflict');
  temp=this.envFile+'.hvmp-'+randomBytes(8).toString('hex')+'.tmp';const output=await open(temp,'wx',0o600);try{await output.writeFile(text,'utf8');await output.sync();}finally{await output.close();}
  await rename(temp,this.envFile);temp=null;this.logs.record('Server settings saved. Restart the game process to apply changes.','info','manager');
  return {ok:true,changed:Object.keys(normalized).length,...this.snapshot(await this.read())};
 }finally{if(temp)await unlink(temp).catch(()=>{});if(lock){await lock.close();await unlink(this.envFile+'.hvmp-lock').catch(()=>{});}this.busy=false;}}
}
