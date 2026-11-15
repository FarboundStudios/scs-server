import {GAME_VERSION} from '../server/shared/protocol.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import {createRelay} from '../server/system/server.mjs';
import {validServers} from '../server/system/registry.mjs';
const get=url=>new Promise((resolve,reject)=>http.get(url,r=>{let data='';r.on('data',b=>data+=b);r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,data:JSON.parse(data)}));}).on('error',reject));
const wait=async check=>{const start=Date.now();while(!check()){if(Date.now()-start>3000)throw Error('API test timeout');await new Promise(r=>setTimeout(r,20));}};
test('local registry rejects duplicates and unsafe endpoints',()=>{
 assert.throws(()=>validServers([{id:'x',name:'X',host:'user:pass@host'}]));
 assert.throws(()=>validServers([{id:'x',name:'X',host:'a.com'},{id:'x',name:'X',host:'b.com'}]));
 assert.throws(()=>validServers([{id:'x',name:'X',host:'a.com',port:65536}]));
 assert.deepEqual(validServers([{id:'eu1',name:'Europe',host:'EU1.EXAMPLE.ORG'}]),[{id:'eu1',name:'Europe',host:'eu1.example.org',port:443}]);
});
test('public APIs show configured servers and fresh player positions without connection secrets or addresses',async t=>{
 const roomKey='private-test-key-'.repeat(3),relay=await createRelay({host:'127.0.0.1',port:0,roomKey,log:()=>{},stateTtl:100});t.after(()=>relay.close());
 const base=`http://127.0.0.1:${relay.address.port}`;
 const list=await get(base+'/servers');assert.equal(list.status,200);assert.equal(list.headers['access-control-allow-origin'],'*');assert.equal(list.data.servers[0].host,'localhost');assert.equal(list.data.servers[0].playerCount,0);
 assert.equal((await get(base+'/players')).data.count,0);
 const ws=new WebSocket(`ws://127.0.0.1:${relay.address.port}/heavymp`);t.after(()=>ws.close());await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
 ws.send(JSON.stringify({type:'join',protocol:1,gameVersion: GAME_VERSION,name:'API Player',room:'HeavyMP',roomKey})+'\n');await wait(()=>relay.sessions.size===1);
 ws.send(JSON.stringify({type:'state',seq:0,state:{x:123,y:4,z:-56,heading:.25,pitch:0,roll:0,speed:0,paused:false}})+'\n');await wait(()=>[...relay.sessions.values()][0].lastState);
 const players=(await get(base+'/players')).data;assert.equal(players.count,1);assert.equal(players.players[0].name,'API Player');assert.equal(players.players[0].inGame,true);assert.equal(players.players[0].position.x,123);
 const serialized=JSON.stringify(players);assert.ok(!serialized.includes(roomKey));assert.ok(!serialized.includes('127.0.0.1'));assert.ok(!serialized.includes('roomKey'));assert.ok(!serialized.includes('socket'));
 await new Promise(r=>setTimeout(r,120));assert.equal((await get(base+'/players')).data.players[0].position,null);
 ws.close();await wait(()=>relay.sessions.size===0);assert.equal((await get(base+'/servers')).data.servers[0].playerCount,0);
});
