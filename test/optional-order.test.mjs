import {strict as assert} from 'node:assert';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import test from 'node:test';
import {describeOptionalOrder,optionalSlots} from '../server/shared/optional-order.mjs';
import {loadAddonContent} from '../server/system/content.mjs';
import {DEALER_ICON_BYTES,dealerBrandingArchive} from '../server/system/dealer-branding.mjs';
import {ManagerAddons} from '../server/system/manager/addons.mjs';
import {SerialStore} from '../server/system/manager/storage.mjs';
import {mixedOrder,storeMixedOrder} from '../server/system/manager/assets/addon-order-view.mjs';
import {mapZip} from './fixtures/zip-fixture.mjs';

function dealerArchiveEntry(archive, name){
 for(let at=0;archive.readUInt32LE(at)===0x04034b50;){
  const pathEnd=at+30+archive.readUInt16LE(at+26);
  const dataStart=pathEnd+archive.readUInt16LE(at+28);
  const dataEnd=dataStart+archive.readUInt32LE(at+18);
  if(archive.toString('utf8',at+30,pathEnd)===name)return inflateRawSync(archive.subarray(dataStart,dataEnd));
  at=dataEnd;
 }
 throw Error('Missing ZIP entry '+name);
}

test('owner can interleave optional slots without adding packages to the shared manifest', async t=>{
 const root=await mkdtemp(join(tmpdir(),'heavymp-order-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const mods=join(root,'mods');
 await mkdir(mods);
 await writeFile(join(mods,'Map Base.scs'),mapZip([['def/test.sii',Buffer.from('map')]]));
 await writeFile(join(mods,'server-patch.scs'),mapZip([['def/test.sii',Buffer.from('patch')]]));
 const manager=new ManagerAddons({
  directory:mods,privateDirectory:join(root,'quarantine'),
  supervisor:{state:'stopped',status:()=>({})},logs:{audit:async()=>{}},lock:new SerialStore()
 });
 const initial=await manager.get();
 const named={name:'Local sound',source:'local',match:'sound.scs',after:'Map Base.scs',downloadUrl:'https://mods.example/sound'};
 const top={name:'Workshop dashboard',source:'workshop',match:'3123456789',after:'server-patch.scs'};
 const request={revision:initial.revision,order:['Map Base.scs','server-patch.scs'],disabled:[],optional:[named,top]};
 await assert.rejects(manager.save(request,'admin'),/permission_denied/);
 await assert.rejects(manager.save({...request,optional:[named,{...named,match:'SOUND.scs'}]},'owner',{canEditOptional:true}),/invalid_optional_order/);
 const saved=await manager.save(request,'owner',{canEditOptional:true});
 const rows=mixedOrder(saved);
 assert.deepEqual(rows.map(row=>row.slot?.name??row.name),['Workshop dashboard','server-patch.scs','Local sound','Map Base.scs']);
 const roundTrip={};
 storeMixedOrder(roundTrip,rows);
 assert.deepEqual(roundTrip,{order:request.order,optional:request.optional});
 let published;
 const content=await loadAddonContent(mods,{onOptional:slots=>{published=slots;}});
 assert.equal(content.manifest.files.length,2);
 assert.equal(published[0].after,content.manifest.files[0].name);
 assert.equal(published[0].downloadUrl,named.downloadUrl);
 assert.equal(published[1].after,content.manifest.files[1].name);
 const baseline=describeOptionalOrder(published,content.revision);
 assert.notEqual(describeOptionalOrder([...published].reverse(),content.revision).revision,baseline.revision);
 assert.equal(describeOptionalOrder(optionalSlots(published),content.revision).revision,baseline.revision);
 const withoutLinks=published.map(({name,source,match,after})=>({name,source,match,after}));
 assert.equal(describeOptionalOrder(withoutLinks,content.revision).revision,baseline.revision);
 for(const downloadUrl of ['http://mods.example/file','javascript:alert(1)','https://user:pass@mods.example/file','https://mods.example/'+('a'.repeat(512))]){
  assert.throws(()=>optionalSlots([{...named,downloadUrl}]),/invalid_optional_order/);
 }
 assert.throws(()=>optionalSlots([{...top,downloadUrl:named.downloadUrl}]),/invalid_optional_order/);

 const dealerBranding=dealerBrandingArchive({name:'Community Motors',icon:Buffer.alloc(DEALER_ICON_BYTES)});
 const archive=dealerBranding.bytes;
 const desktop=dealerArchiveEntry(archive,'def/ui_desktop_ind_full.sii').toString('utf8');
 assert.match(desktop,/^@include "ui_desktop_vehicle_mode_links\.sui"$/m);
 assert.equal([...desktop.matchAll(/^(\s*)@include /gm)].every(match=>!match[1]),true);
 assert(archive.includes(Buffer.from('material/ui/link/hvmp_dealer_brand.mat')));
 const branded=await loadAddonContent(mods,{dealerBranding,onOptional:slots=>{published=slots;}});
 const tile=branded.manifest.files.at(-1);
 assert.equal(tile.sha256,dealerBranding.sha256);
 assert.deepEqual(branded.assets.get(tile.url).bytes,dealerBranding.bytes);
 assert.equal(published[0].after,branded.manifest.files[0].name);
 assert.equal(published[1].after,tile.name);
 assert.equal(dealerBrandingArchive({name:'HeavyMP',icon:null}),null);

});

test('dealer branding fills the icon width with padded artwork at its original aspect ratio',()=>{
 const icon=Buffer.alloc(DEALER_ICON_BYTES);
 for(let y=225;y<289;y++)for(let x=128;x<384;x++)icon.set([23,110,196,255],(y*512+x)*4);
 icon[3]=1;
 const {bytes}=dealerBrandingArchive({name:'Community Motors',icon});
 const texture=dealerArchiveEntry(bytes,'material/ui/hvmp_dealer_brand.dds');
 const centerAlpha=Array.from({length:512},(_,x)=>texture[128+(256*512+x)*4+3]);
 const middleAlpha=Array.from({length:512},(_,y)=>texture[128+(y*512+256)*4+3]);
 assert(centerAlpha.filter(alpha=>alpha>24).length>=499);
 assert(middleAlpha.filter(alpha=>alpha>24).length>=124);
 assert(middleAlpha.filter(alpha=>alpha>24).length<=128);
 assert.deepEqual([...texture.subarray(128+(256*512+256)*4,132+(256*512+256)*4)],[196,110,23,255]);
 assert.equal(texture[131],0);
});
