import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat,utimes} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {loadAddonContent} from '../server/system/content.mjs';
import {GAME_VERSION} from '../server/shared/protocol.mjs';

test('game update migrates generated addon metadata once while preserving file hashes and custom metadata',async t=>{
 const root=await mkdtemp(join(tmpdir(),'heavymp-addons-upgrade-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const indexPath=join(root,'data/addons.json'),hashes=[];
 await writeFile(join(root,'one.scs'),Buffer.alloc(64,5));
 await loadAddonContent(root,{indexPath});
 const previous=JSON.parse(await readFile(indexPath,'utf8'));
 previous.gameVersion='1.61.1.9s';previous.id='custom';previous.version='map-42';previous.requiredDlcs=['dlc_fr'];
 await writeFile(indexPath,JSON.stringify(previous));
 const options={indexPath,onHash:name=>hashes.push(name)};
 const current=await loadAddonContent(root,options),saved=JSON.parse(await readFile(indexPath,'utf8'));
 assert.equal(current.manifest.gameVersion,GAME_VERSION);assert.equal(saved.id,'custom');assert.equal(saved.version,'map-42');
 assert.deepEqual(saved.requiredDlcs,['dlc_fr']);assert.deepEqual(saved.files,previous.files);assert.deepEqual(hashes,[]);
 const time=(await stat(indexPath)).mtimeMs;
 await loadAddonContent(root,options);assert.equal((await stat(indexPath)).mtimeMs,time);assert.deepEqual(hashes,[]);
});
test('addons are discovered deterministically without requiring a manifest or rewriting archives',async t=>{
 const root=await mkdtemp(join(tmpdir(),'heavymp-addons-'));t.after(()=>rm(root,{recursive:true,force:true}));
 assert.equal(await loadAddonContent(root),null);
 const bytes=Buffer.alloc(128,42);for(const file of ['skin.scs','heavymp.scs'])await writeFile(join(root,file),bytes);
 let content=await loadAddonContent(root);assert.deepEqual(content.manifest.files.map(f=>f.name),['heavymp.scs','skin.scs']);assert.equal(content.assets.size,2);assert.equal(content.manifest.files[0].sha256,createHash('sha256').update(bytes).digest('hex'));
 await writeFile(join(root,'manifest.json'),JSON.stringify({...content.manifest,version:'2.0',requiredDlcs:['dlc_north']}));content=await loadAddonContent(root);assert.equal(content.manifest.version,'2.0');assert.deepEqual(content.manifest.requiredDlcs,['dlc_north']);assert.deepEqual(await readFile(join(root,'heavymp.scs')),bytes);
 await writeFile(join(root,'..bad.scs'),bytes);await assert.rejects(loadAddonContent(root),/invalid/i);
});
test('automatic data/addons.json is atomic, cached, unchanged on restart and updated for additions, edits and removals',async t=>{
 const root=await mkdtemp(join(tmpdir(),'heavymp-addons-index-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const indexPath=join(root,'data/addons.json'),hashes=[],logs=[],options={indexPath,onHash:n=>hashes.push(n),log:s=>logs.push(s)};
 const file=join(root,'one.scs');await writeFile(file,Buffer.alloc(64,1));
 await loadAddonContent(root,options);const initial=await readFile(indexPath,'utf8'),before=await stat(indexPath);assert.deepEqual(hashes,['one.scs']);
 await loadAddonContent(root,options);assert.equal(hashes.length,1);assert.equal(await readFile(indexPath,'utf8'),initial);assert.equal((await stat(indexPath)).mtimeMs,before.mtimeMs);
 await writeFile(join(root,'two.scs'),Buffer.alloc(64,2));await loadAddonContent(root,options);assert.deepEqual(hashes,['one.scs','two.scs']);assert.equal(JSON.parse(await readFile(indexPath,'utf8')).files.length,2);
 const oldTime=(await stat(file)).mtime;await writeFile(file,Buffer.alloc(64,3));await utimes(file,oldTime,oldTime);await loadAddonContent(root,options);assert.equal(hashes.at(-1),'one.scs');
 const changed=JSON.parse(await readFile(indexPath,'utf8'));assert.notEqual(changed.files[0].sha256,JSON.parse(initial).files[0].sha256);
 await rm(join(root,'two.scs'));await loadAddonContent(root,options);assert.equal(JSON.parse(await readFile(indexPath,'utf8')).files.length,1);
 await rm(file);assert.equal(await loadAddonContent(root,options),null);assert.equal(JSON.parse(await readFile(indexPath,'utf8')).files.length,0);
 assert.ok(logs.some(s=>s.includes('unchanged')));
});
test('broken cache is rebuilt and touching identical bytes does not rewrite the index',async t=>{
 const root=await mkdtemp(join(tmpdir(),'heavymp-addons-cache-'));t.after(()=>rm(root,{recursive:true,force:true}));const indexPath=join(root,'data/addons.json');await writeFile(join(root,'one.scs'),Buffer.alloc(64,4));await loadAddonContent(root,{indexPath});
 const before=await readFile(indexPath,'utf8');await utimes(join(root,'one.scs'),new Date(),new Date(Date.now()+10000));await loadAddonContent(root,{indexPath});assert.equal(await readFile(indexPath,'utf8'),before);
 await writeFile(indexPath,'BROKEN');await loadAddonContent(root,{indexPath});assert.equal(JSON.parse(await readFile(indexPath,'utf8')).files.length,1);
});
