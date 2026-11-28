import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {lstat,mkdir,mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServerManager} from '../server/system/manager/main.mjs';
import {createClient} from '../client/client.mjs';
import {discoverCommunityServer,fetchCommunityLogo} from '../launcher/server-discovery.mjs';
import {OPTIONAL_ALLOWLIST_HEADER,SERVER_LOGO_PATH} from '../server/shared/discovery.mjs';
import {exportBackup} from '../server/system/manager/backup-archive.mjs';

async function reservePorts(){
 const servers=[createServer(),createServer(),createServer()];
 await Promise.all(servers.map(server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))));
 const ports=servers.map(server=>server.address().port);
 await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
 return ports;
}

async function waitForGames(origins,state){
 for(let i=0;i<150;i++){
  const descriptors=await Promise.all(origins.map(async origin=>
   (await fetch(origin+'/manager/api/public/v1/server',{headers:{[OPTIONAL_ALLOWLIST_HEADER]:'1'}})).json()));
  if(descriptors.every(row=>row.status===state))return descriptors;
  await pause(25);
 }
 throw Error('Managed games did not reach '+state);
}

function session(manager,steamId,token){
 const csrf=token.repeat(64),key=csrf;
 const digest=createHash('sha256').update(key).digest('hex');
 const now=Date.now();
 manager.auth.sessions.set(digest,{profile:{steamId},csrf,lastAt:now,expires:now+600000});
 return {Cookie:manager.auth.cookieKey(manager.auth.cookieName)+'='+key,'X-HVMP-CSRF':csrf};
}

test('importing a full pack creates an isolated stopped instance from an empty registry', async t=>{
 const root=await mkdtemp(join(tmpdir(),'heavymp-create-from-pack-'));
 const [port]=await reservePorts();
 const origin='http://127.0.0.1:'+port,steamId='76561198000000001',delegate='76561198000000002';
 const data=join(root,'data'),addons=join(root,'addons'),scripts=join(root,'scripts');
 const manager=await startServerManager({
  HOST:'127.0.0.1',PORT:String(port),SERVER_ID:'test-relay',SERVER_NAME:'Test Relay',
  MANAGER_PUBLIC_URL:origin,MANAGER_ADMIN_STEAM_IDS:steamId,DATA_DIR:data,ADDONS_DIR:addons,
  LOG_DIR:join(root,'logs'),INSTANCE_SCRIPTS_DIR:scripts,
 },{envFile:join(root,'.env')});
 t.after(async()=>{
  await manager.close();
  if(!process.stdin.listenerCount('data'))process.stdin.pause();
  await rm(root,{recursive:true,force:true});
 });
 await mkdir(join(scripts,'custom-module'),{recursive:true});
 await mkdir(addons,{recursive:true});
 await writeFile(join(scripts,'custom-module','index.mjs'),'export const ready = true;');
 await writeFile(join(addons,'asset.scs'),'test content');
 await writeFile(join(data,'manager-users.json'),JSON.stringify({schema:1,users:[{steamId:delegate,role:'operator'}]}));
 const created=await manager.backups.create({label:'Test Relay full server pack',full:true},steamId);
 const {folder,value}=await manager.backups.manifest(created.id);
 const archive=async manifest=>{
  const chunks=[];
  for await(const chunk of exportBackup(folder,manifest).stream)chunks.push(chunk);
  return Buffer.concat(chunks);
 };
 assert.equal(value.server.name,'Test Relay');
 const file=await archive(value);
 await manager.instances.removeAll({confirm:true,revision:manager.instances.list().revision},steamId);
 assert.deepEqual(manager.instances.list().items,[]);
 const endpoint=origin+'/manager/api/instances/import-pack';
 const headers={...session(manager,steamId,'a'),Origin:origin,'Content-Type':'application/octet-stream','X-HVMP-Trusted-Pack':'1'};
 const post=(body,override={})=>fetch(endpoint,{method:'POST',headers:{...headers,...override},body});
 assert.equal((await post(file,{'X-HVMP-Trusted-Pack':'0'})).status,400);
 const corrupt=Buffer.from(file);corrupt[corrupt.length-1]^=0xff;
 assert.equal((await post(corrupt)).status,400);
 assert.deepEqual(await readdir(join(data,'instances')),['instances.json']);
 const response=await post(file);
 assert.equal(response.status,200,await response.clone().text());
 const {instance}=await response.json();
 assert.equal(instance.id,'test-relay');
 assert.equal(instance.name,'Test Relay');
 assert.equal(instance.state,'stopped');
 assert.notEqual(instance.port,port);
 assert.equal(await readFile(join(instance.folder,'addons','asset.scs'),'utf8'),'test content');
 assert.equal(await readFile(join(instance.folder,'scripts','custom-module','index.mjs'),'utf8'),'export const ready = true;');
 assert.equal(manager.instances.managers.get(instance.id).auth.members.roleFor(delegate),'operator');
 const {server:oldIdentity,...legacy}=value;
 const legacyResponse=await post(await archive(legacy));
 assert.equal(legacyResponse.status,200,await legacyResponse.clone().text());
 const second=(await legacyResponse.json()).instance;
 assert.equal(second.id,'test-relay-2');
 assert.equal(second.name,'Test Relay');
 assert.notEqual(second.port,instance.port);
});

test('isolated instances run concurrently and stopped instances can be renamed and removed',{timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'heavymp-instances-'));
 const [primaryPort,firstPort,secondPort]=await reservePorts();
 const origin='http://127.0.0.1:'+primaryPort;
 const first='http://127.0.0.1:'+firstPort,second='http://127.0.0.1:'+secondPort;
 const owner='76561198000000001',admin='76561198000000002';
 const env={SERVER_ID:'primary',SERVER_NAME:'Primary',HOST:'127.0.0.1',PORT:String(primaryPort),
  DATA_DIR:join(root,'data'),LOG_DIR:join(root,'logs'),ADDONS_DIR:join(root,'addons'),
  MAP_MANIFEST:'none',NO_COLLISION_ZONES_ENABLED:'false',MANAGER_PUBLIC_URL:origin,MANAGER_ADMIN_STEAM_IDS:owner};
 let manager=await startServerManager(env);
 t.after(async()=>{
  await manager.close();
  if(!process.stdin.listenerCount('data'))process.stdin.pause();
  await rm(root,{recursive:true,force:true});
 });
 const url=origin+'/manager/api/instances';
 const ownerHeaders={...session(manager,owner,'a'),Origin:origin,'Content-Type':'application/json'};
 manager.auth.members.members.set(admin,'administrator');
 const adminHeaders={...session(manager,admin,'b'),Origin:origin,'Content-Type':'application/json'};
 const post=(path,value,headers=ownerHeaders)=>fetch(url+'/'+path,{method:'POST',headers,body:JSON.stringify(value)});
 assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url,{headers:adminHeaders})).status,403);
 assert.equal((await post('create',{id:'denied',name:'Denied',port:firstPort,game:'ets2'},adminHeaders)).status,403);
 const ats=await post('create',{id:'ats',name:'ATS',port:firstPort,game:'ats'});
 assert.equal((await ats.json()).error,'unsupported_game');
 const create=(id,port)=>post('create',{id,name:id.toUpperCase(),port,game:'ets2'});
 assert.equal((await create('alpha',firstPort)).status,200);
 const duplicate=await create('duplicate',firstPort);
 assert.equal(duplicate.status,409);
 assert.equal((await duplicate.json()).error,'instance_port_in_use');
 assert.equal((await create('beta',secondPort)).status,200);
 const getRegistry=async()=>JSON.parse(await readFile(join(root,'data','instances','instances.json'),'utf8'));
 const listing=async()=>(await fetch(url,{headers:ownerHeaders})).json();
 const saved=await getRegistry();
 const [alphaEntry,betaEntry]=saved.entries;
 assert.deepEqual(saved.entries.map(row=>row.id),['alpha','beta']);
 const childRoot=join(root,'data','instances','instance-alpha-'+alphaEntry.storageId);
 const betaRoot=join(root,'data','instances','instance-beta-'+betaEntry.storageId);
 for(const directory of ['data','addons','scripts','logs']){
  assert((await lstat(join(childRoot,directory))).isDirectory());
  assert((await lstat(join(betaRoot,directory))).isDirectory());
 }
 const firstCookie=(await fetch(first+'/manager/auth/steam',{redirect:'manual'})).headers.getSetCookie()[0];
 const secondCookie=(await fetch(second+'/manager/auth/steam',{redirect:'manual'})).headers.getSetCookie()[0];
 assert(firstCookie.startsWith('hvmp_login-alpha='));
 assert(secondCookie.startsWith('hvmp_login-beta='));
 const firstHeaders={...session(manager.instances.managers.get('alpha'),owner,'c'),Origin:first,'Content-Type':'application/json'};
 const secondHeaders={...session(manager.instances.managers.get('beta'),owner,'d'),Origin:second,'Content-Type':'application/json'};
 const childGet=(origin,route,headers)=>fetch(origin+'/manager/api/'+route,{headers}).then(response=>response.json());
 const settings=await childGet(first,'settings',firstHeaders);
 const scoped=route=>origin+'/manager/api/'+route;
 const selected=(await (await fetch(scoped('status?instance=alpha'),{headers:ownerHeaders})).json());
 assert.deepEqual(selected.instance,{id:'alpha',name:'ALPHA',port:firstPort});
 assert(!selected.access.pages.includes('instances'));
 assert.equal((await fetch(scoped('status?instance=primary'),{headers:ownerHeaders})).status,200);
 assert.equal((await fetch(scoped('settings?instance=alpha'),{headers:adminHeaders})).status,403);
 assert.equal((await fetch(scoped('settings?instance=alpha'),{headers:firstHeaders})).status,401);
 assert.equal((await fetch(scoped('settings?instance=missing'),{headers:ownerHeaders})).status,404);
 const childAdmin='76561198000000003',alphaManager=manager.instances.managers.get('alpha');
 await alphaManager.auth.members.change({action:'add',steamId:childAdmin,role:'administrator'},owner);
 const alphaAdmin={...session(alphaManager,childAdmin,'e'),Origin:first,'Content-Type':'application/json'};
 assert.equal((await fetch(first+'/manager/api/settings',{headers:alphaAdmin})).status,200);
 assert.equal((await fetch(first+'/manager/api/instances',{headers:alphaAdmin})).status,403);
 assert.equal((await fetch(second+'/manager/api/settings',{headers:alphaAdmin})).status,401);
 assert.equal((await fetch(scoped('backups?instance=beta'),{headers:alphaAdmin})).status,401);
 const crossPack=await fetch(scoped('backups/create?instance=alpha'),{
  method:'POST',headers:ownerHeaders,body:JSON.stringify({label:'Alpha Pack',full:true}),
 });
 assert.equal(crossPack.status,200);
 const packId=(await crossPack.json()).id;
 assert.equal((await childGet(first,'backups',firstHeaders)).items[0].id,packId);
 assert.deepEqual((await childGet(second,'backups',secondHeaders)).items,[]);
 assert.equal((await fetch(scoped('backups/download?instance=alpha&id='+packId),{headers:adminHeaders})).status,403);
 const logo=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=','base64');
 const uploadLogo=(bytes,headers=ownerHeaders)=>fetch(scoped('branding/logo?instance=alpha'),{
  method:'POST',headers:{...headers,'Content-Type':'image/png'},body:bytes,
 });
 assert.equal((await uploadLogo(logo,adminHeaders)).status,403);
 assert.equal((await uploadLogo(Buffer.from('<svg></svg>'))).status,400);
 const logoResponse=await uploadLogo(logo);
 assert.equal(logoResponse.status,200);
 const hash=createHash('sha256').update(logo).digest('hex');
 assert.equal((await logoResponse.json()).logo,hash);
 const announced=await discoverCommunityServer(first);
 assert.equal(announced.logo,hash);
 assert.equal(await fetchCommunityLogo(announced),'data:image/png;base64,'+logo.toString('base64'));
 assert.equal((await discoverCommunityServer(second)).logo,null);
 assert.equal((await fetch(second+SERVER_LOGO_PATH+hash)).status,404);
 assert.equal((await fetch(scoped('branding/logo?instance=alpha'),{headers:ownerHeaders})).headers.get('content-type'),'image/png');
 const save=await fetch(scoped('settings?instance=alpha'),{method:'POST',headers:ownerHeaders,body:JSON.stringify({
  revision:settings.revision,changes:{ROOM:'AlphaRoom',ALLOW_OPTIONAL_MODS:true}
 })});
 assert.equal(save.status,200);
 const firstAddons=await childGet(first,'addons',firstHeaders);
 const changed=await fetch(scoped('addons/order?instance=alpha'),{method:'POST',headers:ownerHeaders,body:JSON.stringify({
  revision:firstAddons.revision,order:[],disabled:[],optional:[{name:'Local sound',source:'local',match:'sound.scs',after:null}]
 })});
 assert.equal(changed.status,200);
 assert.deepEqual((await childGet(second,'addons',secondHeaders)).optional,[]);
 const guidance=await childGet(origin,'guidance?instance=alpha',ownerHeaders);
 const savedPreferences=await fetch(scoped('guidance/preferences?instance=alpha'),{method:'POST',headers:ownerHeaders,body:JSON.stringify({
  revision:guidance.revision,advanced:true,
 })});
 assert.equal(savedPreferences.status,200);
 assert.equal((await childGet(origin,'guidance?instance=alpha',ownerHeaders)).preferences.advanced,true);
 assert.equal((await childGet(origin,'guidance?instance=beta',ownerHeaders)).preferences.advanced,false);
 assert.match(await readFile(join(betaRoot,'.env'),'utf8'),/ROOM=beta/);
 const custom=join(childRoot,'scripts','alpha-custom');
 await mkdir(custom,{recursive:true});
 await writeFile(join(custom,'manifest.json'),JSON.stringify({schema:1,id:'alpha-custom',name:'Alpha custom',version:'1.0.0',entry:'main.mjs'}));
 await writeFile(join(custom,'main.mjs'),'export default {};');
 assert((await childGet(first,'scripts',firstHeaders)).items.some(item=>item.id==='alpha-custom'));
 assert(!(await childGet(second,'scripts',secondHeaders)).items.some(item=>item.id==='alpha-custom'));
 assert((await childGet(second,'scripts',secondHeaders)).items.some(item=>item.id==='classic-chat'));
 const power=(id,action)=>post('power',{id,action,confirm:true});
 assert.equal((await power('alpha','start')).status,200);
 assert.equal((await power('beta','start')).status,200);
 const descriptors=await waitForGames([first,second],'running');
 assert.equal(descriptors[0].connection.room,'AlphaRoom');
 assert.equal(descriptors[0].allowOptionalMods,true);
 assert.equal(descriptors[1].connection.room,'beta');
 assert.equal(descriptors[1].allowOptionalMods,false);
 let telemetry;
 for(let attempt=0;attempt<30;attempt++){
  telemetry=await listing();
  if(telemetry.items.filter(row=>row.state==='running').every(row=>Number.isFinite(row.rssMb)))break;
  await pause(25);
 }
 assert(telemetry.host.memoryTotalMb>0);
 assert(telemetry.host.memoryAvailableMb<=telemetry.host.memoryTotalMb);
 assert(telemetry.host.managerRssMb>0);
 assert.equal(telemetry.items[0].rssMb,null);
 for(const instance of telemetry.items.slice(1)){
  assert(instance.rssMb>0);
  assert(Number.isFinite(instance.cpuPercent));
  assert(Number.isFinite(instance.tickMs));
 }
 assert.equal((await fetch(first+'/health')).status,200);
 assert.equal((await fetch(second+'/health')).status,200);
 await assert.rejects(createClient({name:'Local Test',host:'example.test',localWebsocket:true}),/limited to localhost/);
 const joinInstance=async (port,room)=>{
  const client=await createClient({name:'Local Test',host:'127.0.0.1',port,room,localWebsocket:true,
   telemetryPort:0,monitorPort:0,identityDirectory:root});
  try{
   for(let attempt=0;attempt<150&&!client.status.connected;attempt++)await pause(25);
   assert.equal(client.status.connected,true,client.status.error??'Local WebSocket did not join');
  }finally{await client.close();}
 };
 await joinInstance(firstPort,'AlphaRoom');
 await joinInstance(secondPort,'beta');
 const beforeBulk=await listing();
 assert.equal((await post('delete-all',{revision:beforeBulk.revision,confirm:true})).status,409);
 assert.equal((await listing()).items.length,3);
 const busy=await post('delete',{id:'alpha',confirm:true});
 assert.equal(busy.status,409);
 assert.equal((await busy.json()).error,'stop_required');
 assert.equal((await post('rename',{id:'alpha',name:'Alpha Renamed'})).status,409);
 assert.equal((await post('rename',{id:'primary',name:'Primary Renamed'})).status,409);
 assert.equal((await post('rename',{id:'alpha',name:'Alpha Renamed'},adminHeaders)).status,403);
 assert.equal((await post('delete',{id:'alpha',confirm:true},adminHeaders)).status,403);
 assert.equal((await power('alpha','stop')).status,200);
 assert.equal((await fetch(first+'/health')).status,503);
 assert.equal((await fetch(second+'/health')).status,200);
 assert.equal((await post('rename',{id:'alpha',name:'Alpha Renamed'})).status,200);
 const renamed=(await getRegistry()).entries.find(row=>row.id==='alpha');
 assert.equal(renamed.storageId,alphaEntry.storageId);
 assert.equal((await childGet(first,'public/v1/server',{})).name,'Alpha Renamed');
 assert.equal((await discoverCommunityServer(first)).logo,hash);
 assert.equal((await childGet(second,'public/v1/server',{})).name,'BETA');
 assert.equal((await post('delete',{id:'alpha',confirm:false})).status,400);
 assert.equal((await post('delete',{id:'alpha',confirm:true})).status,200);
 assert.deepEqual((await getRegistry()).entries.map(row=>row.id),['beta']);
 await assert.rejects(fetch(first+'/health'));
 assert.match(await readFile(join(childRoot,'.env'),'utf8'),/ROOM=AlphaRoom/);
 assert.match(await readFile(join(childRoot,'addons','order.json'),'utf8'),/sound\.scs/);
 assert.equal((await fetch(second+'/health')).status,200);
 assert.equal((await create('alpha',firstPort)).status,200);
 const recreated=(await getRegistry()).entries.find(row=>row.id==='alpha');
 assert.notEqual(recreated.storageId,alphaEntry.storageId);
 const freshRoot=join(root,'data','instances','instance-alpha-'+recreated.storageId);
 assert.match(await readFile(join(freshRoot,'.env'),'utf8'),/ROOM=alpha/);
 assert.equal((await discoverCommunityServer(first)).logo,null);
 await manager.close();
 manager=await startServerManager(env);
 const restored=await waitForGames([first,second],'stopped');
 assert.deepEqual(restored.map(row=>row.id),['alpha','beta']);
 const renewed={...session(manager,owner,'e'),Origin:origin,'Content-Type':'application/json'};
 const current=async()=>(await (await fetch(url,{headers:renewed})).json());
 assert.equal((await post('delete-all',{revision:'old',confirm:true},renewed)).status,409);
 assert.equal((await post('delete',{id:'primary',confirm:true},renewed)).status,200);
 assert.equal((await fetch(scoped('public/v1/server'))).status,404);
 assert.equal((await fetch(scoped('power'),{method:'POST',headers:renewed,body:JSON.stringify({action:'start',confirm:true})})).status,403);
 assert.deepEqual((await (await fetch(scoped('status'),{headers:renewed})).json()).access.pages,['instances']);
 assert.equal((await post('delete-all',{revision:(await current()).revision,confirm:true},renewed)).status,200);
 assert.deepEqual((await current()).items,[]);
 assert.deepEqual(await getRegistry(),{schema:1,primaryDeleted:true,entries:[]});
 await assert.rejects(fetch(first+'/health'));
 await assert.rejects(fetch(second+'/health'));
 assert.match(await readFile(join(childRoot,'addons','order.json'),'utf8'),/sound\.scs/);
 await manager.close();
 manager=await startServerManager(env);
 assert.deepEqual(manager.instances.list().items,[]);
 const afterRestart={...session(manager,owner,'f'),Origin:origin,'Content-Type':'application/json'};
 assert.equal((await post('create',{id:'primary',name:'New Relay',port:firstPort,game:'ets2'},afterRestart)).status,200);
 assert.equal((await (await fetch(scoped('status?instance=primary'),{headers:afterRestart})).json()).instance.name,'New Relay');
});
