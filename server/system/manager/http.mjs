import {WebSocketServer} from 'ws';
import http from 'node:http';
import {pipeline} from 'node:stream/promises';
import {readServerAsset} from '../runtime-assets.mjs';
import {sameToken} from './auth.mjs';
import {managerMap} from './map-config.mjs';
import {managerAccess,canUseManagerRoute} from './members.mjs';
import {announcementSummary} from '../announcements.mjs';
import {DISCOVERY_PATH,OPTIONAL_ALLOWLIST_HEADER,SERVER_LOGO_PATH,SERVER_LOGO_LIMIT,acceptsOptionalAllowlist,validLogoHash} from '../../shared/discovery.mjs';
import {MAX_ADDON_ORDER_BYTES} from '../../shared/optional-order.mjs';
import {SERVER_PAGE_PATH,SERVER_PAGE_MAX_BYTES,serverPage} from '../../shared/server-page.mjs';
import {DEALER_ICON_BYTES,DEFAULT_DEALER_NAME,dealerBrandingFile,dealerName,readDealerBranding} from '../dealer-branding.mjs';
import {join} from 'node:path';
import {atomicJson,readJson,SerialStore} from './storage.mjs';
const assets=new Map();for(const [path,type]of [['index.html','text/html; charset=utf-8'],['app.js','text/javascript; charset=utf-8'],['style.css','text/css; charset=utf-8'],['taste-motion.css','text/css; charset=utf-8'],['hvmp-mark.svg','image/svg+xml'],['font-manrope.ttf','font/ttf'],['font-manrope-OFL.txt','text/plain; charset=utf-8'],['taste-LICENSE.txt','text/plain; charset=utf-8'],['staff-badge.svg','image/svg+xml']])assets.set('/manager/'+path,{type,path});
for(const path of ['instance-api.mjs','server-picture.mjs','road-map.mjs','map-coordinates.mjs','map-cities.json','live-feed.mjs','admin.mjs','admin-ui.mjs','addon-order-view.mjs','settings-view.mjs','page-search.mjs','advice-model.mjs','text-format.mjs','guide-ui.mjs','drafts.mjs'])assets.set('/manager/'+path,{type:path.endsWith('.json')?'application/json; charset=utf-8':'text/javascript; charset=utf-8',path});
const errors={access_denied:'This Steam account is not authorized for this server.',invalid_login:'Sign-in expired. Please try again.',invalid_assertion:'Steam sign-in could not be verified.',invalid_nonce:'Steam sign-in expired. Please try again.',steam_unavailable:'Steam is temporarily unavailable.',manager_admins_missing:'No administrators configured. Add SteamID64 accounts to this instance’s manager-access.json.',manager_origin_unavailable:'The server is still starting. Please try again shortly.'};
export async function createManagerHttp({host='0.0.0.0',port,auth,supervisor,logs,getOrigin,settings,operations,members,mapDirectory,discovery,instances,logo,dealerEnabled=false,identity}){
 const staticFiles=new Map();for(const [key,a]of assets)staticFiles.set(key,{type:a.type,body:await readServerAsset('manager/assets/'+a.path)});
 const live=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false}),livePeers=new Map();
 const streams=new Set(),connections=new Set(),rates=new Map();let closing=false;
 const pageFile=mapDirectory?join(mapDirectory,'manager','server-page.json'):null,pageWrites=new SerialStore();
 const readPage=async()=>serverPage(pageFile?await readJson(pageFile,{},SERVER_PAGE_MAX_BYTES):{});
 function rate(req){const key=req.socket.remoteAddress??'local',now=Date.now();let e=rates.get(key);if(!e||now-e.at>60000){if(rates.size>=1000)rates.delete(rates.keys().next().value);rates.set(key,e={at:now,n:0});}return ++e.n<=240;}
 const headers=res=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");};
 const json=(res,status,value)=>{if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 const png=(req,res,image,cache)=>{
  res.writeHead(200,{'content-type':'image/png','content-length':image.bytes.length,'cache-control':cache});
  res.end(req.method==='HEAD'?undefined:image.bytes);
 };
 const dealerStatus=({name=DEFAULT_DEALER_NAME,icon=null}={})=>({supported:dealerEnabled&&!!operations,name,hasIcon:Boolean(icon)});
 const redirect=(res,to,cookie)=>{if(cookie)res.setHeader('Set-Cookie',cookie);res.writeHead(303,{location:to});res.end();};
 async function body(req,limit=65536){if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))throw Error('json_required');if(Number(req.headers['content-length'])>limit)throw Error('body_too_large');const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('body_too_large');chunks.push(chunk);}const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw Error('invalid_body');return data;}
 function currentStatus(){const value=supervisor.status();return operations?{...value,operations:{busy:operations.lock.busy||operations.automation.executing,activeSanctions:operations.moderation.get().rules.length,upcoming:operations.automation.get().jobs.filter(j=>j.state==='scheduled').sort((a,b)=>a.at.localeCompare(b.at)).slice(0,3).map(j=>({id:j.id,kind:j.kind,at:j.at})),chatDropped:operations.chat.dropped}}:value;}
 function accessFor(session,scoped=false){
  const access=managerAccess(auth.roleFor(session.profile.steamId));
  if(instances?.primaryDeleted)return !scoped&&access?.role==='owner'?{...access,power:false,pages:['instances']}:null;
  return access?.role==='owner'&&(!instances||scoped)?{...access,pages:access.pages.filter(page=>page!=='instances')}:access;
 }
 const canReadLogs=(session,scoped)=>canUseManagerRoute(accessFor(session,scoped),'GET','logs');
 const sessionStatus=(session,scoped)=>{const access=accessFor(session,scoped);return access?{...currentStatus(),access,instance:instances?.primaryDeleted&&!scoped?null:identity,instanceDashboard:access.role==='owner'&&Boolean(instances||scoped)}:null;};
 function refreshAccess(steamId,removed){
  for(const stream of streams)if(stream.session.profile.steamId===steamId){if(removed)stream.res.end();else stream.push();}
  for(const [ws,peer] of livePeers)if(peer.session.profile.steamId===steamId){if(removed)ws.close(1008);else peer.push();}
 }
 function observe(){if(supervisor.child?.connected)supervisor.child.send({type:'manager-observe'});}
 async function powerGame(action,actor){
  const power=async()=>{await logs.audit(actor,'game.'+action);if(settings&&['start','restart'].includes(action))await settings.prepareStart();return supervisor.power(action);};
  return operations?operations.lock.run(power):power();
 }
 async function handler(req,res,scope=null){headers(res);const url=new URL(req.url,'http://manager.local');
  if((url.pathname==='/'||url.pathname==='/health')&&(req.headers.accept??'').includes('text/html'))return redirect(res,'/manager/');
  if(!url.pathname.startsWith('/manager'))return proxy(req,res);
  if(req.url.length>16384)return json(res,414,{error:'url_too_long'});
  if(url.pathname===DISCOVERY_PATH){
   if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');return json(res,405,{error:'method_not_allowed'});}
   if(instances?.primaryDeleted)return json(res,404,{error:'instance_not_found'});
   res.setHeader('Cache-Control','public, max-age=2');
   res.setHeader('Access-Control-Allow-Origin','*');
   res.setHeader('Vary',OPTIONAL_ALLOWLIST_HEADER);
   const server=discovery();
   return json(res,200,{...server,allowOptionalMods:server.allowOptionalMods&&acceptsOptionalAllowlist(req.headers)});
  }
  if(url.pathname===SERVER_PAGE_PATH){
   if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');return json(res,405,{error:'method_not_allowed'});}
   if(instances?.primaryDeleted)return json(res,404,{error:'instance_not_found'});
   return json(res,200,await readPage());
  }
  if(url.pathname.startsWith(SERVER_LOGO_PATH)){
   if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');return json(res,405,{error:'method_not_allowed'});}
   const hash=url.pathname.slice(SERVER_LOGO_PATH.length),image=logo?.image;
   if(instances?.primaryDeleted||!validLogoHash(hash)||hash!==image?.hash)return json(res,404,{error:'not_found'});
   res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
   return png(req,res,image,'public, max-age=31536000, immutable');
  }
  if(!rate(req))return json(res,429,{error:'rate_limited'});
  if(req.method==='GET'&&url.pathname==='/manager/auth/steam'){
   try{const next=auth.begin();return redirect(res,next.url,next.cookie);}catch(e){return redirect(res,'/manager/?error='+encodeURIComponent(Object.hasOwn(errors,e.message)?e.message:'steam_unavailable'));}
  }
  if(req.method==='GET'&&url.pathname==='/manager/auth/callback'){
   try{const result=await auth.callback(url,req.headers.cookie);await logs.audit(result.session.profile.steamId,'session.login');return redirect(res,'/manager/',result.cookies);}catch(e){logs.record('Manager Steam sign-in refused.','warn','manager');return redirect(res,'/manager/?error='+encodeURIComponent(Object.hasOwn(errors,e.message)?e.message:'invalid_assertion'),auth.cookie('hvmp_login','',0));}
  }
  if(req.method==='GET'&&(['/manager','/manager/'].includes(url.pathname)||staticFiles.has(url.pathname))){
   const a=staticFiles.get(['/manager','/manager/'].includes(url.pathname)?'/manager/index.html':url.pathname);res.writeHead(200,{'content-type':a.type});return res.end(a.body);
  }
  const authenticate=scope?.authenticate??(cookie=>auth.authenticate(cookie));
  const session=scope?.session??await authenticate(req.headers.cookie);
  if(!session)return json(res,401,{error:'authentication_required'});
  const origin=scope?.origin??getOrigin();
  if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:'origin_denied'});
  const route=url.pathname.startsWith('/manager/api/')?url.pathname.slice('/manager/api/'.length):'';
  const selected=url.searchParams.get('instance');
  if(!scope&&instances&&route&&selected!==null){
   if(auth.roleFor(session.profile.steamId)!=='owner')return json(res,403,{error:'permission_denied'});
   if(route==='logout'||route==='instances'||route.startsWith('instances/'))return json(res,404,{error:'not_found'});
   if(!instances.ready)return json(res,503,{error:'instance_registry_unavailable'});
   const context={session,origin,authenticate};
   if(!instances.primaryDeleted&&selected===instances.primary.id)return handler(req,res,context);
   const child=instances.managers.get(selected);
   if(!child)return json(res,404,{error:'instance_not_found'});
   return child.web.handle(req,res,context);
  }
  const allowed=()=>canUseManagerRoute(accessFor(session,Boolean(scope)),req.method,route);
  const permission=allowed();
  if(permission===null)return json(res,404,{error:'not_found'});
  if(!permission)return json(res,403,{error:'permission_denied'});
  const owner=accessFor(session,Boolean(scope))?.role==='owner';
  if(req.method==='GET'&&route==='backups/download'&&operations){
   const id=url.searchParams.get('id');
   const archive=await operations.backups.download(id);
   res.writeHead(200,{'content-type':'application/octet-stream','content-length':archive.bytes,
    'content-disposition':'attachment; filename="HeavyMP-'+id+'.hvmpbackup"'});
   await pipeline(archive.stream,res);
   return;
  }
  if(req.method==='GET'&&route==='me'){observe();return json(res,200,{user:session.profile,csrf:session.csrf,expiresAt:session.expires,status:sessionStatus(session,Boolean(scope))});}
  if(req.method==='GET'&&route==='status'){observe();return json(res,200,sessionStatus(session,Boolean(scope)));}
  if(req.method==='GET'&&route==='instances')return instances.ready?json(res,200,instances.list()):json(res,503,{error:'instance_registry_unavailable'});
  if(req.method==='GET'&&route==='access')return members?json(res,200,members.list()):json(res,503,{error:'access_unavailable'});
  if(req.method==='GET'&&url.pathname==='/manager/api/map'){try{return json(res,200,await managerMap(mapDirectory));}catch{return json(res,400,{error:'invalid_map_config'});}}
  if(req.method==='GET'&&url.pathname==='/manager/api/settings')return settings?json(res,200,await settings.get()):json(res,503,{error:'settings_unavailable'});
  if(req.method==='GET'&&route==='branding')return json(res,200,logo.metadata());
  if(req.method==='GET'&&route==='branding/page')return json(res,200,await readPage());
  if(req.method==='GET'&&route==='branding/logo')return logo.image?png(req,res,logo.image,'no-store'):json(res,404,{error:'not_found'});
  if(req.method==='GET'&&route==='branding/dealer'){
   return json(res,200,dealerStatus(dealerEnabled?await readDealerBranding(mapDirectory):undefined));
  }
  if(req.method==='GET'&&url.pathname==='/manager/api/guidance'){if(!operations?.guidance)return json(res,503,{error:'guidance_unavailable'});if(url.searchParams.get('refresh')==='1'&&Date.now()-(operations.guidance.context?.at??0)>5000)operations.guidance.invalidate();return json(res,200,await operations.guidance.view(session.profile.steamId));}
  if(req.method==='GET'&&operations){
   const routes={scripts:()=>operations.scripts(),addons:()=>operations.addons.get(),backups:()=>operations.backups.list(),automation:()=>operations.automation.get(),moderation:()=>operations.moderation.get(),audit:()=>operations.audit(),diagnostics:()=>operations.diagnostics(),chat:()=>operations.chat.query(Object.fromEntries(url.searchParams))};
   if(Object.hasOwn(routes,route))return json(res,200,await routes[route]());
  }
  if(req.method==='GET'&&url.pathname==='/manager/api/logs'){const after=Number(url.searchParams.get('after')??0);return json(res,200,{entries:logs.since(Number.isSafeInteger(after)?after:0),dropped:logs.dropped});}
  if(req.method==='GET'&&url.pathname==='/manager/api/events'){
   const active=[...streams].filter(s=>s.session===session);if(active.length>=2||streams.size>=20)return json(res,429,{error:'stream_limit'});
   res.writeHead(200,{'content-type':'text/event-stream','connection':'keep-alive','x-accel-buffering':'no','cache-control':'no-store, no-transform'});res.flushHeaders();res.write(': '+ ' '.repeat(2048)+'\nretry: 1000\n\n');
   const send=(type,data)=>{if(res.destroyed||res.writableEnded)return;if(res.writableLength>262144){res.destroy();return;}res.write(`${type==='log'?'id: '+data.id+'\n':''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);};
   let sentState,hadSnapshot;const pushStatus=()=>{const s=sessionStatus(session,Boolean(scope));if(!s){res.end();return;}sentState=s.state;hadSnapshot=!!s.snapshot;send('status',s);};const entry={res,session,push:pushStatus};streams.add(entry);observe();pushStatus();
   const onChange=()=>{if(supervisor.state!==sentState||!!currentStatus().snapshot!==hadSnapshot)pushStatus();};supervisor.on('change',onChange);
   const after=Number(req.headers['last-event-id']??url.searchParams.get('after')??0);if(canReadLogs(session,Boolean(scope)))for(const item of logs.since(Number.isSafeInteger(after)?after:0))send('log',item);
   const onLog=item=>{if(canReadLogs(session,Boolean(scope)))send('log',item);};logs.on('entry',onLog);
   const timer=setInterval(async()=>{if(!await authenticate(req.headers.cookie)){res.end();return;}observe();pushStatus();},2000);
   res.once('close',()=>{clearInterval(timer);logs.off('entry',onLog);supervisor.off('change',onChange);streams.delete(entry);});return;
  }
  if(req.method!=='POST')return json(res,404,{error:'not_found'});
  if(req.headers.origin!==origin||!sameToken(req.headers['x-hvmp-csrf'],session.csrf))return json(res,403,{error:'csrf_denied'});
  if(route==='instances/import-pack'||(route==='backups/import'&&operations)){
   if(route==='instances/import-pack'&&(!instances?.ready||req.headers['x-hvmp-trusted-pack']!=='1'))
    return instances?.ready?json(res,400,{error:'confirmation_required'}):json(res,503,{error:'instance_registry_unavailable'});
   if(req.headers['content-type']!=='application/octet-stream')return json(res,400,{error:'binary_required'});
   req.setTimeout(60000,()=>req.destroy());
   try{return json(res,200,route==='instances/import-pack'?await instances.importPack(req,session.profile.steamId,allowed):
    await operations.backups.upload(req,session.profile.steamId));}
   catch(error){req.resume();throw error;}
   finally{req.setTimeout(0);}
  }
  if(route==='branding/dealer'){
   if(!dealerEnabled||!operations)return json(res,409,{error:'dealer_unavailable'});
   const action=url.searchParams.get('icon');
   if(!['keep','replace','remove'].includes(action)||req.headers['content-type']!=='application/octet-stream'){
    req.resume();return json(res,400,{error:'invalid_dealer_branding'});
   }
   let name;
   try{name=dealerName(url.searchParams.get('name'));}catch{req.resume();return json(res,400,{error:'invalid_dealer_name'});}
   const limit=action==='replace'?DEALER_ICON_BYTES:0,chunks=[];
   let size=0;
   req.setTimeout(15000,()=>req.destroy());
   for await(const chunk of req.iterator({destroyOnReturn:false})){
    size+=chunk.length;
    if(size>limit){req.resume();return json(res,413,{error:'invalid_dealer_branding'});}
    chunks.push(chunk);
   }
   req.setTimeout(0);
   if(!allowed())return json(res,403,{error:'permission_denied'});
   if(size!==limit)return json(res,400,{error:'invalid_dealer_branding'});
   const result=await operations.lock.run(async()=>{
    const icon=action==='replace'?Buffer.concat(chunks,size):action==='keep'?(await readDealerBranding(mapDirectory)).icon:null;
    await logs.audit(session.profile.steamId,'branding.dealer.save',{name,icon:action});
    await atomicJson(dealerBrandingFile(mapDirectory),{schema:1,name,icon:icon?.toString('base64')??null});
    return dealerStatus({name,icon});
   });
   return json(res,200,result);
  }
  if(route==='branding/logo'){
   if(req.headers['content-type']!=='image/png'){req.resume();return json(res,415,{error:'logo_png_required'});}
   if(Number(req.headers['content-length'])>SERVER_LOGO_LIMIT){req.resume();return json(res,413,{error:'logo_too_large'});}
   req.setTimeout(15000,()=>req.destroy());
   const chunks=[];let size=0;
   for await(const chunk of req.iterator({destroyOnReturn:false})){
    size+=chunk.length;
    if(size>SERVER_LOGO_LIMIT){req.resume();return json(res,413,{error:'logo_too_large'});}
    chunks.push(chunk);
   }
   req.setTimeout(0);
   if(!allowed())return json(res,403,{error:'permission_denied'});
   try{return json(res,200,await logo.set(Buffer.concat(chunks,size),session.profile.steamId));}
   catch(error){if(error.message==='invalid_server_logo')return json(res,400,{error:'invalid_server_logo'});throw error;}
  }
  if(operations&&url.pathname==='/manager/api/addons/upload'){
   if(!/^application\/octet-stream(?:;|$)/i.test(req.headers['content-type']??''))return json(res,400,{error:'binary_required'});
   req.setTimeout(60_000,()=>req.destroy());
   return json(res,200,await operations.addons.upload(req,{name:url.searchParams.get('name'),expected:url.searchParams.get('revision')},session.profile.steamId));
  }
  req.setTimeout(30_000,()=>req.destroy());
  const data=await body(req,route==='addons/order'?MAX_ADDON_ORDER_BYTES:route==='branding/page'?SERVER_PAGE_MAX_BYTES:undefined);
  req.setTimeout(0);
  if(!allowed())return json(res,403,{error:'permission_denied'});
  if(route==='branding/page'){
   if(!pageFile)return json(res,503,{error:'server_page_unavailable'});
   let page;
   try{page=serverPage(data);}catch{return json(res,400,{error:'invalid_server_page'});}
   await (operations?.lock??pageWrites).run(async()=>{
    await logs.audit(session.profile.steamId,'branding.page.save');
    await atomicJson(pageFile,page);
   });
   return json(res,200,page);
  }
  if(route==='branding/remove'){
   if(data.confirm!==true)return json(res,400,{error:'confirmation_required'});
   return json(res,200,await logo.set(null,session.profile.steamId));
  }
  if(['instances/create','instances/power','instances/delete','instances/delete-all','instances/rename'].includes(route)){
   const actor=session.profile.steamId;
   const operation=route==='instances/delete-all'?'removeAll':route==='instances/delete'?'remove':route.slice('instances/'.length);
   return json(res,200,await instances[operation](data,actor));
  }
  if(route==='access'){
   if(!members)return json(res,503,{error:'access_unavailable'});
   const actor=session.profile.steamId;
   try{
    const removed=data.action==='remove';
    const result=await members.change(data,actor,()=>logs.audit(actor,'manager.user.'+data.action,{target:data.steamId,...(removed?{}:{role:data.role})}));
    if(removed)auth.revoke(data.steamId);
    refreshAccess(data.steamId,removed);
    return json(res,200,result);
   }catch(e){
    const conflicts=['manager_user_exists','manager_user_missing','operation_busy'];
    const known=['invalid_manager_user','manager_owner_protected','manager_users_limit','permission_denied',...conflicts];
    const code=e.message==='permission_denied'?403:conflicts.includes(e.message)?409:known.includes(e.message)?400:503;
    return json(res,code,{error:known.includes(e.message)?e.message:'access_unavailable'});
   }
  }
  if(url.pathname.startsWith('/manager/api/guidance/')){
   if(!operations?.guidance)return json(res,503,{error:'guidance_unavailable'});const g=operations.guidance,actor=session.profile.steamId;const routes={'preferences':()=>g.preferences(data,actor),'draft':()=>g.draft(data,actor),'preview':()=>g.preview(data),'apply':()=>g.apply(data,actor),'finish':()=>g.finish(data,actor),'workflow':()=>g.workflow(data,actor),'undo-preview':()=>g.undoPreview(data),'undo':()=>g.undo(data,actor)};const route=url.pathname.replace('/manager/api/guidance/','');if(!Object.hasOwn(routes,route))return json(res,404,{error:'not_found'});try{return json(res,200,await routes[route]());}catch(e){const known=['invalid_guidance','invalid_profile','guidance_conflict','guidance_preview_changed','guidance_hosting_override','guidance_no_undo','guidance_undo_conflict','onboarding_closed','guidance_step_not_ready','guidance_limit','confirmation_required','operation_busy','settings_conflict','settings_busy','settings_unavailable','setting_overridden','invalid_setting','env_unsafe','env_unavailable'];return json(res,['guidance_conflict','guidance_preview_changed','guidance_undo_conflict','guidance_no_undo','onboarding_closed','guidance_step_not_ready','operation_busy','settings_conflict','settings_busy'].includes(e.message)?409:400,{error:known.includes(e.message)?e.message:'guidance_save_failed'});}
  }
  if(operations){
   const actor=session.profile.steamId,routes={
    'scripts/toggle':()=>operations.setScript(data,actor),
    'addons/order':()=>operations.addons.save(data,actor,{canEditOptional:accessFor(session)?.role==='owner'}),'addons/remove':()=>operations.addons.remove(data,actor),'addons/quarantine':()=>operations.addons.quarantine(data,actor),
    'backups/create':()=>{if(data.full===true&&!owner)throw Error('permission_denied');return operations.backups.create(data,actor);},
    'backups/restore':()=>operations.backups.restore(data,actor,owner),'backups/delete':()=>operations.backups.remove(data,actor,owner),
    'automation/create':()=>operations.automation.save(data,actor),'automation/delete':()=>operations.automation.remove(data,actor),'automation/toggle':()=>operations.automation.toggle(data,actor),'moderation':()=>operations.moderation.apply(data,actor)
   };
   const route=url.pathname.replace('/manager/api/','');if(Object.hasOwn(routes,route)){const result=await routes[route]();operations.guidance?.invalidate();return json(res,200,result);}
  }
  if(url.pathname==='/manager/api/settings'){if(!settings)return json(res,503,{error:'settings_unavailable'});try{const result=await settings.save(data,session.profile.steamId);operations?.guidance?.invalidate();return json(res,200,result);}catch(e){const codes=['invalid_setting','invalid_settings','setting_not_editable','setting_overridden','settings_busy','settings_conflict','env_invalid','env_unsafe','env_unavailable','permission_denied'];return json(res,e.message==='permission_denied'?403:['settings_conflict','settings_busy','setting_overridden'].includes(e.message)?409:400,{error:codes.includes(e.message)?e.message:'settings_write_failed',...(typeof e.field==='string'&&/^[A-Z0-9_]+$/.test(e.field)?{field:e.field}:{})});}}
  if(url.pathname==='/manager/api/logout'){await logs.audit(session.profile.steamId,'session.logout');res.setHeader('Set-Cookie',auth.logout(req.headers.cookie));return json(res,200,{ok:true});}
  if(url.pathname==='/manager/api/power'){
   if(!['start','restart','stop','kill'].includes(data.action)||data.confirm!==true)return json(res,400,{error:'invalid_action'});
   return json(res,200,await powerGame(data.action,session.profile.steamId));
  }
  if(url.pathname==='/manager/api/console'){
   if(typeof data.line!=='string'||data.line.length>350||/[\u0000-\u001f\u007f]/.test(data.line))return json(res,400,{error:'invalid_command'});
   const match=/^\/?(\S+)(?:\s+(.*))?$/.exec(data.line.trim());if(!match)return json(res,400,{error:'invalid_command'});const command=match[1].toLowerCase();let args;
   if(['annonce','announce'].includes(command)){if(!match[2]||match[2].length>240)return json(res,400,{error:'invalid_announcement'});args={message:match[2]};}
   else if(['fake-call','missions-debug'].includes(command)){if((match[2]??'').length>80)return json(res,400,{error:'invalid_target'});args={target:match[2]??''};}
   else if(command==='help')args={};else return json(res,400,{error:'unknown_command',message:'help · announce <message> · fake-call [player] · missions-debug [player]'});
   await logs.audit(session.profile.steamId,'console.'+command,{argument:match[2]??''});logs.record('❯ '+data.line,'info','console');
   const result=await supervisor.command(command==='announce'?'annonce':command,args);
   const announced=['annonce','announce'].includes(command)&&result.ok;
   const output=result.output??(announced?announcementSummary(result):JSON.stringify(result,null,2));
   logs.record(output,result.ok===false?'warn':'info','console');return json(res,200,announced?{...result,note:output}:result);
  }
  if(url.pathname==='/manager/api/kick'){
   const steam=typeof data.steamId==='string'&&/^\d{17}$/.test(data.steamId);
   const guest=typeof data.playerId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.playerId);
   if(steam===guest||typeof data.reason!=='string'||data.reason.length>160||/[\u0000-\u001f\u007f]/.test(data.reason))return json(res,400,{error:'invalid_target'});
   const target=steam?{steamId:data.steamId}:{playerId:data.playerId};
   await logs.audit(session.profile.steamId,'player.kick',{target:steam?data.steamId:data.playerId,reason:data.reason});
   return json(res,200,await supervisor.command('kick',{...target,reason:data.reason||'Removed by server administrator.'}));
  }
  return json(res,404,{error:'not_found'});
 }
 function proxy(req,res){if(supervisor.state!=='running'||!supervisor.port)return json(res,503,{service:'HeavyMP',version:'1.0.2',online:false,players:0,error:'game_unavailable'});
  const upstream=http.request({host:'127.0.0.1',port:supervisor.port,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);reply.on('error',()=>res.destroy());});upstream.on('error',()=>{if(!res.headersSent)json(res,503,{error:'game_unavailable'});else res.destroy();});res.on('close',()=>upstream.destroy());req.pipe(upstream);
 }
 const server=http.createServer((req,res)=>{void handler(req,res).catch(e=>{if(!res.headersSent){const known=['body_too_large','json_required','game_busy','game_unavailable','unknown_command','console_busy','command_timeout','operation_busy','stop_required','revision_conflict','invalid_module','invalid_module_settings','module_limit','invalid_instance','invalid_action','unsupported_game','instance_id_in_use','instance_port_in_use','instance_origin_in_use','instance_limit','instance_not_found','instance_primary_protected','instance_registry_unavailable','invalid_addon_order','invalid_optional_order','permission_denied','invalid_addon_name','addon_exists','upload_too_large','invalid_archive','addon_limit','quarantine_limit','confirmation_required','invalid_label','backup_limit','backup_too_large','data_changed','sqlite_not_checkpointed','invalid_backup','full_pack_required','backup_corrupt','backup_not_found','schedule_limit','invalid_schedule','schedule_not_found','invalid_moderation','reason_required','invalid_duration','moderation_limit','invalid_query','unsafe_path','unsafe_file'];json(res,['operation_busy','stop_required','revision_conflict','game_busy','game_unavailable','console_busy','instance_id_in_use','instance_port_in_use','instance_origin_in_use','instance_primary_protected'].includes(e.message)?409:e.message==='upload_too_large'?413:e.message==='permission_denied'?403:e.message==='instance_registry_unavailable'?503:400,{error:known.includes(e.message)?e.message:'request_failed'});}else res.end();});});
 server.headersTimeout=10000;server.requestTimeout=2*60*60*1000;server.maxHeadersCount=64;
 server.on('connection',socket=>{connections.add(socket);socket.once('close',()=>connections.delete(socket));if(connections.size>6000)socket.destroy();});
 server.on('upgrade',(req,socket,head)=>{
  if(req.url?.startsWith('/manager/live?')){void (async()=>{const session=await auth.authenticate(req.headers.cookie);if(!session||!accessFor(session)||req.headers.origin!==getOrigin()||livePeers.size>=20||[...livePeers.values()].filter(p=>p.session===session).length>=2){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
   live.handleUpgrade(req,socket,head,ws=>{const send=(type,data)=>{if(ws.readyState!==1)return;if(ws.bufferedAmount>262144){ws.terminate();return;}ws.send(JSON.stringify({type,data}));};const push=()=>{const next=sessionStatus(session);if(next)send('status',next);else ws.close(1008);};livePeers.set(ws,{session,push});const onLog=e=>{if(canReadLogs(session))send('log',e);};let state=supervisor.state,has=!!currentStatus().snapshot;const change=()=>{const next=currentStatus();if(next.state!==state||!!next.snapshot!==has){state=next.state;has=!!next.snapshot;push();}};
    observe();push();const after=Number(new URL(req.url,'http://manager.local').searchParams.get('after')??0);if(canReadLogs(session))for(const e of logs.since(Number.isSafeInteger(after)?after:0))send('log',e);logs.on('entry',onLog);supervisor.on('change',change);const timer=setInterval(async()=>{if(!await auth.authenticate(req.headers.cookie)){ws.close(1008);return;}observe();push();},2000);ws.on('error',()=>{});ws.on('message',()=>ws.close(1008));ws.once('close',()=>{clearInterval(timer);logs.off('entry',onLog);supervisor.off('change',change);livePeers.delete(ws);});
   });})().catch(()=>socket.destroy());return;
  }
  if(req.url!=='/heavymp'||supervisor.state!=='running'||!supervisor.port){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;}
  const upstream=http.request({host:'127.0.0.1',port:supervisor.port,path:req.url,method:req.method,headers:req.headers});
  upstream.on('upgrade',(reply,remote,remoteHead)=>{socket.write('HTTP/1.1 101 Switching Protocols\r\n'+reply.rawHeaders.reduce((s,v,i)=>s+(i%2?v+'\r\n':v+': '),'')+'\r\n');if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);remote.pipe(socket).pipe(remote);remote.on('error',()=>socket.destroy());socket.on('error',()=>remote.destroy());socket.on('close',()=>remote.destroy());});
  upstream.on('response',reply=>{reply.resume();socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');});upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());upstream.end();
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
 return {server,handle:handler,power:powerGame,address:server.address(),async close(){if(closing)return;closing=true;for(const ws of livePeers.keys())ws.terminate();for(const s of streams)s.res.end();for(const socket of connections)socket.destroy();await new Promise(r=>server.close(r));}};
}
export {errors as managerLoginErrors};

