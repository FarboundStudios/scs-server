// Shared, deterministic guidance. Observations are facts; suggested checks are not diagnoses.
export const PROFILES=[
 {id:'keep',title:'Keep my configuration',description:'Review your current server without changing any game settings.',values:{}},
 {id:'community',title:'Community server',description:'Allow players, with player collisions and a moderate update rate.',values:{STAFF_ONLY:'false',PLAYER_COLLISIONS:'true',TICK_HZ:'20'}},
 {id:'simulation',title:'Simulation',description:'Public access, player collisions and a limited initial traffic population. Native traffic requires compatible clients.',values:{STAFF_ONLY:'false',PLAYER_COLLISIONS:'true',TICK_HZ:'20',TRAFFIC_ENABLED:'true',TRAFFIC_MAX_VEHICLES:'16',TRAFFIC_HZ:'10'}},
 {id:'convoy',title:'Convoy event',description:'Public access with player collisions and AI traffic disabled. Existing missions and addons are preserved.',values:{STAFF_ONLY:'false',PLAYER_COLLISIONS:'false',TRAFFIC_ENABLED:'false',TICK_HZ:'20'}},
 {id:'development',title:'Staff development',description:'Only verified configured staff clients can join. This is not a private invitation list for ordinary community members.',values:{STAFF_ONLY:'true',TRAFFIC_ENABLED:'false',TICK_HZ:'20'}}
];
export const BASIC_SETTINGS=['MAX_PLAYERS','STAFF_ONLY','PLAYER_COLLISIONS','NO_COLLISION_ZONES_ENABLED','TRAFFIC_ENABLED','TRAFFIC_MAX_VEHICLES','TIME_SCALE','LOCAL_CHAT_RADIUS'];
export const SEARCH_INTENTS=[
 {id:'intent:public',title:'Let community members join',description:'Open the access setting. Review staff-only access before saving.',terms:'public private access staff join members',page:'settings',key:'STAFF_ONLY'},
 {id:'intent:slots',title:'Change the player limit',description:'Configure how many players can join, within your hosting allowance.',terms:'slots capacity players limit',page:'settings',key:'MAX_PLAYERS'},
 {id:'intent:traffic',title:'Configure AI traffic',description:'Enable traffic and review the population budget.',terms:'traffic ai cars vehicles enable disable on off',page:'settings',key:'TRAFFIC_ENABLED'},
 {id:'intent:collisions',title:'Configure player collisions',description:'Choose whether player vehicles can collide.',terms:'collision collisions contact physics enable disable on off',page:'settings',key:'PLAYER_COLLISIONS'},
 {id:'intent:addon',title:'Add a mod step by step',description:'Prepare, back up, import and verify a server resource.',terms:'add install mod addon resource skin map',page:'help',workflow:'addon'},
 {id:'intent:restart',title:'Schedule a restart',description:'Plan a restart and warn connected players.',terms:'restart schedule',page:'automation'},
 {id:'intent:announce',title:'Send an announcement',description:'Send an official notification to connected players.',terms:'announce announcement notify notification broadcast message',page:'automation'},
 {id:'intent:profile',title:'Choose a server profile',description:'Preview a community, simulation, convoy or development configuration.',terms:'profile preset simulation convoy development configuration',page:'help',workflow:'profile'}
];
export function profileChanges(id,fields,slots){
 const profile=PROFILES.find(p=>p.id===id);if(!profile)throw Error('invalid_profile');
 const values={...profile.values};if(slots!==undefined&&slots!==null&&slots!=='')values.MAX_PLAYERS=String(slots);
 const changes=[],blocked=[];
 for(const [key,after]of Object.entries(values)){
  const field=fields.find(f=>f.key===key);if(!field){blocked.push({key,reason:'unsupported'});continue;}
  if(String(field.value)===after)continue;
  if(field.overridden){blocked.push({key,reason:'hosting'});continue;}
  if(field.type==='number'&&(!Number.isFinite(Number(after))||Number(after)<field.min||Number(after)>field.max||Math.abs((Number(after)-field.min)/field.step-Math.round((Number(after)-field.min)/field.step))>1e-7))throw Error('invalid_profile');
  changes.push({key,label:field.label,group:field.group,before:String(field.value),after,effective:String(field.effective)});
 }
 return {profileId:id,changes,blocked};
}
const activeValue=(context,key)=>context?.settings?.fields?.find(f=>f.key===key)?.effective;
export function adviceModel({status,context={},logs=[],setup,now=Date.now()}){
 const cards=[],h=status?.snapshot?.health,m=h?.metrics??{},fresh=!!h&&Number.isFinite(status?.sampledAt)&&now-status.sampledAt>=-1000&&now-status.sampledAt<10000;
 const add=(id,priority,title,description,page,evidence={})=>cards.push({id,priority,title,description,page,evidence});
 if(status?.state==='crashed')add('crashed',0,'The game server stopped unexpectedly','Open the console and check the latest startup error before trying again.','console',{state:status.state});
 else if(status?.state==='stopped')add('stopped',1,'Your game server is stopped','Players cannot join until you start the game server. The Manager stays available.','console',{state:status.state});
 else if(['starting','stopping'].includes(status?.state))add('transition',2,'A server operation is in progress','Wait for the current operation to finish.','console',{state:status.state});
 if(setup&&!setup.completedAt)add('setup',1,setup.startedAt?'Continue your first setup':'Prepare your community','Review access, choose a profile and finish the first-use checklist.','help',{step:setup.step??0});
 if(status?.state==='running'&&!fresh)add('stale',1,'Live measurements are unavailable','The game process is running, but its latest measurements are missing or older than ten seconds. Check the connection before changing settings.','performance',{sampledAt:status?.sampledAt??null});
 if(context.settings?.restartRequired)add('pending',1,'Saved settings are waiting for a restart','Your saved configuration differs from the running game. Choose a quiet time to restart; connected players will disconnect.','settings',{keys:context.settings.fields.filter(f=>!f.overridden&&String(f.value)!==String(f.effective)).map(f=>f.key)});
 if(fresh){
  const recent=(status.history??[]).filter(p=>Number.isFinite(p.at)&&now-p.at>=-1000&&now-p.at<120000).slice(-12);
  const budget=Number.isFinite(h.tickHz)&&h.tickHz>0?1000/h.tickHz:null;
  if(recent.length>=4&&budget&&recent.filter(p=>Number.isFinite(p.tick)&&p.tick>budget).length>=3)add('tick',2,'Update work repeatedly exceeded its budget','Several recent samples took longer than the configured update interval. Review synchronization load before increasing the update rate.','performance',{samples:recent.length,overBudget:recent.filter(p=>p.tick>budget).length,budgetMs:Math.round(budget*100)/100});
  if(recent.length>=4&&recent.filter(p=>Number.isFinite(p.loop)&&p.loop>100).length>=3)add('loop',2,'The server repeatedly responded late','Several samples show a delayed event loop. Inspect performance and recent operations to narrow down the cause.','performance',{samples:recent.length,delayed:recent.filter(p=>p.loop>100).length});
  if(h.traffic?.enabled&&h.players>0&&h.traffic.actors===0&&Number.isFinite(status.startedAt)&&now-status.startedAt>90000)add('traffic',3,'No synchronized traffic is currently reported','Ask a player to stay in driving mode on an open road with a compatible client, then inspect traffic measurements. This observation alone does not identify a fault.','performance',{actors:0,players:h.players});
 }
 const errors=logs.filter(e=>e.level==='error'&&!e.message&&Number.isFinite(Date.parse(e.at))&&now-Date.parse(e.at)>=-1000&&now-Date.parse(e.at)<300000&&Date.parse(e.at)>=(status?.startedAt??0)).slice(-20);
 if(errors.length){
  const auth=errors.some(e=>/staff_identities|access_denied|unauthorized/i.test(e.text));
  const mission=errors.some(e=>/job_mismatch|mission.*failed/i.test(e.text));
  add('errors',auth?0:2,auth?'A server access error was reported':mission?'A mission synchronization error was reported':'Recent errors need a look',auth?'Check the access settings and the error details in the console.':mission?'Inspect the latest mission errors in the console.':'Open the logs to see the recorded evidence. An error message alone is not a confirmed root cause.','logs',{count:errors.length,lastAt:errors.at(-1).at});
 }
 if(activeValue(context,'STAFF_ONLY')==='true')add('staff',4,'Only configured staff clients can join','Staff-only access is enabled in the running game. Ordinary community members will be refused.','settings',{key:'STAFF_ONLY',effective:true});
 if(context.addons?.conflicts>0)add('conflicts',3,'Some resources override the same files','Load order decides which content wins. Overrides may be intentional; inspect them before changing the order.','addons',{overlappingPaths:context.addons.conflicts,inspectionComplete:context.addons.complete});
 if(context.backups?.count===0)add('backup',4,'Create your first restore point','Plan a short stop to create a verified data backup before important changes. Addon archives and credentials are excluded.','backups',{snapshots:0});
 if(context.diagnostics?.storage&&context.diagnostics.storage.freeBytes<1073741824)add('disk',1,'Storage space is running low','Less than one GiB is reported free. Review backups and hosting storage before importing a resource.','backups',{freeBytes:context.diagnostics.storage.freeBytes});
 const checks=[
  {id:'setup',label:'First setup',state:setup?.completedAt?'ok':setup?'todo':'unknown'},
  {id:'process',label:'Game process',state:status?.state==='running'?'ok':status?'todo':'unknown'},
  {id:'data',label:'Live measurements',state:fresh?'ok':'unknown'},
  {id:'config',label:'Saved settings applied',state:context.settings?context.settings.restartRequired?'todo':'ok':'unknown'},
  {id:'backup',label:'Data restore point',state:context.backups?context.backups.count?'ok':'todo':'unknown'}
 ];
 return {cards:cards.sort((a,b)=>a.priority-b.priority).slice(0,6),checks,fresh,players:fresh?h.players:null};
}
