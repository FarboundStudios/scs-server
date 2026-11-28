import {dialog,confirmAction,download,friendly} from './admin-ui.mjs';
import {managerApi} from './instance-api.mjs';
import {mixedOrder,storeMixedOrder,optionalRow,newSlotForm,addOptionalSlot,addLocalArchiveSlots,uploadAddonBatch,optionalDownloadUrlLimit,validateOptionalDownloadLink} from './addon-order-view.mjs';
export const adminPages={instances:['Instances','Create and run independent game servers from one Manager.'],scripts:['Scripts','Choose the modules available on this server.'],performance:['Performance','Understand load, latency and the resources your server uses.'],backups:['Backups','Verified data snapshots, with a safety copy before every restore.'],automation:['Automation','Schedule announcements and restarts for this server.'],chat:['Chat history','Search public server channels from the last seven UTC dates.'],moderation:['Moderation','Local sanctions for this instance. HeavyMP-wide bans remain separate.'],audit:['Activity log','Who changed what, and when.'],access:['Users & roles','Choose who can sign in to this Manager and what they can do.']};
const roleNotes={
 administrator:'Manage server operations, settings, resources, schedules and moderation.',
 operator:'Control the game process, run commands and read the live console and logs.',
 moderator:'Review chat history and manage local player sanctions.',
 viewer:'View server status, performance, connected players and the live map.',
};
function sendAddon(file,revision,progress){
 return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();
  xhr.open('POST',managerApi('addons/upload?'+new URLSearchParams({name:file.name,revision})));
  xhr.timeout=2*60*60*1000;
  xhr.setRequestHeader('content-type','application/octet-stream');
  xhr.setRequestHeader('x-hvmp-csrf',document.querySelector('meta[name="hvmp-csrf"]').content);
  xhr.upload.onprogress=event=>progress(event.loaded);
  xhr.upload.onload=()=>progress(file.size,true);
  xhr.onerror=()=>reject(Error('Upload interrupted. Reload to check which resources were saved.'));
  xhr.ontimeout=()=>reject(Error('Upload timed out. Reload to check which resources were saved.'));
  xhr.onload=()=>{
   let result;
   try{result=JSON.parse(xhr.responseText);}catch{reject(Error('Invalid upload response. Reload to check which resources were saved.'));return;}
   if(xhr.status===200&&result?.revision&&Array.isArray(result.files))resolve(result);
   else reject(Error(result?.error??'Upload failed. Reload to check which resources were saved.'));
  };
  xhr.send(file);
 });
}
async function importBackupFile(file,progress,instance,{createInstance=false}={}){
 return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();
  xhr.open('POST',createInstance?managerApi('instances/import-pack',null):managerApi('backups/import',instance));
  xhr.timeout=2*60*60*1000;
  xhr.setRequestHeader('content-type','application/octet-stream');
  xhr.setRequestHeader('x-hvmp-csrf',document.querySelector('meta[name="hvmp-csrf"]').content);
  if(createInstance)xhr.setRequestHeader('x-hvmp-trusted-pack','1');
  xhr.upload.onprogress=event=>progress(event.loaded);
  xhr.onerror=()=>reject(Error('Backup upload interrupted.'));
  xhr.ontimeout=()=>reject(Error('Backup upload timed out.'));
  xhr.onload=()=>{
   try{
    const result=JSON.parse(xhr.responseText);
    if(xhr.status===200&&(result.ok||result.instance))resolve(result);
    else reject(Error(result.error??'Backup import failed.'));
   }catch{reject(Error('Backup import returned an unreadable response.'));}
  };
  xhr.send(file);
 });
}
export function createAdminViews({api,esc,panel,empty,metric,num,size,time,getStatus,notice,icons,openInstance,setInstances,getDrafts=()=>null,getDraftBanner=()=>''}){
 let current='',generation=0,addonData=null,addonDraft=null,chatData=null,chartMode='cpu',addonDirty=false,uploading=false;const root=()=>document.querySelector('#content');
 let packInstance=null,packRequest=0,packBusy=false;
 const status=()=>getStatus(),stopped=()=>['stopped','crashed'].includes(status()?.state),local=v=>new Date(v).toLocaleString('en-GB'),button=(id,label,extra='')=>`<button class="button small" data-action="${id}" ${extra}>${label}</button>`;
 function stateNote(){return `<div class="callout ${stopped()?'':'warning'}"><strong>${stopped()?'Ready to make changes':'Game server is running'}</strong><span>${stopped()?'Changes are applied on the next game start.':'Stop the game server before changing addons, creating a backup or restoring data.'}</span></div>`;}
 async function load(kind){addonDirty=false;const id=++generation;current=kind;root().innerHTML=empty('Loading…','Retrieving this server’s data.');try{const data=await api(kind==='performance'?'diagnostics':kind);if(id!==generation||current!==kind)return;if(kind==='access')drawAccess(data);else draw(kind,data);bind(kind,data);icons(root());}catch(e){if(id!==generation)return;root().innerHTML=panel('UNAVAILABLE','',`<div class="panel-body"><p role="alert">${esc(friendly(e.message))}</p>${button('reload','Try again')}</div>`);root().querySelector('[data-action="reload"]')?.addEventListener('click',()=>load(kind));}}
 function drawAccess({users,roles}){
  const options=selected=>roles.map(({role,label})=>`<option value="${esc(role)}" ${role===selected?'selected':''}>${esc(label)}</option>`).join('');
  const rows=users.map(({steamId,role})=>{
   const id=esc(steamId),owner=role==='owner';
   const field=owner?'<span class="badge good">Owner</span>':`<select data-member-role aria-label="Role for ${id}">${options(role)}</select>`;
   const actions=owner?'<span class="muted">Configured on the server</span>':`<div class="row-actions">${button('save-member','Save role','disabled')}${button('remove-member','Remove access')}</div>`;
   return `<tr data-member="${id}"><td><strong>${id}</strong></td><td>${field}</td><td>${actions}</td></tr>`;
  }).join('');
  const list=panel('Manager users',`${users.length} account(s) on this instance`,`<div class="table-wrap"><table><thead><tr><th>SteamID64</th><th>Role</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  const add=panel('Add a user','The user signs in with a Steam account linked to HeavyMP.',`<form id="manager-add-user" class="panel-body backup-create-form"><label for="manager-steam-id">SteamID64<input name="steamId" id="manager-steam-id" type="text" inputmode="numeric" pattern="[0-9]{17}" maxlength="17" required autocomplete="off" placeholder="17-digit Steam ID"></label><label for="manager-user-role">Role<select id="manager-user-role" name="role">${options('viewer')}</select></label><button class="button primary">Add user</button></form>`);
  const permissions=panel('Role permissions','',`<div class="panel-body facts">${roles.map(({role,label})=>`<div class="fact"><strong>${esc(label)}</strong><span>${esc(roleNotes[role])}</span></div>`).join('')}</div>`);
  root().innerHTML=`<div class="resource-layout">${list}${add}</div>${permissions}`;
 }
 function draw(kind,data){if(kind==='instances')drawInstances(data);else if(kind==='scripts')drawScripts(data);else if(kind==='addons')drawAddons(data);else if(kind==='backups')drawBackups(data);else if(kind==='automation')drawAutomation(data);else if(kind==='chat')drawChat(data);else if(kind==='moderation'){drawModeration(data);}else if(kind==='audit')drawAudit(data);else if(kind==='performance'){root().innerHTML=`<div id="performance-live"></div>`+panel('HOST ENVIRONMENT','Server process measurements; these are not ETS2 client FPS.',`<div class="panel-body facts">${[['Runtime','Node '+data.node],['Platform',data.platform],['Manager memory',num(data.managerMemoryMb)+' MB'],['Storage free',data.storage?size(data.storage.freeBytes)+' / '+size(data.storage.totalBytes):'Unavailable'],['Dropped log entries',num(data.droppedLogs)],['Dropped chat history',num(data.droppedChat)]].map(([k,v])=>`<div class="fact"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>`,button('report','Export diagnostics'));updatePerformance();}}
 function instanceRows(items){return items.map(item=>{
  const state={starting:'Starting',running:'Running',stopping:'Stopping',crashed:'Crashed',stopped:'Stopped',manager_unavailable:'Manager unavailable'}[item.state]??item.state;
  const busy=['starting','stopping'].includes(item.state),running=item.state==='running';
  const controls=[
   '<button class="button small" data-instance-power="start" '+(running||busy?'disabled':'')+'>Start</button>',
   '<button class="button small" data-instance-power="restart" '+(!running||busy?'disabled':'')+'>Restart</button>',
   '<button class="button small" data-instance-power="stop" '+(!running||busy?'disabled':'')+'>Stop</button>',
   item.managerUrl?'<button class="button small" data-instance-manage>Manage</button>':'',
   item.managerUrl?'<button class="button small" data-instance-packs aria-controls="instance-packs" aria-expanded="'+(packInstance?.id===item.id)+'">Server packs</button>':'',
   item.primary?'':'<button class="button small" data-instance-rename '+(running||busy?'disabled':'')+'>Rename</button>',
   '<button class="button small danger-quiet" data-instance-delete '+(!item.canDelete?'disabled':'')+'>Delete instance</button>'
  ].join('');
  return '<tr data-instance="'+esc(item.id)+'"><td><strong>'+esc(item.name)+'</strong><small>'+esc(item.id)+'</small></td>'+
   '<td data-label="Game">ETS2</td><td data-label="Port">'+esc(item.port)+'</td><td data-label="State"><span class="badge '+(running?'good':item.state==='crashed'?'bad':'')+'">'+esc(state)+'</span></td>'+
   '<td data-label="Players">'+esc(item.players)+'</td><td data-label="CPU">'+sample(item.cpuPercent,1,' %')+'</td><td data-label="RAM">'+sample(item.rssMb,0,' MB')+'</td><td data-label="Tick time">'+sample(item.tickMs,1,' ms')+'</td><td><div class="row-actions">'+controls+'</div></td></tr>';
 }).join('');}
 const sample=(value,precision,unit)=>Number.isFinite(value)?num(value,precision)+unit:'—';
 function instanceMetrics({items,host}){
  const running=items.filter(item=>item.state==='running');
  const ram=running.filter(item=>Number.isFinite(item.rssMb));
  return `<div class="metrics">${metric('Running servers',num(running.length)+' / '+num(items.length),'Game processes')}${metric('Players online',num(items.reduce((sum,item)=>sum+item.players,0)),'Across all instances')}${metric('Game RAM',ram.length?sample(ram.reduce((sum,item)=>sum+item.rssMb,0),0,' MB'):'—','Resident memory across game processes')}${metric('Host RAM',sample(host?.memoryAvailableMb,0,' MB'),sample(host?.memoryTotalMb,0,' MB')+' total · '+sample(host?.managerRssMb,0,' MB')+' used by Manager')}</div>`;
 }
 function drawInstances(data){
  setInstances(data.items);
  const table='<div class="table-wrap" id="instance-table"'+(data.items.length?'':' hidden')+'><table><thead><tr><th>Server</th><th>Game</th><th>Port</th><th>State</th><th>Players</th><th title="100% equals one CPU core">CPU</th><th title="Resident memory">RAM</th><th>Tick time</th><th>Actions</th></tr></thead>'+
   '<tbody id="instance-rows">'+instanceRows(data.items)+'</tbody></table></div>';
  const form='<form id="instance-create" class="panel-body backup-create-form instance-create-fields">'+
   '<label>Server name<input name="name" maxlength="80" required></label>'+
   '<label>Server ID<input name="id" pattern="[a-z0-9][a-z0-9_\\-]{0,31}" maxlength="32" required placeholder="community-convoy"></label>'+
   '<label>Game<select name="game"><option value="ets2">Euro Truck Simulator 2</option><option value="ats" disabled>American Truck Simulator · native bridge pending</option></select></label>'+
   '<label>Local port<input name="port" type="number" min="1024" max="65535" value="'+esc(data.nextPort)+'" required></label>'+
   '<label class="instance-create-wide">Public HTTPS origin (optional)<input name="publicOrigin" type="url" maxlength="256" placeholder="https://server.example.com"></label>'+
   '<div class="row-actions instance-create-wide"><button class="button primary">Create instance</button></div></form>';
  const entryActions=`<section class="instance-entry panel" aria-label="Add a server">
   <div><h2>Bring a server online</h2><p>Import a full .hvmpbackup file or set up a new server.</p></div>
   <div class="row-actions"><input id="instance-pack-file" type="file" accept=".hvmpbackup,application/octet-stream" hidden>
    <button class="button primary" id="import-instance-pack">Import server pack</button>
    <button class="button" id="toggle-instance-create" aria-controls="instance-create-panel" aria-expanded="false">Create an instance</button>
   </div>
   <div class="instance-import-progress" hidden><progress id="instance-import-meter" aria-label="Server pack upload progress"></progress>
    <p id="instance-import-message" role="status"></p></div></section>`;
  const actions='<div class="row-actions">'+button('reload','Refresh')+'<button class="button small danger-quiet" data-action="delete-all" '+(!data.items.length||data.items.some(item=>!item.canDelete)?'disabled':'')+'>Delete all instances</button></div>';
  root().innerHTML='<div class="instances-layout">'+entryActions+
   '<section id="instance-create-panel" hidden>'+panel('Create an instance','For a new server without a pack.',form)+'</section>'+
   '<div id="instance-metrics"'+(data.items.length?'':' hidden')+'>'+instanceMetrics(data)+'</div>'+
   panel('Server instances','',table+'<div id="no-instances"'+(data.items.length?' hidden':'')+'>'+empty('No server instances','Import a pack or create an instance to get started.')+'</div>',actions)+
   '<section id="instance-packs" hidden tabindex="-1" aria-label="Instance server packs"></section></div>';
  if(packInstance){
   const selected=data.items.find(item=>item.id===packInstance.id);
   if(selected)void showInstancePacks(selected);
   else packInstance=null;
  }
 }
 let instancesFetchedAt=0,instancesRefreshing=false;
 async function updateInstances(){
  const body=root().querySelector('#instance-rows');
  if(current!=='instances'||!body||instancesRefreshing||Date.now()-instancesFetchedAt<2000)return;
  instancesRefreshing=true;instancesFetchedAt=Date.now();
  try{
   const data=await api('instances');const {items}=data;
   if(current==='instances'&&body.isConnected){
    const metrics=root().querySelector('#instance-metrics');
    metrics.hidden=!items.length;metrics.innerHTML=instanceMetrics(data);
   }
   if(current==='instances'&&body.isConnected&&packInstance&&!packBusy&&!uploading){
    const next=items.find(item=>item.id===packInstance.id);
    if(next&&next.state!==packInstance.state)void showInstancePacks(next);
   }
   if(current==='instances'&&body.isConnected&&!body.matches(':focus-within')){
    setInstances(items);
    body.innerHTML=instanceRows(items);icons(body);
    root().querySelector('#no-instances').hidden=items.length>0;
    root().querySelector('#instance-table').hidden=!items.length;
    root().querySelector('[data-action="delete-all"]').disabled=!items.length||items.some(item=>!item.canDelete);
   }
  }catch{}finally{instancesRefreshing=false;}
 }
 const packEnabled=item=>['stopped','crashed'].includes(item.state);
 function packLink(id,instance){
  return managerApi('backups/download?id='+id,instance);
 }
 function renderPacks(container,item,data){
  const canRestore=packEnabled(item),disabled=canRestore?'':'disabled';
  const rows=data.items.map(pack=>`<tr><td><strong>${esc(pack.label)}</strong><small>${pack.complete?'Full server pack':pack.full?'Server backup':'Game data snapshot'}</small></td>
   <td>${esc(local(pack.createdAt))}</td><td>${size(pack.bytes)}</td><td><div class="row-actions">
   <a class="button small" href="${esc(packLink(pack.id,item.id))}" download>Download</a>
   <button class="button small" data-pack-restore="${esc(pack.id)}" ${disabled}>Restore</button>
   </div></td></tr>`).join('');
  const list=rows?`<div class="table-wrap"><table><thead><tr><th>Pack</th><th>Created</th><th>Size</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`:
   empty('No saved packs','Create a full pack or import a .hvmpbackup file.');
  const create=`<form class="panel-body backup-create-form" data-pack-create>
   <label>Pack name<input name="label" maxlength="80" value="${esc((item.name+' server pack').slice(0,80))}" required ${disabled}></label>
   <button class="button primary" ${disabled}>Create and download full pack</button></form>`;
  const imported=`<form class="panel-body backup-create-form" data-pack-import>
   <label>Import a server pack <input name="pack" type="file" accept=".hvmpbackup,application/octet-stream" required></label>
   <progress hidden aria-label="Import progress"></progress><button class="button">Import pack</button></form>`;
  const footer=`<div class="panel-body"><p class="hint">Includes shared mod files, load order, custom scripts, delegated users and roles, schedules, game data, and branding. The destination keeps its own owner, port, and host credentials.</p>
   ${item.folder?`<p class="hint">Instance files <code>${esc(item.folder)}</code></p>`:''}
   <p role="status" data-pack-progress>${canRestore?'Ready to create or restore a pack.':'Stop this game server to create or restore a pack.'}</p></div>`;
  container.innerHTML=panel('Server packs for '+item.name,'Create a portable pack or restore a pack onto this instance.',`<div class="grid-two">${create}${imported}</div>`+list+footer,
   '<button class="button small" data-pack-close>Close server packs</button>');
  container.querySelector('[data-pack-close]').onclick=()=>{
   if(packBusy)return;
   packInstance=null;packRequest++;container.hidden=true;
   const button=[...root().querySelectorAll('[data-instance-packs]')].find(control=>control.closest('[data-instance]').dataset.instance===item.id);
   button?.setAttribute('aria-expanded','false');button?.focus();
  };
  const run=async(task,label,resultMessage)=>{
   if(packBusy)return;
   packBusy=true;
   const feedback=container.querySelector('[data-pack-progress]');
   const controls=[...container.querySelectorAll('button,input')].filter(control=>!control.disabled);
   controls.forEach(control=>{control.disabled=true;});
   feedback.textContent=label;
   try{
    const result=await task(feedback);
    notice(resultMessage);
    if(current==='instances'&&container.isConnected&&packInstance?.id===item.id)await showInstancePacks(item);
    return result;
   }catch(error){feedback.textContent=friendly(error.message);}
   finally{
    controls.forEach(control=>{if(control.isConnected)control.disabled=false;});
    packBusy=false;
   }
  };
  container.querySelector('[data-pack-create]').onsubmit=async event=>{
   event.preventDefault();
   const label=new FormData(event.currentTarget).get('label');
   const result=await run(()=>api('backups/create',{label,full:true},item.id),'Creating and checking the server pack…','Full pack created and verified.');
   if(result?.id){
    const link=document.createElement('a');link.href=packLink(result.id,item.id);link.download='';link.click();
   }
  };
  container.querySelector('[data-pack-import]').onsubmit=async event=>{
   event.preventDefault();
   const form=event.currentTarget,file=form.elements.pack.files[0];
   if(!file||packBusy||uploading)return;
   const meter=form.querySelector('progress');meter.hidden=false;meter.max=file.size;meter.value=0;
   uploading=true;
   try{
    await run(feedback=>importBackupFile(file,bytes=>{
     meter.value=bytes;
     if(bytes===file.size)feedback.textContent='Verifying the uploaded pack…';
    },item.id),'Uploading the server pack…','Pack imported. Select Restore to apply it.');
   }finally{uploading=false;meter.hidden=true;}
  };
  for(const button of container.querySelectorAll('[data-pack-restore]')){
   button.onclick=async()=>{
    const pack=data.items.find(entry=>entry.id===button.dataset.packRestore);
    if(!pack||packBusy||!await confirmAction('Restore a pack onto '+item.name+'?',
     pack.complete?'This replaces the instance’s files and delegated access, including custom scripts that can run on this host. Restore packs from a source you trust. A safety backup is created first.':
      'The saved files will replace live data on this instance. A safety backup is created first.'))return;
    await run(()=>api('backups/restore',{id:pack.id,confirm:true,trusted:pack.complete},item.id),'Creating a safety backup and restoring the pack…','Pack restored. Start the instance when ready.');
   };
  }
 }
 async function showInstancePacks(item,focus=false){
  const container=root().querySelector('#instance-packs');
  if(!container)return;
  const request=++packRequest;
  packInstance=item;
  for(const button of root().querySelectorAll('[data-instance-packs]'))button.setAttribute('aria-expanded',String(button.closest('[data-instance]').dataset.instance===item.id));
  container.hidden=false;
  container.innerHTML=empty('Loading server packs…','Reading backups for '+esc(item.name)+'.');
  if(focus){container.focus({preventScroll:true});container.scrollIntoView({block:'start'});}
  try{
   const data=await api('backups',undefined,item.id);
   if(current==='instances'&&request===packRequest&&container.isConnected)renderPacks(container,item,data);
  }catch(error){
   if(current==='instances'&&request===packRequest&&container.isConnected)container.innerHTML=empty('Server packs unavailable',esc(friendly(error.message)));
  }
 }
 function drawScripts(data) {
  const rows = data.items.map(item => {
   const state = item.error ? 'Invalid' : item.state === 'failed' ? 'Failed' :
      item.state === 'limit' ? 'Limit reached' : item.state === 'running' ? 'Running' :
      item.enabled ? 'Enabled' : 'Disabled';
   const tone = ['Invalid', 'Failed', 'Limit reached'].includes(state) ? 'bad' :
      ['Enabled', 'Running'].includes(state) ? 'good' : '';
   return `<tr><td><strong>${esc(item.name)}</strong><small>${esc(item.id)}${item.version ? ' · ' + esc(item.version) : ''}</small></td>
    <td class="wrap-cell">${esc(item.error || item.description || '')}</td>
    <td><span class="badge ${tone}">${esc(state)}</span></td>
    <td>${button('toggle-script',item.enabled?'Disable':'Enable',`data-id="${esc(item.id)}" data-enabled="${!item.enabled}" ${!data.editable||item.error?'disabled':''}`)}</td></tr>`;
  }).join('');
  const hint = data.editable ? 'Changes are applied on the next game start.' : 'Stop the game server to change scripts.';
  root().innerHTML = `<div class="callout"><strong>Server modules</strong><span>${hint}</span></div>` +
   panel('Scripts', 'Modules installed in the scripts folder at the server root.', rows ?
    `<div class="table-wrap"><table><thead><tr><th>Module</th><th>Description</th><th>State</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` :
    empty('No scripts installed','Add a module folder with a manifest to the scripts directory.'),button('reload','Refresh')) +
   (data.truncated ? '<p class="hint">Only the first 64 module folders are inspected.</p>' : '') +
   '<p class="hint">Install custom modules through your hosting file manager. Enable only code from a trusted source.</p>';
 }
 function drawAddons(data,draft={order:[...data.order],disabled:[...data.disabled],optional:[...(data.optional??[])]}){addonData=data;addonDraft=draft;const owner=status()?.access?.role==='owner',editable=owner&&stopped();const ordered=[...mixedOrder(draft),...draft.disabled.map(name=>({name,key:'shared:'+name}))],activeCount=ordered.length-draft.disabled.length;
  const rows=ordered.map((row,index)=>{if(row.slot)return optionalRow(row,{esc,editable,index,total:activeCount});const {name,key}=row,f=data.files.find(f=>f.name===name),active=draft.order.includes(name);return `<tr ${active?'data-order-row="'+esc(key)+'" draggable="'+editable+'"':''}><td><strong>${esc(name)}</strong><small>${esc(local(f.modifiedAt))}</small></td><td>${size(f.size)}</td><td><span class="badge ${active?'good':''}">${active?'ENABLED':'DISABLED'}</span></td><td><div class="row-actions"><button class="button small" data-toggle="${esc(name)}" ${!stopped()||!f.safe?'disabled':''}>${active?'Disable':'Enable'}</button><button class="button small" data-move-row="${esc(key)}" data-dir="-1" aria-label="Move ${esc(name)} up" ${!stopped()||!active||index===0?'disabled':''}>↑</button><button class="button small" data-move-row="${esc(key)}" data-dir="1" aria-label="Move ${esc(name)} down" ${!stopped()||!active||index===activeCount-1?'disabled':''}>↓</button><button class="button small danger-quiet" data-remove="${esc(name)}" ${!stopped()?'disabled':''}>Remove</button>${editable&&active&&f.safe?'<button type="button" class="button small" data-mark-optional="'+esc(name)+'">Mark optional</button>':''}</div></td></tr>`;}).join('');
  root().innerHTML=stateNote()+(!addonDirty?getDraftBanner('addons'):'')+`<div class="resource-layout">`+panel('ADDON LIBRARY',`${data.files.length} archives · ${size(data.files.reduce((n,f)=>n+f.size,0))} · top entries have highest priority and load last`,rows?`<div class="table-wrap"><table><thead><tr><th>RESOURCE / LOAD ORDER</th><th>SIZE</th><th>STATE</th><th>ACTIONS</th></tr></thead><tbody>${rows}</tbody></table></div>`:empty('No addons yet','Upload an SCS or ZIP resource to get started.'),`<div class="row-actions">${button('reload','Reload')}${button('save-addons','Save order',!stopped()?'disabled':'')}</div>`)+panel('UPLOAD RESOURCE',`SCS and ZIP supported · maximum ${size(data.maxUpload)} · existing files are never overwritten.`,`<form id="upload-form" class="panel-body upload-form"><label class="file-drop">Drop archives here or browse<input id="addon-file" type="file" accept=".scs,.zip" multiple required ${!stopped()?'disabled':''}></label><button class="button primary" ${!stopped()?'disabled':''}>Upload selected archives</button><progress id="upload-progress" value="0" max="100" hidden aria-label="Upload progress"></progress><p class="hint" id="upload-state" role="status">${data.inspection?`${data.inspection.conflictCount??0} overlapping paths in published resources. ${data.inspection.complete?'Inspection complete.':'Some native archive indexes cannot be inspected.'}`:'Uploaded files are checked before publishing.'}</p><ul class="hint" id="upload-errors" hidden></ul></form>`)+`</div><p class="hint">Remove moves an archive to a private quarantine directory. It does not delete its bytes. Save order after arranging resources; then Start the game server to rebuild addons.json automatically.</p>`;
  if(owner)root().innerHTML+=panel('OPTIONAL MOD SLOTS','These slots are the optional mod allowlist. A compatible launcher uses a slot only when the approved mod is enabled in the player’s ETS2 career.',newSlotForm(editable));
  if(data.quarantine?.length)root().innerHTML+=panel('QUARANTINE',`${data.quarantine.length} / 20 archived resources`, `<div class="table-wrap"><table><thead><tr><th>RESOURCE</th><th>SIZE</th><th>ACTIONS</th></tr></thead><tbody>${data.quarantine.map(f=>`<tr><td><strong>${esc(f.name)}</strong></td><td>${size(f.size)}</td><td>${button('quarantine-restore','Restore',`data-id="${f.id}" ${!stopped()?'disabled':''}`)} ${button('quarantine-delete','Delete permanently',`data-id="${f.id}" ${!stopped()?'disabled':''}`)}</td></tr>`).join('')}</tbody></table></div>`);

 }
 function refreshDraft(){getDrafts()?.write('addons',{revision:addonData.revision,...addonDraft});const draft=addonDraft;drawAddons(addonData,draft);bind('addons',addonData);icons(root());}
 function bindAddonUpload(){
  const view=root(),form=view.querySelector('#upload-form'),input=form.querySelector('#addon-file');
  const drop=form.querySelector('.file-drop'),progress=form.querySelector('#upload-progress');
  const fileDrag=event=>event.dataTransfer.types.includes('Files');
  drop.ondragover=event=>{
   if(!fileDrag(event))return;
   event.preventDefault();
   event.dataTransfer.dropEffect=input.disabled?'none':'copy';
   drop.toggleAttribute('data-dragging',!input.disabled);
  };
  drop.ondragleave=event=>{if(!drop.contains(event.relatedTarget))drop.removeAttribute('data-dragging');};
  drop.ondrop=event=>{
   if(!fileDrag(event))return;
   event.preventDefault();
   drop.removeAttribute('data-dragging');
   if(!input.disabled)input.files=event.dataTransfer.files;
  };
  form.onsubmit=async event=>{
   event.preventDefault();
   const files=Array.from(input.files);
   if(!files.length||uploading||!stopped())return;
   uploading=true;
   const activeGeneration=generation;
   const controls=Array.from(view.querySelectorAll('button:enabled,input:enabled,select:enabled'));
   controls.forEach(control=>{control.disabled=true;});
   progress.hidden=false;
   const label=form.querySelector('#upload-state');
   try{
    const result=await uploadAddonBatch(files,addonData,sendAddon,({file,index,totalFiles,percent,checking})=>{
     progress.value=percent;
     label.textContent=(checking?'Checking ':'Uploading ')+(index+1)+' / '+totalFiles+' · '+file.name;
    });
    const summary=result.uploaded.length+' of '+files.length+' archives uploaded.'+
     (result.remaining?' '+result.remaining+' remaining.':'');
    if(generation!==activeGeneration){notice(summary);return;}
    if(result.uploaded.length){
     addonData=result.data;
     if(addonDirty){
      for(const name of result.uploaded){
       const target=result.data.order.includes(name)?addonDraft.order:addonDraft.disabled;
       target.push(name);
      }
      refreshDraft();
     }else{
      drawAddons(result.data);
      bind('addons',result.data);
      icons(root());
     }
    }
    view.querySelector('#upload-state').textContent=summary;
    const errors=view.querySelector('#upload-errors');
    for(const {name,code} of result.failed){
     const item=document.createElement('li');
     item.textContent=name+' · '+friendly(code);
     errors.append(item);
    }
    errors.hidden=!result.failed.length;
   }finally{
    uploading=false;
    controls.forEach(control=>{control.disabled=!stopped()&&control.dataset.action!=='reload';});
   }
  };
 }
 function drawBackups(data){
  const owner=status()?.access?.role==='owner',disabled=stopped()?'':'disabled';
  const used=data.items.reduce((sum,b)=>sum+b.bytes,0);
  const create=panel('Create a backup','Save a point you can restore to later.',`<form id="backup-create-form" class="panel-body backup-create-form">
   <label for="backup-label">Backup name<input id="backup-label" name="label" maxlength="80" required placeholder="Before changing mods" ${disabled}></label>
   ${owner?`<label>Backup type<select name="scope" ${disabled}><option value="data">Game data and load order</option><option value="full">Full server backup</option></select></label>
   <p>Full backups also include mod archives, configured game settings, module settings, and branding.</p>`:''}
   <div class="backup-facts"><span>Saved backups<strong>${data.items.length} / ${data.limit}</strong></span><span>Space used<strong>${size(used)}</strong></span></div>
   <button class="button primary" ${disabled}>Create backup</button></form>`);
  const list=panel('Your backups',`${data.items.length} saved snapshots`,data.items.length?`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Created</th><th>Size</th><th>Actions</th></tr></thead><tbody>${data.items.map(b=>`<tr><td><strong>${esc(b.label)}</strong><small>${b.full?'Full server':'Game data'} · ${b.files} files</small></td><td>${esc(local(b.createdAt))}</td><td>${size(b.bytes)}</td><td><div class="row-actions">
   ${owner||!b.full?button('restore','Restore',`data-id="${b.id}" ${disabled}`):''}
   ${owner?`<a class="button small" href="${esc(managerApi('backups/download?id='+b.id))}">Download</a>`:''}
   ${owner||!b.full?button('delete-backup','Delete',`data-id="${b.id}"`):''}
   </div></td></tr>`).join('')}</tbody></table></div>`:empty('No backups yet','Create or import your first backup.'),button('reload','Refresh'));
  const imported=owner?panel('Import a backup','Verify and add a downloaded HeavyMP backup to this server.',`<form id="backup-import-form" class="panel-body backup-create-form">
   <label>Backup file<input type="file" name="backup" required accept=".hvmpbackup,application/octet-stream"></label>
   <progress hidden aria-label="Backup upload progress"></progress><p role="status" hidden></p>
   <button class="button">Import backup</button></form>`):'';
  root().innerHTML=stateNote()+`<div class="backup-layout"><div>${create}${imported}</div>${list}</div><p class="hint">Restore creates a verified safety backup first. Credentials, executable scripts, and host files are managed separately.</p>`;
 }
 function drawAutomation(data){root().innerHTML=`<div class="callout"><strong>Times shown in your browser’s local timezone</strong><span>Schedules are stored in UTC and survive restarts. Restarts warn connected players 60 and 10 seconds beforehand. Tasks missed by more than two minutes are not replayed.</span></div>`+panel('SCHEDULED TASKS',`${data.jobs.length} / ${data.limit} tasks`,data.jobs.length?`<div class="table-wrap"><table><thead><tr><th>TASK</th><th>NEXT EXECUTION</th><th>REPEAT</th><th>STATE</th><th></th></tr></thead><tbody>${data.jobs.map(j=>`<tr><td><strong>${j.kind==='restart'?'Server restart':'Announcement'}</strong><small>${esc(j.message||'Graceful game restart')}</small>${j.lastError?`<small class="amber">${esc(j.lastError)}</small>`:''}</td><td>${esc(local(j.at))}</td><td>${j.repeatMinutes?j.repeatMinutes+' min':'Once'}</td><td><span class="badge ${j.state==='completed'?'good':j.state==='failed'?'bad':''}">${esc(j.state.toUpperCase())}</span></td><td><div class="row-actions">${['scheduled','paused'].includes(j.state)?button('toggle-task',j.state==='paused'?'Resume':'Pause',`data-id="${j.id}"`):''}${button('delete-task','Remove',`data-id="${j.id}"`)}</div></td></tr>`).join('')}</tbody></table></div>`:empty('Nothing scheduled','Plan an announcement or a quiet restart window.'),`<div class="row-actions">${button('reload','Reload')}${button('create-task','Schedule a task')}</div>`)+panel('SEND AN ANNOUNCEMENT','Appears in HeavyMP and in active game sessions.',`<form id="announcement-form" class="panel-body inline-form"><input name="message" required maxlength="240" placeholder="Message to everyone on this server" aria-label="Announcement message"><button class="button primary">Send now</button></form>`);}
 function drawChat(data){chatData=data;root().innerHTML=panel('CHAT ARCHIVE','Public server channels only. Private SMS and calls are never captured.',`<form id="chat-search" class="toolbar"><input name="day" type="date" value="${data.day}" required aria-label="UTC date"><select name="channel" aria-label="Channel"><option value="all">All channels</option>${['global','local','vtc','system'].map(c=>`<option value="${c}">${c.toUpperCase()}</option>`).join('')}</select><input name="search" maxlength="100" placeholder="Search message, name, SteamID…" aria-label="Search chat"><button class="button">Search</button></form><div id="chat-results"></div><div class="toolbar">${button('more-chat','Load older',data.next?'':'disabled')}${button('export-chat','Export this page')}<span class="search-meta">UTC date · up to 200 entries per page</span></div>`);drawChatResults(data.entries);}
 function drawChatResults(entries){document.querySelector('#chat-results').innerHTML=entries.length?`<div class="chat-archive">${entries.map(e=>`<article class="archive-message"><time>${esc(local(e.at))}</time><span class="badge">${esc(e.message.channel.toUpperCase())}</span><div><strong>${esc(e.message.name)}</strong><small>${esc(e.message.senderId??'System')}</small><p>${esc(e.message.text)}</p></div></article>`).join('')}</div>`:empty('No matching messages','Choose a different date or search. Only messages recorded after this update are available.');}
 function drawModeration(data){root().innerHTML=`<div class="callout"><strong>Local to this server</strong><span>Warnings and kicks apply immediately to connected players. Mutes and bans are persisted, expire automatically and survive restarts.</span></div>`+panel('ACTIVE SANCTIONS',`${data.rules.length} active restrictions`,data.rules.length?`<div class="table-wrap"><table><thead><tr><th>CLIENT FINGERPRINT</th><th>RESTRICTION</th><th>REASON</th><th>EXPIRES</th><th></th></tr></thead><tbody>${data.rules.map(r=>`<tr><td><strong>${esc(r.identity)}</strong></td><td><span class="badge ${r.kind==='ban'?'bad':''}">${r.kind.toUpperCase()}</span></td><td class="wrap-cell">${esc(r.reason)}</td><td>${esc(local(r.until))}</td><td>${button('lift','Lift',`data-identity="${esc(r.identity)}" data-kind="${r.kind}"`)}</td></tr>`).join('')}</tbody></table></div>`:empty('No active sanctions','Connected players can be moderated from Players.'),`<div class="row-actions">${button('reload','Reload')}${button('moderate','New action')}</div>`);}
 function drawAudit(data){root().innerHTML=panel('ADMINISTRATIVE ACTIVITY','Last 500 actions · secrets are excluded.',data.entries.length?`<div class="table-wrap"><table><thead><tr><th>TIME</th><th>ADMINISTRATOR</th><th>ACTION</th><th>DETAILS</th></tr></thead><tbody>${data.entries.map(e=>`<tr><td>${esc(local(e.at))}</td><td>${esc(e.actor)}</td><td><strong>${esc(e.action)}</strong></td><td class="wrap-cell">${esc(JSON.stringify(e.details))}</td></tr>`).join('')}</tbody></table></div>`:empty('No administrative activity yet'),`<div class="row-actions">${button('reload','Reload')}${button('export-audit','Export')}</div>`);}
 function performanceChart(points,key,label){const values=points.filter(p=>Number.isFinite(p[key])).slice(-150);if(values.length<2)return empty('Collecting measurements','A lightweight sample is collected every five seconds while the panel is closed.');const max=Math.max(1,...values.map(p=>p[key])),path=values.map((p,i)=>(i?'L':'M')+(12+i*576/(values.length-1)).toFixed(1)+' '+(150-p[key]/max*128).toFixed(1)).join(' ');return `<svg class="performance-chart" viewBox="0 0 600 180" role="img" aria-label="${label}"><path class="gridline" d="M12 22H588M12 86H588M12 150H588"/><path class="line" d="${path}"/><text x="12" y="173">${esc(time(values[0].at))}</text><text x="510" y="173">${esc(time(values.at(-1).at))}</text><text x="12" y="15">${num(max,1)} ${label}</text></svg>`;}
 function updatePerformance(){if(current!=='performance')return;const box=document.querySelector('#performance-live');if(!box)return;const s=status(),h=s?.snapshot?.health,m=h?.metrics??{},p=s?.snapshot?.process,history=s?.history??[];box.innerHTML=`<div class="metrics">${metric('TICK WORK',num(m.lastTickMs,2)+'<small> ms</small>',h?'Budget '+num(1000/h.tickHz,2)+' ms per tick':'Waiting for game data')}${metric('EVENT LOOP P95',num(m.eventLoopP95Ms,2)+'<small> ms</small>','Delay observed by Node')}${metric('NETWORK OUT',size(m.syncOutBytesPerSecond??0)+'<small>/s</small>','Synchronization bytes')}${metric('PING P95',num(m.pingP95Ms)+'<small> ms</small>',num(m.pingSamples)+' measured players')}</div><div class="grid-two">${panel('RESOURCE TIMELINE','Recent in-memory samples; resets when the Manager restarts.',`<div class="panel-body"><div class="segmented">${[['cpu','CPU'],['rss','Memory'],['tick','Tick'],['loop','Loop delay']].map(([key,label])=>`<button class="button small ${chartMode===key?'primary':''}" data-chart="${key}">${label}</button>`).join('')}</div>${performanceChart(history,chartMode,chartMode==='cpu'?'%':chartMode==='rss'?'MB':'ms')}</div>`)}${panel('SYNCHRONIZATION','Actual measurements from the running game process.',`<div class="panel-body facts">${[['CPU / core',num(p?.cpuPercent,1)+'%'],['Heap used',num(p?.heapMb)+' MB'],['States accepted / s',num(m.acceptedStatesPerSecond)],['States throttled / s',num(m.throttledStatesPerSecond)],['Skipped ticks / s',num(m.skippedTicksPerSecond)],['Synchronized vehicles',num(m.synchronizedVehicles)],['Traffic actors',num(h?.traffic?.actors)],['Active sectors',num(h?.sectors?.occupied)]].map(([k,v])=>`<div class="fact"><span>${k}</span><strong>${v}</strong></div>`).join('')}</div>`)}</div><p class="hint">CPU is measured against one core. Sequence gaps are application-level messages, not packet loss. This panel does not measure client FPS.</p>`;for(const b of box.querySelectorAll('[data-chart]'))b.onclick=()=>{chartMode=b.dataset.chart;updatePerformance();};icons(box);}
 async function action(task,success){const view=current,token=generation;try{const result=await task();notice(success??result.note??'Changes saved.');if(current===view&&generation===token)await load(view);}catch(e){notice(friendly(e.message));}}
 function bind(kind,data){for(const b of root().querySelectorAll('[data-action]'))b.onclick=async()=>{const a=b.dataset.action;
  if(a==='reload'){if(addonDirty&&!await confirmAction('Discard unsaved addon changes?','Your saved configuration will be reloaded.',false))return;return load(kind);}
  if(a==='save-member'||a==='remove-member'){
   const row=b.closest('[data-member]'),steamId=row.dataset.member,role=row.querySelector('[data-member-role]').value,remove=a==='remove-member';
   if(remove&&!await confirmAction('Remove Manager access?','This signs the user out of this instance immediately.'))return;
   b.disabled=true;
   try{await action(()=>api('access',{action:remove?'remove':'set',steamId,role}),remove?'Access removed.':'Role updated.');}
   finally{if(b.isConnected)b.disabled=false;}
   return;
  }
  if(a==='toggle-script'){
   b.disabled=true;
   try{await action(()=>api('scripts/toggle',{id:b.dataset.id,enabled:b.dataset.enabled==='true',revision:data.revision}),'Module setting saved.');}
   finally{if(b.isConnected)b.disabled=false;}
   return;
  }
  if(a==='report')return download('hvmp-diagnostics.json',JSON.stringify({host:data,status:status()},null,2),'application/json');
  if(a==='export-audit')return download('hvmp-audit.json',JSON.stringify(data.entries,null,2),'application/json');
  if(a==='create-backup'){const v=await dialog({title:'Create data backup',description:'The game server must stay stopped until the copy is complete.',fields:[{name:'label',label:'Backup name',value:'Manual backup',maxLength:80,required:true}],submit:'Create backup'});if(v)void action(()=>api('backups/create',v),'Backup created and verified.');}
  if(a==='restore'){
   const backup=data.items.find(item=>item.id===b.dataset.id);
   if(backup&&await confirmAction('Restore this backup?',backup.complete?'This replaces the saved files and delegated access, including custom scripts that can run on this host. Restore packs from a source you trust. A safety backup is created first.':'Live game data will be replaced. A verified safety snapshot is created first. The game server will stay stopped.'))
    void action(()=>api('backups/restore',{id:backup.id,confirm:true,trusted:backup.complete}),'Backup restored. Start the server when ready.');
  }
  if(a==='delete-backup'&&await confirmAction('Delete this backup?','This snapshot will be permanently removed. Live game data is not changed.'))void action(()=>api('backups/delete',{id:b.dataset.id,confirm:true}),'Backup deleted.');
  if(a==='create-task'){const at=new Date(Date.now()+3600000);at.setMinutes(at.getMinutes()-at.getTimezoneOffset());const v=await dialog({title:'Schedule a task',description:'Date and time use your browser’s timezone.',submit:'Schedule',fields:[{name:'kind',label:'Action',options:[{value:'announcement',label:'Announcement'},{value:'restart',label:'Restart game server'}]},{name:'at',label:'Date and time',type:'datetime-local',value:at.toISOString().slice(0,16),required:true},{name:'message',label:'Announcement text (not used for restart)',maxLength:240},{name:'repeatMinutes',label:'Repeat every (minutes, 0 = once)',type:'number',value:0,min:0,max:10080}]});if(v)void action(()=>api('automation/create',{...v,revision:data.revision,at:new Date(v.at).toISOString(),repeatMinutes:Number(v.repeatMinutes)}),'Task scheduled.');}
  if(a==='toggle-task')void action(()=>api('automation/toggle',{id:b.dataset.id,revision:data.revision}),'Schedule updated.');
  if(a==='delete-task'&&await confirmAction('Remove this task?','Its next execution will be cancelled.'))void action(()=>api('automation/delete',{id:b.dataset.id,revision:data.revision}),'Task removed.');
  if(a==='moderate')void moderate();
  if(a==='lift'&&await confirmAction('Lift this restriction?','This removes only the local '+b.dataset.kind+' on this instance.',false))void action(()=>api('moderation',{identity:b.dataset.identity,action:'un'+b.dataset.kind,revision:data.revision}),'Restriction lifted.');
  if(a==='quarantine-restore'||a==='quarantine-delete'){if(await confirmAction(a==='quarantine-restore'?'Restore this resource?':'Permanently delete this resource?',a==='quarantine-restore'?'The archive returns to the addon library.':'The quarantined archive bytes will be deleted.'))void action(()=>api('addons/quarantine',{id:b.dataset.id,revision:addonData.revision,action:a==='quarantine-restore'?'restore':'delete',confirm:true}),'Quarantine updated.');}
  if(a==='save-addons')void action(async()=>{const {order,disabled,optional}=addonDraft;const result=await api('addons/order',{order,disabled,...(status()?.access?.role==='owner'?{optional}:{}),revision:addonData.revision});getDrafts()?.clear('addons');return result;},'Addon order saved. Start the server to publish changes.');
  if(a==='export-chat')download('hvmp-chat-'+chatData.day+'.json',JSON.stringify(chatData.entries,null,2),'application/json');
  if(a==='more-chat'){const params=new URLSearchParams(new FormData(document.querySelector('#chat-search')));params.set('before',chatData.next);try{const next=await api('chat?'+params);chatData={...next,entries:[...chatData.entries,...next.entries]};drawChatResults(chatData.entries);b.disabled=!next.next;}catch(e){notice(friendly(e.message));}}
 };
 if(kind==='access'){
  for(const row of root().querySelectorAll('[data-member]')){
   const select=row.querySelector('[data-member-role]');
   if(select)select.onchange=()=>{row.querySelector('[data-action="save-member"]').disabled=select.value===data.users.find(u=>u.steamId===row.dataset.member).role;};
  }
  root().querySelector('#manager-add-user').onsubmit=async e=>{
   e.preventDefault();
   const form=e.currentTarget,{steamId,role}=Object.fromEntries(new FormData(form)),submit=form.querySelector('button');
   if(data.users.some(u=>u.steamId===steamId))return notice('This Steam account already has access. Use its row to change the role.');
   submit.disabled=true;
   try{await action(()=>api('access',{action:'add',steamId,role}),'User added. They can now sign in with Steam.');}
   finally{if(submit.isConnected)submit.disabled=false;}
  };
 }
 if(kind==='instances'){
  const picker=root().querySelector('#instance-pack-file'),importButton=root().querySelector('#import-instance-pack');
  const createButton=root().querySelector('#toggle-instance-create'),createPanel=root().querySelector('#instance-create-panel');
  createButton.onclick=()=>{
   createPanel.hidden=!createPanel.hidden;
   createButton.setAttribute('aria-expanded',String(!createPanel.hidden));
   if(!createPanel.hidden)createPanel.querySelector('input').focus();
  };
  importButton.onclick=()=>picker.click();
  picker.onchange=async()=>{
   const file=picker.files[0];
   picker.value='';
   if(!file||uploading)return;
   if(!await confirmAction('Import this server pack?','This creates a stopped instance with the pack’s settings, shared mods, scripts and delegated roles. Only import packs from a source you trust.',false))return;
   const progress=root().querySelector('.instance-import-progress');
   if(!progress)return;
   const meter=progress.querySelector('progress'),message=progress.querySelector('[role=status]');
   uploading=true;importButton.disabled=true;progress.hidden=false;meter.hidden=false;meter.max=file.size;meter.value=0;
   message.textContent='Uploading server pack…';
   try{
    const result=await importBackupFile(file,bytes=>{
     meter.value=bytes;
     if(bytes===file.size)message.textContent='Verifying the pack and creating the instance…';
    },null,{createInstance:true});
    notice(result.instance.name+' imported on port '+result.instance.port+'. It is ready to start.');
    if(current==='instances')await load('instances');
   }catch(error){message.textContent=friendly(error.message);meter.hidden=true;}
   finally{uploading=false;importButton.disabled=false;}
  };
  root().querySelector('[data-action="delete-all"]').onclick=async e=>{
   const control=e.currentTarget;control.disabled=true;
   try{
    const latest=await api('instances');
    if(!latest.items.length)return;
    if(latest.items.some(item=>!item.canDelete)){notice('Stop all game servers before deleting them.');return;}
    if(await confirmAction('Delete all '+latest.items.length+' server instances?',
     'All instances will be removed. Their mods, saves, and settings stay on disk. This dashboard stays open.'))
     await action(()=>api('instances/delete-all',{revision:latest.revision,confirm:true}),'All server instances removed.');
   }catch(error){notice(friendly(error.message));}
   finally{if(control.isConnected)control.disabled=false;}
  };
  root().querySelector('#instance-rows').onclick=async e=>{
   const button=e.target.closest('button[data-instance-manage],button[data-instance-power],button[data-instance-delete],button[data-instance-rename],button[data-instance-packs]');
   if(!button||button.disabled)return;
   const id=button.closest('[data-instance]').dataset.instance,choice=button.dataset.instancePower;
   if(button.hasAttribute('data-instance-packs')){
    if(packBusy||uploading)return notice('Wait for the current server pack operation to finish.');
    const {items}=await api('instances').catch(error=>{notice(friendly(error.message));return {items:[]};});
    const item=items.find(row=>row.id===id);
    if(item&&current==='instances')await showInstancePacks(item,true);
    return;
   }
   if(button.hasAttribute('data-instance-manage'))return openInstance(id);
   if(button.hasAttribute('data-instance-rename')){
    const name=button.closest('[data-instance]').querySelector('strong').textContent;
    const result=await dialog({title:'Rename server',fields:[{name:'name',label:'Server name',value:name,maxLength:80,required:true}],submit:'Rename'});
    if(result)await action(()=>api('instances/rename',{id,name:result.name}),'Server renamed.');
    return;
   }
   if(button.hasAttribute('data-instance-delete')){
    if(!await confirmAction('Delete '+id+'?','This removes the server instance and keeps its mods, saves, and settings on disk.'))return;
    button.disabled=true;
    try{await action(()=>api('instances/delete',{id,confirm:true}),'Instance removed. Its files are retained on disk.');}
    finally{if(button.isConnected)button.disabled=false;}
    return;
   }
   if(choice!=='start'&&!await confirmAction('Change the game state?','This will disconnect players from '+id+'.'))return;
   button.disabled=true;
   try{await action(()=>api('instances/power',{id,action:choice,confirm:true}),'Instance command accepted.');}
   finally{if(button.isConnected)button.disabled=false;}
  };
  root().querySelector('#instance-create').onsubmit=async e=>{
   e.preventDefault();
   const form=e.currentTarget,values=Object.fromEntries(new FormData(form)),submit=form.querySelector('button');
   submit.disabled=true;
   try{await action(()=>api('instances/create',{...values,port:Number(values.port)}),'Server instance created.');}
   finally{if(submit.isConnected)submit.disabled=false;}
  };
 }
 if(kind==='addons'){
  const owner=status()?.access?.role==='owner';
  const updateRows=rows=>{addonDirty=true;storeMixedOrder(addonDraft,rows);refreshDraft();};
  for(const b of root().querySelectorAll('[data-toggle]'))b.onclick=()=>{
   const name=b.dataset.toggle,rows=mixedOrder(addonDraft),index=rows.findIndex(row=>row.name===name);
   if(index>=0){rows.splice(index,1);addonDraft.disabled.push(name);}
   else{addonDraft.disabled=addonDraft.disabled.filter(n=>n!==name);rows.push({key:'shared:'+name,name});}
   updateRows(rows);
  };
  for(const b of root().querySelectorAll('[data-move-row]'))b.onclick=()=>{
   const rows=mixedOrder(addonDraft),items=owner?rows:rows.filter(row=>row.name);
   const index=items.findIndex(row=>row.key===b.dataset.moveRow),to=index+Number(b.dataset.dir);
   if(index<0||to<0||to>=items.length)return;
   [items[index],items[to]]=[items[to],items[index]];
   if(owner)updateRows(items);
   else{addonDirty=true;addonDraft.order=items.reverse().map(row=>row.name);refreshDraft();}
  };
  for(const b of root().querySelectorAll('[data-remove-slot]'))b.onclick=()=>updateRows(mixedOrder(addonDraft).filter(row=>row.key!==b.dataset.removeSlot));
  for(const b of root().querySelectorAll('[data-edit-slot-link]'))b.onclick=async()=>{
   const key=b.dataset.editSlotLink,initial=mixedOrder(addonDraft).find(row=>row.key===key);
   if(!initial?.slot)return;
   const openingGeneration=generation;
   const fields=await dialog({title:'Download link for '+initial.slot.name,
    description:'Use an HTTPS download or mod page. Leave the field empty to remove the link.',
    fields:[{name:'url',label:'Download link',type:'url',value:initial.slot.downloadUrl??'',maxLength:optionalDownloadUrlLimit}],submit:'Apply link'});
   if(!fields||generation!==openingGeneration||uploading||!stopped())return;
   const rows=mixedOrder(addonDraft),row=rows.find(item=>item.key===key);
   if(!row?.slot)return;
   try{
    const url=validateOptionalDownloadLink(fields.url);
    if(url)row.slot.downloadUrl=url;
    else delete row.slot.downloadUrl;
    updateRows(rows);
   }catch(error){notice(error.message);}
  };
  for(const b of root().querySelectorAll('[data-mark-optional]'))b.onclick=()=>{
   const name=b.dataset.markOptional,rows=mixedOrder(addonDraft),index=rows.findIndex(row=>row.name===name);
   if(index<0)return;
   rows.splice(index,1);
   if(!addOptionalSlot(rows,{name:name.slice(0,100),source:'local',match:name},index))return notice('This archive already has an optional slot.');
   addonDraft.disabled.push(name);
   updateRows(rows);
  };
  const slotForm=root().querySelector('#optional-slot-form');
  if(slotForm){
   const downloadLabel=slotForm.querySelector('[data-optional-download]');
   const sourceInput=slotForm.elements.namedItem('source');
   sourceInput.onchange=()=>{
    downloadLabel.hidden=sourceInput.value==='workshop';
    downloadLabel.querySelector('input').disabled=downloadLabel.hidden;
   };
   slotForm.onsubmit=e=>{
    e.preventDefault();
    const fields=new FormData(slotForm),name=fields.get('name').trim(),source=fields.get('source'),match=fields.get('match').trim();
    if(!name||!match||source==='workshop'&&!/^[1-9][0-9]{0,19}$/.test(match))return notice('Enter a display name and a valid file name or Workshop item ID.');
    let downloadUrl;
    try{downloadUrl=source==='local'?validateOptionalDownloadLink(fields.get('downloadUrl')??''):'';}
    catch(error){return notice(error.message);}
    const rows=mixedOrder(addonDraft);
    if(!addOptionalSlot(rows,{name,source,match,...(downloadUrl?{downloadUrl}:{})}))return notice('This optional mod already has a slot.');
    updateRows(rows);
   };
  }
  const optionalBulk=root().querySelector('#optional-bulk-form');
  if(optionalBulk)optionalBulk.onsubmit=event=>{
   event.preventDefault();
   if(uploading||!stopped())return;
   const rows=mixedOrder(addonDraft);
   const names=Array.from(optionalBulk.querySelector('#optional-files').files,file=>file.name);
   const {added,skipped}=addLocalArchiveSlots(rows,names);
   if(added)updateRows(rows);
   notice(added+' optional '+(added===1?'slot':'slots')+' added.'+
    (skipped.length?' '+skipped.length+' skipped (duplicate, invalid filename, or slot limit).':'')+
    (added?' Save order to apply.':''));
  };
  for(const row of root().querySelectorAll('[draggable="true"]')){
   row.ondragstart=e=>{if(uploading){e.preventDefault();return;}e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',row.dataset.orderRow);};
   row.ondragover=e=>{e.preventDefault();e.dataTransfer.dropEffect='move';};
   row.ondrop=e=>{
    e.preventDefault();
    if(uploading)return;
    const rows=mixedOrder(addonDraft),from=rows.findIndex(item=>item.key===e.dataTransfer.getData('text/plain'));
    if(from<0||rows[from].key===row.dataset.orderRow)return;
    const [moved]=rows.splice(from,1),to=rows.findIndex(item=>item.key===row.dataset.orderRow),bounds=row.getBoundingClientRect();
    rows.splice(to+(e.clientY>bounds.top+bounds.height/2?1:0),0,moved);
    updateRows(rows);
   };
  }
  for(const b of root().querySelectorAll('[data-remove]'))b.onclick=async()=>{if(await confirmAction('Remove this addon?','The archive will be moved to private quarantine. It will no longer be published.'))void action(()=>api('addons/remove',{name:b.dataset.remove,revision:addonData.revision,confirm:true}),'Resource moved to quarantine.');};
  bindAddonUpload();
 }
 if(kind==='backups'){
  document.querySelector('#backup-create-form').onsubmit=async e=>{
   e.preventDefault();
   const fields=new FormData(e.target),submit=e.target.querySelector('button');
   submit.disabled=true;
   await action(()=>api('backups/create',{label:fields.get('label'),full:fields.get('scope')==='full'}),'Backup created and verified.');
   if(submit.isConnected)submit.disabled=!stopped();
  };
  const form=document.querySelector('#backup-import-form');
  if(form)form.onsubmit=async e=>{
   e.preventDefault();
   const file=form.elements.backup.files[0],submit=form.querySelector('button'),meter=form.querySelector('progress'),label=form.querySelector('[role=status]');
   if(!file||uploading)return;
   uploading=true;submit.disabled=true;form.elements.backup.disabled=true;
   meter.hidden=label.hidden=false;meter.max=file.size;meter.value=0;
   label.textContent='Uploading backup…';
   try{
    await action(()=>importBackupFile(file,bytes=>{
     meter.value=bytes;
     if(bytes===file.size)label.textContent='Verifying backup…';
    }),'Backup imported and verified. Select Restore to apply it.');
   }finally{
    uploading=false;
    if(form.isConnected){submit.disabled=form.elements.backup.disabled=false;label.hidden=meter.hidden=true;}
   }
  };
 }
 if(kind==='automation')document.querySelector('#announcement-form').onsubmit=async e=>{e.preventDefault();const message=new FormData(e.target).get('message');if(await confirmAction('Send announcement?','Everyone connected will receive: '+message,false))void action(()=>api('console',{line:'annonce '+message}));};
 if(kind==='chat')document.querySelector('#chat-search').onsubmit=async e=>{e.preventDefault();try{const params=new URLSearchParams(new FormData(e.target));chatData=await api('chat?'+params);drawChatResults(chatData.entries);document.querySelector('[data-action="more-chat"]').disabled=!chatData.next;}catch(error){notice(friendly(error.message));}};
 }
 document.addEventListener('manager:draft-action',async e=>{if(current!=='addons')return;const a=e.detail.action;if(a==='discard-addons-draft'){getDrafts()?.clear('addons');await load('addons');}else if(a==='restore-addons-draft'){const saved=getDrafts()?.read('addons')?.value;if(!saved)return;const available=new Set(addonData.files.map(f=>f.name));if(saved.revision!==addonData.revision){notice('Resources changed since this draft. Review the current library and arrange the order again.');return;}if(await confirmAction('Restore unfinished addon order?','This restores your editing draft. Resources are not changed until you save the order.',false)){addonDraft={order:saved.order.filter(n=>available.has(n)),disabled:saved.disabled.filter(n=>available.has(n)),optional:saved.optional??addonData.optional??[]};addonDirty=true;refreshDraft();}}});
 async function moderate(identity=''){const data=await api('moderation');const v=await dialog({title:'Moderate player',description:'Applies to this server only.',submit:'Apply action',danger:true,fields:[{name:'identity',label:'Client fingerprint',value:identity,required:true,maxLength:64},{name:'action',label:'Action',options:[{value:'warn',label:'Warn'},{value:'kick',label:'Kick'},{value:'mute',label:'Mute chat'},{value:'ban',label:'Ban from this server'}]},{name:'reason',label:'Reason',required:true,maxLength:160},{name:'minutes',label:'Duration (minutes, mute/ban only)',value:60,type:'number',min:1,max:43200}]});if(v){try{const result=await api('moderation',{...v,minutes:Number(v.minutes),revision:data.revision});notice(result.result?.ok===false?result.result.error:result.note??'Action applied.');if(current==='moderation')await load(current);}catch(e){notice(friendly(e.message));}}}
 return {has:kind=>kind==='addons'||Object.hasOwn(adminPages,kind),render:load,leave(){current='';generation++;},update(){updatePerformance();void updateInstances();},hasUnsaved:()=>addonDirty&&current==='addons',isUploading:()=>uploading,discard:()=>{getDrafts()?.clear('addons');addonDirty=false;},moderate};
}
