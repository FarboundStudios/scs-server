import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import {ManagerAuth} from '../server/system/manager/auth.mjs';
import {createManagerHttp} from '../server/system/manager/http.mjs';
import {ManagerLogs} from '../server/system/manager/logs.mjs';
import {ManagerMembers} from '../server/system/manager/members.mjs';

const owner='76561198000000001',user='76561198000000002',other='76561198000000003';
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'hvmp-manager-members-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const owners=new Set([owner]),members=new ManagerMembers({directory,owners});
 await members.open();
 return {directory,owners,members};
}

test('instance members persist, concurrent adds cannot overwrite roles and owners are protected',async t=>{
 const {members,directory,owners}=await fixture(t);
 await assert.rejects(async()=>members.change({action:'remove',steamId:owner},owner),/manager_owner_protected/);
 const edit=role=>members.change({action:'add',steamId:user,role},owner);
 const [first,second]=await Promise.allSettled([edit('operator'),edit('administrator')]);
 assert.equal(first.status,'fulfilled',String(first.reason??''));
 assert.match(second.reason.message,/operation_busy/);
 await assert.rejects(edit('administrator'),/manager_user_exists/);
 await assert.rejects(async()=>members.change({action:'add',steamId:other,role:'viewer'},user),/permission_denied/);
 await assert.rejects(async()=>members.change({action:'add',steamId:other,role:'owner'},owner),/invalid_manager_user/);
 const reloaded=new ManagerMembers({directory,owners});
 await reloaded.open();
 assert.equal(reloaded.roleFor(user),'operator');
 assert.equal(reloaded.roleFor(owner),'owner');
 assert.equal(reloaded.roleFor(other),null);
 const auth=new ManagerAuth({admins:owners,members:reloaded});
 assert.equal(auth.roleFor(user),'operator');
 await reloaded.change({action:'remove',steamId:user},owner);
 assert.equal(auth.roleFor(user),null);
 assert.equal(reloaded.roleFor(user),null);
});

test('HTTP and live feeds enforce role changes and removal on existing sessions',async t=>{
 const {members}=await fixture(t);
 const logs=new ManagerLogs();
 await logs.open();
 const supervisor=Object.assign(new EventEmitter(),{
  state:'running',status:()=>({state:'running',snapshot:null}),power:async()=>({ok:true}),command:async()=>({ok:true}),
 });
 const session=id=>({profile:{steamId:id},csrf:'a'.repeat(64)});
 const sessions=new Map([[owner,session(owner)],[user,session(user)]]);
 const auth={roleFor:id=>members.roleFor(id),authenticate:async id=>members.roleFor(id)?sessions.get(id):null,revoke:id=>sessions.delete(id)};
 let origin;
 const web=await createManagerHttp({host:'127.0.0.1',port:0,auth,members,supervisor,logs,getOrigin:()=>origin});
 t.after(()=>web.close());
 origin='http://127.0.0.1:'+web.address.port;
 const request=(id,route,data)=>fetch(origin+'/manager/api/'+route,{headers:{cookie:id,origin,'content-type':'application/json','x-hvmp-csrf':'a'.repeat(64)},...(data?{method:'POST',body:JSON.stringify(data)}:{})});
 const change=(action,role)=>request(owner,'access',{action,steamId:user,role});
 assert.equal((await request(user,'me')).status,401);
 assert.equal((await change('add','viewer')).status,200);
 assert.equal((await (await request(user,'me')).json()).status.access.role,'viewer');
 for(const route of ['logs','settings','chat','access','audit'])assert.equal((await request(user,route)).status,403,route);
 assert.equal((await request(user,'power',{action:'restart',confirm:true})).status,403);
 assert.equal((await request(user,'access',{action:'set',steamId:user,role:'administrator'})).status,403);
 logs.record('private backlog');
 const socket=new WebSocket(origin.replace('http:','ws:')+'/manager/live?after=0',{headers:{cookie:user,origin}});
 t.after(()=>socket.terminate());
 const received=[];
 socket.on('message',raw=>received.push(JSON.parse(raw)));
 const waitFor=predicate=>new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{socket.off('message',check);reject(Error('Live event missing'));},1500);
  function check(){if(received.some(predicate)){clearTimeout(timeout);socket.off('message',check);resolve();}}
  socket.on('message',check);check();
 });
 await waitFor(m=>m.data?.access?.role==='viewer');
 const sse=await request(user,'events');
 const reader=sse.body.getReader();
 t.after(()=>reader.cancel());
 let initial='';
 while(!initial.includes('event: status')){const chunk=await reader.read();assert(!chunk.done);initial+=Buffer.from(chunk.value).toString();}
 assert.doesNotMatch(initial,/private backlog|event: log/);
 logs.record('viewer cannot see this');
 assert.equal((await change('set','operator')).status,200);
 await waitFor(m=>m.data?.access?.role==='operator');
 assert(!received.some(m=>m.type==='log'));
 assert.equal((await request(user,'power',{action:'restart',confirm:true})).status,200);
 assert.equal((await request(user,'settings')).status,403);
 logs.record('operator may see this');
 await waitFor(m=>m.data?.text==='operator may see this');
 assert.equal((await change('set','moderator')).status,200);
 await waitFor(m=>m.data?.access?.role==='moderator');
 logs.record('moderator cannot see this');
 assert.equal((await request(user,'logs')).status,403);
 assert.equal((await request(user,'console',{line:'help'})).status,403);
 const closed=once(socket,'close');
 assert.equal((await change('remove')).status,200);
 assert.equal((await closed)[0],1008);
 assert(!received.some(m=>m.data?.text==='moderator cannot see this'));
 assert.equal((await request(user,'me')).status,401);
 assert.equal((await change('add','viewer')).status,200);
 assert.equal((await request(user,'me')).status,401,'Adding a removed account requires a new Steam session');
});
