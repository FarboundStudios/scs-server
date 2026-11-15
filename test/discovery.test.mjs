import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {startServerManager} from '../server/system/manager/main.mjs';
import {communityOrigin,discoverCommunityServer} from '../launcher/server-discovery.mjs';
import {DISCOVERY_PATH} from '../server/shared/discovery.mjs';
import {GAME_VERSION,PROTOCOL} from '../server/shared/protocol.mjs';

const owner='76561198000000001';
const steam='https://steamcommunity.com/openid/login';

test('public discovery works with the game stopped and running, and private pages require an authorized Steam session',{timeout:15000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'hvmp-discovery-'));
 const probe=createServer();
 probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const port=probe.address().port;
 await new Promise(resolve=>probe.close(resolve));
 const origin='http://127.0.0.1:'+port;
 const env={
  SERVER_ID:'test-club',SERVER_NAME:'Test Club',
  ROOM:'TestRoom',MAX_PLAYERS:'32',HOST:'127.0.0.1',PORT:String(port),
  DATA_DIR:join(directory,'data'),LOG_DIR:join(directory,'logs'),ADDONS_DIR:join(directory,'addons'),
  MAP_MANIFEST:'none',NO_COLLISION_ZONES_ENABLED:'false',MANAGER_ADMIN_STEAM_IDS:owner,MANAGER_PUBLIC_URL:origin,LOG_COLORS:'false',
 };
 await mkdir(env.DATA_DIR);
 const requests=[],profileUrl='https://steamcommunity.com/profiles/'+owner+'?xml=1';
 const avatar='https://avatars.fastly.steamstatic.com/'+'a'.repeat(40)+'_medium.jpg';
 await writeFile(join(env.DATA_DIR,'manager-profiles.json'),JSON.stringify({schema:1,profiles:{[owner]:{name:'Truck Driver',avatar}}}));
 const manager=await startServerManager(env,{steamFetch:async (url,options)=>{
  requests.push(url);
  if(url===profileUrl)return new Response('',{status:429});
  if(url===profileUrl.replace('?xml=1','/'))return new Response('',{status:503});
  assert.equal(url,steam);
  assert.equal(new URLSearchParams(options.body).get('openid.mode'),'check_authentication');
  return new Response('is_valid:true\n');
 }});
 t.after(async()=>{await manager.close();if(!process.stdin.listenerCount('data'))process.stdin.pause();await rm(directory,{recursive:true,force:true});});
 const get=(path,options)=>fetch(origin+path,options);
 const discovery=await discoverCommunityServer(origin+'/manager/');
 assert.equal(discovery.id,'test-club');
 assert.equal(discovery.name,'Test Club');
 assert.equal(discovery.auth,'guest');
 assert.equal(discovery.status,'stopped');
 assert.equal(discovery.online,false);
 assert.equal(discovery.room,'TestRoom');
 assert.equal(discovery.maxPlayers,32);
 assert.equal(discovery.endpoints.manifest,origin+'/content/manifest');
 const descriptor=await (await get(DISCOVERY_PATH)).json();
 assert.deepEqual(Object.keys(descriptor).sort(),['schema','service','edition','id','name','status','online','serverVersion','gameVersion','protocol','playerCount','maxPlayers','map','connection','endpoints'].sort());
 assert.equal(JSON.stringify(descriptor).includes(owner),false);
 assert.equal((await get(DISCOVERY_PATH,{method:'HEAD'})).status,200);
 assert.equal((await get(DISCOVERY_PATH,{method:'POST'})).status,405);
 assert.equal((await get('/health')).status,503);
 for(const path of ['/manager/api/status','/manager/api/logs','/manager/api/settings'])assert.equal((await get(path)).status,401);
 assert.doesNotMatch(await (await get('/manager/')).text(),/data-page="updates"/);

 async function login(id){
  const begin=await get('/manager/auth/steam',{redirect:'manual'});
  const provider=new URL(begin.headers.get('location')),returnTo=provider.searchParams.get('openid.return_to');
  const callback=new URL(returnTo),claim='https://steamcommunity.com/openid/id/'+id;
  const params={
   'openid.ns':'http://specs.openid.net/auth/2.0','openid.mode':'id_res','openid.op_endpoint':steam,
   'openid.claimed_id':claim,'openid.identity':claim,'openid.return_to':returnTo,
   'openid.response_nonce':new Date().toISOString().replace(/\.\d{3}Z$/,'Z')+id,
   'openid.signed':'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle','openid.assoc_handle':'association',
  };
  for(const [k,v] of Object.entries(params))callback.searchParams.set(k,v);
  return fetch(callback,{redirect:'manual',headers:{Cookie:begin.headers.getSetCookie()[0].split(';')[0]}});
 }
 assert.match((await login('76561198000000002')).headers.get('location'),/access_denied/);
 const authorized=await login(owner);
 assert.equal(authorized.headers.get('location'),'/manager/');
 const cookie=authorized.headers.getSetCookie()[0].split(';')[0];
 const me=await (await get('/manager/api/me',{headers:{Cookie:cookie}})).json();
 assert.deepEqual(me.user,{steamId:owner,name:'Truck Driver',avatar});
 assert.equal(me.status.access.role,'owner');
 assert.deepEqual(requests,[steam,steam,profileUrl,profileUrl.replace('?xml=1','/')]);
 assert(manager.logs.items.some(entry=>entry.text==='Steam profile using saved display details (XML: HTTP 429; HTML: HTTP 503).'));
 assert.equal((await get('/manager/api/updates',{headers:{Cookie:cookie}})).status,404);
 assert.equal((await get('/manager/api/birdwatch',{headers:{Cookie:cookie}})).status,404);
 const ready=once(manager.supervisor,'ready');
 const actionHeaders={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-HVMP-CSRF':me.csrf};
 const started=await get('/manager/api/power',{method:'POST',headers:actionHeaders,body:JSON.stringify({action:'start',confirm:true})});
 assert.equal(started.status,200);
 await ready;
 const running=await discoverCommunityServer(origin);
 assert.equal(running.online,true);
 assert.equal(running.gameVersion,GAME_VERSION);
 assert.equal((await get('/health')).status,200);
 assert.equal((await get('/content/manifest')).status,200);
 assert.equal((await (await get('/servers')).json()).servers[0].id,'test-club');
 const player=new WebSocket(running.websocketUrl);
 try{
  const received=once(player,'message');
  await once(player,'open');
  player.send(JSON.stringify({type:'join',protocol:PROTOCOL,gameVersion:GAME_VERSION,name:'RoadTester',room:running.room})+'\n');
  const welcome=JSON.parse(String((await received)[0]).split('\n')[0]);
  assert.equal(welcome.type,'welcome',welcome.code);
  const removed=new Promise(resolve=>player.on('message',buffer=>{
   for(const line of String(buffer).trim().split('\n')){
    const message=JSON.parse(line);
    if(message.type==='error'&&message.code==='kicked')resolve(message);
   }
  }));
  const kick=await get('/manager/api/kick',{method:'POST',headers:actionHeaders,body:JSON.stringify({playerId:welcome.id,reason:'Test guest moderation'})});
  assert.equal(kick.status,200);assert.equal((await kick.json()).ok,true);
  assert.equal((await removed).reason,'Test guest moderation');
 }finally{player.terminate();}
});

test('launcher fetches only the chosen origin and rejects incompatible responses and URLs',async()=>{
 for(const address of ['http://community.example.org','https://user@community.example.org','https://community.example.org/other','https://community.example.org/?token=value']){
  assert.throws(()=>communityOrigin(address),/HTTPS server address/);
 }
 assert.equal(communityOrigin('https://community.example.org/manager/'),'https://community.example.org');
 await assert.rejects(discoverCommunityServer('https://community.example.org',{fetch:async(url,opts)=>{
  assert.equal(url.href,'https://community.example.org'+DISCOVERY_PATH);
  assert.equal(opts.credentials,'omit');assert.equal(opts.redirect,'error');
  return new Response('{}',{status:503});
 }}),/HTTP 503/);
 await assert.rejects(discoverCommunityServer('https://community.example.org',{fetch:async()=>Response.json('x'.repeat(17000))}),/too large/);
 await assert.rejects(discoverCommunityServer('https://community.example.org',{fetch:async()=>Response.json({schema:1,service:'HeavyMP'})}),/incompatible/);
});
