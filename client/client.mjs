import {createTrafficTransport} from './traffic.mjs';
import {zonePacket,validZonePolicy} from '../server/shared/no-collision-zones.mjs';
import {createDispatchTransport} from './dispatch-network.mjs';
import {createDispatchService} from './dispatch-service.mjs';
import {dispatchJob} from '../server/shared/dispatch.mjs';
import {createNativeDispatch} from './dispatch-native.mjs';
import {homedir} from 'node:os';
import {nearbyPlayersPacket,validPeerPing} from '../server/shared/nearby-players.mjs';
import net from 'node:net';
import WebSocket, { createWebSocketStream } from 'ws';
import dgram from 'node:dgram';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { audioPacket,mapPacket,trailerPacket,vehiclePacket } from './vehicles.mjs';
import { appearancePacket } from './appearance.mjs';
import { validAppearance,appearanceHash,appearanceChunks,trailerForPeer,acceptAppearancePart } from '../server/shared/appearance.mjs';
import {collisionPacket} from '../server/shared/collisions.mjs';
import {validWorld,worldPacket} from '../server/shared/world.mjs';
import { PROTOCOL, GAME_VERSION, isLoopback, port, cleanName, validState, send, readLines } from '../server/shared/protocol.mjs';
import { canonicalRoom, WEBSOCKET_PATH } from '../server/shared/branding.mjs';
import {appearanceSegments,segmentId} from '../server/shared/trailer-chain.mjs';
import {validChatMessage,chatForViewer,chatPacket,repairPacket} from '../server/shared/chat.mjs';
import {decodeCompact,encodeCompact,compactHasAnimation} from '../server/shared/compact.mjs';
import {MotionBuffer} from './smoothing.mjs';
import {playerIdentity} from './identity.mjs';
import {describeRefusal,FATAL_REFUSALS} from '../server/shared/refusals.mjs';
import {MAX_NEARBY_PLAYERS,MAX_SERVER_PLAYERS} from '../server/shared/limits.mjs';
import {validVtcCompany} from '../server/shared/vtc-profile.mjs';
import {join} from 'node:path';
import {createPhoneServices,parseNotify} from './phone-services.mjs';
import {createPhoneTransport} from './phone-network.mjs';

export async function createClient(config) {
  if (!cleanName(config.name) || typeof config.host !== 'string' || !config.host.length) throw new Error('Invalid name or host');
  if (config.plaintext && !isLoopback(config.host)) throw new Error('Le mode local sans TLS ne peut pas joindre un VPS');
  if (config.localWebsocket && !(isLoopback(config.host) || config.host === 'localhost')) throw new Error('Plain WebSocket is limited to localhost.');
  const serverPort = port(config.port, config.plaintext ? 4443 : 443);
  const telemetryPort = port(config.telemetryPort, 34061, true);
  const identity=await playerIdentity(config.identityDirectory,config.name);
  const events = new EventEmitter();
  const status = { name: config.name, collisions:false, connected: false, id: null, error: null, pingMs: null,
    telemetry: false, source: config.demo ? 'Simulation de test' : 'ETS2', players: [], renderer: null,
    gameVersion: GAME_VERSION, inGameVehicles: false };
  status.network={receivedSnapshots:0,receivedUpdates:0,rejectedPeerUpdates:0,sentStates:0,skippedUploads:0,snapshotSequenceGaps:0,pingTimeouts:0,transportPacketLossPercent:null};
  let rateAt=performance.now(),rateCounts={receivedSnapshots:0,receivedUpdates:0,sentStates:0},snapshotSequence=0,pingPending=false;
  const standaloneMap=Boolean(config.mapModule&&config.mapModule!=='europe');
  let mapReady=standaloneMap?config.mapReady===true:config.mapReady!==false;status.mapReady=mapReady;
  const worldReady = () => !standaloneMap || mapReady;
  let socket, stopped = false, welcomed = false, retryTimer, delay = 1000;
  let latest = null, telemetryAt = 0, seq = 0, lastSnapshot = 0, lastServer = 0, pingAt = 0;
  let vehicleSequence = 0,audioAt=0,sentStateMeta=null,lastUploadAt=-Infinity,uploadHz=20,staffPolicyAt=-Infinity;
  const remotePlayers=new Map(),motion=new MotionBuffer(),downAssemblies=new Map(),gameConfigurations=new Map();
  const uuid=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
  let localAppearance=null,sentAppearance=null,appearanceEnabled=false,appearanceAt=0,gameConfigAt=0;
  const configurations=new Map(),trailerConfigurations=new Map();
  let localTrailer=null,sentTrailer=null,trailerEnabled=false,cargoEnabled=false,trailerAt=0;
  let chainEnabled=false,chainGeneration=null,localSegments=[];
  status.chat=[];status.chatChannel='global';let pendingRepair=null,chatAt=0;
  let phoneEnabled=false, classicChatEnabled=false;
  const modulePolicy=Buffer.alloc(16);
  modulePolicy.write('HML1');
  modulePolicy.writeUInt32LE(1,4);
  const phoneNotifications=[];
  let latestJob={supported:false,active:false},unavailableCompanies=[];
  const dispatchNotify=n=>{phoneNotifications.push({...n,message:n.text});if(phoneNotifications.length>50)phoneNotifications.shift();};
  const dispatchTransport=createDispatchTransport({send:message=>send(socket,message),isConnected:()=>welcomed&&worldReady(),notify:dispatchNotify});
  const dispatchLocalData=()=>({connected:status.connected,telemetry:status.telemetry,speedKmh:latest?Math.abs(latest.speed)*3.6:null,vehicle:latest?.truck?.identity??null,job:latestJob,unavailableCompanies});
  const nativeDispatch=createNativeDispatch({send:packet=>{if(!config.vehiclePort)throw Error('The native game connection is unavailable.');udp.send(packet,port(config.vehiclePort,34063),'127.0.0.1');}});
  const dispatchService=createDispatchService({native:nativeDispatch,transport:dispatchTransport,home:config.ets2Home??join(homedir(),'Documents','Euro Truck Simulator 2'),directory:config.identityDirectory,scope:config.host+':'+serverPort,getData:dispatchLocalData,notify:dispatchNotify});
  const traffic=createTrafficTransport({getPosition:()=>worldReady()&&latest?[latest.x,latest.y,latest.z]:null,send:message=>welcomed&&worldReady()&&send(socket,message),native:packet=>{if(config.vehiclePort)try{udp.send(packet,port(config.vehiclePort,34063),'127.0.0.1',()=>{});}catch{}}});
  const phoneComms=createPhoneTransport({send:message=>send(socket,message),isConnected:()=>welcomed&&phoneEnabled});
  const trimChat=()=>{const counts=new Map();status.chat=status.chat.slice().reverse().filter(m=>{const channel=m.channel??(m.system?'system':'global'),n=(counts.get(channel)??0)+1;counts.set(channel,n);return n<=40;}).reverse();};
  const localChat=text=>{status.chat.push({id:0,time:Date.now(),name:'HeavyMP',text,system:true});trimChat();publish();};
  // Codes qui arrêtent les tentatives automatiques : ceux du protocole + les refus du module partagé (banni, expulsé, Steam non lié…).
  const fatalCodes = new Set(['access_denied', 'game_version', 'name', 'name_taken', 'protocol', 'room_full', 'identity_in_use', ...FATAL_REFUSALS]);
  let admissionRetries=config.retryPreviousAdmission===true?3:0;
  // Refus (du serveur de jeu ou du site au moment d'obtenir le ticket) : message clair, bannissement détaillé, arrêt si fatal.
  const refuse=msg=>{
    if(!welcomed&&admissionRetries>0&&['name_taken','identity_in_use'].includes(msg.code)){
      admissionRetries--;
      socket?.destroy();
      return;
    }
    status.error=describeRefusal(msg);
    status.ban=msg.code==='banned'?{scope:msg.scope??'game',until:msg.until??null,reason:msg.reason??null}:null;
    if(fatalCodes.has(msg.code))stopped=true;
    socket?.destroy();publish();
  };
  const publish = () => {
    status.traffic=traffic.diagnostics();
    const now=performance.now(),elapsed=now-rateAt;
    if(elapsed>=1000){for(const key of ['receivedSnapshots','receivedUpdates','sentStates']){status.network[key+'PerSecond']=Math.round((status.network[key]-rateCounts[key])*1000/elapsed*100)/100;rateCounts[key]=status.network[key];}rateAt=now;}
    status.network.synchronizedVehicles=status.players.filter(p=>p.state&&p.id!==status.id).length;
    status.network.smoothing={...motion.stats};
    events.emit('status',structuredClone(status));
  };
  const udp = dgram.createSocket('udp4');
  udp.on('error', error => { status.error = `TÃ©lÃ©mÃ©trie : ${error.code}`; publish(); });
  udp.on('message', (buffer, remote) => {
    if (remote.address !== '127.0.0.1' || buffer.length > 60000) return;
    let msg;
    try { msg = JSON.parse(buffer); } catch { return; }
    if (msg.protocol !== PROTOCOL || msg.gameId !== 'eut2') return;
    // Keep the renderer heartbeat for launcher startup, but ignore gameplay events on a different map.
    if (!worldReady() && msg.type !== 'telemetry') return;
    if(traffic.receive(msg)||nativeDispatch.receive(msg))return;
    if(msg.type==='dispatch_companies'){if(buffer.length<65536&&Array.isArray(msg.unavailable)&&msg.unavailable.length<=512&&msg.unavailable.every(id=>typeof id==='string'&&id.length<=100&&/^[a-z0-9_]+\.[a-z0-9_]+$/.test(id)))unavailableCompanies=msg.unavailable;return;}
    if(msg.type==='chat_channel'){if(['global','local','vtc'].includes(msg.channel))status.chatChannel=msg.channel;return;}
    if(msg.type==='chat'){
      if(typeof msg.text==='string'&&msg.text.startsWith('/notify ')){const n=parseNotify(msg.text);if(n){phoneNotifications.push(n);if(phoneNotifications.length>50)phoneNotifications.shift();}else localChat('Usage: /notify "Titre" message');return;}
      if(typeof msg.text!=='string'||msg.text.length>280||Buffer.byteLength(msg.text)>850||/[\u0000-\u001f\u007f]/.test(msg.text))return;
      if(!welcomed){localChat('Connect to the server first.');return;}
      if(!status.chatCompatible){localChat('Update the server to use chat.');return;}
      if(msg.channel&&msg.channel!=='global'&&!status.channelCompatible){localChat('Update the server to use the Nearby and VTC channels.');return;}
      send(socket,{type:'chat',text:msg.text,channel:['global','local','vtc'].includes(msg.channel)?msg.channel:'global'});return;
    }
    if(msg.type==='command_result'){
      if(pendingRepair?.id===msg.id&&typeof msg.ok==='boolean'){send(socket,{type:'repair_result',id:msg.id,ok:msg.ok,reason:typeof msg.reason==='string'?msg.reason.slice(0,160):''});pendingRepair=null;}return;
    }
    if(msg.type==='trailer_configuration'){
      const appearance=validAppearance(msg.appearance,true);if(!appearance)return;
      if(msg.segmentCount!==undefined){
        if(!Number.isInteger(msg.segmentCount)||msg.segmentCount<1||msg.segmentCount>10||!Number.isInteger(msg.segment)||msg.segment<0||msg.segment>=msg.segmentCount||!Number.isSafeInteger(msg.generation))return;
        if(chainGeneration!==msg.generation){chainGeneration=msg.generation;localSegments=Array(msg.segmentCount).fill(null);}
        if(localSegments.length!==msg.segmentCount)return;localSegments[msg.segment]=appearance;
        if(localSegments.some(x=>!x))return;
        localTrailer=validAppearance({...localSegments[0],...(localSegments.length>1?{children:localSegments.slice(1)}:{})},true);
        if(!localTrailer)return;status.trailerAppearance={available:true,segments:localSegments.length,accessories:localSegments.reduce((n,a)=>n+a.accessories.length,0),serverCompatible:trailerEnabled,chainServerCompatible:chainEnabled,cargoAvailable:localSegments.some(a=>a.accessories.some(x=>x.kind===7)),cargoServerCompatible:cargoEnabled};return;
      }
      localTrailer=appearance;status.trailerAppearance={available:true,accessories:appearance.accessories.length,serverCompatible:trailerEnabled,cargoAvailable:appearance.accessories.some(x=>x.kind===7),cargoServerCompatible:cargoEnabled};return;
    }
    if(msg.type==='configuration'){
      const appearance=validAppearance(msg.appearance);if(!appearance)return;
      localAppearance=appearance;status.appearance={available:true,accessories:appearance.accessories.length,serverCompatible:appearanceEnabled};return;
    }
    if(msg.type==='dispatch_job'){
      if(buffer.length>=8192||msg.job?.supported!==true||typeof msg.job.active!=='boolean')return;
      try{latestJob=dispatchJob(msg.job);}catch{return;}
      void dispatchService.observe(latestJob).catch(error=>console.error('Missions: '+error.message));return;
    }
    if(msg.type!=='telemetry'||buffer.length>60000)return;
    const state = validState(msg.state);
    if (!state) return;
    latest = state; telemetryAt = performance.now();
    status.telemetry = true;
    status.localState = state;
    status.renderer = msg.render && typeof msg.render.hooked === 'boolean' && typeof msg.render.camera === 'boolean' &&
      Number.isInteger(msg.render.drawn) && msg.render.drawn >= 0 && msg.render.drawn <= MAX_NEARBY_PLAYERS
      ? { hooked: msg.render.hooked, camera: msg.render.camera, drawn: msg.render.drawn,
          mode: msg.render.mode === 'native' ? 'native' : 'd3d' } : null;
  });
  await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(telemetryPort, '127.0.0.1', resolve); });

  function forgetPeer(id){remotePlayers.delete(id);motion.remove(id);configurations.delete(id);trailerConfigurations.delete(id);for(const key of gameConfigurations.keys())if(key.startsWith(id+':'))gameConfigurations.delete(key);for(const key of downAssemblies.keys())if(key.startsWith(id+':'))downAssemblies.delete(key);}
  function updateRemoteView(now){
   status.players=[...remotePlayers.values()].filter(p=>p.state&&now-p.seenAt<=1500).map(p=>({id:p.id,name:p.name,pingMs:p.pingMs??null,state:p.state,ageMs:now-p.seenAt,animationAgeMs:now-(p.animationAt??now)}));
  }
  function queueAppearance(id,appearance,trailer){
   const map=trailer?trailerConfigurations:configurations,revision=appearanceHash(appearance);if(map.get(id)?.revision===revision)return true;if(map.size>=MAX_NEARBY_PLAYERS&&!map.has(id))return false;map.set(id,{appearance,revision});
   for(const key of gameConfigurations.keys())if(key.startsWith(id+':'+(trailer?'trailer:':'tractor:')))gameConfigurations.delete(key);
   if(trailer)appearanceSegments(appearance).forEach((segment,index)=>{const packet=appearancePacket(segmentId(id,index),segment,true);if(packet)gameConfigurations.set(id+':trailer:'+index,{owner:id,packet,at:-Infinity});});
   else{const packet=appearancePacket(id,appearance);if(packet)gameConfigurations.set(id+':tractor:0',{owner:id,packet,at:-Infinity});}return true;
  }
  function receiveDelta(msg){
   const now=performance.now();if(Number.isInteger(msg.uploadHz)&&msg.uploadHz>=10&&msg.uploadHz<=30)uploadHz=msg.uploadHz;for(const key of ['entered','updates','removed','alive'])if(!Array.isArray(msg[key])||msg[key].length>MAX_NEARBY_PLAYERS*2)return false;
   if(msg.peerInfo!==undefined&&(!Array.isArray(msg.peerInfo)||msg.peerInfo.length>MAX_NEARBY_PLAYERS))return false;
   if(msg.audio!==undefined&&(!Array.isArray(msg.audio)||msg.audio.length>MAX_NEARBY_PLAYERS))return false;
   if(msg.ages!==undefined&&(!Array.isArray(msg.ages)||msg.ages.length!==msg.updates.length||msg.ages.some(v=>!Number.isFinite(v)||v<0||v>1500)))return false;
   if(msg.sequence!==undefined&&(!Number.isSafeInteger(msg.sequence)||msg.sequence<1||msg.sequence<=snapshotSequence))return false;
   const next=new Map(remotePlayers),changed=[];let updateIndex=0;
   for(const id of msg.removed){if(!uuid(id))return false;next.delete(id);}
   for(const entry of msg.entered){if(!uuid(entry?.id)||!cleanName(entry.name)||entry.id===status.id)return false;if(next.size>=MAX_NEARBY_PLAYERS&&!next.has(entry.id))return false;next.set(entry.id,{...next.get(entry.id),id:entry.id,name:cleanName(entry.name)});}
   for(const row of msg.updates){
    const age=msg.ages?.[updateIndex++]??0;
    if(!Array.isArray(row)||row.length!==2||!uuid(row[0])||!next.has(row[0])){status.network.rejectedPeerUpdates++;continue;}
    const old=next.get(row[0]),state=decodeCompact(row[1],old.state);
    if(!state){status.network.rejectedPeerUpdates++;continue;}
    next.set(row[0],{...old,state,seenAt:now,animationAt:compactHasAnimation(row[1])?now:old.animationAt??now});
    changed.push([row[0],now-age]);
   }
   for(const id of msg.alive){if(!uuid(id))return false;const old=next.get(id);if(old)next.set(id,{...old,seenAt:now});}
   for(const row of msg.audio??[]){if(!Array.isArray(row)||row.length!==2||!uuid(row[0]))continue;const player=next.get(row[0]);if(!player?.state?.truck)continue;const state=validState({...player.state,truck:{...player.state.truck,audio:row[1]===null?undefined:row[1]}});if(state)next.set(row[0],{...player,state});}
   for(const id of msg.removed)forgetPeer(id);remotePlayers.clear();for(const [id,value] of next)remotePlayers.set(id,value);
   for(const [id,at] of changed)motion.update(id,remotePlayers.get(id).state,at);
   if(msg.sequence!==undefined){if(snapshotSequence)status.network.snapshotSequenceGaps+=Math.max(0,msg.sequence-snapshotSequence-1);snapshotSequence=msg.sequence;}
   status.network.receivedSnapshots++;status.network.receivedUpdates+=changed.length;
   for(const info of msg.peerInfo??[]){if(!info||!uuid(info.id))continue;const player=remotePlayers.get(info.id);if(player)player.pingMs=validPeerPing(info.pingMs);}
   if(Object.hasOwn(msg,'world'))status.world=status.worldCompatible?validWorld(msg.world):null;
   if(Number.isInteger(msg.playerCount)&&msg.playerCount>=0&&msg.playerCount<=MAX_SERVER_PLAYERS)status.playerCount=msg.playerCount;
   if(Object.hasOwn(msg,'collisionZones')){status.collisionZones=status.zoneCompatible?validZonePolicy(msg.collisionZones):null;status.zonePolicyAt=performance.now();}
   updateRemoteView(now);lastSnapshot=now;publish();return true;
  }

  const connect = () => {
    // Authenticate so the launcher can enable Play before ETS2 has opened the selected map.
    if (stopped || socket) return;
    welcomed = false;
    seq = 0;snapshotSequence=0;pingPending=false;sentStateMeta=null;lastUploadAt=-Infinity;uploadHz=20;
    const onConnect = () => {
      if (stopped || connection !== socket || connection.destroyed) return;
      lastServer = performance.now();
      send(socket, { type: 'join', protocol: PROTOCOL, gameVersion: GAME_VERSION, name: config.name,
        room: canonicalRoom(config.room),...(config.optionalModsActive===true?{optionalModsActive:true,...(config.optionalOrderRevision?{optionalOrderRevision:config.optionalOrderRevision}:{})}:{}),mapRevision:config.mapRevision??null,...(standaloneMap?{mapModule:config.mapModule}:{}), identity, capabilities:{traffic:6,noCollisionZones:1,missions:1,phone:1,phoneTestCall:1,chat:1,chatChannels:1,deltaSnapshots:1,networkMetrics:1,configurationChunks:1,vehicleConfiguration:1,trailerConfiguration:1,trailerCargoConfiguration:1,trailerChainConfiguration:1,worldSynchronization:1,hornSynchronization:1} });
    };
    if (config.plaintext) socket = net.connect({ host: config.host, port: serverPort }, onConnect);
    else {
      const hostname = config.host.includes(':') ? `[${config.host}]` : config.host;
      const scheme = config.localWebsocket ? 'ws' : 'wss';
      const ws = new WebSocket(`${scheme}://${hostname}:${serverPort}${WEBSOCKET_PATH}`, {
        rejectUnauthorized: true, minVersion: 'TLSv1.2', handshakeTimeout: 10000,
        maxPayload: 262144, perMessageDeflate: false, followRedirects: false
      });
      socket = createWebSocketStream(ws);
      ws.once('open', onConnect);
    }
    const connection=socket;
    socket.setNoDelay?.(true);
    socket.setTimeout?.(10000, () => socket.destroy());
    socket.on('error', error => {
      status.error = error.message?.includes('Unexpected server response: 502')
        ? 'The HTTPS domain is reachable, but HeavyMP is not responding. Check that the game server is running.'
        : ['DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code)
        ? `The server HTTPS certificate is not trusted (${error.code}). Check the address and use public port 443.`
        : `Connection: ${error.code ?? error.message}`;
      publish();
    });
    readLines(socket, msg => {
      lastServer = performance.now();
      if(worldReady()&&traffic.handle(msg))return;
      if(welcomed&&(dispatchTransport.receive(msg)||(phoneEnabled&&phoneComms.receive(msg))))return;
      if(msg.type==='network_probe'&&welcomed&&Number.isSafeInteger(msg.token)){send(socket,{type:'network_probe_ack',token:msg.token});return;}
      if(msg.type==='vehicle_access'&&welcomed){status.staffVehicles=msg.staff===true;status.staffVehiclesAt=performance.now();return;}
      if (msg.type === 'welcome' && msg.protocol === PROTOCOL && typeof msg.id === 'string') {
        admissionRetries=0;
        traffic.capabilities(msg.capabilities);phoneComms.disconnect();dispatchTransport.disconnect();dispatchTransport.capabilities(msg.capabilities);welcomed = true; delay = 1000;
        const moduleList=msg.modules;
        phoneEnabled=moduleList?.schema===1 ? moduleList.phone===true : msg.capabilities?.phone!==0&&msg.capabilities?.phone!==false;
        classicChatEnabled=moduleList?.schema===1&&moduleList.classicChat===true;
        status.zoneCompatible=msg.capabilities?.noCollisionZones===1;status.collisionZones=null;status.connected = true; status.collisions=msg.capabilities?.collisions===true; status.id = msg.id; status.steamId = typeof msg.steamId === 'string' ? msg.steamId : null; status.ban = null; status.error = null; publish();
        appearanceEnabled=msg.capabilities?.vehicleConfiguration===1;sentAppearance=null;trailerEnabled=msg.capabilities?.trailerConfiguration===1;sentTrailer=null;
        cargoEnabled=msg.capabilities?.trailerCargoConfiguration===1;status.serverVersion=msg.serverVersion??null;
        chainEnabled=msg.capabilities?.trailerChainConfiguration===1;status.chainCompatible=chainEnabled;
        status.worldCompatible=msg.capabilities?.worldSynchronization===1;status.hornCompatible=msg.capabilities?.hornSynchronization===1;
        status.chatCompatible=msg.capabilities?.chat===1&&(phoneEnabled||classicChatEnabled);status.channelCompatible=msg.capabilities?.chatChannels===1;status.deltaCompatible=msg.capabilities?.deltaSnapshots===1;status.limits=msg.limits??null;status.chat=[];pendingRepair=null;remotePlayers.clear();motion.clear();gameConfigurations.clear();downAssemblies.clear();
        if(status.trailerAppearance){status.trailerAppearance.serverCompatible=trailerEnabled;status.trailerAppearance.cargoServerCompatible=cargoEnabled;}
        if(status.appearance)status.appearance.serverCompatible=appearanceEnabled;
      } else if(msg.type==='snapshot_delta'&&welcomed&&status.deltaCompatible){receiveDelta(msg);
      } else if(msg.type==='vtc_status'&&welcomed){
          const company=validVtcCompany(msg.company);if(msg.company!==null&&!company)return;
        if(status.vtc?.id!==company?.id)status.chat=status.chat.filter(m=>m.channel!=='vtc');status.vtc=company;publish();
      } else if((msg.type==='vehicle_configuration_part'||msg.type==='trailer_configuration_part')&&welcomed){
        if(!uuid(msg.id)||!remotePlayers.has(msg.id))return;const trailer=msg.type==='trailer_configuration_part',key=msg.id+':'+(trailer?'trailer':'tractor');if(downAssemblies.size>=64&&!downAssemblies.has(key))return;
        const result=acceptAppearancePart(downAssemblies.get(key),msg,performance.now(),trailer,15000);if(!result){downAssemblies.delete(key);return;}if(result.pending)downAssemblies.set(key,result.pending);else{downAssemblies.delete(key);if(queueAppearance(msg.id,result.appearance,trailer))send(socket,{type:trailer?'trailer_config_ack':'vehicle_config_ack',id:msg.id,revision:result.revision});}
      } else if(msg.type==='chat_history'&&welcomed&&Array.isArray(msg.messages)&&msg.messages.length<=120){
        status.chat=msg.messages.map(m=>chatForViewer(m,status)).filter(Boolean);trimChat();publish();
      } else if(msg.type==='chat_message'&&welcomed){
        const message=chatForViewer(msg.message,status);if(message){status.chat.push(message);status.chat=status.chat.slice(-40);publish();}
      } else if(msg.type==='action'&&welcomed&&worldReady()&&msg.action==='repair'&&repairPacket(msg.id)){
        pendingRepair={id:msg.id,until:performance.now()+12000,at:0};
      } else if(msg.type==='configuration_retry'&&welcomed&&typeof msg.trailer==='boolean'){
        const until=performance.now()+Math.max(1000,Math.min(10000,Number(msg.afterMs)||5000));if(msg.trailer){sentTrailer=null;trailerAt=until;}else{sentAppearance=null;appearanceAt=until;}
      } else if(msg.type==='trailer_configuration'&&welcomed&&trailerEnabled){
        const appearance=validAppearance(msg.appearance,true);
        if(!appearance||appearanceHash(appearance)!==msg.revision||!/^[a-f0-9-]{36}$/i.test(msg.id))return;
        if(!queueAppearance(msg.id,appearance,true))return;
        send(socket,{type:'trailer_config_ack',id:msg.id,revision:msg.revision});
      } else if(msg.type==='vehicle_configuration'&&welcomed){
        const appearance=validAppearance(msg.appearance);
        if(!appearance||appearanceHash(appearance)!==msg.revision||!/^[a-f0-9-]{36}$/i.test(msg.id))return;
        if(!queueAppearance(msg.id,appearance,false))return;
        send(socket,{type:'vehicle_config_ack',id:msg.id,revision:msg.revision});
      } else if (msg.type === 'snapshot' && welcomed && Array.isArray(msg.players) && msg.players.length <= MAX_NEARBY_PLAYERS+1) {
        status.world=status.worldCompatible?validWorld(msg.world):null;
        if(Object.hasOwn(msg,'collisionZones')){status.collisionZones=status.zoneCompatible?validZonePolicy(msg.collisionZones):null;status.zonePolicyAt=performance.now();}
        status.players = msg.players.map(p => ({ id: p.id, name: cleanName(p.name) ?? 'Player',pingMs:validPeerPing(p.pingMs),
          ageMs: p.ageMs, state: p.state === null ? null : validState(p.state) }));
        lastSnapshot = performance.now();status.playerCount=msg.playerCount??status.players.length; publish();
        for(const id of trailerConfigurations.keys())if(!status.players.some(p=>p.id===id))trailerConfigurations.delete(id);
        for(const id of configurations.keys())if(!status.players.some(p=>p.id===id))configurations.delete(id);
      } else if (msg.type === 'pong' && msg.echo === pingAt) {
        status.pingMs = Math.round(performance.now() - pingAt);pingPending=false;
      } else if (msg.type === 'error') {
        refuse(msg);
      }
    });
    socket.once('close', () => {
      traffic.disconnect();phoneComms.disconnect();dispatchTransport.disconnect();welcomed = false; phoneEnabled=false;classicChatEnabled=false;status.chat=[];phoneNotifications.length=0;status.collisionZones=null;status.zoneCompatible=false;status.connected = false; status.collisions=false; status.staffVehicles=false; status.id = null; status.players = []; publish();
      status.world=null;status.worldCompatible=false;status.hornCompatible=false;
      pendingRepair=null;status.chatCompatible=false;status.vtc=null;remotePlayers.clear();motion.clear();gameConfigurations.clear();downAssemblies.clear();
      configurations.clear();trailerConfigurations.clear();sentAppearance=null;appearanceEnabled=false;sentTrailer=null;trailerEnabled=false;cargoEnabled=false;
      socket=null;
      if (!stopped) { retryTimer = setTimeout(connect,Math.round(delay*(.75+Math.random()*.5))); delay = Math.min(30000, delay * 2); }
    });
  };
  connect();
  const ticker = setInterval(() => {
    const now = performance.now();
    status.telemetry = latest !== null && now - telemetryAt < 1000;
    if (!status.telemetry) { status.localState = null; status.renderer = null; }
    if (welcomed && now - lastServer > 10000) socket?.destroy();
    if(welcomed&&mapReady&&status.telemetry&&now-lastUploadAt>=1000/uploadHz-5){lastUploadAt=Number.isFinite(lastUploadAt)?Math.max(now-1000/uploadHz,lastUploadAt)+1000/uploadHz:now;if(status.deltaCompatible){const meta=JSON.stringify({identity:latest.truck?.identity??null,audio:latest.truck?.audio??null});const accepted=send(socket,{type:'state_compact',seq:seq++,state:encodeCompact(latest,true),...(meta!==sentStateMeta?{meta:JSON.parse(meta)}:{})});if(accepted){sentStateMeta=meta;status.network.sentStates++;}else status.network.skippedUploads++;}else{if(send(socket,{type:'state',seq:seq++,state:latest}))status.network.sentStates++;else status.network.skippedUploads++;}}
    if(welcomed&&worldReady()&&appearanceEnabled&&localAppearance&&now-appearanceAt>=1500){
      const revision=appearanceHash(localAppearance);
      if(revision!==sentAppearance){
        let accepted=true;for(const part of appearanceChunks(localAppearance))if(!send(socket,part)){accepted=false;break;}
        if(accepted)sentAppearance=revision;appearanceAt=now;
      }
    }
    if(welcomed&&worldReady()&&trailerEnabled&&localTrailer&&now-trailerAt>=1500){
      let outgoing=trailerForPeer(localTrailer,cargoEnabled);if(outgoing.children&&!chainEnabled)outgoing={plate:outgoing.plate,accessories:outgoing.accessories};const revision=appearanceHash(outgoing);
      if(revision!==sentTrailer){let accepted=true;for(const part of appearanceChunks(outgoing,true))if(!send(socket,part)){accepted=false;break;}
        if(accepted)sentTrailer=revision;trailerAt=now;}
    }
    if (lastSnapshot && now - lastSnapshot > 1500) {status.players = [];status.world=null;}
    if (config.vehiclePort) {
      const activeMap = worldReady();
      if(activeMap)traffic.tick();
      if(now-staffPolicyAt>=500){staffPolicyAt=now;
       const access=Buffer.alloc(16);access.write('HME1');access.writeUInt32LE(1,4);
       access.writeUInt32LE(activeMap&&welcomed&&status.staffVehicles===true&&now-(status.staffVehiclesAt??-Infinity)<2500?1:0,8);
       udp.send(access,port(config.vehiclePort,34063),'127.0.0.1');
      }
      const target=port(config.vehiclePort,34063);
      if(status.deltaCompatible)updateRemoteView(now);
      if(latest)status.players.sort((a,b)=>!a.state?1:!b.state?-1:(a.state.x-latest.x)**2+(a.state.z-latest.z)**2-((b.state.x-latest.x)**2+(b.state.z-latest.z)**2));
      const worldStatus = activeMap ? status : {...status,connected:false,players:[],world:null,collisions:false,collisionZones:null};
      const renderStatus = activeMap&&status.deltaCompatible ? {...status,players:motion.render(status.players,now)} : worldStatus;
      udp.send(vehiclePacket(renderStatus, vehicleSequence++),target,'127.0.0.1');
      if(now-audioAt>=500){audioAt=now;udp.send(audioPacket(renderStatus,vehicleSequence),target,'127.0.0.1');}
      if(now-chatAt>=200){
        chatAt=now;
        modulePolicy.writeUInt32LE(activeMap&&welcomed ? Number(phoneEnabled)+2*Number(classicChatEnabled) : 0,8);
        udp.send(modulePolicy,target,'127.0.0.1');
        udp.send(chatPacket(activeMap?status.chat:[],vehicleSequence),target,'127.0.0.1');
        udp.send(nearbyPlayersPacket(worldStatus,vehicleSequence),target,'127.0.0.1');
      }
      if(activeMap&&pendingRepair){
        if(now>pendingRepair.until){send(socket,{type:'repair_result',id:pendingRepair.id,ok:false,reason:'no response from the game'});pendingRepair=null;}
        else if(now-pendingRepair.at>=500){pendingRepair.at=now;udp.send(repairPacket(pendingRepair.id),target,'127.0.0.1');}
      }
      udp.send(trailerPacket(renderStatus,vehicleSequence),target,'127.0.0.1');
      udp.send(zonePacket(worldStatus.collisionZones,vehicleSequence,{enabled:activeMap&&status.zoneCompatible===true,fresh:worldStatus.connected&&lastSnapshot&&now-lastSnapshot<=1000&&now-(status.zonePolicyAt??-Infinity)<=1200}),target,'127.0.0.1');
      udp.send(collisionPacket(lastSnapshot&&now-lastSnapshot<=1500?worldStatus:{...worldStatus,collisions:false},vehicleSequence),target,'127.0.0.1');
      udp.send(worldPacket(lastSnapshot&&now-lastSnapshot>1500?{...worldStatus,world:null}:worldStatus,vehicleSequence),target,'127.0.0.1');
      udp.send(mapPacket(worldStatus,vehicleSequence),target===65535?34064:target+1,'127.0.0.1');
      for(const [key,pending] of downAssemblies)if(now-pending.at>15000)downAssemblies.delete(key);
      let sent=0,attempts=0;const max=gameConfigurations.size;
      while(activeMap&&sent<2&&attempts++<max){
        const [key,entry]=gameConfigurations.entries().next().value??[];
        if(!entry)break;
        gameConfigurations.delete(key);
        const visible=status.players.some(p=>p.id===entry.owner);
        // A configuration can arrive before a recoverable roster update.
        if(visible||status.deltaCompatible)gameConfigurations.set(key,entry);
        if(!visible||now-entry.at<1000)continue;
        entry.at=now;udp.send(entry.packet,target,'127.0.0.1');sent++;
      }
    }
    if (!welcomed) publish();
  }, 50);
  const pinger = setInterval(() => {
    if (!welcomed) return;
    if(pingPending)status.network.pingTimeouts++;pingPending=true;pingAt = performance.now(); send(socket, { type: 'ping', echo: pingAt });
  }, 2000);
  let monitor = null;
  const streams = new Set();
  if (config.monitorPort !== false) {
    const phoneServices=createPhoneServices({dispatcher:dispatchService,comms:phoneComms,directory:config.identityDirectory,getData:()=>({connected:status.connected,telemetry:status.telemetry,speedKmh:latest?Math.round(Math.abs(latest.speed)*3.6):null,position:latest?{x:latest.x,y:latest.y,z:latest.z,heading:latest.heading}:null,truck:latest?.truck?.identity??null,cargo:latestJob.active?latestJob.cargo:null,job:latestJob,players:status.players.slice(0,32).map(p=>({name:p.name,pingMs:p.pingMs??null})),notifications:phoneNotifications,chat:status.chat.slice(-40).map(({id,time,name,text,system,channel,own})=>({id,time,name,text,system,channel,own})),at:Date.now()})});
    const html = readFileSync(new URL('./monitor.html', import.meta.url));
    monitor = http.createServer(async (req, res) => {
      const requestHost = req.headers.host?.split(':')[0];
      if (!['127.0.0.1', 'localhost'].includes(requestHost)) { res.writeHead(403); res.end(); return; }
      if(req.url?.startsWith('/phone/')){if(welcomed&&!phoneEnabled){res.writeHead(503);res.end();return;}try{await phoneServices(req,res);}catch{if(!res.headersSent)res.writeHead(500);res.end();}return;}
      if(req.method!=='GET'){res.writeHead(405);res.end();return;}
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
      if (req.url === '/') {
        res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
      } else if (req.url === '/events') {
        if (streams.size >= 8) { res.writeHead(429); res.end(); return; }
        res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(status)}\n\n`); streams.add(res);
        req.on('close', () => streams.delete(res));
      } else { res.writeHead(404); res.end(); }
    });
    events.on('status', s => {
      for (const res of streams) {
        if (res.writableLength > 65536) res.destroy();
        else res.write(`data: ${JSON.stringify(s)}\n\n`);
      }
    });
    try {
      await new Promise((resolve, reject) => { monitor.once('error', reject); monitor.listen(port(config.monitorPort, 34062, true), '127.0.0.1', resolve); });
    } catch (e) {
      stopped = true; clearTimeout(retryTimer); clearInterval(ticker); clearInterval(pinger);
      socket?.destroy(); udp.close(); throw e;
    }
  }
  return { status, events, setMapReady(value){
    const next=value===true;
    if(mapReady!==next&&standaloneMap){
      latest=null;telemetryAt=0;localAppearance=null;localTrailer=null;localSegments=[];
      status.telemetry=false;status.localState=null;status.renderer=null;
      if(!next){
        // Rejoin without a position so the server forgets the vehicle from the previous map.
        status.connected=false;
        socket?.destroy();
      }
    }
    mapReady=next;status.mapReady=mapReady;publish();
  }, telemetryAddress: udp.address(), monitorAddress: monitor?.address(), async close() {
    stopped = true; clearTimeout(retryTimer); clearInterval(ticker); clearInterval(pinger);
    const closing=socket;
    const disconnected=closing&&!closing.destroyed?new Promise(resolve=>{
      const deadline=setTimeout(()=>closing.destroy(),1200);
      closing.once('close',()=>{clearTimeout(deadline);resolve();});
      closing.end();
    }):null;
    traffic.disconnect();nativeDispatch.close();await dispatchService.close();
    for (const stream of streams) stream.end();
    if (monitor) await new Promise(resolve => monitor.close(resolve));
    await new Promise(resolve => udp.close(resolve));
    await disconnected;
  } };
}
