import {sendSerialized} from '../shared/protocol.mjs';
import {normalizeAnnouncement} from './announcements.mjs';

// The game uses these packets for native announcements and system replies,
// including on servers with both player-facing chat modules removed.
export function createServerMessages({sessions,onMessage,stateTtl=1500}){
 let sequence=0;
 const message=(name,text,system,channel,rank,company,senderId)=>({
  id:(++sequence)>>>0,time:Date.now(),name,text,system,channel,
  ...(!system&&senderId?{senderId}:{}),...(rank?{rank}:{}),
  ...(!system&&company?.tag?{vtc:{tag:company.tag,color:company.tagColor}}:{}),
 });
 function enqueue(s,line){
  if(s.chatOutbox?.length){
   if(s.chatOutbox.length>=40)s.chatOutbox.shift();
   s.chatOutbox.push(line);flush(s);
   return !s.chatOutbox.length;
  }
  if(sendSerialized(s.socket,line))return true;
  if(s.socket.destroyed)return false;
  if(!s.chatOutbox){
   s.chatOutbox=[];
   s.socket.on('drain',()=>flush(s));
  }
  s.chatOutbox.push(line);
  return false;
 }
 function flush(s){
  while(s.chatOutbox.length&&sendSerialized(s.socket,s.chatOutbox[0]))s.chatOutbox.shift();
 }
 const tell=(s,text)=>enqueue(s,JSON.stringify({type:'chat_message',message:message('HeavyMP',text,true,'system')}));
 function broadcast(recipients,name,text,system,channel,rank,company,senderId){
  const record=message(name,text,system,channel,rank,company,senderId);
  const line=JSON.stringify({type:'chat_message',message:record});
  for(const s of recipients)if(s.supportsChat)enqueue(s,line);
  try{onMessage?.(record);}catch{/* Console observation is best effort. */}
  return record;
 }
 function announce(value){
  const text=normalizeAnnouncement(value);
  if(!text)return {ok:false,recipients:0};
  const recipients=[...sessions.values()].filter(s=>s.supportsChat);
  broadcast(recipients,'HeavyMP','[Annonce] '+text,true,'system');
  const now=performance.now();
  const withGameTelemetry=recipients.filter(s=>s.lastState&&now-s.stateAt<=stateTtl).length;
  return {ok:true,recipients:recipients.length,withGameTelemetry};
 }
 function handle(s,msg){
  if(msg.type==='teleport_result'){
   if(s.teleportId===msg.id&&typeof msg.ok==='boolean'){
    s.teleportId=null;
    if(!msg.ok)tell(s,'Teleport failed: '+(typeof msg.reason==='string'?msg.reason.slice(0,160):'game unavailable')+'.');
   }
   return true;
  }
  if(msg.type==='repair_result'){
   if(s.repairId===msg.id&&typeof msg.ok==='boolean'){
    s.repairId=null;
    tell(s,msg.ok?'Truck repaired.':'Repair failed: '+(typeof msg.reason==='string'?msg.reason.slice(0,160):'game unavailable')+'.');
   }
   return true;
  }
  return false;
 }
 return {announce,broadcast,enqueue,handle,tell};
}
