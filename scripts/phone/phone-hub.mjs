import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {createPhoneNetwork} from './phone.mjs';

// Central directory, SMS storage and call signalling, shared by configured servers.
// Audio stays WebRTC peer-to-peer (or TURN); game state never enters this service.
export async function createPhoneHub({host='127.0.0.1',port=30100,keys,database=':memory:',ice,log=()=>{},send,WebSocket,WebSocketServer}={}){
 if(!keys||!Object.keys(keys).length||Object.entries(keys).some(([id,key])=>!/^[a-zA-Z0-9_-]{1,32}$/.test(id)||typeof key!=='string'||key.length<32||key.length>256||/[\r\n]/.test(key)))throw Error('PHONE_HUB_KEYS must assign each SERVER_ID a private key of 32 to 256 characters.');
 const phone=createPhoneNetwork({database,ice,scope:'heavymp-network',send}),connections=new Map();let closing=false;
 const server=http.createServer((req,res)=>{res.writeHead(404);res.end();});
 const wss=new WebSocketServer({noServer:true,maxPayload:32768,perMessageDeflate:false});
 server.on('upgrade',(req,socket,head)=>{
  const id=req.headers['x-heavymp-server'],key=keys[id],auth=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+(key??''));
  if(closing||req.url!=='/phone-hub'||!Object.hasOwn(keys,id)||auth.length!==expected.length||!timingSafeEqual(auth,expected)||connections.has(id)){
   socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
  }
  wss.handleUpgrade(req,socket,head,ws=>{connections.set(id,ws);wss.emit('connection',ws,req);});
 });
 wss.on('connection',(ws,req)=>{
  const serverId=req.headers['x-heavymp-server'],sessions=new Map();let tokens=300,last=Date.now(),alive=true;
  const write=m=>{if(ws.readyState!==WebSocket.OPEN)return false;if(ws.bufferedAmount>262144){ws.terminate();return false;}ws.send(JSON.stringify(m));return true;};
  const pulse=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;ws.ping();},20000);pulse.unref?.();ws.on('pong',()=>alive=true);
  ws.on('error',()=>{});
  ws.on('message',bytes=>{try{
   const now=Date.now();tokens=Math.min(300,tokens+(now-last));last=now;if(--tokens<0){ws.close(1008,'Rate limit');return;}
   const m=JSON.parse(bytes);if(typeof m.id!=='string'||!/^[a-zA-Z0-9-]{1,64}$/.test(m.id))throw Error('Invalid id');
   if(m.type==='attach'){
    if(sessions.has(m.id)||sessions.size>=5000||!/^[a-f0-9]{64}$/.test(m.identity??'')||typeof m.name!=='string'||!m.name.trim()||m.name.length>64||/[\u0000-\u001f\u007f]/.test(m.name))throw Error('Invalid session');
    const identityHash=createHash('sha256').update(serverId+':'+m.identity).digest('hex');
    const s={id:serverId+':'+m.id,identityHash,name:m.name,supportsPhone:true,supportsPhoneTestCall:m.test===true,
     socket:{writable:true,destroyed:false,write:line=>write({type:'frame',id:m.id,frame:JSON.parse(line)}),destroy:()=>ws.terminate()}};
    sessions.set(m.id,s);Promise.resolve(phone.join(s)).catch(()=>write({type:'frame',id:m.id,frame:{type:'phone_state',state:{available:false}}}));return;
   }
   if(m.type==='detach'){const s=sessions.get(m.id);if(s){phone.leave(s);sessions.delete(m.id);}return;}
   if(m.type==='request'){const s=sessions.get(m.id);if(s&&m.request?.type==='phone_request')phone.handle(s,m.request);return;}
   if(m.type==='fake-call'){
    if(typeof m.target!=='string'||m.target.length>80||/[\u0000-\u001f\u007f]/.test(m.target))throw Error('Invalid target');
    // A console may target only its own server's players, even on the shared hub.
    const target=m.target.trim().toLowerCase(),matches=[...sessions.values()].filter(s=>s.phone&&(!target||s.phone.number===target||s.name.toLowerCase()===target));
    const result=matches.length===1?phone.fakeCall(matches[0].phone.number):{ok:false,error:'Specify a player connected to this server.'};write({type:'result',id:m.id,result});return;
   }
   throw Error('Unknown message');
  }catch{ws.close(1008,'Invalid request');}});
  ws.on('close',()=>{clearInterval(pulse);for(const s of sessions.values())phone.leave(s);sessions.clear();if(connections.get(serverId)===ws)connections.delete(serverId);});
  write({type:'ready'});
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
 return {address:server.address(),async close(){closing=true;for(const ws of connections.values())ws.terminate();await new Promise(r=>wss.close(r));phone.close();await new Promise(r=>server.close(r));}};
}
