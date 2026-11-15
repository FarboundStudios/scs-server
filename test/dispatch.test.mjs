import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,utimes,readdir} from 'node:fs/promises';
import {join,relative,isAbsolute,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {decodeDispatchSave,parseDispatchSave,injectDispatchOffer,createDispatchSaves} from '../client/dispatch-save.mjs';
import {createDispatcher} from '../server/system/dispatch.mjs';
import {createRelay} from '../server/system/server.mjs';
import {createClient} from '../client/client.mjs';
import {createNotificationBus,validNotificationIcon} from '../client/phone-notification-bus.mjs';
import {createPhoneAlerts} from '../client/phone-alerts.mjs';
import {dispatchJob} from '../server/shared/dispatch.mjs';
import {createDispatchService} from '../client/dispatch-service.mjs';
import {nativeDispatchPacket,createNativeDispatch} from '../client/dispatch-native.mjs';
const base=tmpdir();
const spec={title:'Evening convoy',source:'euroacres.erfurt',destination:'sellplan.lodz',cargo:'cargo.pears',trailerDefinition:'trailer_def.schmitz.sko.single_3.reefer',unitsCount:33,distanceKm:646,visibility:'private'};
const source=`SiiNunit
{
economy : _nameless.eco {
 game_time: 10000
}
player : _nameless.player {
 current_job: null
 money_account: 123456
}
company : company.volatile.euroacres.erfurt {
 permanent_data: company.permanent.euroacres
 job_offer: 1
 job_offer[0]: _nameless.offer
 discovered: true
}
company : company.volatile.sellplan.lodz {
 job_offer: 0
}
company : company.volatile.trameri.lille {
 job_offer: 0
}
job_offer_data : _nameless.offer {
 target: "sellplan.lodz"
 expiration_time: 10500
 urgency: 2
 shortest_distance_km: 646
 ferry_time: 0
 ferry_price: 0
 cargo: cargo.pears
 company_truck: volvo_fh2021_4x2_420
 trailer_variant: trailer.sch_sko_col
 trailer_definition: trailer_def.schmitz.sko.single_3.reefer
 units_count: 33
 fill_ratio: 1
 trailer_place: 0
}
}
`;
async function temporary(t){const dir=await mkdtemp(join(base,'dispatch-test-'));t.after(async()=>{const rel=relative(base,dir);assert.ok(rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));await rm(dir,{recursive:true,force:true});});return dir;}
test('native freight offer is generated from a real template, linked once and leaves vehicles/economy unchanged',()=>{
 const mission={id:randomUUID(),spec:{...spec,destination:'trameri.lille',distanceKm:1000}},result=injectDispatchOffer(source,mission),parsed=parseDispatchSave(result.text);
 assert.equal(parsed.offers.length,2);const generated=parsed.offers.find(o=>o.unit.id===result.offerId);assert.equal(generated.destination,'trameri.lille');assert.equal(generated.cargo,spec.cargo);assert.equal(generated.unitsCount,33);
 assert.match(generated.unit.body,/company_truck: volvo_fh2021_4x2_420/);assert.match(generated.unit.body,/expiration_time: 20080/);
 assert.equal(parsed.units.get('_nameless.player').text,parseDispatchSave(source).units.get('_nameless.player').text);
 assert.equal(parsed.units.get('_nameless.eco').text,parseDispatchSave(source).units.get('_nameless.eco').text);
 assert.equal(injectDispatchOffer(result.text,mission).text,result.text);
});
test('save injection rejects missing cargo/trailer/company, path-like IDs and broken unit graphs',()=>{
 for(const patch of [{cargo:'cargo.missing'},{source:'missing.city'},{trailerDefinition:'trailer_def.missing'},{unitsCount:10},{destination:'../outside'}])assert.throws(()=>injectDispatchOffer(source,{id:randomUUID(),spec:{...spec,...patch}}));
 assert.throws(()=>injectDispatchOffer(source,{id:'../../bad',spec}));assert.throws(()=>parseDispatchSave(source.replace('job_offer[0]: _nameless.offer','job_offer[0]: missing.unit')));assert.throws(()=>decodeDispatchSave(Buffer.from('BSII')));
});
test('preparation publishes a NEW valid save atomically and never writes the original; stale snapshots are refused',async t=>{
 const dir=await temporary(t),folder=join(dir,'profiles/4142/save/autosave');await mkdir(folder,{recursive:true});await writeFile(join(folder,'game.sii'),source);const info='SiiNunit\n{\nsave_container : _nameless.info {\n name: "Original"\n}\n}\n';await writeFile(join(folder,'info.sii'),info);
 const service=createDispatchSaves({home:dir}),profiles=await service.profiles();assert.equal(profiles[0].name,'AB');const catalogue=await service.catalogue(profiles[0].id);assert.equal(catalogue.cargo[0].unitsCount,33);
 const mission={id:randomUUID(),spec},receipt=await service.prepare(profiles[0].id,mission,catalogue.sourceHash);assert.equal(receipt.requiresLoad,true);assert.match(receipt.slot,/^hmd_/);assert.equal(await readFile(join(folder,'game.sii'),'utf8'),source);assert.equal(await readFile(join(folder,'info.sii'),'utf8'),info);
 assert.equal(parseDispatchSave(await readFile(join(dir,profiles[0].id,'save',receipt.slot,'game.sii'),'utf8')).offers.length,2);assert.deepEqual(await service.prepare(profiles[0].id,mission,catalogue.sourceHash),receipt);
 await assert.rejects(service.prepare(profiles[0].id,mission,'0'.repeat(64)),/changed/);
 const past=new Date(Date.now()-180000);await utimes(join(folder,'game.sii'),past,past);const refreshed=await service.catalogue(profiles[0].id);await assert.rejects(service.prepare(profiles[0].id,{id:randomUUID(),spec},refreshed.sourceHash),/two minutes/);
 assert.equal((await readdir(join(dir,'profiles/4142/save'))).filter(n=>n.startsWith('hmd_')).length,1);
});
const session=(name,steamId)=>({id:randomUUID(),name,steamId,supportsMissions:true,socket:{writable:true,destroyed:false,write:()=>{}}});
test('server owns identity, private invitations, revisions, idempotency and immutable membership rules',()=>{
 const a=session('Alice','76561198000000001'),b=session('Bob','76561198000000002'),c=session('Clara','76561198000000003'),sessions=new Map([a,b,c].map(s=>[s.id,s])),d=createDispatcher({sessions});
 try{const requestId=randomUUID(),m=d.request(a,'create',{spec,requestId});assert.equal(m.membership,'accepted');assert.equal(d.request(b,'list').missions.length,0);assert.throws(()=>d.request(b,'get',{id:m.id}));assert.deepEqual(d.request(a,'create',{spec,requestId}),m);assert.throws(()=>d.request(a,'create',{spec:{...spec,title:'Other'},requestId}),/reused/);
 const invited=d.request(a,'invite',{id:m.id,revision:m.revision,playerId:b.id,requestId:randomUUID()});assert.equal(d.request(b,'list').missions[0].membership,'invited');assert.throws(()=>d.request(c,'join',{id:m.id,revision:invited.revision,requestId:randomUUID()}));
 const joined=d.request(b,'join',{id:m.id,revision:invited.revision,requestId:randomUUID()});assert.equal(joined.membership,'accepted');assert.throws(()=>d.request(b,'cancel',{id:m.id,revision:joined.revision,requestId:randomUUID()}),/organiser/);assert.throws(()=>d.request(a,'cancel',{id:m.id,revision:m.revision,requestId:randomUUID()}),/changed/);
 const prepared=d.request(b,'prepared',{id:m.id,revision:joined.revision,saveHash:'a'.repeat(64),requestId:randomUUID()});assert.equal(prepared.membership,'prepared');
 assert.throws(()=>d.request(b,'telemetry',{id:m.id,revision:prepared.revision,job:{cargo:'wrong',source:spec.source,destination:spec.destination},requestId:randomUUID()}),/match/);
 const driving=d.request(b,'telemetry',{id:m.id,revision:prepared.revision,job:{cargo:'pears',source:spec.source,destination:spec.destination},requestId:randomUUID()});assert.equal(driving.membership,'driving');
 const delivered=d.request(b,'telemetry',{id:m.id,revision:driving.revision,job:{cargo:'pears',source:spec.source,destination:spec.destination,event:'job.delivered'},requestId:randomUUID()});assert.equal(delivered.membership,'delivered');
 }finally{d.close();}
});
test('missions and participant state persist across dispatcher restarts',async t=>{
 const dir=await temporary(t),database=join(dir,'missions.sqlite'),a=session('Alice','76561198000000001'),sessions=new Map([[a.id,a]]);let d=createDispatcher({database,sessions});const m=d.request(a,'create',{spec,requestId:randomUUID()});d.close();d=createDispatcher({database,sessions});try{assert.equal(d.request(a,'get',{id:m.id}).membership,'accepted');}finally{d.close();}
});
test('application notifications carry distinct identities and icons in the rich closed-phone packet',async t=>{
 const bus=createNotificationBus({directory:await temporary(t)});await bus.ready;const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDd0AAAAASUVORK5CYII=';assert.ok(validNotificationIcon(png));assert.equal(validNotificationIcon('file:///secret'),null);
 await bus.register({id:'missions',name:'Missions',icon:png});await bus.notify({app:'missions',id:randomUUID(),title:'Invitation',message:'Join our convoy'});await assert.rejects(bus.notify({app:'unknown',title:'x',message:'y'}));
 const a=createPhoneAlerts({snapshot:()=>({available:false}),getData:()=>({connected:true,notificationApps:[...bus.apps.values()],notifications:bus.notifications})}),rich=a.packet(0,2);assert.equal(rich.subarray(0,4).toString(),'HMN2');assert.equal(rich.readUInt32LE(8),1);assert.ok(rich.includes(Buffer.from('Missions')));assert.ok(rich.includes(Buffer.from('89504e470d0a1a0a','hex')));assert.equal(a.packet().subarray(0,4).toString(),'HMN1');
});
test('two real clients share missions and receive a private invitation with the Missions application identity',async()=>{
 const relay=await createRelay({host:'127.0.0.1',port:0,plaintext:true,log:()=>{}});let a,b;try{
  const common={host:'127.0.0.1',port:relay.address.port,plaintext:true,telemetryPort:0,monitorPort:0,vehiclePort:false};a=await createClient({...common,name:'DispatchAlice'});b=await createClient({...common,name:'DispatchBob'});
  for(let i=0;i<100&&(!a.status.connected||!b.status.connected);i++)await new Promise(r=>setTimeout(r,20));
  const call=async(c,action,data={})=>{const r=await fetch(`http://127.0.0.1:${c.monitorAddress.port}/phone/missions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,data})});const body=await r.json();assert.equal(r.status,200,body.error);return body;};
  const m=await call(a,'create',{spec,requestId:randomUUID()});assert.equal((await call(b,'list')).missions.length,0);await call(a,'invite',{id:m.id,revision:m.revision,playerId:b.status.id,requestId:randomUUID()});const list=await call(b,'list');assert.equal(list.missions[0].membership,'invited');
  const data=await fetch(`http://127.0.0.1:${b.monitorAddress.port}/phone/data`).then(r=>r.json());assert.equal(data.notifications.at(-1).app,'missions');assert.match(data.notifications.at(-1).message,/DispatchAlice/);assert.equal(data.notificationApps.find(a=>a.id==='missions').name,'Missions');
 }finally{await a?.close();await b?.close();await relay.close();}
});
test('invalid metadata leaves no partial save and the corrected snapshot can be retried',async t=>{
 const dir=await temporary(t),folder=join(dir,'profiles/4142/save/autosave');await mkdir(folder,{recursive:true});await writeFile(join(folder,'game.sii'),source);await writeFile(join(folder,'info.sii'),'SiiNunit\n{\n invalid: true\n}\n');
 const service=createDispatchSaves({home:dir}),catalogue=await service.catalogue('profiles/4142'),mission={id:randomUUID(),spec};
 await assert.rejects(service.prepare('profiles/4142',mission,catalogue.sourceHash),/metadata/);assert.deepEqual(await readdir(join(dir,'profiles/4142/save')),['autosave']);
 await writeFile(join(folder,'info.sii'),'SiiNunit\n{\nsave_container : _nameless.info {\n name: "Original"\n}\n}\n');
 assert.equal((await service.prepare('profiles/4142',mission,catalogue.sourceHash)).requiresLoad,true);
});
test('job telemetry rejects unknown events and invalid numbers and never stores arbitrary client fields',()=>{
 const valid={supported:true,active:true,cargo:'pears',source:spec.source,destination:spec.destination,cargoDamage:.1,secret:'discard',vehicle:{brand:'Test',model:'A',plate:'AB',secret:'discard'}};
 assert.equal(dispatchJob(valid).secret,undefined);assert.equal(dispatchJob(valid).vehicle.secret,undefined);
 for(const patch of [{cargo:'../../bad'},{event:'reward.me'},{xp:Infinity},{cargoDamage:-1},{eventId:'bad\nvalue'},{vehicle:{plate:'x'.repeat(100)}}])assert.throws(()=>dispatchJob({...valid,...patch}));
});
test('delivery tracking survives client restart, runs with the app closed, and deduplicates completion',async t=>{
 const dir=await temporary(t),folder=join(dir,'profiles/4142/save/autosave');await mkdir(folder,{recursive:true});await writeFile(join(folder,'game.sii'),source);await writeFile(join(folder,'info.sii'),'SiiNunit\n{\nsave_container : _nameless.info {\n name: "Original"\n}\n}\n');
 const a=session('Alice','76561198000000001'),sessions=new Map([[a.id,a]]),dispatcher=createDispatcher({sessions});t.after(()=>dispatcher.close());
 const local={connected:true,telemetry:true,speedKmh:0,job:{supported:true,liveCreation:true,active:false}};const transport={available:()=>true,request:async(action,data)=>dispatcher.request(a,action,data)},notices=[],options={native:{request:async()=>{local.job={supported:true,liveCreation:true,active:true,cargo:'pears',source:spec.source,destination:spec.destination};return {id:randomUUID(),method:'live',requiresLoad:false};}},transport,home:dir,directory:join(dir,'identity'),scope:'test-relay',getData:()=>local,notify:n=>notices.push(n)};
 let service=createDispatchService(options);const mission=await service.request('create',{spec}),catalogue=await service.request('catalogue',{profile:'profiles/4142'});
 const prepared=await service.request('prepare',{id:mission.id});assert.equal(prepared.requiresLoad,false);assert.deepEqual(await readdir(join(dir,'profiles/4142/save')),['autosave']);
 service=createDispatchService(options);await service.observe({supported:true,liveCreation:true,active:false,cargo:'pears',source:spec.source,destination:spec.destination,event:'job.delivered',eventId:'one-test-delivery',revenue:500,xp:25});
 assert.equal(dispatcher.request(a,'get',{id:mission.id}).membership,'delivered');assert.equal(notices.filter(n=>n.title==='Delivery complete').length,1);
 await service.observe({supported:true,liveCreation:true,active:false,cargo:'pears',source:spec.source,destination:spec.destination,event:'job.delivered',eventId:'one-test-delivery'});
 assert.equal(notices.filter(n=>n.title==='Delivery complete').length,1);
});
test('live freight packet is bounded and native acknowledgement is required before success',async()=>{
 const id=randomUUID(),packet=nativeDispatchPacket({spec},id);assert.equal(packet.length,544);assert.equal(packet.subarray(0,4).toString(),'HMD1');assert.equal(packet.readUInt32LE(8),33);assert.equal(packet.subarray(32,160).toString().split('\0')[0],'cargo.pears');assert.throws(()=>nativeDispatchPacket({spec},'bad'));
 let sent;const bridge=createNativeDispatch({send:p=>{sent=p;},timeoutMs:1000}),pending=bridge.request({spec});assert.ok(sent);const hex=sent.subarray(16,32).toString('hex'),requestId=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
 bridge.receive({type:'dispatch_result',id:randomUUID(),ok:true});await assert.rejects(bridge.request({spec}),/already/);bridge.receive({type:'dispatch_result',id:requestId,ok:true,market:'cargo_market',unitsCount:22});const receipt=await pending;assert.equal(receipt.requiresLoad,false);assert.equal(receipt.market,'cargo_market');assert.equal(receipt.unitsCount,22);bridge.close();
});
test('no native response or explicit refusal can create a save or mark the delivery prepared',async()=>{
 const a=session('Alice','76561198000000001'),sessions=new Map([[a.id,a]]),dispatcher=createDispatcher({sessions});
 try{const transport={available:()=>true,request:async(action,data)=>dispatcher.request(a,action,data)},service=createDispatchService({native:{request:async()=>{throw Error('Game refused');}},transport,scope:'test',getData:()=>({connected:true,telemetry:true,speedKmh:0,job:{supported:true,liveCreation:true,active:false}})});const mission=await service.request('create',{spec});await assert.rejects(service.request('prepare',{id:mission.id}),/Game refused/);assert.equal(dispatcher.request(a,'get',{id:mission.id}).membership,'accepted');
 const bridge=createNativeDispatch({send:()=>{},timeoutMs:20});await assert.rejects(bridge.request(mission),/did not confirm/);bridge.close();}finally{dispatcher.close();}
});
test('native acknowledgement alone cannot mark a mission started without matching active SDK job',async()=>{
 const a=session('Alice','76561198000000001'),dispatcher=createDispatcher({sessions:new Map([[a.id,a]])});
 try{const service=createDispatchService({native:{request:async()=>({id:randomUUID(),method:'live'})},transport:{available:()=>true,request:async(action,data)=>dispatcher.request(a,action,data)},scope:'test',acceptTimeoutMs:20,getData:()=>({connected:true,telemetry:true,speedKmh:0,job:{supported:true,liveCreation:true,active:false}})});const mission=await service.request('create',{spec});await assert.rejects(service.request('prepare',{id:mission.id}),/did not report an accepted/);assert.equal(dispatcher.request(a,'get',{id:mission.id}).membership,'accepted');}finally{dispatcher.close();}
});
test('companies missing from the live economy are removed from the save-based selection catalogue',async t=>{
 const dir=await temporary(t),folder=join(dir,'profiles/4142/save/autosave');await mkdir(folder,{recursive:true});await writeFile(join(folder,'game.sii'),source);
 const service=createDispatchService({home:dir,scope:'test',transport:{available:()=>true},getData:()=>({unavailableCompanies:['sellplan.lodz']})});const list=await service.request('catalogue',{profile:'profiles/4142'});assert.equal(list.companies.some(c=>c.id==='sellplan.lodz'),false);assert.equal(list.companies.some(c=>c.id==='euroacres.erfurt'),true);
});
