import {GAME_VERSION} from '../shared/protocol.mjs';
// Single-line, bounded output for panels which already add timestamps/severity.
const levels={debug:10,info:20,warn:30,error:40};
const paint=(text,color,bold=false)=>`\u001b[${color}m${bold?'\u001b[1m':''}${text}\u001b[0m`;
function coloredLine(level,prefix,text){
 if(level!=='info'){const color=level==='error'?91:level==='warn'?93:90;return paint(`[${prefix}]`,color,true)+' '+paint(text,color);}
 const label=paint(`[${prefix}]`,92,true);
 if(/^(?:◆|└─) /.test(text))return label+' '+paint(text,92,true);
 const section=/^(│  [A-Z]+)( {2,})/.exec(text);
 // Highlight individual values, rather than tinting the entire summary alike.
 const tokens=/INVALID MANIFEST|FAILED|LIMIT REACHED|DISABLED|ACTIVE\b|enabled|configured|staff only|\b\d+(?:\.\d+)?(?: slots?| Hz| m| s| [KMG]iB| bytes?| vehicles\/group)\b/gi;
 const body=(section?paint(section[1],96,true)+section[2]+'\u001b[97m':'')+text.slice(section?.[0].length??0).replace(tokens,token=>{
  const color=/^(?:failed|invalid manifest|limit reached|disabled)/i.test(token)?91:/^staff only$/i.test(token)?95:/^\d/.test(token)?93:92;
  return paint(token,color)+'\u001b[97m';
 });
 return label+' \u001b[97m'+body+'\u001b[0m';
}
const archiveFormats={zip:'ZIP',hashfs:'HashFS',opaque:'unknown format'};
const scriptStates={running:'ACTIVE',failed:'FAILED',limit:'LIMIT REACHED',starting:'PENDING'};
const decimal=(value,digits=1)=>value.toFixed(digits);
const countLabel=(count,singular,plural=singular+'s')=>count+' '+(count===1?singular:plural);
function archiveSize(size){
 if(size<1024)return countLabel(size,'byte');
 const power=Math.min(3,Math.floor(Math.log2(size)/10));
 return decimal(size/1024**power)+' '+['','KiB','MiB','GiB'][power];
}

export function logSettings(env={}){
 const level=String(env.LOG_LEVEL??'info').trim().toLowerCase();
 const players=String(env.LOG_PLAYER_EVENTS??'false').trim().toLowerCase();
 const repeatMs=Number(env.LOG_REPEAT_INTERVAL_MS??60000);
 const colors=String(env.LOG_COLORS??'true').trim().toLowerCase();
 if(!Object.hasOwn(levels,level))throw Error('LOG_LEVEL must be debug, info, warn or error.');
 if(!['true','false','1','0'].includes(players))throw Error('LOG_PLAYER_EVENTS must be true or false.');
 if(!Number.isInteger(repeatMs)||repeatMs<10000||repeatMs>3600000)throw Error('LOG_REPEAT_INTERVAL_MS must be between 10000 and 3600000.');
 if(!['true','false','1','0','auto'].includes(colors))throw Error('LOG_COLORS must be true, false or auto.');
 return {level,playerEvents:['true','1'].includes(players),repeatMs,colors:env.NO_COLOR?'false':colors};
}
export function cleanLog(value){
 return String(value?.message??value)
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'')
  .replace(/Bearer\s+\S+/gi,'Bearer [redacted]')
  .replace(/((?:"?(?:PHONE_HUB_KEY|sessionId|identityToken|roomKey|token)"?)\s*[=:]\s*"?)[^\s,;"}]+/gi,'$1[redacted]')
  .replace(/\b[a-f0-9]{64}\b/gi,'[hash redacted]')
  .replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,600);
}
export function createServerLogger({env={},write=console.log,writeError=console.error,now=Date.now,timers=true,stdoutIsTTY=process.stdout.isTTY===true,stderrIsTTY=process.stderr.isTTY===true}={}){
 const settings=logSettings(env),repeats=new Map();let timer,closed=false;
 function output(level,text){if(levels[level]<levels[settings.level])return;const prefix=level==='info'?'HeavyMP':level==='warn'?'Warning':level==='error'?'Error':'Debug';
  const enabled=['true','1'].includes(settings.colors)||settings.colors==='auto'&&(level==='error'?stderrIsTTY:stdoutIsTTY);
  const line=`[${prefix}] ${text}`;(level==='error'?writeError:write)(enabled?coloredLine(level,prefix,text):line);
 }
 function summarize(item){if(item.skipped){output(item.level,item.text+` (${item.skipped} repeat${item.skipped>1?'s':''} grouped)`);item.skipped=0;item.at=now();}}
 function flush(){for(const [key,item] of repeats)if(now()-item.at>=settings.repeatMs){summarize(item);repeats.delete(key);}}
 function emit(level,value,{key,dedupe=false}={}){
  if(closed||levels[level]<levels[settings.level])return;const text=cleanLog(value);
  if(dedupe){key=level+':'+(key??text);const item=repeats.get(key);if(item&&now()-item.at<settings.repeatMs){item.skipped++;return;}if(item)summarize(item);
   if(repeats.size>=256){const [oldKey,old]=repeats.entries().next().value;summarize(old);repeats.delete(oldKey);}
   repeats.set(key,{level,text,at:now(),skipped:0});
  }output(level,text);
 }
 // Legacy producers keep working; explicit methods are available to new modules.
 function log(value){const text=String(value?.message??value);
  if(/^Player (joined|left):/.test(text))return emit(settings.playerEvents?'info':'debug',text);
  if(text.startsWith('Phone: ')&&text!=='Phone: connected to the shared hub.')return emit('warn',text,{dedupe:true});
  if(/^Add-ons: .*file\(s\) overridden|^Add-ons: partial conflict scan|^Add-on index (unchanged|updated)|^Official map/.test(text))return emit('debug',text);
  if(/^Add-on index rebuilt|^Add-ons:|DISABLED/.test(text))return emit('warn',text,{dedupe:true});
  if(/persistence:|Could not save/.test(text))return emit('error',text,{dedupe:true});
  if(/unavailable|unreachable|failed/i.test(text))return emit('warn',text,{dedupe:true});
  return emit('info',text,{dedupe:true});
 }
 for(const level of Object.keys(levels))log[level]=(value,options)=>emit(level,value,options);
 log.startup=value=>{
  const text=String(value);
  if(/DISABLED|^Add-ons: skipped missing entry|^Add-ons: .*duplicate archive|^Add-on index rebuilt/.test(text))log(text);
  else emit('debug',text);
 };
 log.begin=version=>emit('info','◆  HEAVYMP '+version+'  /  STARTING');
 log.stage=(label,text)=>emit('info','│  '+label.padEnd(10)+text);
 log.ready=(options,relay,{control=true,elapsedMs=0,scripts=[],scriptStatus=[],scriptsTruncated=false}={})=>{
  const stage=log.stage;
  const access=options.staffOnly?'Staff only':'Standard access';
  const zones=options.noCollisionZonesEnabled?countLabel(options.zoneCatalogue?.zones.length??0,'non-collision zone','non-collision zones'):'Zones disabled';
  const sectors=options.sectorScheduling===false?'Sectors disabled':'Sectors '+(options.cellSize??250)+' m';
  const missions='Local missions';
  const traffic=options.trafficEnabled?'AI traffic '+(options.trafficLimit??8)+' vehicles/group at '+(options.trafficHz??10)+' Hz':'AI traffic disabled';
  stage('INSTANCE',options.serverId+'  ·  ETS2 '+GAME_VERSION);
  stage('NETWORK',[countLabel(relay.maxPlayers,'slot'),relay.tickHz+' Hz',access].join('  ·  '));
  stage('WORLD',['Collisions '+(options.collisions?'enabled':'disabled'),zones,sectors].join('  ·  '));
  const mapModule=options.content?.manifest.module;
  if(mapModule&&mapModule!=='europe')stage('MAP','Standalone module  ·  '+mapModule+'.mbd');
  stage('SERVICES',missions+'  ·  '+traffic);

  const files=options.content?.manifest.files??[];
  const report=options.addonsReport;
  const archives=new Map(report?.archives?.map(item=>[item.publishedName,item]));
  const disabled=report?.disabled??[];
  stage('ADDONS',countLabel(files.length,'archive published','archives published')
   +(disabled.length?'  ·  '+countLabel(disabled.length,'archive disabled','archives disabled'):'')
   +(report?.conflictCount?'  ·  '+countLabel(report.conflictCount,'file overridden','files overridden'):''));
  for(const [index,file] of files.entries()){
   const archive=archives.get(file.name);
   const details=[archive?.name??file.name,archiveSize(file.size)];
   if(archive){
    details.push(archiveFormats[archive.format]??archive.format);
    details.push(archive.complete?countLabel(archive.entries,'entry indexed','entries indexed'):'Internal index not inspected');
   }
   stage('ADDON',String(index+1).padStart(2,'0')+'  '+details.join('  ·  '));
  }
  for(const name of disabled)emit('debug','Add-on disabled: '+name);

  const states=new Map(scriptStatus.map(item=>[item.id,item.state]));
  const active=scriptStatus.filter(item=>item.state==='running').length;
  stage('SCRIPTS',countLabel(active,'active module','active modules')+' / '+countLabel(scripts.length,'module detected','modules detected'));
  for(const script of scripts){
   const state=script.error?'INVALID MANIFEST':script.enabled?(scriptStates[states.get(script.id)]??'PENDING'):'DISABLED';
   const name=script.name===script.id?script.id:script.name+' ['+script.id+']';
   stage('SCRIPT',state+'  ·  '+name+(script.version?' v'+script.version:'')+(script.service?'  ·  Server module':''));
  }
  if(scriptsTruncated)emit('warn','Scripts: directory scan limit reached. See the Scripts page.');
  if(control)stage('CONSOLE','npm run console -- help');
  emit('info','└─ READY  ·  '+decimal(elapsedMs/1000)+' s');
 };
 log.flush=flush;
 log.close=()=>{if(closed)return;clearInterval(timer);for(const item of repeats.values())summarize(item);repeats.clear();closed=true;};
 if(timers){timer=setInterval(flush,settings.repeatMs);timer.unref?.();}
 return log;
}
