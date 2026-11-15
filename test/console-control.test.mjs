import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createConsoleControl,consoleDescriptor,readControl,validControl} from '../server/system/console-control.mjs';
import {runConsoleCommand} from '../server/scripts/cli.mjs';
import {createRelay} from '../server/system/server.mjs';
import {createClient} from '../client/client.mjs';
const exec=promisify(execFile);

test('separate shell process publishes a real announcement to a connected client without stdin',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'heavymp-cli-'));let control,client;const relay=await createRelay({host:'127.0.0.1',port:0,plaintext:true,log:()=>{}});
 try{
  control=await createConsoleControl(relay,{directory});assert.equal(control.address.address,'127.0.0.1');
  client=await createClient({host:'127.0.0.1',port:relay.address.port,plaintext:true,telemetryPort:0,monitorPort:0,vehiclePort:false,name:'PanelClient'});
  for(let i=0;i<100&&!client.status.connected;i++)await new Promise(r=>setTimeout(r,20));assert.ok(client.status.connected);
  const {stdout}=await exec(process.execPath,[resolve('server/scripts/cli.mjs'),'annonce','Bonne route à tous 🚛'],{env:{...process.env,DATA_DIR:directory},windowsHide:true,timeout:10000});assert.match(stdout,/Announcement sent to 1 player/);
  for(let i=0;i<100&&!client.status.chat.some(m=>m.text==='[Annonce] Bonne route à tous 🚛');i++)await new Promise(r=>setTimeout(r,20));
  const messages=client.status.chat.filter(m=>m.text==='[Annonce] Bonne route à tous 🚛');assert.equal(messages.length,1);assert.equal(messages[0].channel,'system');
  await assert.rejects(createConsoleControl(relay,{directory}),/already active/);
  const record=await readControl(directory),url=`http://127.0.0.1:${record.port}`;
  assert.equal((await fetch(url+'/announce',{method:'POST',body:'{"message":"unauthorized"}'})).status,401);
  assert.equal((await fetch(url+'/announce',{method:'POST',headers:{authorization:'Bearer '+record.token},body:'bad json'})).status,400);
  assert.equal((await fetch(url+'/announce',{method:'POST',headers:{authorization:'Bearer '+record.token},body:JSON.stringify({message:'x'.repeat(241)})})).status,400);
  assert.equal((await fetch(url+'/announce',{method:'POST',headers:{authorization:'Bearer '+record.token},body:'x'.repeat(5000)})).status,413);
  if(process.platform!=='win32')assert.equal((await stat(consoleDescriptor(directory))).mode&0o777,0o600);
 }finally{await control?.close();await client?.close();await relay.close();}
 await assert.rejects(readFile(consoleDescriptor(directory)),{code:'ENOENT'});await rm(directory,{recursive:true,force:true});
});

test('CLI validates requests, supports aliases, isolates DATA_DIR, and does not log secrets',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'heavymp-cli-'));const lines=[];let received=[];let control;
 try{
  assert.equal(await runConsoleCommand(['help'],{directory,write:v=>lines.push(v)}),0);
  assert.equal(await runConsoleCommand(['annonce'],{directory,write:v=>lines.push(v)}),2);
  assert.equal(await runConsoleCommand(['annonce','absent'],{directory,write:v=>lines.push(v)}),1);
  control=await createConsoleControl({announce:message=>{received.push(message);return {ok:true,recipients:0};}},{directory});
  for(const alias of ['annonce','announce','/annonce'])assert.equal(await runConsoleCommand([alias,'Bonjour'],{directory,write:v=>lines.push(v)}),0);
  assert.deepEqual(received,['Bonjour','Bonjour','Bonjour']);
  const record=await readControl(directory);assert.equal(lines.join('\n').includes(record.token),false);
  for(const invalid of [{...record,host:'example.org'},{...record,port:0},{...record,token:'bad'}])assert.equal(validControl(invalid),false);
  await control.close();control=null;
  await writeFile(consoleDescriptor(directory),'secret-token invalid json');
  lines.length=0;assert.equal(await runConsoleCommand(['annonce','Test'],{directory,write:v=>lines.push(v)}),1);assert.equal(lines.join('').includes('secret-token'),false);
 }finally{await control?.close();await rm(directory,{recursive:true,force:true});}
});
test('operator missions-debug reads live diagnostics through authenticated loopback without a player session token',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'heavymp-cli-missions-')),lines=[],targets=[];let control;
 try{control=await createConsoleControl({missionsDiagnostics:target=>{targets.push(target);return {ok:true,diagnostic:{sessionActive:true,lastApiError:{method:'POST',path:'/missions/test/prepared',status:400,code:'unknown_field',fields:['specHash'],requestId:'request-test-123'}}};}},{directory});
 assert.equal(await runConsoleCommand(['missions-debug','76561198000000001'],{directory,write:v=>lines.push(v)}),0);assert.deepEqual(targets,['76561198000000001']);const d=JSON.parse(lines.at(-1));assert.equal(d.lastApiError.fields[0],'specHash');assert.equal(d.lastApiError.status,400);const descriptor=await readControl(directory);assert.equal(lines.join('').includes(descriptor.token),false);
 assert.equal((await fetch(`http://127.0.0.1:${descriptor.port}/missions-debug`,{method:'POST',body:'{}'})).status,401);
 }finally{await control?.close();await rm(directory,{recursive:true,force:true});}
});
