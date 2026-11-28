import {managerApi,selectedInstance,setInstance} from './instance-api.mjs';
import {createGuide} from './guide-ui.mjs';
import {formatText} from './text-format.mjs';
import {BASIC_SETTINGS} from './advice-model.mjs';
import {openPageSearch} from './page-search.mjs';
import {settingsMarkup} from './settings-view.mjs';
import {createDealerPicture,createServerPageEditor,createServerPicture} from './server-picture.mjs';
import {createAdminViews,adminPages} from './admin.mjs';
import {confirmAction,promptText,download,dialog} from './admin-ui.mjs';
import {LiveFeed} from './live-feed.mjs';
import {RoadMap} from './road-map.mjs';
let roadMap=new RoadMap(),guide=null,pendingSetting=null;
const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const instanceList=$('#instance-navigation'),instancePages=$('#instance-pages'),mainNav=$('#navigation');
let instanceRows=[],navVersion='',scopeEpoch=0,scopeRequests=new AbortController(),switching=false,pendingWrites=0;
const brandingActions={api,getCsrf:()=>csrf,write:async task=>{pendingWrites++;try{return await task();}finally{pendingWrites--;}}};
const syncServerPicture=createServerPicture(brandingActions);
const syncDealerPicture=createDealerPicture(brandingActions);
const syncServerPage=createServerPageEditor(brandingActions);

function setInstances(items){
 instanceRows=items;
 const dashboard=status?.instanceDashboard===true;
 const version=JSON.stringify([dashboard,selectedInstance,items.map(({id,name,managerUrl})=>[id,name,Boolean(managerUrl)])]);
 if(version===navVersion)return;
 navVersion=version;
 const focused=document.activeElement?.dataset.serverId;
 mainNav.append(instancePages);
 instanceList.innerHTML=dashboard?items.map(({id,name,managerUrl})=>{
  const expanded=id===selectedInstance;
  return `<li><button type="button" class="instance-select" data-server-id="${esc(id)}" aria-expanded="${expanded}" ${expanded?'aria-controls="instance-pages"':''} ${managerUrl?'':'disabled'} title="${esc(name)}"><i data-icon="truck"></i><span class="nav-text">${esc(name)}</span><i class="instance-chevron" data-icon="chevron-right"></i></button></li>`;
 }).join(''):'';
 instanceList.hidden=!dashboard||!items.length;
 const selected=[...instanceList.querySelectorAll('[data-server-id]')].find(button=>button.dataset.serverId===selectedInstance);
 selected?.parentElement.append(instancePages);
 instancePages.hidden=dashboard&&!selected;
 icons(instanceList);
 if(focused)[...instanceList.querySelectorAll('[data-server-id]')].find(button=>button.dataset.serverId===focused)?.focus({preventScroll:true});
 requestAnimationFrame(updateNavScroll);
}

function workspaceUrl(id,section){
 const url=new URL(location.href);
 if(id===null)url.searchParams.delete('instance');else url.searchParams.set('instance',id);
 url.searchParams.delete('embedded');url.searchParams.delete('error');url.hash=section;
 return url;
}

async function openInstance(id,section=id===null?'instances':'overview',{historyMode='push'}={}){
 if(switching||!status?.instanceDashboard)return;
 if(id===selectedInstance){if(location.hash!=='#'+section)location.hash=section;return;}
 if(pendingWrites||powerBusy||settingsSaving||adminViews.isUploading()){
  if(historyMode==='replace')history.replaceState(null,'',workspaceUrl(selectedInstance,page));
  notice('Wait for the current operation to finish before switching servers.');return;
 }
 switching=true;
 try{
  if((Object.keys(settingsDraft).length||adminViews.hasUnsaved())&&
     !await confirmAction('Switch servers?','Unsaved changes will be discarded.',false)){
   if(historyMode==='replace')history.replaceState(null,'',workspaceUrl(selectedInstance,page));return;
  }
  const next=await api('status',undefined,id);
  if(!next?.access||id!==null&&next.instance?.id!==id)throw Error('That server instance is unavailable.');
  if(pendingWrites||powerBusy||settingsSaving||adminViews.isUploading())throw Error('Wait for the current operation to finish before switching servers.');
  guide?.drafts?.clear('settings');adminViews.discard();adminViews.leave();
  stopStatusFallback();stream?.close();stream=null;roadMap.pause();roadMap=new RoadMap();
  scopeRequests.abort();scopeRequests=new AbortController();scopeEpoch++;
  setInstance(id);
  history[historyMode==='replace'?'replaceState':'pushState'](null,'',workspaceUrl(id,section));
  entries=[];consoleHistory=[];consoleHistoryIndex=0;consolePaused=false;lastStreamStatus=0;
  settingsData=null;settingsDraft={};settingsLoading=false;settingsLoadedPid=null;settingsQuery='';settingsSelectedGroup='Access';pendingSetting=null;
  status=next;access=null;
  configureGuide();applyAccess(next.access);setInstances(instanceRows);
  lastHttpStatus=Date.now();connected=true;
  await navigate();updateStatus();connect();startStatusFallback();
  if(canPage('help'))startGuide();
  setSidebar(false);window.scrollTo(0,0);$('#content').focus({preventScroll:true});
 }catch(error){
  if(historyMode==='replace')history.replaceState(null,'',workspaceUrl(selectedInstance,page));
  if(user)notice(error.message==='instance_not_found'?'That server instance has been removed.':error.message);
 }finally{switching=false;}
}
const iconPaths={'chevron-left':'m15 6-6 6 6 6','chevron-right':'m9 6 6 6-6 6',lifebuoy:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8M5.6 5.6l3.6 3.6m5.6 5.6 3.6 3.6M5.6 18.4l3.6-3.6m5.6-5.6 3.6-3.6','panel-left':'M4 3h16v18H4zM9 3v18m7-13-3 4 3 4',search:'m21 21-4.5-4.5M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16',menu:'M4 6h16M4 12h16M4 18h16',archive:'M3 4h18v4H3zm2 4v13h14V8m-9 5h4',calendar:'M5 5h14a2 2 0 0 1 2 2v13H3V7a2 2 0 0 1 2-2M7 3v4m10-4v4M3 11h18',shield:'m12 3 8 4v6c0 4-8 8-8 8s-8-4-8-8V7zm-4 9 3 3 5-6',activity:'M3 12h4l3-8 4 16 3-8h4',message:'M4 4h16v12H8l-4 4zm4 4h8m-8 4h5',clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 4v5l3 2',truck:'M3 6h11v11H3zm11 4h4l3 4v3h-7M6 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4m12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4',grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',terminal:'m5 7 5 5-5 5m8 0h6',users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8 0a4 4 0 0 1 0 8',map:'m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zm6-3v15m6-12v15',list:'M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1',box:'m12 3 9 5v9l-9 5-9-5V8zm-9 5 9 5 9-5m-9 5v9m-4-17 9 5',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',logout:'M10 4H4v16h6m4-12 4 4-4 4m-5-4h12',play:'m7 4 14 8-14 8z',refresh:'M20 7v5h-5M4 17v-5h5m10-3a8 8 0 0 0-13-4m-1 10a8 8 0 0 0 13 4',stop:'M5 5h14v14H5z',x:'m6 6 12 12M6 18 18 6'};
function icons(root=document){for(const button of root.querySelectorAll('.button'))button.classList.add('btn');for(const n of root.querySelectorAll('[data-icon]'))n.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPaths[n.dataset.icon]??iconPaths.grid}"/></svg>`;decorateTables(root);}icons();
const pages={help:['Help & preferences','Guided operations, community profiles and your personal view.'],...adminPages,overview:['Overview','Your server, at a glance.'],console:['Console','Live output and HeavyMP commands.'],players:['Players','Everyone connected to this server.'],map:['Live map','Live player positions in the ETS2 world.'],logs:['Logs','Find the events you need, without the noise.'],addons:['Addons','Resources published by this server.'],settings:['Settings','Edit this server’s configuration.']};
let user=null,csrf='',status=null,access=null,entries=[],stream=null,connected=false,page='overview',powerBusy=false,logFilter='',logLevel='all',playerFilter='',noticeTimer;
const canPage=id=>status?.instanceDashboard&&selectedInstance===null?id==='instances':access?.pages.includes(id)===true;
const hashPage=()=>{const id=location.hash.slice(1);if(status?.instanceDashboard&&selectedInstance===null)return 'instances';return Object.hasOwn(pages,id)&&canPage(id)?id:'overview';};
function applyAccess(next){
 if(access?.role===next?.role&&access?.pages.join(',')===next?.pages.join(','))return;
 const hadHelp=canPage('help'),hadLogs=canPage('logs');
 access=next??null;
 $('#account-role').textContent=access?.label??'';
 $('#guide-menu').hidden=$('#sidebar-size').hidden=!canPage('help');
 mainNav.querySelector('[data-page="instances"]').hidden=!status?.instanceDashboard;
 let label=null,visible=false;
 for(const node of instancePages.children){
  if(node.classList.contains('nav-label')){if(label)label.hidden=!visible;label=node;visible=false;}
  if(node.dataset.page){node.hidden=!canPage(node.dataset.page);visible||=!node.hidden;}
 }
 if(label)label.hidden=!visible;
 if(hadHelp&&!canPage('help')){guide.reset();applyNavigation();}
 if(hadLogs&&!canPage('logs')){entries=[];consoleHistory=[];}
 if(hadLogs!==canPage('logs')&&stream)connect();
 if(!canPage(page)&&!switching&&status)void navigate();
 requestAnimationFrame(updateNavScroll);
}
const num=(n,d=0)=>Number.isFinite(n)?n.toLocaleString('en-GB',{maximumFractionDigits:d}):'—';
const size=n=>n>=1073741824?(n/1073741824).toFixed(2)+' GB':n>=1048576?(n/1048576).toFixed(1)+' MB':num(n/1024,1)+' KB';
const time=stamp=>stamp?new Date(stamp).toLocaleTimeString('en-GB',{hour12:false}):'—';
const uptime=stamp=>{if(!stamp)return '—';const s=Math.floor((Date.now()-stamp)/1000);return s>=3600?Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m':s>=60?Math.floor(s/60)+'m '+s%60+'s':s+'s';};
function notice(text){$('#notice').textContent=formatText(text);$('#notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#notice').hidden=true,5000);}
async function api(path,data,instance=selectedInstance){
 const signal=scopeRequests.signal;
 const write=data!==undefined;
 if(write)pendingWrites++;
 try{
  const timeout=path==='backups/create'||path==='backups/restore'?2*60*60*1000:path==='status'?3500:15000;
  const r=await fetch(managerApi(path,instance),{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(timeout)]),...(write?{method:'POST',headers:{'content-type':'application/json','x-hvmp-csrf':csrf},body:JSON.stringify(data)}:{})});
  let body;try{body=await r.json();}catch{signal.throwIfAborted();throw Error('The server returned an unreadable response.');}
  signal.throwIfAborted();
  if(r.status===401){login();throw Error('Please sign in again.');}
  if(!r.ok)throw Error(({game_busy:'Another server operation is in progress.',game_unavailable:'The game server is not running.',csrf_denied:'Your session changed. Refresh and try again.',unknown_command:'Use help, annonce, fake-call or missions-debug.',request_failed:'The request could not be completed.',rate_limited:'Too many requests. Please wait a moment.'})[body.error]??body.message??body.error??'Request failed.');
  return body;
 }finally{if(write)pendingWrites--;}
}
function login(){void syncServerPicture(false);void syncDealerPicture(false);void syncServerPage(false);stopStatusFallback();stream?.close();stream=null;user=null;access=null;entries=[];status=null;settingsData=null;settingsDraft={};adminViews.leave();roadMap.pause();$('#content').replaceChildren();guide?.reset();$('#workspace').hidden=true;$('#login').hidden=false;const code=new URL(location.href).searchParams.get('error');const messages={invalid_login:'Sign-in expired. Please try again.',invalid_assertion:'Steam sign-in could not be verified.',invalid_nonce:'Steam sign-in expired. Please try again.',access_denied:'This Steam account is not authorized for this server.',steam_unavailable:'Steam is temporarily unavailable.',manager_admins_missing:'No administrator has been configured for this instance yet.',manager_origin_unavailable:'The server is still starting. Please try again shortly.'};$('#login-error').hidden=!code;$('#login-error').textContent=messages[code]??'Sign-in could not be completed. Please try again.';}
function renderAccount(profile){
 const name=$('#account-name'),avatar=$('#avatar');
 name.textContent=profile.name;
 name.title=profile.name;
 const initials=Array.from(profile.name).slice(0,2).join('').toUpperCase();
 avatar.textContent=initials;
 if(!profile.avatar)return;
 const image=new Image();
 image.alt='';
 image.referrerPolicy='no-referrer';
 image.addEventListener('error',()=>{if(image.parentNode===avatar)avatar.textContent=initials;},{once:true});
 image.src=profile.avatar;
 avatar.replaceChildren(image);
}
async function init(){
 try{
  let me;
  try{me=await api('me');}
  catch(error){
   if(selectedInstance===null||error.message!=='instance_not_found')throw error;
   setInstance(null);history.replaceState(null,'',workspaceUrl(null,'instances'));me=await api('me');
  }
  user=me.user;csrf=me.csrf;
  let meta=document.querySelector('meta[name="hvmp-csrf"]');
  if(!meta){meta=document.createElement('meta');meta.name='hvmp-csrf';document.head.append(meta);}
  meta.content=csrf;$('#login').hidden=true;$('#workspace').hidden=false;renderAccount(user);
  status=me.status??await api('status');configureGuide();applyNavigation();applyAccess(status.access);
  if(status.instanceDashboard&&selectedInstance!==null){
   setInstances([{...status.instance,managerUrl:true}]);
   const epoch=scopeEpoch;
   void api('instances',undefined,null).then(({items})=>{if(epoch===scopeEpoch)setInstances(items);}).catch(()=>{});
  }
  lastHttpStatus=Date.now();connected=true;await navigate();updateStatus();connect();startStatusFallback();if(canPage('help'))startGuide();
 }catch{login();}
}
function connect(){if(!user||document.hidden)return;stream?.close();stream=new LiveFeed(managerApi('events?after='+(entries.at(-1)?.id??0)));stream.onopen=()=>{connected=true;$('#connection-error').hidden=true;updatePower();};stream.onerror=()=>{if(Date.now()-lastHttpStatus<6000)return;connected=false;$('#connection-error').hidden=false;$('#connection-error').textContent='Connection interrupted. Reconnecting automatically; the last received data is shown.';updatePower();};stream.addEventListener('log',e=>{if(!canPage('logs'))return;let item;try{item=JSON.parse(e.data);}catch{return;}if(entries.some(n=>n.id===item.id))return;entries.push(item);if(entries.length>1500)entries.shift();if(page==='console')appendLog(item);if(page==='logs')scheduleLogs();});stream.addEventListener('status',e=>{try{lastStreamStatus=Date.now();acceptStatus(JSON.parse(e.data));}catch{notice('Server data could not be read.');}});}
let statusTimer=null,lastStreamStatus=0,lastHttpStatus=0,statusRequestPending=false;
function acceptStatus(next){if(!user||!next?.state)return;if(Number.isFinite(next.revision)&&Number.isFinite(status?.revision)&&next.revision<status.revision)return;const hadHelp=canPage('help');status=next;applyAccess(next.access);updateStatus();if(!hadHelp&&canPage('help'))startGuide();}
function stopStatusFallback(){clearInterval(statusTimer);statusTimer=null;}
function startStatusFallback(){stopStatusFallback();if(!user||document.hidden)return;statusTimer=setInterval(async()=>{if(!user||document.hidden||statusRequestPending||Date.now()-lastStreamStatus<3500)return;statusRequestPending=true;const epoch=scopeEpoch;try{const next=await api('status');if(!user||document.hidden||epoch!==scopeEpoch)return;lastHttpStatus=Date.now();acceptStatus(next);connected=true;$('#connection-error').hidden=true;updatePower();}catch(error){if(user&&epoch===scopeEpoch){if(error.message==='instance_not_found'&&selectedInstance!==null)void openInstance(null);else{connected=false;updatePower();}}}finally{statusRequestPending=false;}},2000);}
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopStatusFallback();stream?.close();stream=null;roadMap.pause();}else{connect();startStatusFallback();if(user&&page==='map')void roadMap.bind($('#content'));}});
$('#logout').onclick=async()=>{try{await api('logout',{});entries=[];status=null;settingsData=null;settingsDraft={};login();}catch(e){notice(e.message);}};
mainNav.onclick=e=>{
 const server=e.target.closest('[data-server-id]');
 if(server)return void openInstance(server.getAttribute('aria-expanded')==='true'?null:server.dataset.serverId);
 const button=e.target.closest('[data-page]');
 if(!button)return;
 if(button.dataset.page==='instances')return void openInstance(null);
 location.hash=button.dataset.page;setSidebar(false);
};
window.addEventListener('popstate',()=>{
 const wanted=new URLSearchParams(location.search).get('instance');
 if(wanted!==selectedInstance)void openInstance(wanted,location.hash.slice(1)||undefined,{historyMode:'replace'});
});
window.addEventListener('hashchange',()=>{if(!switching&&new URLSearchParams(location.search).get('instance')===selectedInstance)void navigate();});
async function navigate(){if(!user)return;const target=hashPage();if(target!==page&&(Object.keys(settingsDraft).length||adminViews.hasUnsaved())){if(!await confirmAction('Discard unsaved changes?','Leave this page without saving your changes?',false)){history.replaceState(null,'','#'+page);return;}guide?.drafts?.clear('settings');settingsDraft={};adminViews.discard();}page=hashPage();void syncServerPicture(page==='settings');void syncDealerPicture(page==='settings'&&access?.role==='owner');void syncServerPage(page==='settings'&&access?.role==='owner');if(location.hash&&location.hash!=='#'+page)history.replaceState(null,'','#'+page);document.documentElement.dataset.managerPage=page;const [name,description]=pages[page];$('#breadcrumb').textContent=formatText(name);$('#page-title').textContent=formatText(name);$('#page-description').textContent=formatText(description);$('#page-eyebrow').textContent=status?.meta?.serverId?.toUpperCase()??'SERVER WORKSPACE';document.title=name+' · HVMP Server Manager';for(const n of document.querySelectorAll('[data-page]')){n.classList.toggle('active',n.dataset.page===page);n.setAttribute('aria-current',n.dataset.page===page?'page':'false');n.setAttribute('aria-label',formatText(pages[n.dataset.page]?.[0]??n.textContent));n.title=formatText(pages[n.dataset.page]?.[0]??n.textContent);}render();if(canPage('help'))guide.visit(page);if(document.documentElement.dataset.navigation==='horizontal')$('#navigation button.active')?.scrollIntoView({block:'nearest',inline:'nearest'});requestAnimationFrame(updateNavScroll);}
function updatePower(){document.documentElement.dataset.connected=String(connected);$('#power-controls').hidden=!access?.power;for(const b of document.querySelectorAll('[data-power]')){const state=status?.state;b.hidden=b.dataset.power==='start'?!!state&&!['stopped','crashed'].includes(state):['stopped','crashed'].includes(state);b.disabled=!connected||powerBusy||settingsSaving||status?.busy||status?.operations?.busy||(b.dataset.power==='start'?!['stopped','crashed'].includes(state):b.dataset.power==='restart'?state!=='running':!status?.pid);}}
$('#power-controls').onclick=async e=>{const button=e.target.closest('[data-power]');if(!button||button.disabled)return;const action=button.dataset.power;if(action!=='start'&&!await confirmAction(`${action[0].toUpperCase()+action.slice(1)} the game server?`,formatText('{count} players currently connected. They will disconnect. The Manager stays available.',{count:status?.snapshot?.health?.players??'—'})))return;powerBusy=true;updatePower();try{await api('power',{action,confirm:true});notice(action==='start'?'Starting game server…':action==='restart'?'Restarting game server…':'Game server stopped.');acceptStatus(await api('status'));}catch(error){notice(error.message);}finally{powerBusy=false;updatePower();}};
function updateStatus(){if(!status)return;$('#ets2-version').textContent='ETS2 '+(status.snapshot?.health?.gameVersion||'—');$('#top-status').className='badge '+status.state;$('#top-status').textContent=status.state[0].toUpperCase()+status.state.slice(1);$('#instance-title').textContent=status.instance?.name??status.meta?.name??'HeavyMP';$('#instance-identifier').textContent=status.instance?status.instance.id+' · Port '+status.instance.port:status.meta?.serverId??'—';const h=status.snapshot?.health;$('#server-population').textContent=h?formatText('{count} / {max} players',{count:num(h.players),max:num(h.maxPlayers)}):'Waiting for game';$('#nav-count').textContent=status.snapshot?.health.players??0;$('#footer-name').textContent='HVMP Server Manager · '+(status.instance?.id??status.meta?.serverId??'instance');$('#updated').textContent=status.sampledAt?formatText('Updated {time}',{time:time(status.sampledAt)}):'Waiting for game process';$('#page-eyebrow').textContent=status.meta?.serverId?.toUpperCase()??'SERVER WORKSPACE';updatePower();if(page==='overview'&&!document.querySelector('dialog[open]'))render();adminViews.update();if(page==='settings'&&settingsData&&!settingsLoading&&!settingsSaving&&!Object.keys(settingsDraft).length&&status.state==='running'&&status.pid!==settingsLoadedPid)void loadSettings();if(page==='players')renderPlayers();if(page==='console')updateConsoleInspector();if(page==='map')roadMap.update(status.snapshot?.players??[]);guide?.tick();}
function panel(title,subtitle,body,extra=''){title=title.toLowerCase().replace(/^./,c=>c.toUpperCase()).replace(/\b(cpu|ram|ets2|ai|utc)\b/g,w=>w.toUpperCase());return `<section class="panel"><div class="panel-head"><div><span class="panel-title">${title}</span>${subtitle?`<div class="panel-sub">${subtitle}</div>`:''}</div>${extra}</div>${body}</section>`;}
function empty(title,detail=''){return `<div class="empty"><strong>${title}</strong>${detail}</div>`;}
function metric(label,value,note){return `<div class="metric"><span class="metric-label">${label.toLowerCase().replace(/^./,c=>c.toUpperCase()).replace(/\b(cpu|ram|p95)\b/g,w=>w.toUpperCase())}</span><strong class="metric-value">${value}</strong><span class="metric-note">${note}</span></div>`;}
function overview(){const snapshot=status?.snapshot,h=snapshot?.health,m=h?.metrics??{},p=snapshot?.process,history=status?.history??[];
 const cards=`<div class="metrics">${metric('Players online',h?num(h.players)+` <small>/ ${num(h.maxPlayers)}</small>`:'—','Connected players')}${metric('CPU usage',num(p?.cpuPercent,1)+'<small>%</small>','Game process · one core')}${metric('Memory',p?num(p.rssMb)+'<small> MB</small>':'—','Resident server memory')}${metric('Uptime',status?.pid?uptime(status.startedAt):'—','Since the last start')}</div>`;
 const facts=[['Server ID',status?.meta?.serverId],['Game version',h?.gameVersion],['Tick rate',h?num(h.tickHz)+' Hz':null],['Nearby players',h?.nearbyLimit],['AI traffic',h?h.traffic?.enabled?'Enabled':'Disabled':null],['Collisions',h?h.capabilities?.collisions?'Enabled':'Disabled':null],['Missions',h?.missions?.mode]];
 const chart=panel('Resource usage','CPU activity over recent samples',`<div class="panel-body"><div class="spark-summary"><span>CPU <b>${num(p?.cpuPercent,1)}%</b></span><span>Tick work <b>${num(m.lastTickMs,1)} ms</b></span><span>Manager <b>${num(status?.managerMemoryMb)} MB</b></span></div>${graph(history)}</div>`,`<a class="button small" href="#performance">View performance</a>`);
 const details=panel('Server configuration','Currently loaded values',`<div class="panel-body facts">${facts.map(([name,value])=>`<div class="fact"><span>${name}</span><strong>${esc(value??'—')}</strong></div>`).join('')}</div>`);
 const activity=entries.slice(-6).reverse().map(e=>`<div class="activity"><time>${time(e.at)}</time><span class="badge ${e.level==='error'?'bad':e.level==='warn'?'starting':''}">${esc(e.level)}</span><p>${esc(e.text)}</p></div>`).join('');
 const alerts=[];if(status?.state==='crashed')alerts.push('The game process stopped unexpectedly. Check the console before restarting.');if((m.eventLoopP95Ms??0)>100)alerts.push('Event loop delay is elevated.');if(h&&(m.lastTickMs??0)>1000/h.tickHz)alerts.push('Tick work exceeded the current budget.');const next=canPage('automation')?status?.operations?.upcoming?.[0]:null;
 const note=alerts.length?`<div class="callout warning"><strong>Server needs attention</strong><span>${esc(alerts.join(' '))}</span></div>`:next?`<div class="callout"><strong>Next scheduled ${esc(next.kind)}</strong><span>${esc(new Date(next.at).toLocaleString('en-GB'))} · <a href="#automation">View schedules</a></span></div>`:'';
 return (canPage('help')?guide.home():'')+cards+`<div class="overview-technical advanced-only">`+note+`<div class="grid-two">${chart}${details}</div>`+(canPage('logs')?panel('Recent activity','Latest server events',`<div class="panel-body">${activity||empty('No activity yet','Events will appear as the server runs.')}</div>`,`<a class="button small" href="#logs">View logs</a>`):'')+`</div>`;
}
function graph(points){if(points.length<2)return empty('Collecting performance samples','This chart fills with live server measurements.');const items=points.slice(-150),max=Math.max(100,...items.map(n=>n.cpu)),w=620,height=155,x=i=>35+i*(w-45)/(items.length-1),y=v=>height-10-v/max*(height-30),path=items.map((v,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(v.cpu).toFixed(1)).join(' ');return `<svg class="chart" viewBox="0 0 640 190" role="img" aria-label="Game process CPU usage over time">${[0,.5,1].map(t=>`<path class="gridline" d="M35 ${y(max*t)}H${w}"/><text x="0" y="${y(max*t)+3}">${Math.round(max*t)}%</text>`).join('')}<path class="fill" d="${path}L${w} ${y(0)}H35Z"/><path class="line" d="${path}"/><text x="35" y="180">${time(items[0].at)}</text><text x="563" y="180">${time(items.at(-1).at)}</text></svg>`;}
let consolePaused=false,consoleHistory=[],consoleHistoryIndex=0;
function decorateTables(root){for(const table of root.querySelectorAll('table')){const labels=[...table.querySelectorAll('thead th')].map(n=>n.textContent);for(const row of table.querySelectorAll('tbody tr'))[...row.children].forEach((td,i)=>{if(labels[i])td.dataset.label=labels[i];});}}
const navigationMedia=window.matchMedia('(max-width:900px)');let navigationHydrated=false,navigationOptimistic=null,navigationMotionTimer;
function updateNavigationAccess(){const horizontal=document.documentElement.dataset.navigation==='horizontal';$('#sidebar').inert=horizontal||(navigationMedia.matches&&!document.body.classList.contains('sidebar-open'));}
function applyNavigation(){const prefs=guide?.data?.preferences??{},horizontal=prefs.navigation==='horizontal',compact=navigationOptimistic??!!prefs.sidebarCompact,nav=$('#navigation'),host=$('#horizontal-navigation'),foot=$('.sidebar-foot'),account=$('.account');const root=document.documentElement,nextLayout=horizontal?'horizontal':'vertical',nextSize=compact?'small':'full',changed=root.dataset.navigation!==nextLayout||root.dataset.sidebarSize!==nextSize;const flip=navigationHydrated&&!navigationMedia.matches&&root.dataset.navigation==='vertical'&&nextLayout==='vertical'&&root.dataset.sidebarSize!==nextSize&&!window.matchMedia('(prefers-reduced-motion:reduce)').matches?[...document.querySelectorAll('#navigation > button,.sidebar-foot .avatar,.sidebar-foot #logout,#sidebar-size')].map(node=>({node,rect:node.getBoundingClientRect()})):[];for(const {node}of flip)for(const animation of node.getAnimations())if(animation.id==='manager-navigation-flip')animation.cancel();if(changed&&navigationHydrated&&!window.matchMedia('(prefers-reduced-motion:reduce)').matches){clearTimeout(navigationMotionTimer);root.dataset.navigationMoving='true';navigationMotionTimer=setTimeout(()=>delete root.dataset.navigationMoving,280);}if(guide?.data)navigationHydrated=true;document.documentElement.dataset.navigation=horizontal?'horizontal':'vertical';document.documentElement.dataset.sidebarSize=compact?'small':'full';host.hidden=!horizontal;if(horizontal){if(nav.parentElement!==$('#horizontal-nav-slot'))$('#horizontal-nav-slot').append(nav);if(account.parentElement!==$('#top-account'))$('#top-account').append(account);}else{if(nav.parentElement!==$('#sidebar'))$('#sidebar').insertBefore(nav,foot);if(account.parentElement!==foot)foot.append(account);}setSidebar(false);const toggle=$('#sidebar-size'),label=formatText(compact?'Expand sidebar':'Collapse sidebar');toggle.setAttribute('aria-pressed',String(compact));toggle.setAttribute('aria-label',label);toggle.title=label;toggle.querySelector('span').textContent=label;for(const n of nav.querySelectorAll('[data-page]')){const label=formatText(pages[n.dataset.page][0]);n.title=label;n.setAttribute('aria-label',label);}$('#guide-menu').title='Help & preferences';$('#guide-menu').setAttribute('aria-label','Help & preferences');for(const {node,rect}of flip){const next=node.getBoundingClientRect(),x=rect.left-next.left,y=rect.top-next.top;if(Math.abs(x)+Math.abs(y)>.5){const motion=node.animate([{transform:`translate(${x}px,${y}px)`},{transform:'translate(0,0)'}],{duration:220,easing:'cubic-bezier(.2,.75,.25,1)'});motion.id='manager-navigation-flip';}}requestAnimationFrame(updateNavScroll);}
function updateNavScroll(){const nav=$('#navigation'),overflow=nav.scrollWidth>nav.clientWidth+2;$('#horizontal-navigation').classList.toggle('scrollable',overflow);$('#nav-previous').disabled=nav.scrollLeft<=1;$('#nav-next').disabled=nav.scrollLeft+nav.clientWidth>=nav.scrollWidth-2;}
$('#navigation').addEventListener('scroll',updateNavScroll,{passive:true});window.addEventListener('resize',updateNavScroll,{passive:true});
for(const [id,direction]of [['nav-previous',-1],['nav-next',1]])$('#'+id).onclick=()=>$('#navigation').scrollBy({left:direction*$('#navigation').clientWidth*.7,behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});
navigationMedia.addEventListener('change',()=>{setSidebar(false);});window.matchMedia('(prefers-reduced-motion:reduce)').addEventListener('change',e=>{if(e.matches){for(const motion of document.getAnimations())if(motion.id==='manager-navigation-flip')motion.cancel();delete document.documentElement.dataset.navigationMoving;}});
$('#sidebar-size').onclick=async()=>{const b=$('#sidebar-size');if(b.disabled)return;const next=!(guide?.data?.preferences?.sidebarCompact??false);b.disabled=true;navigationOptimistic=next;applyNavigation();try{await guide.setNavigation({sidebarCompact:next});}catch(e){notice(e.message);}finally{navigationOptimistic=null;applyNavigation();b.disabled=false;}};
function setSidebar(open){if(document.documentElement.dataset.navigation==='horizontal')open=false;document.body.classList.toggle('sidebar-open',open);$('#sidebar-backdrop').hidden=!open;$('#menu-toggle').setAttribute('aria-expanded',String(open));updateNavigationAccess();if(open)($('#navigation button.active')??$('#navigation button')).focus();}
$('#menu-toggle').onclick=()=>setSidebar(!document.body.classList.contains('sidebar-open'));$('#sidebar-backdrop').onclick=()=>{setSidebar(false);$('#menu-toggle').focus();};
$('#quick-nav').onclick=()=>{setSidebar(false);document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true}));};
document.addEventListener('keydown',e=>{if(!document.body.classList.contains('sidebar-open'))return;if(e.key==='Escape'){setSidebar(false);$('#menu-toggle').focus();return;}if(e.key==='Tab'){const controls=[...$('#sidebar').querySelectorAll('a,button')].filter(n=>!n.disabled&&n.getClientRects().length);const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
function consoleInspector(){const h=status?.snapshot?.health,p=status?.snapshot?.process,m=h?.metrics??{};return [['Status',status?.state??'—'],['Players',h?num(h.players)+' / '+num(h.maxPlayers):'—'],['Tick rate',h?num(h.tickHz)+' Hz':'—'],['CPU',num(p?.cpuPercent,1)+'%'],['Memory',p?num(p.rssMb)+' MB':'—'],['Network out',Number.isFinite(m.syncOutBytesPerSecond)?size(m.syncOutBytesPerSecond)+'/s':'—']].map(([k,v])=>`<div class="fact"><span>${k}</span><strong>${esc(v)}</strong></div>`).join('');}
function updateConsoleInspector(){const box=$('#console-inspector-facts');if(box){box.innerHTML=consoleInspector();}}
function renderConsolePage(root){root.innerHTML=`<div class="console-layout">`+`<section class="panel console-panel" aria-label="Server console"><div id="console-lines" class="console-output" tabindex="0" aria-label="Console output"></div><form id="console-command-form" class="console-form"><span aria-hidden="true">›</span><input id="command" autocomplete="off" maxlength="350" placeholder="Enter a server command…" aria-label="HeavyMP console command"><button class="button small">Send</button></form><div class="console-foot"><button type="button" class="button small" id="console-pause">Pause display</button><button type="button" class="button small" id="console-export">Export</button><button type="button" class="button small" id="console-help">Command help</button><span>↑ ↓ command history · Enter to send</span></div></section>`+`<aside class="console-inspector">`+panel('Server details','',`<div class="panel-body facts" id="console-inspector-facts">${consoleInspector()}</div>`)+`<p class="console-side-note">Commands run on this server. Announcements are delivered through the game’s native notifications.</p></aside></div>`;
 refreshConsole();$('#console-command-form').onsubmit=sendCommand;
 $('#console-pause').textContent=consolePaused?'Resume display':'Pause display';$('#console-pause').onclick=()=>{consolePaused=!consolePaused;$('#console-pause').textContent=consolePaused?'Resume display':'Pause display';if(!consolePaused)refreshConsole();};$('#console-export').onclick=()=>download('hvmp-console.txt',entries.map(e=>e.at+' ['+e.level+'] '+e.text).join('\n'));$('#console-help').onclick=()=>{$('#command').value='help';$('#command').focus();};$('#command').onkeydown=e=>{if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();consoleHistoryIndex=Math.min(consoleHistory.length,Math.max(0,consoleHistoryIndex+(e.key==='ArrowUp'?-1:1)));e.target.value=consoleHistory[consoleHistoryIndex]??'';}};
}
function render(){const topGuide=$('#guide-banner');topGuide.innerHTML=guide?.banner()??'';topGuide.hidden=!topGuide.textContent;if(page!=='map')roadMap.pause();if(adminViews.has(page)){void adminViews.render(page);return;}adminViews.leave();const root=$('#content');if(page==='overview'){const key=document.activeElement?.closest('[data-guide]')?.dataset.guide;root.innerHTML=overview();if(key)root.querySelector('[data-guide="'+key+'"]')?.focus({preventScroll:true});}if(page==='help'){root.innerHTML=guide?.help()??'';guide?.bind();}if(page==='console')renderConsolePage(root);
 if(page==='players'){root.innerHTML=panel('CONNECTED PLAYERS','',`<div class="toolbar"><input id="player-search" placeholder="Search by name or SteamID…" aria-label="Search players" value="${esc(playerFilter)}"><span class="search-meta" id="player-result"></span></div><div id="player-table"></div>`);$('#player-search').oninput=e=>{playerFilter=e.target.value;renderPlayers();};renderPlayers();}
 if(page==='logs'){root.innerHTML=panel('SERVER LOGS','Recent history is retained across game restarts',`<div class="toolbar"><input id="log-search" placeholder="Search logs…" aria-label="Search logs" value="${esc(logFilter)}"><select id="log-level" aria-label="Log severity"><option value="all">All levels</option><option value="error">Errors</option><option value="warn">Warnings</option><option value="info">Information</option><option value="debug">Debug</option></select><button id="download-logs" class="button small">Export</button></div><div id="log-lines" class="console-output logs-output"></div>`);$('#log-level').value=logLevel;$('#log-search').oninput=e=>{logFilter=e.target.value;renderLogs();};$('#log-level').onchange=e=>{logLevel=e.target.value;renderLogs();};$('#download-logs').onclick=downloadLogs;renderLogs();}
 if(page==='map'){root.innerHTML=panel('ETS2 LIVE MAP','Real road tiles · live server players',`<div class="map-shell road-map-shell"><canvas id="world-map" aria-label="ETS2 road map with live server players"></canvas><div class="map-controls"><button class="button small" id="fit-map">Fit players</button><button class="button small" id="world-map-fit">World map</button><button class="button small" id="map-retry">Retry</button><button class="button small" id="map-in" aria-label="Zoom in">+</button><button class="button small" id="map-out" aria-label="Zoom out">−</button></div><div class="map-info" id="map-info"><strong>ETS2</strong><span>Loading road map…</span></div></div><div class="map-legend"><span data-map-status>Loading road map…</span><span id="map-count"></span></div><div class="map-attribution"><a data-map-attribution target="_blank" rel="noopener noreferrer"></a></div>`);roadMap.update(status?.snapshot?.players??[]);void roadMap.bind(root);}
 if(page==='addons'){const files=status?.meta?.addons??[],report=status?.meta?.addonsReport;root.innerHTML=panel('PUBLISHED RESOURCES',`${files.length} archive(s) · ${size(files.reduce((n,f)=>n+f.size,0))}`,files.length?`<div class="table-wrap"><table><thead><tr><th>ORDER</th><th>RESOURCE</th><th>SIZE</th><th>STATE</th></tr></thead><tbody>${files.map((f,i)=>`<tr><td>${String(i+1).padStart(2,'0')}</td><td><strong>${esc(f.name)}</strong></td><td>${size(f.size)}</td><td><span class="badge good">PUBLISHED</span></td></tr>`).join('')}</tbody></table></div>`:empty('No resources published','This instance has no active addons.'))+`<p class="hint">Resources are mounted in the order shown. ${report?`Inspection: ${report.complete?'complete':'partial for native archives or index limits'} · ${num(report.conflictCount??0)} overlapping internal paths.`:''} Manage the files and their order in this server’s addons directory.</p>`;}
 if(page==='settings')renderSettings(root);
 const banner=$('#guide-banner');banner.innerHTML=guide?.banner()??'';banner.hidden=!banner.textContent;icons(root);
}
async function sendCommand(e){e.preventDefault();const input=$('#command'),line=input.value.trim();if(!line)return;consoleHistory.push(line);if(consoleHistory.length>30)consoleHistory.shift();consoleHistoryIndex=consoleHistory.length;const button=e.target.querySelector('button');button.disabled=true;try{await api('console',{line});input.value='';}catch(error){notice(error.message);}finally{button.disabled=false;input.focus();}}
function isAnnouncement(e){return e.message?.system&&/^\[(?:Announcement|Annonce)\] /.test(e.message.text);}
function refreshConsole(){const out=$('#console-lines');if(!out)return;out.replaceChildren();for(const e of entries.slice(-500))out.append(logNode(e));out.scrollTop=out.scrollHeight;}
function logNode(e){const row=document.createElement('div');row.className='log-line '+e.level+' '+e.source;const stamp=document.createElement('time');stamp.textContent=time(e.message?.time??e.at);const level=document.createElement('span');level.className='log-level';level.textContent=e.message?(isAnnouncement(e)?'NOTICE':e.message.channel.toUpperCase()):e.level.toUpperCase();const text=document.createElement('span');text.className='log-text';
 const m=e.message;if(m){row.dataset.channel=m.channel;row.classList.add('chat-message');if(isAnnouncement(e)){row.classList.add('announcement-preview');const title=document.createElement('strong');title.className='announcement-title';title.textContent='OFFICIAL ANNOUNCEMENT';const content=document.createElement('span');content.className='announcement-content';content.textContent=m.text.replace(/^\[(?:Announcement|Annonce)\] /,'');text.append(title,content);}
 else{const head=document.createElement('span');head.className='chat-sender';if(m.rank){const badge=new Image();badge.src='/manager/staff-badge.svg';badge.alt='Staff';badge.title=m.rank.label;badge.className='staff-badge';head.append(badge);}if(m.vtc?.tag){const tag=document.createElement('span');tag.className='chat-vtc';tag.textContent='['+m.vtc.tag+'] ';if(/^#[a-f0-9]{6}$/i.test(m.vtc.color??''))tag.style.color=m.vtc.color;head.append(tag);}const name=document.createElement('strong');name.textContent=m.name;head.append(name);const content=document.createElement('span');content.className='chat-content';content.textContent=': '+m.text;text.append(head,content);if(m.system)row.classList.add('chat-system');}}
 else{const value=e.text.replace(/^\[(?:HeavyMP|Error|Warning|Erreur|Avertissement|Debug)\]\s*/,'');const boot=/^((?:◆  HEAVYMP|└─ (?:READY|PRÊT)).*$|│  [A-ZÀ-Ÿ]+)(?= {2,}|$)/.exec(value);if(boot){const ready=value.startsWith('└─');level.textContent=ready?'OK':'BOOT';if(ready)level.classList.add('console-state');const heading=document.createElement('strong');heading.className=value.startsWith('│')?'console-number':'console-state';heading.textContent=boot[0];text.append(heading);}const pieces=value.slice(boot?.[0].length??0).split(/(\b\d+(?:[.,]\d+)?\s*(?:ms|Hz|MB|%|joueurs|players)?\b|(?<!\p{L})(?:INVALID MANIFEST|LIMIT REACHED|FAILED|ACTIVE|activé[es]*|vérifié[es]*|configuré[es]*|ready|enabled|disabled|désactivé[es]*)(?!\p{L}))/giu);for(let i=0;i<pieces.length;i++){if(i%2){const span=document.createElement('span');span.className=/disabled|désactivé|échec|invalid manifest|limit reached|failed/i.test(pieces[i])?'console-off':/^\d/.test(pieces[i])?'console-number':'console-state';span.textContent=pieces[i];text.append(span);}else text.append(document.createTextNode(pieces[i]));}}
 row.append(stamp,level,text);return row;}
function appendLog(e){const out=$('#console-lines');if(!out||consolePaused)return;const stick=out.scrollHeight-out.scrollTop-out.clientHeight<60;out.append(logNode(e));while(out.children.length>500)out.firstChild.remove();if(stick)out.scrollTop=out.scrollHeight;}
let logRenderQueued=false;function scheduleLogs(){if(logRenderQueued)return;logRenderQueued=true;requestAnimationFrame(()=>{logRenderQueued=false;renderLogs();});}
function filteredLogs(){return entries.filter(e=>(logLevel==='all'||e.level===logLevel)&&e.text.toLowerCase().includes(logFilter.toLowerCase()));}
function renderLogs(){const out=$('#log-lines');if(!out)return;const stick=out.scrollHeight-out.scrollTop-out.clientHeight<60;out.replaceChildren(...filteredLogs().map(logNode));if(stick)out.scrollTop=out.scrollHeight;}
function downloadLogs(){const text=filteredLogs().map(e=>`${e.at} [${e.level}] ${e.text}`).join('\n');const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='hvmp-'+(status?.meta?.serverId??'server')+'-logs.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function renderPlayers(){const table=$('#player-table');if(!table)return;const all=status?.snapshot?.players??[],players=all.filter(p=>(p.name+' '+(p.identity??p.id)).toLowerCase().includes(playerFilter.toLowerCase()));$('#player-result').textContent=players.length+' / '+all.length+' '+'players';const moderation=canPage('moderation');const signature=String(moderation)+JSON.stringify(players.map(p=>[p.id,p.name,p.identity,p.pingMs,p.inGame,p.ageMs==null,p.truck?.brand,p.truck?.model,p.trailerCount,!!p.position]));if(table.dataset.signature===signature)return;table.dataset.signature=signature;table.innerHTML=players.length?`<div class="table-wrap"><table><thead><tr><th>PLAYER</th><th>STATE</th><th>PING</th><th>VEHICLE</th><th>TRAILERS</th><th>ACTIONS</th></tr></thead><tbody>${players.map(p=>`<tr><td><strong>${esc(p.name)}</strong><small>${esc(p.id)}</small></td><td><span class="badge ${p.inGame?'good':''}">${p.inGame?'DRIVING':p.position?'IN GAME · PAUSED':p.ageMs==null?'LAUNCHER CONNECTED':'NO CURRENT TELEMETRY'}</span></td><td>${num(p.pingMs)} ms</td><td>${esc([p.truck?.brand,p.truck?.model].filter(Boolean).join(' ')||'—')}</td><td>${num(p.trailerCount)}</td><td>${p.position?`<button class="button small" data-locate="${esc(p.id)}">Locate</button> `:''}${moderation&&p.identity?`<button class="button small danger-quiet" data-moderate="${esc(p.identity)}">Moderate</button>`:moderation?`<button class="button small danger-quiet" data-kick="${esc(p.id)}">Kick</button>`:''}</td></tr>`).join('')}</tbody></table></div>`:empty(all.length?'No matching players':'No players connected',all.length?'Try another name or client fingerprint.':'Players will appear when they join this server.');decorateTables(table);}
$('#content').onclick=async e=>{const moderate=e.target.closest('[data-moderate]');if(moderate){try{await adminViews.moderate(moderate.dataset.moderate);}catch(error){notice(error.message);}return;}const kick=e.target.closest('[data-kick]'),locate=e.target.closest('[data-locate]');if(locate){roadMap.select(locate.dataset.locate);location.hash='map';return;}if(kick){const reason=await promptText('Remove player','Removed by server administrator.');if(reason===null)return;try{const r=await api('kick',{playerId:kick.dataset.kick,reason});notice(r.ok?'Player removed.':r.error??'Player could not be removed.');}catch(error){notice(error.message);}}};
window.addEventListener('resize',()=>{if(page==='map')roadMap.drawSoon();});

let settingsData=null,settingsDraft={},settingsLoading=false,settingsSaving=false,settingsLoadedPid=null,settingsSelectedGroup='Access',settingsQuery='';
const settingsErrors={settings_conflict:'The file changed elsewhere. Reload before saving; your edits are still shown.',setting_overridden:'This value is controlled by the hosting environment.',invalid_setting:'One or more values are invalid.',setting_not_editable:'This setting cannot be changed here.',env_unsafe:'The .env file cannot be edited safely. Check its type and size in your hosting panel.',settings_busy:'Another save is in progress. Please try again.',settings_unavailable:'Configuration editing is unavailable on this instance.',settings_write_failed:'The file could not be saved. Check disk space and permissions.',env_unavailable:'The configuration file is not readable.'};
function settingsMessage(text,error=false){const box=$('#settings-message');if(box){box.textContent=formatText(text);box.className=error?'settings-message error':'settings-message';box.hidden=false;}}
async function loadSettings(){if(settingsLoading)return;settingsLoading=true;const epoch=scopeEpoch;try{const settings=await api('settings');if(epoch!==scopeEpoch)return;settingsData=settings;settingsDraft={};settingsLoadedPid=status?.pid;if(page==='settings')renderSettings($('#content'));}catch(error){if(epoch===scopeEpoch&&page==='settings'&&user){const mount=$('#settings-fields');if(mount)mount.innerHTML=empty('Settings unavailable',esc(settingsErrors[error.message]??error.message));else settingsMessage(settingsErrors[error.message]??error.message,true);}}finally{if(epoch===scopeEpoch)settingsLoading=false;}}
function renderSettings(root){
 if(!settingsData){root.innerHTML=panel('SERVER CONFIGURATION','',`<div id="settings-fields">${empty('Loading configuration…')}</div><div class="settings-actions"><button type="button" class="button" id="reload-settings">Reload</button></div>`);$('#reload-settings').onclick=loadSettings;if(!settingsLoading)void loadSettings();return;}
 if(!settingsData.fields.some(f=>f.group===settingsSelectedGroup))settingsSelectedGroup=settingsData.fields[0]?.group;
 if(pendingSetting){const f=settingsData.fields.find(f=>f.key===pendingSetting);if(f){settingsSelectedGroup=f.group;settingsQuery=f.key;}pendingSetting=null;}
 root.innerHTML=(guide?.draftBanner('settings')??'')+`<div class="guide-settings-mode"><span>${formatText(guide?.advanced?'Advanced view':'Simple view')}</span><button type="button" class="button small" data-guide="toggle-mode">${formatText(guide?.advanced?'Use simple view':'Show advanced settings')}</button></div>`+settingsMarkup({data:{...settingsData,fields:settingsData.fields.filter(field=>!field.ownerOnly||status?.access?.role==='owner')},draft:settingsDraft,selected:settingsSelectedGroup,query:settingsQuery,esc});
 const form=$('#settings-form');
 form.oninput=event=>{const key=event.target.dataset.setting;if(!key)return;const value=event.target.type==='checkbox'?String(event.target.checked):event.target.value;const field=settingsData.fields.find(f=>f.key===key);if(String(value)===String(field.value))delete settingsDraft[key];else settingsDraft[key]=value;const row=event.target.closest('.setting-row');row.classList.toggle('is-edited',Object.hasOwn(settingsDraft,key));if(event.target.type==='checkbox')row.querySelector('[data-switch-state]').textContent=formatText(event.target.checked?'Enabled':'Disabled');persistSettingsDraft();updateSettingsSave();};form.onchange=form.oninput;
 for(const button of root.querySelectorAll('[data-settings-group]'))button.onclick=()=>{settingsSelectedGroup=button.dataset.settingsGroup;settingsQuery='';$('#settings-search').value='';filterSettings();};
 $('#settings-search').oninput=e=>{settingsQuery=e.target.value;filterSettings();};
 form.addEventListener('invalid',event=>{const section=event.target.closest('[data-section]');if(section){settingsQuery=event.target.dataset.setting??'';settingsSelectedGroup=section.dataset.section;$('#settings-search').value=settingsQuery;filterSettings();}},true);
 form.onsubmit=saveSettings;
 $('#reload-settings').onclick=async()=>{if(Object.keys(settingsDraft).length&&!await confirmAction('Discard unsaved configuration changes?','Saved values will be loaded from disk.',false))return;void loadSettings();};
 $('#discard-settings').onclick=async()=>{if(await confirmAction('Discard your changes?','The last saved values will be shown again.',false)){guide?.drafts?.clear('settings');settingsDraft={};renderSettings(root);}};
 if(settingsData.restartRequired)settingsMessage('Restart the game server to apply saved changes.');filterSettings();updateSettingsSave();icons(root);
}
function persistSettingsDraft(){if(!guide?.drafts||!settingsData)return;if(Object.keys(settingsDraft).length)guide.drafts.write('settings',{revision:settingsData.revision,changes:settingsDraft});else guide.drafts.clear('settings');}
function filterSettings(){const query=settingsQuery.trim().toLowerCase();let count=0;const advanced=guide?.advanced??false;
 for(const section of document.querySelectorAll('.settings-section')){let visible=0;for(const row of section.querySelectorAll('.setting-row')){const key=row.querySelector('[data-setting]')?.dataset.setting;const label=row.querySelector('label')?.textContent??'';row.hidden=query?!((row.dataset.search+' '+label.toLowerCase()).includes(query)):!advanced&&!BASIC_SETTINGS.includes(key);if(!row.hidden)visible++;}section.hidden=query?visible===0:section.dataset.section!==settingsSelectedGroup;if(!section.hidden)count+=visible;}
 for(const button of document.querySelectorAll('[data-settings-group]')){const basic=settingsData.fields.filter(f=>f.group===button.dataset.settingsGroup&&BASIC_SETTINGS.includes(f.key)).length;button.hidden=!advanced&&!basic&&!query;const badge=button.querySelector('.category-count');if(badge)badge.textContent=String(advanced?settingsData.fields.filter(f=>f.group===button.dataset.settingsGroup).length:basic);const selected=!query&&button.dataset.settingsGroup===settingsSelectedGroup;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));}
 $('#settings-empty').hidden=count!==0;$('#settings-result-count').textContent=formatText('{count} settings',{count});}
function updateSettingsSave(){const button=$('#save-settings');if(!button)return;const count=Object.keys(settingsDraft).length;button.disabled=settingsSaving||!count;button.textContent=settingsSaving?'Saving…':'Save changes';$('#settings-draft-count').textContent=settingsSaving?'Saving configuration…':count?formatText('{count} unsaved changes',{count}):'All changes saved';$('#discard-settings').disabled=settingsSaving||!count;$('#reload-settings').disabled=settingsSaving;for(const input of document.querySelectorAll('[data-setting]'))input.disabled=settingsSaving||settingsData.fields.find(f=>f.key===input.dataset.setting)?.overridden===true;updatePower();}
async function saveSettings(event){event.preventDefault();if(settingsSaving||!settingsData)return;const changes={};for(const [key,value]of Object.entries(settingsDraft)){const f=settingsData.fields.find(s=>s.key===key);if(f&&!f.overridden&&String(value)!==String(f.value))changes[key]=value;}if(!Object.keys(changes).length){settingsDraft={};updateSettingsSave();settingsMessage('No changes to save.');return;}
 if(guide&&!await guide.confirmSettings(changes,settingsData.fields))return;
 settingsSaving=true;updateSettingsSave();try{const result=await api('settings',{revision:settingsData.revision,changes});settingsData=result;guide?.drafts?.clear('settings');settingsDraft={};void guide?.refresh(true);if(page==='settings'){renderSettings($('#content'));settingsMessage('Configuration saved. '+(result.restartRequired?'Restart the game server to apply changes.':'No restart is needed.'));}}catch(error){settingsMessage(settingsErrors[error.message]??error.message,true);}finally{settingsSaving=false;updateSettingsSave();}}
const adminViews=createAdminViews({api,esc,panel,empty,metric,num,size,time,getStatus:()=>status,notice,icons,openInstance,setInstances,getDrafts:()=>guide?.drafts,getDraftBanner:kind=>guide?.draftBanner(kind)??''});
function configureGuide(){
 const signal=scopeRequests.signal,id=selectedInstance;
 guide=createGuide({
  api:(path,data)=>{signal.throwIfAborted();return api(path,data,id);},signal,autoSetup:id===null,
  getStatus:()=>status,getLogs:()=>entries,getUser:()=>user,getPage:()=>page,pages,
  notice:message=>{if(!signal.aborted)notice(message);},onStatus:next=>{if(!signal.aborted)acceptStatus(next);},
  openSetting:key=>{pendingSetting=key;settingsQuery=key;if(page==='settings')renderSettings($('#content'));else location.hash='settings';},
  rerender:()=>{if(signal.aborted||!user||!canPage('help')||page==='instances')return;applyNavigation();if(['overview','help'].includes(page))render();else if(page==='settings'&&settingsData)renderSettings($('#content'));const banner=$('#guide-banner');banner.innerHTML=guide?.banner()??'';banner.hidden=!banner.textContent;icons(document);},
 });
 document.documentElement.dataset.viewMode='simple';
}
function startGuide(){const signal=scopeRequests.signal;void guide.init().catch(()=>{if(!signal.aborted)notice('Guided assistance is unavailable.');});}
$('#guide-menu').onclick=()=>{location.hash='help';};
document.addEventListener('manager:draft-action',async event=>{const action=event.detail.action;if(action==='discard-settings-draft'){guide.drafts?.clear('settings');if(page==='settings')renderSettings($('#content'));}else if(action==='restore-settings-draft'&&settingsData){const restored=await guide.reviewSettingsDraft(settingsData.fields);if(restored){settingsDraft=restored;settingsQuery='';settingsSelectedGroup=settingsData.fields.find(f=>f.key===Object.keys(restored)[0])?.group??'Access';renderSettings($('#content'));persistSettingsDraft();}}});
document.addEventListener('keydown',e=>{if(page!=='instances'&&(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&user&&!document.querySelector('dialog[open]')){e.preventDefault();const available=Object.fromEntries(Object.entries(pages).filter(([id])=>canPage(id)));openPageSearch(available,page,id=>{if(canPage(id))location.hash=id;else if(canPage('help'))guide.intent(id);},canPage('help')?guide.intents:[]);}});
window.addEventListener('beforeunload',e=>{if(Object.keys(settingsDraft).length||adminViews.hasUnsaved()||adminViews.isUploading()){e.preventDefault();e.returnValue='';}});
void init();
