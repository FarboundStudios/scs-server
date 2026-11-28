import {SectorScheduler} from './sectors.mjs';
import {createTrafficService} from './traffic-service.mjs';
import {createCollisionZones} from './no-collision-zones.mjs';
import {createDispatcher} from './dispatch.mjs';
import {staffOnlySetting} from './access.mjs';
import {NetworkMetrics} from './network-metrics.mjs';
import {serveMapContent} from './content.mjs';
import net from 'node:net';
import http from 'node:http';
import {WebSocket,WebSocketServer,createWebSocketStream} from 'ws';
import {randomUUID} from 'node:crypto';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import metadata from '../../package.json' with {type:'json'};
import {collisionSetting} from '../shared/collisions.mjs';
import {createWorldTimeline} from './world.mjs';
import {decodeCompact} from '../shared/compact.mjs';
import {PROTOCOL,GAME_VERSION,isLoopback,port,cleanName,validState,validTruck,send,sendSerialized,readLines} from '../shared/protocol.mjs';
import {acceptAppearancePart,appearanceHash,appearanceChunks,trailerForPeer} from '../shared/appearance.mjs';
import {MAX_NEARBY_PLAYERS,MAX_SERVER_PLAYERS} from '../shared/limits.mjs';
import {canonicalRoom,WEBSOCKET_PATH} from '../shared/branding.mjs';
import {validServers,DEFAULT_SERVERS} from './registry.mjs';
import {trailerSegments} from '../shared/trailer-chain.mjs';
import {createServerMessages} from './messages.mjs';
import {createModulesRuntime,readModules} from './modules.mjs';
import {createVtc,identityHash} from './vtc.mjs';
import {SpatialIndex} from './spatial.mjs';
import {Replicator,updateEncodedState} from './replication.mjs';
import {validRules} from './manager/moderation.mjs';
import {createCommands} from './commands.mjs';
import {canUseStaffVehicles,isStaffVehicle,staffVehicleState} from './staff-vehicles.mjs';
export const SERVER_VERSION=metadata.version;
export const SERVER_CAPABILITIES={missions:1,nearbyPlayerInfo:1,phone:1,chat:1,chatChannels:1,vtc:1,interestManagement:1,deltaSnapshots:1,networkMetrics:1,configurationChunks:1,inGameVehicles:true,collisions:false,traffic:false,vehicleConfiguration:1,trailerConfiguration:1,trailerCargoConfiguration:1,trailerChainConfiguration:1,worldSynchronization:1,hornSynchronization:1,mapContent:1};
const integer=(n,min,max,label)=>{if(!Number.isInteger(n)||n<min||n>max)throw Error('Invalid '+label+' ('+min+' to '+max+').');return n;};
const bundle=(appearance,trailer=false)=>({appearance,revision:appearanceHash(appearance),parts:appearanceChunks(appearance,trailer)});
function trailerViews(appearance){const base=trailerForPeer(appearance,false),single=a=>a.children?{plate:a.plate,accessories:a.accessories}:a,cache=new Map();return [appearance,single(appearance),base,single(base)].map(a=>{const revision=appearanceHash(a);if(!cache.has(revision))cache.set(revision,bundle(a,true));return cache.get(revision);});}
const trailerView=(owner,viewer)=>owner.trailerViews?.[viewer.supportsCargo?(viewer.supportsChain?0:1):(viewer.supportsChain?2:3)];
// These coaches report active truck horn bits even when no horn is pressed.
const coachModels=new Set(['vehicle.man.lions_24','vehicle.scania.touring_23','vehicle.volvo.9700_23']);
export async function createRelay(options={}){
 const capabilities={...SERVER_CAPABILITIES,collisions:collisionSetting(options.collisions),traffic:options.trafficEnabled===true?6:false};
 const content=options.content??null;
 const collisionZones=createCollisionZones({enabled:options.noCollisionZonesEnabled??false,catalogue:options.zoneCatalogue,stateTtl:options.stateTtl??1500});capabilities.noCollisionZones=collisionZones.enabled?1:0;
 const host=options.host??'0.0.0.0',listenPort=port(options.port,4443,true),room=canonicalRoom(options.room);
 const maxPlayers=integer(options.maxPlayers??5000,1,MAX_SERVER_PLAYERS,'MAX_PLAYERS'),nearbyLimit=integer(options.nearbyLimit??32,1,MAX_NEARBY_PLAYERS,'MAX_NEARBY_PLAYERS'),radius=integer(options.radius??1000,200,3000,'SYNC_RADIUS'),tickHz=integer(options.tickHz??20,10,1000,'TICK_HZ');
 const cellSize=integer(options.cellSize??250,50,4000,'GRID_CELL_SIZE'),interestMs=integer(options.interestMs??200,50,1000,'INTEREST_INTERVAL_MS'),candidateBudget=integer(options.candidateBudget??512,64,4096,'INTEREST_CANDIDATE_BUDGET');
 const chatRadius=integer(options.chatRadius??500,50,2000,'LOCAL_CHAT_RADIUS'),globalChatRate=integer(options.globalChatRate??6,1,20,'GLOBAL_CHAT_RATE');
 const stateTtl=options.stateTtl??1500,idleMs=options.idleMs??10000,maxConfigBytes=integer(options.maxConfigBytes??512*1024*1024,1048576,2147483648,'MAX_CONFIG_BYTES');
 if(!/^[A-Za-z0-9_-]{1,32}$/.test(room))throw Error('Invalid room name');if(options.plaintext&&!isLoopback(host))throw Error('Plaintext mode is limited to loopback addresses');
 const sessions=new Map(),names=new Map(),identities=new Map(),sockets=new Set(),index=new SpatialIndex(cellSize),log=options.log??console.log;
 let managerRules=validRules({schema:1,rules:options.managerRules??[]});
 const localRule=(identity,kind)=>identity&&managerRules.find(r=>r.identity===identity&&r.kind===kind&&r.until>Date.now());
 const localStaff=new Set(options.localStaff??[]);
 const staffOnly=staffOnlySetting(options.staffOnly);
 if(staffOnly&&!localStaff.size)throw Error('Staff-only mode requires a local staff list.');
 const localPermissions={can:s=>s.staff===true,priority:s=>s.staff===true?1:0};
 function kickSession(s,code,details={}){send(s.socket,{type:'error',code,...details});s.socket.end();setTimeout(()=>s.socket.destroy(),1500).unref?.();}
 const worldTimeline=createWorldTimeline(options.world),vtc=createVtc({sessions,initial:options.vtcs,persist:options.persistVtcs,log,now:options.now});
 const modules=options.modules??createModulesRuntime(await readModules(null),log);
 const messages=createServerMessages({sessions,onMessage:options.onChat,stateTtl});
 const chatContext={sessions,modules,messages,sendSerialized,world:worldTimeline,persistWorld:options.persistWorld,index,vtc,
  localRadius:chatRadius,globalRate:globalChatRate,commands:helpers=>createCommands({sessions,moderation:localPermissions,kick:kickSession,tell:helpers.tell,announce:helpers.announce,depots:options.depots})};
 const classicChat=await modules.activateService('classic-chat',entry=>entry.create(chatContext));
 const phone=await modules.activateService('phone',async entry=>{
  const fallbackChat=classicChat?null:entry.createChat(chatContext);
  const network=await entry.create({options,sessions,send,WebSocket,log});
  return {network,fallbackChat};
 });
 const phones=phone?.network;
 const chat=classicChat??phone?.fallbackChat;
 const phoneEnabled=Boolean(phones);
 capabilities.phone=Number(phoneEnabled);
 capabilities.chat=capabilities.chatChannels=Number(Boolean(chat));
 const networkMetrics=new NetworkMetrics();
 const dispatcher=createDispatcher({database:options.dispatchDatabase,sessions});
 modules.setMissionCreator?.((session, spec) => {
  if (!session.supportsMissions) throw Error('Update your HeavyMP client to use Missions.');
  if (!['public', 'private'].includes(spec?.visibility)) throw Error('Choose public or private mission visibility.');
  return dispatcher.request(session, 'create', {spec, requestId: randomUUID()});
 });
 const metrics={incomingMessages:0,acceptedStates:0,throttledStates:0,sequenceGaps:0,probeTimeouts:0,statePackets:0,stateBytes:0,syncOutBytes:0,skippedTicks:0,slowClients:0,lastTickMs:0,maxTickMs:0,assetBytes:0,effectiveNearbyLimit:nearbyLimit,effectiveTickHz:tickHz,assemblyBytes:0};
 let assemblyBytes=0,configTokens=16*1024*1024,configRefill=performance.now(),nextTickAt=0,assetBytes=0,closing=false,ticking=false,lastAdapt=0,stableTicks=0,joinTokens=200,joinAt=performance.now(),publicCache={at:0,players:[]};
 const histogram=monitorEventLoopDelay({resolution:20});histogram.enable();
 const write=(socket,line)=>{const queued=Math.max(socket.writableLength??0,socket.transportBuffered??0);if(queued>262144){socket.destroy();return false;}if(queued>65536)return false;const okay=sendSerialized(socket,line);if(okay)metrics.syncOutBytes+=Buffer.byteLength(line)+1;return okay;};
 const replicator=new Replicator({sessions,index,radius,limit:nearbyLimit,stateTtl,interestMs,candidateBudget,world:worldTimeline,sendRaw:write,metrics,collisionZones});
 replicator.effectiveHz=tickHz;
 const sectorScheduler=options.sectorScheduling===false?null:new SectorScheduler({index,hz:tickHz,limit:nearbyLimit,budgetMs:options.sectorWorkBudgetMs??4});
 const trafficService=createTrafficService({enabled:options.trafficEnabled===true,sessions,send:(socket,msg)=>write(socket,JSON.stringify(msg)),sendState:write,limit:options.trafficLimit??8,radius:options.trafficRadius??750,hz:options.trafficHz??10,roads:options.trafficRoads,graphError:options.trafficGraphError,maxActors:options.trafficMaxActors??128,sourceGraceMs:options.trafficSourceGraceMs??750,sourceTimeoutMs:options.trafficSourceTimeoutMs??3000,sourceWarmupMs:options.trafficSourceWarmupMs??15000,cellSize});
 const servers=validServers(options.servers??(options.serverId?[{...DEFAULT_SERVERS[0],id:options.serverId}]:DEFAULT_SERVERS)),serverId=options.serverId??servers[0].id;if(!servers.some(s=>s.id===serverId))throw Error('Server ID missing from the local registry.');
 function publicPlayers(){const time=performance.now();if(time-publicCache.at<Math.min(1000,stateTtl*.5))return publicCache.players;const players=[];for(const s of sessions.values()){const state=s.lastState&&time-s.stateAt<=stateTtl?s.lastState:null;players.push({id:s.steamId??s.id,name:s.name,inGame:!!(state&&!state.paused),paused:state?.paused??null,position:state?{x:state.x,y:state.y,z:state.z,heading:state.heading}:null,truck:state?.truck?{brand:state.truck.identity.brand,model:state.truck.identity.model}:null,trailerCount:trailerSegments(state).length});}publicCache={at:time,players};return players;}
 function cleanup(s){sectorScheduler?.forget(s.id);trafficService.forget(s.id);collisionZones.forget(s.id);phones?.leave(s);modules?.playerEvent('onLeave',s);replicator.forget(s);sessions.delete(s.id);names.delete(s.name.toLowerCase());if(s.identityHash)identities.delete(s.identityHash);assemblyBytes-=(s.assembly?.bytes??0)+(s.trailerAssembly?.bytes??0);metrics.assemblyBytes=assemblyBytes;assetBytes-=s.appearanceBytes+s.trailerBytes;metrics.assetBytes=assetBytes;publicCache.at=-Infinity;log('Player left: '+s.name);}
 const accept=socket=>{
  socket.setNoDelay?.(true);socket.setKeepAlive?.(true,5000);socket.setTimeout?.(idleMs,()=>socket.destroy());let session=null,rejected=false,rateStart=performance.now(),count=0,ingress=0;
  const joinTimer=setTimeout(()=>socket.destroy(),5000);socket.once('close',()=>{clearTimeout(joinTimer);if(session)cleanup(session);});
  const fail=(code,details={})=>{rejected=true;send(socket,{type:'error',code,...details});socket.end();};
  readLines(socket,msg=>{
   if(rejected)return;const now=performance.now();metrics.incomingMessages++;if(now-rateStart>=1000){rateStart=now;count=0;ingress=0;}if(++count>200){socket.destroy();return;}
   if(!session){
    if(msg.type!=='join'||msg.protocol!==PROTOCOL)return fail('protocol');joinTokens=Math.min(200,joinTokens+(now-joinAt)/10);joinAt=now;if(joinTokens<1)return fail('server_busy');joinTokens--;if(canonicalRoom(msg.room)!==room)return fail('access_denied');if(msg.gameVersion!==GAME_VERSION)return fail('game_version');if((msg.mapRevision??null)!==(content?.revision??null))return fail('map_mismatch');
    if(msg.optionalModsActive===true){
     if(options.allowOptionalMods!==true)return fail('optional_mods_disabled');
     if(options.optionalOrder&&!options.optionalOrder.slots.length)return fail('optional_mods_disabled');
     if((options.optionalOrder||msg.optionalOrderRevision!==undefined)&&msg.optionalOrderRevision!==options.optionalOrder?.revision)return fail('optional_order_changed');
    }
    const expectedMapModule=content?.manifest.module??'europe';
    if((msg.mapModule??'europe')!==expectedMapModule)return fail('map_module_mismatch');
    const name=cleanName(msg.name),identity=identityHash(msg.identity);
    if(!name)return fail('name');
    if(sessions.size>=maxPlayers)return fail('room_full');
    const staff=localStaff.has(identity),ban=localRule(identity,'ban');
    if(staffOnly&&!staff)return fail('staff_only');
    if(ban)return fail('banned',{scope:'game',reason:ban.reason,until:new Date(ban.until).toISOString()});
    if(names.has(name.toLowerCase()))return fail('name_taken');if(identity&&identities.has(identity))return fail('identity_in_use');
    if(collisionZones.enabled&&msg.capabilities?.noCollisionZones!==1)return fail('update_required');
    if(options.trafficEnabled===true&&msg.capabilities?.traffic!==6)return fail('update_required');
    session={id:randomUUID(),name,steamId:null,staff,supportsTeleport:msg.capabilities?.teleport===1,identityHash:identity,socket,lastState:null,stateAt:0,seq:-1,lastSeen:now,appearance:null,appearanceBytes:0,revision:null,assembly:null,configAt:-Infinity,configStartedAt:-Infinity,pendingConfigs:new Map(),configSentAt:0,trailer:null,trailerBytes:0,trailerRevision:null,trailerAssembly:null,trailerConfigAt:-Infinity,trailerStartedAt:-Infinity,pendingTrailers:new Map(),trailerSentAt:0,supportsNetworkMetrics:msg.capabilities?.networkMetrics===1,supportsDelta:msg.capabilities?.deltaSnapshots===1,supportsChunks:msg.capabilities?.configurationChunks===1,supportsMissions:msg.capabilities?.missions===1,supportsPhone:msg.capabilities?.phone===1,supportsPhoneTestCall:msg.capabilities?.phoneTestCall===1,supportsChat:msg.capabilities?.chat===1,supportsChannels:msg.capabilities?.chatChannels===1,supportsCargo:msg.capabilities?.trailerCargoConfiguration===1,supportsChain:msg.capabilities?.trailerChainConfiguration===1,supportsWorld:msg.capabilities?.worldSynchronization===1,supportsTrailer:msg.capabilities?.trailerConfiguration===1,supportsAppearance:msg.capabilities?.vehicleConfiguration===1};
    session.managerConnectedAt=Date.now();session.supportsTraffic=msg.capabilities?.traffic===6;
    session.managerMutedUntil=localRule(identity,'mute')?.until??0;
    replicator.initialize(session);sessions.set(session.id,session);sectorScheduler?.register(session,now);names.set(name.toLowerCase(),session.id);if(identity)identities.set(identity,session.id);publicCache.at=-Infinity;clearTimeout(joinTimer);log('Player joined: '+name);
    send(socket,{type:'welcome',mapRevision:content?.revision??null,...(options.modules?{modules:{schema:1,phone:phoneEnabled,classicChat:Boolean(classicChat)}}:{}),protocol:PROTOCOL,id:session.id,steamId:session.steamId,tickHz,gameVersion:GAME_VERSION,serverVersion:SERVER_VERSION,capabilities,limits:{maxPlayers,nearbyPlayers:nearbyLimit,syncRadius:radius,localChatRadius:chatRadius}});chat?.join(session);modules?.playerEvent('onJoin',session);try{Promise.resolve(phones?.join(session)).catch(error=>{log('Phone unavailable : '+error.message);send(socket,{type:'phone_state',state:{available:false}});});}catch(error){log("Phone unavailable : "+error.message);send(socket,{type:"phone_state",state:{available:false}});}    return;
   }
   session.lastSeen=now;if(trafficService.handle(session,msg))return;if(msg.type==='network_probe_ack'){if(session.probeAt!==undefined&&msg.token===session.probeToken){session.rttMs=now-session.probeAt;session.probeAt=undefined;}return;}if(msg.type==='ping'){send(socket,{type:'pong',echo:msg.echo});return;}if(dispatcher.handle(session,msg)||phones?.handle(session,msg)||(chat??messages).handle(session,msg))return;
   if((!chat&&msg.type==='chat')||(!phones&&msg.type==='phone_request'))return;
   if(msg.type==='vehicle_config_ack'||msg.type==='trailer_config_ack'){const trailer=msg.type==='trailer_config_ack',pending=trailer?session.pendingTrailers:session.pendingConfigs,acked=trailer?session.ackedTrailers:session.ackedConfigs;if(typeof msg.id==='string'&&pending.get(msg.id)===msg.revision){pending.delete(msg.id);acked.set(msg.id,msg.revision);}return;}
   if(msg.type==='vehicle_config_part'||msg.type==='trailer_config_part'){
    const trailer=msg.type==='trailer_config_part';if(trailer?!session.supportsTrailer:!session.supportsAppearance)return fail('configuration_unsupported');
    const blocked=trailer?'trailerBlockedRevision':'carBlockedRevision',until=trailer?'trailerBlockedUntil':'carBlockedUntil',assembly=trailer?'trailerAssembly':'assembly';
    if(msg.index===0&&now>=(session[until]??0))session[blocked]=null;if(session[blocked]===msg.revision||now<(session[until]??0))return;
    const started=trailer?'trailerStartedAt':'configStartedAt';if(msg.index===0){if(now-session[started]<1000)return fail('configuration_rate');session[started]=now;}
    const oldBytes=session[assembly]?.bytes??0,partBytes=typeof msg.data==='string'?Math.min(4000,msg.data.length)*.75:0;
    configTokens=Math.min(16*1024*1024,configTokens+(now-configRefill)*8*1024*1024/1000);configRefill=now;
    if(configTokens<partBytes||assemblyBytes+partBytes>32*1024*1024){assemblyBytes-=oldBytes;metrics.assemblyBytes=assemblyBytes;session[assembly]=null;session[blocked]=msg.revision;session[until]=now+3000+Math.random()*3000;send(socket,{type:'configuration_retry',trailer,afterMs:Math.ceil(session[until]-now)});return;}configTokens-=partBytes;
    const result=acceptAppearancePart(session[assembly],msg,now,trailer);if(!result){assemblyBytes-=oldBytes;metrics.assemblyBytes=assemblyBytes;session[assembly]=null;return fail('configuration_invalid');}session[assembly]=result.pending;assemblyBytes+=(result.pending?.bytes??0)-oldBytes;metrics.assemblyBytes=assemblyBytes;
    if(result.appearance){
     if(!trailer&&isStaffVehicle(result.appearance)&&!canUseStaffVehicles(session)){
      
      return fail('staff_vehicle_required');
     }
     const property=trailer?'trailerBytes':'appearanceBytes',bytes=Buffer.byteLength(JSON.stringify(result.appearance));if(assetBytes-session[property]+bytes>maxConfigBytes){if(now-(session.assetWarnAt??-Infinity)>30000){session.assetWarnAt=now;messages.tell(session,'Vehicle customisation is temporarily unavailable due to server load.');}send(socket,{type:'configuration_retry',trailer,afterMs:8000});return;}assetBytes+=bytes-session[property];session[property]=bytes;metrics.assetBytes=assetBytes;
     if(trailer){session.trailer=result.appearance;session.trailerRevision=result.revision;session.trailerConfigAt=now;session.trailerViews=trailerViews(result.appearance);}else{
      session.appearance=result.appearance;session.revision=result.revision;session.configAt=now;session.configuration=bundle(result.appearance);
      session.coachVehicle=result.appearance.accessories.some(item=>item.kind===1&&/^\/def\/vehicle\/bus\/[^/]+\/data\.sii$/.test(item.path));
     }
     for(const id of session.watchers){const peer=sessions.get(id);if(!peer)continue;if(trailer&&peer.supportsTrailer)peer.pendingTrailers.set(session.id,trailerView(session,peer).revision);else if(!trailer&&peer.supportsAppearance)peer.pendingConfigs.set(session.id,session.revision);}
    }return;
   }
   if(!['state','state_compact'].includes(msg.type)||!Number.isSafeInteger(msg.seq)||msg.seq<=session.seq)return fail('state_sequence');if(session.seq>=0)metrics.sequenceGaps+=Math.max(0,msg.seq-session.seq-1);session.seq=msg.seq;if(now-session.stateAt<35&&session.lastState&&msg.meta===undefined){metrics.throttledStates++;return;}
   const state=msg.type==='state_compact'?decodeCompact(msg.state,session.lastState):validState(msg.state);if(!state)return fail('state_invalid');if(msg.type==='state_compact'&&msg.meta!==undefined){if(!msg.meta||typeof msg.meta!=='object'||Array.isArray(msg.meta))return fail('state_invalid');if(state.truck){const truck=validTruck({...state.truck,identity:msg.meta.identity??undefined,audio:msg.meta.audio??undefined});if(!truck)return fail('state_invalid');state.truck=truck;}}const old=session.lastState,distance=old?Math.hypot(state.x-old.x,state.z-old.z):0,teleport=old&&distance>Math.max(50,Math.min(110,Math.max(Math.abs(state.speed),Math.abs(old.speed)))*(now-session.stateAt)/1000*2+10);
   if(!old||teleport)session.interestAt=-Infinity;
   if(staffVehicleState(state)&&!canUseStaffVehicles(session)){
    
    return fail('staff_vehicle_required');
   }
   if(state.truck?.horn&&(session.coachVehicle||coachModels.has(state.truck.identity.model)))state.truck.horn={normal:false,air:false};
   session.lastState=state;session.stateAt=now;
   if(index.update(session))session.interestAt=-Infinity;sectorScheduler?.update(session,now);
   if(teleport)for(const id of session.watchers){const viewer=sessions.get(id);if(viewer)viewer.interestAt=-Infinity;}
   metrics.acceptedStates++;updateEncodedState(session);
  },65536);
  socket.on('data',chunk=>{ingress+=chunk.length;if(ingress>524288)socket.destroy();});
 };
 const healthSnapshot=()=>({service:'HeavyMP',map:content?{id:content.manifest.id,version:content.manifest.version,revision:content.revision,module:content.manifest.module}:null,version:SERVER_VERSION,minLauncherVersion:null,authentication:false,staffOnly,missions:{mode:'local',registrySource:'file',reason:null},protocol:PROTOCOL,transport:'websocket',gameVersion:GAME_VERSION,capabilities,traffic:trafficService.diagnostics(),sectors:sectorScheduler?.diagnostics()??{enabled:false},noCollisionZones:collisionZones.diagnostics(),players:sessions.size,maxPlayers,tickHz,nearbyLimit,syncRadius:radius,gridCellSize:cellSize,interestIntervalMs:interestMs,candidateBudget,metrics:{...metrics,...networkMetrics.sample(metrics,sessions),eventLoopP95Ms:Math.round(histogram.percentile(95)/1e4)/100}});
 const server=options.plaintext?net.createServer(accept):http.createServer((request,response)=>{
  response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');const url=new URL(request.url,'http://localhost');
  if(serveMapContent(content,request,response,url,options.optionalOrder))return;
  if(request.method==='GET'&&(url.pathname==='/servers'||url.pathname==='/players')){
   response.setHeader('Access-Control-Allow-Origin','*');response.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
   if(url.pathname==='/servers')response.end(JSON.stringify({servers:servers.map(s=>({...s,healthUrl:'https://'+s.host+':'+s.port+'/health',playersUrl:'https://'+s.host+':'+s.port+'/players',websocketUrl:'wss://'+s.host+':'+s.port+WEBSOCKET_PATH,online:s.id===serverId?true:null,staffOnly:s.id===serverId?staffOnly:null,playerCount:s.id===serverId?sessions.size:null,maxPlayers:s.id===serverId?maxPlayers:null}))}));
   else{const all=publicPlayers(),offset=Math.max(0,Math.min(10000,Number(url.searchParams.get('offset'))||0))|0,limit=Math.max(1,Math.min(500,Number(url.searchParams.get('limit'))||100))|0,players=all.slice(offset,offset+limit);response.end(JSON.stringify({serverId,count:all.length,offset,limit,returned:players.length,maxPlayers,players}));}return;
  }
  if(request.method==='GET'&&(url.pathname==='/'||url.pathname==='/health')){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(healthSnapshot()));}else{response.writeHead(404);response.end();}
 });
 let websocketServer;if(!options.plaintext){server.headersTimeout=10000;server.requestTimeout=15000;websocketServer=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});server.on('upgrade',(request,socket,head)=>{if(request.url!==WEBSOCKET_PATH){socket.destroy();return;}websocketServer.handleUpgrade(request,socket,head,ws=>{const stream=createWebSocketStream(ws);Object.defineProperty(stream,'transportBuffered',{get:()=>ws.bufferedAmount});stream.on('error',()=>{});accept(stream);});});}
 server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));if(sockets.size>maxPlayers*2+8)socket.destroy();});
 function pumpConfiguration(s,now){
  for(let n=0;n<2;n++){s.transferKind=!s.transferKind;const trailer=s.transferKind,pending=trailer?s.pendingTrailers:s.pendingConfigs,key=trailer?'trailerTransfer':'carTransfer';let transfer=s[key];
   if(transfer&&(!pending.has(transfer.id)||pending.get(transfer.id)!==transfer.revision||!s.nearbyIds.has(transfer.id)))transfer=s[key]=null;
   if(transfer&&transfer.index>=transfer.parts.length){if(now-transfer.at<1000)continue;transfer=s[key]=null;}
   if(!transfer){for(const [id,revision] of pending){const owner=sessions.get(id);if(!owner||!s.nearbyIds.has(id)){pending.delete(id);continue;}const view=trailer?trailerView(owner,s):owner.configuration;if(!view||view.revision!==revision){pending.delete(id);continue;}transfer=s[key]={id,revision,parts:view.parts,appearance:view.appearance,index:0,at:now};break;}}
   if(!transfer)continue;
   if(s.supportsChunks){const part=transfer.parts[transfer.index],line=JSON.stringify({...part,id:transfer.id,type:trailer?'trailer_configuration_part':'vehicle_configuration_part'});if(write(s.socket,line)){transfer.index++;transfer.at=now;}}
   else{if(now-(trailer?s.trailerSentAt:s.configSentAt)<200)continue;if(write(s.socket,JSON.stringify({type:trailer?'trailer_configuration':'vehicle_configuration',id:transfer.id,revision:transfer.revision,appearance:transfer.appearance}))){if(trailer)s.trailerSentAt=now;else s.configSentAt=now;transfer.index=transfer.parts.length;transfer.at=now;}}
  }
 }
 const tick=()=>{if(closing||performance.now()<nextTickAt)return;if(ticking){metrics.skippedTicks++;return;}ticking=true;const started=performance.now(),jobs=sectorScheduler?.plan(started),list=jobs?jobs.map(j=>j.entry.s):[...sessions.values()];let at=0;metrics.slowClients=0;trafficService.tick(jobs?[]:null);
  const batch=()=>{const sliceStart=performance.now();while(at<list.length&&performance.now()-sliceStart<6){const job=jobs?.[at],s=list[at++];if(s.socket.destroyed)continue;const now=performance.now(),workAt=now;if(now-s.lastSeen>idleMs){s.socket.destroy();continue;}const queued=Math.max(s.socket.writableLength??0,s.socket.transportBuffered??0);if(queued>65536){metrics.slowClients++;s.blockedAt??=now;if(queued>262144||now-s.blockedAt>3000)s.socket.destroy();continue;}s.blockedAt=null;
    if(s.supportsNetworkMetrics&&now-(s.probeSentAt??-Infinity)>=5000){
     if(s.probeAt!==undefined)metrics.probeTimeouts++;
     const token=(s.probeToken??0)+1;
     if(write(s.socket,JSON.stringify({type:'network_probe',token}))){s.probeToken=token;s.probeAt=now;s.probeSentAt=now;}
    }
    if(now-(s.staffPolicyAt??-Infinity)>=1000){s.staffPolicyAt=now;const allowed=canUseStaffVehicles(s);if(staffOnly&&!allowed){kickSession(s,'staff_only');continue;}send(s.socket,{type:'vehicle_access',staff:allowed});if(!allowed&&isStaffVehicle(s.appearance)){kickSession(s,'staff_vehicle_required');continue;}}
    for(const key of ['assembly','trailerAssembly'])if(s[key]&&now-s[key].at>5000){assemblyBytes-=s[key].bytes;s[key]=null;metrics.assemblyBytes=assemblyBytes;}if(now-(s.vtcNotifyAt??-Infinity)>=1000){s.vtcNotifyAt=now;vtc.notify(s);}replicator.send(s,now,job?.policy);pumpConfiguration(s,now);if(job){trafficService.tick([s]);sectorScheduler.commit(job,now,performance.now()-workAt);}}
   if(at<list.length&&!closing){setImmediate(batch);return;}metrics.lastTickMs=performance.now()-started;metrics.maxTickMs=Math.max(metrics.maxTickMs,metrics.lastTickMs);
   const finished=performance.now(),budget=1000/replicator.effectiveHz;
   if(sectorScheduler){sectorScheduler.finish(finished,metrics.lastTickMs);const d=sectorScheduler.summary();metrics.effectiveTickHz=d.minHz;metrics.effectiveNearbyLimit=d.minNearbyLimit;nextTickAt=started+1000/tickHz;networkMetrics.sample(metrics,sessions,finished);ticking=false;return;}
   if(metrics.lastTickMs>budget*.8){stableTicks=0;if(finished-lastAdapt>1000){if(replicator.effectiveHz>10)replicator.effectiveHz=Math.max(10,replicator.effectiveHz-5);else if(replicator.limit>Math.min(8,nearbyLimit))replicator.limit=Math.max(Math.min(8,nearbyLimit),Math.floor(replicator.limit*.75));lastAdapt=finished;}}
   else if(metrics.lastTickMs<budget*.4){if(++stableTicks>40&&finished-lastAdapt>3000){if(replicator.limit<nearbyLimit)replicator.limit++;else if(replicator.effectiveHz<tickHz)replicator.effectiveHz=Math.min(tickHz,replicator.effectiveHz+5);lastAdapt=finished;stableTicks=0;}}else stableTicks=0;
   nextTickAt=started+1000/replicator.effectiveHz;metrics.effectiveTickHz=replicator.effectiveHz;
   metrics.effectiveNearbyLimit=replicator.limit;networkMetrics.sample(metrics,sessions,finished);ticking=false;
  };batch();
 };
 const timer=setInterval(tick,1000/tickHz);
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(listenPort,host,resolve);});}catch(error){clearInterval(timer);histogram.disable();phones?.close();await chat?.close();await vtc.close();await dispatcher.close();throw error;}
 return {moduleStatus:()=>modules?.status()??[],managerApplyRules(rules){managerRules=validRules({schema:1,rules});for(const s of sessions.values()){s.managerMutedUntil=localRule(s.identityHash,'mute')?.until??0;const ban=localRule(s.identityHash,'ban');if(ban)kickSession(s,'banned',{scope:'game',until:new Date(ban.until).toISOString(),reason:ban.reason});}return {ok:true};},managerModerate({identity,action,reason}){const s=sessions.get(identities.get(identity));if(!s)return {ok:false,error:'player_not_found'};if(action==='kick')kickSession(s,'kicked',{reason});else if(action==='warn')messages.tell(s,'Warning: '+reason);else return {ok:false,error:'invalid_action'};return {ok:true};},managerSnapshot({includePlayers=true}={}){const now=performance.now();return {health:healthSnapshot(),players:includePlayers?[...sessions.values()].map(s=>({id:s.id,steamId:s.steamId,identity:s.identityHash,name:s.name,pingMs:Number.isFinite(s.rttMs)?Math.round(s.rttMs):null,inGame:!!(s.lastState&&!s.lastState.paused&&now-s.stateAt<1500),position:s.lastState&&now-s.stateAt<1500?{x:s.lastState.x,y:s.lastState.y,z:s.lastState.z,heading:s.lastState.heading}:null,truck:s.lastState?.truck?.identity??null,trailerCount:trailerSegments(s.lastState).length,mutedUntil:s.managerMutedUntil??0,connectedAt:s.managerConnectedAt??null,ageMs:s.lastState?Math.round(now-s.stateAt):null})):[]};},managerKick(steamId,reason,playerId){const s=sessions.get(playerId);if(!s)return {ok:false,error:'player_not_found'};kickSession(s,'kicked',{reason});return {ok:true};},server,sessions,index,metrics,tickHz,maxPlayers,nearbyLimit,address:server.address(),missionsDiagnostics(target=''){const value=String(target).trim(),matches=[...sessions.values()].filter(s=>!value||s.identityHash===value||s.id===value||s.name.toLowerCase()===value.toLowerCase());if(matches.length!==1)return {ok:false,error:matches.length?'Multiple players match. Specify a player name, ID or fingerprint.':'Player is not connected.'};const diagnostic=dispatcher.diagnostics?.(matches[0]);return diagnostic?{ok:true,diagnostic}:{ok:false,error:'Local mission diagnostics are unavailable for this player.'};},fakeCall(target){return closing?{ok:false,error:'Server is shutting down.'}:phones?phones.fakeCall(target):{ok:false,error:'Phone module disabled.'};},announce(text){return closing?{ok:false,recipients:0}:messages.announce(text);},async close(){closing=true;clearInterval(timer);histogram.disable();await chat?.close();await vtc.close();phones?.close();await dispatcher.close();for(const socket of sockets)socket.destroy();if(websocketServer)for(const ws of websocketServer.clients)ws.terminate();await new Promise(resolve=>server.close(resolve));}};
}
