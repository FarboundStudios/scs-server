import {createDecipheriv,createHash,randomUUID} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {readFile,writeFile,mkdir,readdir,lstat,rename,stat,realpath,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {dispatchSpec,dispatchId} from '../server/shared/dispatch.mjs';

const MAX=64*1024*1024,KEY=Buffer.from('2a5fcb1791d22fb60245b3d8369ed0b2c27371563fbf1f3c9edf6b11825a5d0a','hex');
const hash=b=>createHash('sha256').update(b).digest('hex');
export function decodeDispatchSave(bytes){
 if(bytes.length>MAX)throw Error('Save exceeds the supported size.');let data=bytes;
 if(bytes.subarray(0,4).toString()==='ScsC'){
  if(bytes.length<72||(bytes.length-56)%16)throw Error('Invalid save container.');
  const cipher=createDecipheriv('aes-256-cbc',KEY,bytes.subarray(36,52));data=inflateSync(Buffer.concat([cipher.update(bytes.subarray(56)),cipher.final()]),{maxOutputLength:MAX});
  if(data.length!==bytes.readUInt32LE(52))throw Error('Invalid decompressed save size.');
 }
 if(data.subarray(0,8).toString()!=='SiiNunit')throw Error('This save is binary. Use text saves (g_save_format 2), save again and refresh.');
 const text=data.toString('utf8');if(!Buffer.from(text).equals(data)||!text.trimEnd().endsWith('}'))throw Error('Invalid save encoding.');return text;
}
export function parseDispatchSave(text){
 const units=new Map();for(const m of text.matchAll(/^(\w+)\s*:\s*([.\w]+)\s*\{\r?\n([\s\S]*?)^\}/gm)){
  if(units.has(m[2])||units.size>200000)throw Error('Ambiguous or oversized save.');units.set(m[2],{type:m[1],id:m[2],body:m[3],start:m.index,end:m.index+m[0].length,text:m[0]});
 }
 const economies=[...units.values()].filter(u=>u.type==='economy');if(economies.length!==1)throw Error('The economy could not be identified.');
 const gameTime=Number(/^\s*game_time:\s*(\d+)\s*$/m.exec(economies[0].body)?.[1]);if(!Number.isSafeInteger(gameTime))throw Error('Invalid game time.');
 const offers=[],companies=[];for(const u of units.values())if(u.type==='company'&&/^company\.volatile\.[a-z0-9_]+\.[a-z0-9_]+$/.test(u.id)){
  const id=u.id.slice(17),[company,city]=id.split('.');companies.push({id,company,city});
  const refs=[...u.body.matchAll(/^\s*job_offer\[(\d+)\]:\s*([.\w]+)\s*$/gm)];const count=Number(/^\s*job_offer:\s*(\d+)\s*$/m.exec(u.body)?.[1]);if(count!==refs.length)throw Error('Invalid freight market links.');
  for(let i=0;i<refs.length;i++){if(Number(refs[i][1])!==i)throw Error('Invalid freight market order.');const offer=units.get(refs[i][2]);if(!offer||offer.type!=='job_offer_data')throw Error('Missing job offer.');
   const target=/^\s*target:\s*"([a-z0-9_]+\.[a-z0-9_]+)"\s*$/m.exec(offer.body)?.[1],cargo=/^\s*cargo:\s*(cargo\.[a-z0-9_.]+)\s*$/m.exec(offer.body)?.[1];
   const trailerDefinition=/^\s*trailer_definition:\s*([a-z0-9_.]+)\s*$/m.exec(offer.body)?.[1],unitsCount=Number(/^\s*units_count:\s*(\d+)\s*$/m.exec(offer.body)?.[1]);
   if(target&&cargo&&trailerDefinition&&unitsCount>0)offers.push({source:id,destination:target,cargo,trailerDefinition,unitsCount,unit:offer,company:u,distanceKm:Number(/^\s*shortest_distance_km:\s*(\d+)\s*$/m.exec(offer.body)?.[1])||1});
  }
 }
 return {units,gameTime,offers,companies};
}
// Clone a real local cargo/trailer template. No fabricated model, trailer slot,
// economy, garage, active job or vehicle graph is written into the save.
export function injectDispatchOffer(text,mission){
 if(!dispatchId(mission.id))throw Error('Invalid mission identifier.');const spec=dispatchSpec(mission.spec),save=parseDispatchSave(text);
 const company=save.units.get('company.volatile.'+spec.source);if(!company||!save.companies.some(c=>c.id===spec.destination))throw Error('One of the companies does not exist on your current map.');
 const compatible=o=>o.cargo===spec.cargo&&o.trailerDefinition===spec.trailerDefinition&&o.unitsCount===spec.unitsCount;
 const template=save.offers.find(o=>compatible(o)&&o.source===spec.source)??save.offers.find(compatible);if(!template)throw Error('This cargo/trailer configuration is not available in your save.');
 const id='_nameless.hmd.'+mission.id.replaceAll('-','').match(/.{1,8}/g).join('.');
 if(save.units.has(id)){const linked=company.body.includes(': '+id);if(!linked)throw Error('Mission identity conflict.');return {text,alreadyPrepared:true,offerId:id};}
 const count=Number(/^\s*job_offer:\s*(\d+)\s*$/m.exec(company.body)?.[1]);if(!Number.isInteger(count)||count>=100)throw Error('Company freight market is full.');
 let offer=template.unit.text.replace(template.unit.id,id);
 const set=(key,value)=>{const re=new RegExp('(^\\s*'+key+':)[^\\r\\n]*','m');if(!re.test(offer))throw Error('Incomplete cargo template: '+key);offer=offer.replace(re,(_,prefix)=>prefix+' '+value);};
 set('target',JSON.stringify(spec.destination));set('expiration_time',save.gameTime+7*24*60);set('shortest_distance_km',spec.distanceKm);set('urgency',0);
 const route=save.offers.find(o=>o.source===spec.source&&o.destination===spec.destination);
 for(const key of ['ferry_time','ferry_price'])set(key,Number(new RegExp('^\\s*'+key+':\\s*(\\d+)','m').exec(route?.unit.body??'')?.[1])||0);
 const place=/^\s*trailer_place:\s*([^\r\n]+)$/m.exec(save.offers.find(o=>o.source===spec.source)?.unit.body??'')?.[1]?.trim();
 if(!place||!/^\d+$/.test(place))throw Error('No verified pickup trailer slot at this company. Choose another departure.');set('trailer_place',place);
 let body=company.text.replace(/(^\s*job_offer:)\s*\d+\s*$/m,(_,prefix)=>prefix+' '+(count+1));const before=body.lastIndexOf('}');body=body.slice(0,before)+` job_offer[${count}]: ${id}\n`+body.slice(before);
 const result=text.slice(0,company.start)+body+text.slice(company.end);const end=result.lastIndexOf('}');const output=result.slice(0,end)+'\n'+offer+'\n'+result.slice(end);
 const verified=parseDispatchSave(output);if(!verified.units.has(id)||!verified.offers.some(o=>o.unit.id===id&&o.source===spec.source&&o.destination===spec.destination))throw Error('Generated freight offer failed validation.');
 return {text:output,alreadyPrepared:false,offerId:id};
}
export function createDispatchSaves({home,now=Date.now}){
 const root=resolve(home);let cached=null;
 async function plain(path,directory=false){const s=await lstat(path);if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile()))throw Error('Unsupported save path.');const canonical=await realpath(path),rel=relative(await realpath(root),canonical);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw Error('Save path outside ETS2 home.');return s;}
 async function profiles(){const items=[];for(const base of ['profiles','steam_profiles']){let rows;try{await plain(join(root,base),true);rows=await readdir(join(root,base),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
  for(const row of rows){if(!row.isDirectory()||!/^([a-f0-9]{2}){1,128}$/i.test(row.name))continue;const id=base+'/'+row.name;await plain(join(root,id),true);items.push({id,name:Buffer.from(row.name,'hex').toString('utf8').slice(0,60)});if(items.length>64)break;}}
  return items;
 }
 async function load(profile){if(!(await profiles()).some(p=>p.id===profile))throw Error('Select a valid ETS2 profile.');const folder=join(root,profile,'save');await plain(folder,true);let latest;
  for(const row of await readdir(folder,{withFileTypes:true})){if(!row.isDirectory()||!/^[-a-z0-9_]{1,64}$/i.test(row.name)||row.name.startsWith('hmd_'))continue;const dir=join(folder,row.name);await plain(dir,true);const path=join(dir,'game.sii');try{const info=await plain(path);if(info.size<=MAX&&(!latest||info.mtimeMs>latest.at))latest={path,dir,at:info.mtimeMs,size:info.size};}catch(e){if(e.code!=='ENOENT')throw e;}}
  if(!latest)throw Error('No usable save. Save your game and refresh.');
  if(cached?.path===latest.path&&cached.at===latest.at&&cached.size===latest.size)return cached;
  const bytes=await readFile(latest.path);const after=await stat(latest.path);if(after.mtimeMs!==latest.at||after.size!==latest.size)throw Error('ETS2 is saving. Try again in a moment.');const text=decodeDispatchSave(bytes),data=parseDispatchSave(text);
  cached={...latest,bytes,text,data,sha256:hash(bytes)};return cached;
 }
 return {profiles,async catalogue(profile,query=''){
  const s=await load(profile),q=String(query).toLowerCase().slice(0,60),sources=new Set(s.data.offers.map(o=>o.source));
  return {profile,savedAt:s.at,sourceHash:s.sha256,gameTime:s.data.gameTime,companies:s.data.companies.filter(c=>!q||c.id.includes(q)).slice(0,120).map(c=>({...c,pickup:sources.has(c.id)})),companyCount:s.data.companies.length,
   cargo:[...new Map(s.data.offers.filter(o=>!q||o.cargo.includes(q)).map(o=>[o.cargo+'|'+o.trailerDefinition+'|'+o.unitsCount,{id:hash(Buffer.from(o.cargo+'|'+o.trailerDefinition+'|'+o.unitsCount)).slice(0,16),cargo:o.cargo,trailerDefinition:o.trailerDefinition,unitsCount:o.unitsCount}])).values()].slice(0,300),source:'ETS2 save',nativeJobs:true};
 },async route(profile,source,destination){
  const s=await load(profile),a=source.split('.')[1],b=destination.split('.')[1];if(!s.data.companies.some(c=>c.id===source)||!s.data.companies.some(c=>c.id===destination)||source===destination)throw Error('Choose two different companies.');
  const exact=s.data.offers.find(o=>o.source===source&&o.destination===destination);if(exact)return {distanceKm:exact.distanceKm,estimated:false};
  const graph=new Map();for(const o of s.data.offers){const from=o.source.split('.')[1],to=o.destination.split('.')[1];if(from===to)continue;if(!graph.has(from))graph.set(from,new Map());graph.get(from).set(to,Math.min(graph.get(from).get(to)??Infinity,o.distanceKm));}
  const distances=new Map([[a,0]]),visited=new Set();while(visited.size<graph.size+1){let next=null,best=Infinity;for(const [city,d]of distances)if(!visited.has(city)&&d<best){next=city;best=d;}if(next===null)break;if(next===b)return {distanceKm:Math.max(1,Math.ceil(best)),estimated:true};visited.add(next);for(const [city,d]of graph.get(next)??[])if(best+d<(distances.get(city)??Infinity))distances.set(city,best+d);}
  throw Error('No reliable distance found for this route in your save. Choose another destination.');
 },async prepare(profile,mission,expectedHash){
  const s=await load(profile);if(s.sha256!==expectedHash)throw Error('Your save changed. Refresh before preparing the delivery.');if(now()-s.at>120000)throw Error('Save your game now, then refresh: the snapshot is older than two minutes.');
  const result=injectDispatchOffer(s.text,mission),slot='hmd_'+mission.id.replaceAll('-','')+'_'+s.sha256.slice(0,8),folder=join(root,profile,'save'),destination=join(folder,slot);
  try{await plain(destination,true);const receipt=JSON.parse(await readFile(join(destination,'heavymp-dispatch.json'),'utf8'));if(receipt.missionId!==mission.id||receipt.sourceHash!==s.sha256||hash(await readFile(join(destination,'game.sii')))!==receipt.preparedHash)throw Error('Prepared save conflict.');return receipt;}catch(e){if(e.code!=='ENOENT')throw e;}
  const infoPath=join(s.dir,'info.sii');await plain(infoPath);let info=decodeDispatchSave(await readFile(infoPath));if(!/^\s*name:\s*"[^\r\n]*"\s*$/m.test(info))throw Error('Unsupported save metadata.');info=info.replace(/(^\s*name:)\s*"[^\r\n]*"\s*$/m,(_,prefix)=>prefix+' '+JSON.stringify('HeavyMP Missions · '+mission.spec.title.slice(0,45)));
  const receipt={missionId:mission.id,sourceHash:s.sha256,preparedHash:hash(Buffer.from(result.text)),slot,profile,saveName:'HeavyMP Missions · '+mission.spec.title.slice(0,45),preparedAt:now(),requiresLoad:true};
  // A unique staging directory also permits a retry after a previous process
  // was interrupted. Never delete an existing or another process's directory.
  const temporaryName=slot+'_tmp_'+randomUUID().slice(0,8),temporary=join(folder,temporaryName);await mkdir(temporary,{recursive:false});
  try{
   await writeFile(join(temporary,'game.sii'),result.text,{flag:'wx'});await writeFile(join(temporary,'info.sii'),info,{flag:'wx'});await writeFile(join(temporary,'heavymp-dispatch.json'),JSON.stringify(receipt),{flag:'wx'});
  // Existing save slots are the backup: only publish a NEW slot atomically.
   await rename(temporary,destination);return receipt;
  }catch(error){
   const target=resolve(temporary),parent=resolve(folder);
   if(relative(parent,target)===temporaryName){await plain(target,true);await rm(target,{recursive:true,force:true});}
   throw error;
  }
 }};
}
