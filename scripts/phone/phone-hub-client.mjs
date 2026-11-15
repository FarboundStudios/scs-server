import {randomUUID} from 'node:crypto';

export function phoneHubConfig(url,key,serverId){
 const u=new URL(url);
 if(!['ws:','wss:'].includes(u.protocol)||u.protocol==='ws:'&&!['127.0.0.1','[::1]','localhost'].includes(u.hostname)||u.username||u.password||u.hash||u.search)throw Error('PHONE_HUB_URL requires wss outside loopback.');
 if(typeof key!=='string'||key.length<32||key.length>256||/[\r\n]/.test(key))throw Error('PHONE_HUB_KEY must contain 32 to 256 characters.');
 if(!/^[a-zA-Z0-9_-]{1,32}$/.test(serverId??''))throw Error('Invalid SERVER_ID for the phone hub.');
 return u.href;
}

// One authenticated connection per game relay; no new browser/client protocol.
export function createPhoneHubClient({url,key,serverId,log=()=>{},send,WebSocket}){
 url=phoneHubConfig(url,key,serverId);
 const sessions=new Map(),pending=new Map(),outbox=[];let ws,ready=false,closed=false,retry,flushTimer,delay=1000,budget=100,refilled=Date.now();
 function flush(){
  clearTimeout(flushTimer);flushTimer=null;if(!ready||ws?.readyState!==WebSocket.OPEN)return;
  const now=Date.now();budget=Math.min(100,budget+(now-refilled)*.5);refilled=now;
  while(outbox.length&&budget>=1){if(ws.bufferedAmount>262144){ws.terminate();return;}budget--;ws.send(outbox.shift());}
  if(outbox.length){flushTimer=setTimeout(flush,10);flushTimer.unref?.();}
 }
 // Pace large reconnect waves below the hub's existing abuse limit. Never replay
 // queued requests across a broken connection (especially SMS/call mutations).
 const write=message=>{if(!ready||ws?.readyState!==WebSocket.OPEN)return false;if(outbox.length>=10000){ws.terminate();return false;}outbox.push(JSON.stringify(message));flush();return true;};
 const attach=s=>write({type:'attach',id:s.id,identity:s.identityHash,name:s.name,test:s.supportsPhoneTestCall===true});
 function connect(){
  if(closed)return;
  // A legal snapshot can include 80 messages and 100 contacts. Incoming state
  // uses the existing 256 KiB protocol ceiling; hub-bound requests stay 32 KiB.
  const socket=ws=new WebSocket(url,{headers:{authorization:'Bearer '+key,'x-heavymp-server':serverId},maxPayload:262144,handshakeTimeout:5000});
  socket.on('error',()=>{}); // Never log URLs/headers containing operator secrets.
  socket.on('message',bytes=>{try{
   const m=JSON.parse(bytes);
   if(m.type==='ready'){ready=true;delay=1000;budget=100;refilled=Date.now();log('Phone: connected to the shared hub.');for(const s of sessions.values())attach(s);return;}
   if(m.type==='frame'&&sessions.has(m.id)){
    const s=sessions.get(m.id),frame=m.frame;if(!['phone_state','phone_event','phone_reply'].includes(frame?.type))return;
    if(frame.type==='phone_state')s.phone=frame.state?.available?{number:frame.state.number}:null;
    send(s.socket,frame);return;
   }
   if(m.type==='result'){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);p.resolve(m.result);}}
  }catch{socket.close(1008,'Invalid frame');}});
  socket.on('close',()=>{
   ready=false;clearTimeout(flushTimer);outbox.length=0;for(const s of sessions.values()){s.phone=null;send(s.socket,{type:'phone_state',state:{available:false}});}
   for(const p of pending.values()){clearTimeout(p.timer);p.resolve({ok:false,error:'Phone hub disconnected.'});}pending.clear();
   if(!closed){log('Phone: shared hub unavailable. Reconnecting automatically.');retry=setTimeout(connect,delay);retry.unref?.();delay=Math.min(15000,delay*2);}
  });
 }
 connect();
 return {
  join(s){if(!s.supportsPhone)return;if(!(/^[a-f0-9]{64}$/.test(s.identityHash??''))){send(s.socket,{type:'phone_state',state:{available:false}});return;}sessions.set(s.id,s);if(!attach(s))send(s.socket,{type:'phone_state',state:{available:false}});},
  leave(s){sessions.delete(s.id);write({type:'detach',id:s.id});s.phone=null;},
  handle(s,m){if(m.type!=='phone_request')return false;if(!sessions.has(s.id)||!write({type:'request',id:s.id,request:m}))send(s.socket,{type:'phone_reply',id:m.id,ok:false,error:'Phone hub unavailable.'});return true;},
  fakeCall(target=''){
   if(!ready||pending.size>=16)return Promise.resolve({ok:false,error:'Phone hub unavailable.'});
   return new Promise(resolve=>{const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);resolve({ok:false,error:'Phone hub did not respond.'});},4500);timer.unref?.();pending.set(id,{resolve,timer});write({type:'fake-call',id,target});});
  },
  close(){closed=true;clearTimeout(retry);clearTimeout(flushTimer);outbox.length=0;ws?.terminate();for(const p of pending.values()){clearTimeout(p.timer);p.resolve({ok:false,error:'Server is shutting down.'});}pending.clear();sessions.clear();}
 };
}
