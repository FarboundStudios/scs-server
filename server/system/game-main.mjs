import { createRelay, SERVER_VERSION } from './server.mjs';
import { prepareServer } from './bootstrap.mjs';
import { createServerConsole } from './console.mjs';
import { createConsoleControl } from './console-control.mjs';
import { createServerLogger,cleanLog } from './logger.mjs';
import {loadManagerRules} from './manager/moderation.mjs';
import {join,resolve} from 'node:path';
import {access} from 'node:fs/promises';
import {readInstanceModules, createModulesRuntime} from './modules.mjs';

let log, modules;
try {
  log=createServerLogger({env:process.env});const started=performance.now();
  log.begin(SERVER_VERSION);
  try{await access(join(resolve(process.env.DATA_DIR??'./data'),'manager/backups/restore-pending.json'));throw Error('A data restore needs Manager recovery before starting the game.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const scriptConfig=await readInstanceModules(resolve(process.env.DATA_DIR ?? './data'),process.env);
  modules = createModulesRuntime(scriptConfig, log.warn);
  const options=await prepareServer(process.env,log.startup,{
    onAddonScan:()=>log.stage('ADDONS','Verifying archives…'),
    onAddonHash:name=>log.debug('Hashing archive: '+name),
  });
  const managed=process.env.HEAVYMP_MANAGER_WORKER==='1'&&typeof process.send==='function';
  let chatInFlight=0,chatDropped=0,chatReportAt=0;
  const onChat=managed?message=>{if(!process.connected)return;if(chatInFlight>=64){chatDropped++;return;}chatInFlight++;process.send({type:'manager-chat',message},()=>{chatInFlight--;});if(chatDropped&&Date.now()-chatReportAt>10000){log.warn('Console chat: '+chatDropped+' messages skipped during overload.');chatDropped=0;chatReportAt=Date.now();}}:null;
  const managerRules=managed?await loadManagerRules(join(resolve(process.env.DATA_DIR??'./data'),'manager/moderation.json')):[];
  if(scriptConfig.modules.some(script=>script.enabled&&!script.service))log.stage('SCRIPTS','Starting community scripts…');
  await modules.start();
  const relay = await createRelay({...options,modules,moduleEnvironment:process.env,managerRules,log,onChat,...(managed?{host:'127.0.0.1',port:0}:{})});
  const operator = createServerConsole(relay);
  let control;
  try{control=await createConsoleControl(relay);}
  catch(error){log.error('Panel commands unavailable: '+error.message);}
  log.ready(options,relay,{
    control:!!control,elapsedMs:performance.now()-started,
    scripts:scriptConfig.modules,scriptStatus:modules.status(),scriptsTruncated:scriptConfig.truncated,
  });
  let observationUntil=0,lastCpu=process.cpuUsage(),lastSample=performance.now();
  const sample=()=>{if(!managed)return;const now=performance.now(),cpu=process.cpuUsage(),data=relay.managerSnapshot({includePlayers:Date.now()<observationUntil});data.modules=relay.moduleStatus();data.process={rssMb:Math.round(process.memoryUsage().rss/1048576),heapMb:Math.round(process.memoryUsage().heapUsed/1048576),cpuPercent:Math.round((cpu.user-lastCpu.user+cpu.system-lastCpu.system)/1000/Math.max(1,now-lastSample)*1000)/10};lastCpu=cpu;lastSample=now;process.send?.({type:'manager-snapshot',data});};
  const sampling=managed?setInterval(()=>{if(Date.now()<observationUntil||performance.now()-lastSample>=5000)sample();},1000):null;sampling?.unref();
  if(managed){const selected=options.servers.find(s=>s.id===options.serverId);process.send({type:'manager-ready',port:relay.address.port,meta:{serverId:options.serverId,name:selected?.name??options.serverId,publicOrigin:'https://'+selected.host+(selected.port===443?'':':'+selected.port),addons:options.content?.manifest.files.map(f=>({name:f.name,size:f.size}))??[],addonsReport:options.content?.addonsReport?{conflictCount:options.content.addonsReport.conflictCount,complete:options.content.addonsReport.complete,duplicateArchives:options.content.addonsReport.duplicateArchives}:null}});sample();}
  let stopping=false;
  const shutdown = async () => {if(stopping)return;stopping=true;clearInterval(sampling);log.info('Stopping server…');try{operator.close();await control?.close();await relay.close();await modules.close();log.info('Server stopped.');log.close();process.exit(0);}catch(error){log.error('Incomplete shutdown: '+error.message);log.close();process.exit(1);}};
  if(managed){process.on('message',async message=>{if(message?.type==='manager-stop'){void shutdown();return;}if(message?.type==='manager-observe'){observationUntil=Date.now()+15000;if(performance.now()-lastSample>500)sample();return;}if(message?.type!=='manager-command'||typeof message.id!=='string')return;
    try{let result;const a=message.args??{};if(message.command==='annonce')result=relay.announce(a.message);else if(message.command==='fake-call')result=await relay.fakeCall(a.target??'');else if(message.command==='missions-debug')result=relay.missionsDiagnostics(a.target??'');else if(message.command==='kick')result=relay.managerKick(a.steamId,a.reason,a.playerId);else if(message.command==='moderate')result=relay.managerModerate(a);else if(message.command==='rules')result=relay.managerApplyRules(a.rules);else if(message.command==='help')result={ok:true,output:'announce <message> · fake-call [player] · missions-debug [player] · help'};else throw Error('unknown_command');process.send?.({type:'manager-reply',id:message.id,result});}catch{process.send?.({type:'manager-reply',id:message.id,error:'command_failed'});}
   });process.once('disconnect',shutdown);}
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
} catch (e) {await modules?.close();if(log){log.error('Startup failed: '+e.message);log.close();}else console.error('[Error] '+cleanLog(e));process.exitCode=1;}
