import {createHash} from 'node:crypto';
import {DISCOVERY_PATH,DISCOVERY_SCHEMA,OPTIONAL_ALLOWLIST_HEADER,SERVER_LOGO_PATH,SERVER_LOGO_LIMIT,validLogoHash,validLogoPng} from '../server/shared/discovery.mjs';
import {WEBSOCKET_PATH} from '../server/shared/branding.mjs';
import {validMapModule} from '../server/shared/content.mjs';

const bodyLimit=16*1024;
const loopback=new Set(['localhost','127.0.0.1','[::1]']);
const states=new Set(['stopped','starting','running','stopping','crashed']);
const paths={health:'/health',players:'/players',manifest:'/content/manifest'};
const logos=new Map();

export function communityOrigin(address){
 const url=URL.parse(address);
 if(!url||url.username||url.password||url.search||url.hash||
    !['/','/manager','/manager/'].includes(url.pathname)||
    (url.protocol!=='https:'&&(url.protocol!=='http:'||!loopback.has(url.hostname)))){
  throw Error('Enter an HTTPS server address or a local HTTP address.');
 }
 return url.origin;
}

async function discoveryBody(response){
 if(!response.ok){await response.body?.cancel();throw Error('Server discovery returned HTTP '+response.status+'.');}
 if(!response.body||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){
  await response.body?.cancel();throw Error('The address did not return a HeavyMP server description.');
 }
 const reader=response.body.getReader();
 const decoder=new TextDecoder();
 let size=0,text='';
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   size+=value.byteLength;
   if(size>bodyLimit)throw Error('Server description is too large.');
   text+=decoder.decode(value,{stream:true});
  }
  return JSON.parse(text+decoder.decode());
 }finally{
  await reader.cancel().catch(()=>{});
  reader.releaseLock();
 }
}

export async function discoverCommunityServer(address,{fetch:fetcher=fetch}={}){
 const origin=communityOrigin(address);
 const request=new URL(DISCOVERY_PATH,origin);
 const server=await discoveryBody(await fetcher(request,{
  headers:{Accept:'application/json',[OPTIONAL_ALLOWLIST_HEADER]:'1'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(6000),
 }));
 const validMap=server?.map===null||(validMapModule(server?.map?.module)&&
  (server.map.revision===null||/^[a-f0-9]{64}$/.test(server.map.revision)));
 const connection=server?.connection;
 if(server?.schema!==DISCOVERY_SCHEMA||server.service!=='HeavyMP'||server.edition!=='community'||
    !/^[a-z0-9_-]{1,32}$/.test(server.id??'')||typeof server.name!=='string'||!server.name.trim()||server.name.length>80||
    !states.has(server.status)||server.online!==(server.status==='running')||
    !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(server.serverVersion??'')||
    !/^\d{1,3}(?:\.\d{1,4}){2,3}s?$/.test(server.gameVersion??'')||
    !Number.isSafeInteger(server.protocol)||server.protocol<1||
    !Number.isInteger(server.playerCount)||server.playerCount<0||server.playerCount>5000||
    (server.maxPlayers!==null&&(!Number.isInteger(server.maxPlayers)||server.maxPlayers<1||server.maxPlayers>5000))||
    !validMap||connection?.auth!=='guest'||connection.transport!=='websocket'||
    connection.path!==WEBSOCKET_PATH||!/^[A-Za-z0-9_-]{1,32}$/.test(connection.room??'')||
    Object.entries(paths).some(([key,value])=>server.endpoints?.[key]!==value)){
  throw Error('Invalid or incompatible HeavyMP server description.');
 }
 const websocket=new URL(WEBSOCKET_PATH,origin);
 websocket.protocol=websocket.protocol==='https:'?'wss:':'ws:';
 return {
  origin,id:server.id,name:server.name,online:server.online,status:server.status,
  logo:validLogoHash(server.logo)?server.logo:null,
  serverVersion:server.serverVersion,gameVersion:server.gameVersion,protocol:server.protocol,
  playerCount:server.playerCount,maxPlayers:server.maxPlayers,map:server.map,
  auth:connection.auth,room:connection.room,websocketUrl:websocket.href,
  allowOptionalMods:server.allowOptionalMods===true,
  collisions:typeof server.collisions==='boolean'?server.collisions:null,
  traffic:typeof server.traffic==='boolean'?server.traffic:null,
  endpoints:Object.fromEntries(Object.entries(paths).map(([key,path])=>[key,new URL(path,origin).href])),
 };
}

export async function fetchCommunityLogo(server,{fetch:fetcher=fetch}={}){
 if(!validLogoHash(server?.logo))return null;
 const url=new URL(SERVER_LOGO_PATH+server.logo,communityOrigin(server.origin));
 const key=url.href;
 if(logos.has(key))return logos.get(key);
 const response=await fetcher(url,{headers:{Accept:'image/png'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(2500)});
 if(!response.ok||!response.body||response.headers.get('content-type')!=='image/png'||Number(response.headers.get('content-length'))>SERVER_LOGO_LIMIT){
  await response.body?.cancel();return null;
 }
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;if(size>SERVER_LOGO_LIMIT)return null;
   chunks.push(Buffer.from(value));
  }
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const png=Buffer.concat(chunks,size);
 if(!validLogoPng(png)||createHash('sha256').update(png).digest('hex')!==server.logo)return null;
 const data='data:image/png;base64,'+png.toString('base64');
 if(logos.size>=24)logos.delete(logos.keys().next().value);
 logos.set(key,data);
 return data;
}
