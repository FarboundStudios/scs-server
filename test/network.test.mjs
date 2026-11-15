import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import {identityHash} from '../server/system/vtc.mjs';
import { createRelay } from '../server/system/server.mjs';
import { createClient } from '../client/client.mjs';
import { readLines, send, GAME_VERSION } from '../server/shared/protocol.mjs';

const key = () => randomBytes(32).toString('hex');
const pause = ms => new Promise(r => setTimeout(r, ms));
export async function waitFor(check, timeout = 4000) {
  const start = performance.now();
  while (!check()) { if (performance.now()-start > timeout) throw new Error('Condition non atteinte'); await pause(10); }
}
const state = x => ({ x, y: 10, z: -32, heading: .25, pitch: 0, roll: 0, speed: 12, paused: false });

test('two clients relay real-shaped loopback telemetry, discard stale state, and remove disconnected peers', async t => {
  const roomKey = key();
  const relay = await createRelay({ host: '127.0.0.1', port: 0, plaintext: true, roomKey, stateTtl: 450, log: () => {} });
  t.after(() => relay.close());
  const common = { host:'127.0.0.1', port:relay.address.port, roomKey, plaintext:true, telemetryPort:0, monitorPort:false };
  const a = await createClient({...common, name:'Alice'}), b = await createClient({...common, name:'Bob'});
  t.after(() => a.close());
  let bClosed = false; t.after(() => bClosed ? undefined : b.close());
  const udp = dgram.createSocket('udp4'); t.after(() => udp.close());
  await waitFor(() => a.status.connected && b.status.connected);
  assert.notEqual(a.status.id,b.status.id);
  assert.equal(a.status.inGameVehicles,false);
  const sendState = (client, s) => udp.send(JSON.stringify({protocol:1, type:'telemetry',gameId:'eut2',state:s}),client.telemetryAddress.port,'127.0.0.1');
  sendState(a,state(123)); sendState(b,{...state(456),paused:true});
  await waitFor(() => a.status.players.find(p=>p.name==='Bob')?.state?.x===456&&b.status.players.find(p=>p.name==='Alice')?.state?.x===123);
  assert.equal(a.status.players.find(p=>p.name==='Bob').state.paused,true);
  assert.equal(b.status.players.find(p=>p.name==='Alice').state.x,123);
  // Invalid NaN/infinite payloads must not replace the last valid telemetry.
  sendState(a,{...state(999),x:null});
  await pause(60);
  assert.equal(a.status.localState.x,123);
  await waitFor(() => a.status.players.every(p=>p.state===null),3000);
  await b.close(); bClosed = true;
  await waitFor(() => a.status.players.length===0);
});

test('public join routing, exact version and server-owned identity', async t => {
  const roomKey = key();
  const relay = await createRelay({host:'127.0.0.1',port:0,plaintext:true,roomKey,log:()=>{}});
  t.after(()=>relay.close());
  async function join(overrides){
    const socket=net.connect(relay.address.port,'127.0.0.1');
    const message = await new Promise((resolve,reject)=>{
      socket.on('error',reject); readLines(socket,resolve);
      socket.on('connect',()=>send(socket,{type:'join',protocol:1,name:'Alice',gameVersion:GAME_VERSION,room:'HeavyMP',roomKey,...overrides}));
    }); socket.destroy();return message;
  }
  assert.equal((await join({roomKey:key()})).type,'welcome');
  assert.equal((await join({gameVersion:'1.60'})).code,'game_version');
  assert.equal((await join({room:'other'})).code,'access_denied');
  const response=await join({id:'fake',name:'Alice',steamId:'76561198000000001',ticket:'untrusted'});
  assert.equal(response.type,'welcome');assert.notEqual(response.id,'fake');assert.equal(response.steamId,null);
});

test('local staff allowlist checks the actual client token', async t=>{
  const token=key(),fingerprint=identityHash(token);
  const relay=await createRelay({host:'127.0.0.1',port:0,plaintext:true,localStaff:[fingerprint],staffOnly:true,log:()=>{}});
  t.after(()=>relay.close());
  async function join(name,identity){
    const socket=net.connect(relay.address.port,'127.0.0.1');
    t.after(()=>socket.destroy());
    return new Promise((resolve,reject)=>{
      socket.once('error',reject);
      readLines(socket,resolve);
      socket.once('connect',()=>send(socket,{type:'join',protocol:1,gameVersion:GAME_VERSION,room:'HeavyMP',name,identity,staff:true}));
    });
  }
  assert.equal((await join('Impostor',fingerprint)).code,'staff_only');
  assert.equal((await join('Moderator',token)).type,'welcome');
  assert.equal([...relay.sessions.values()][0].staff,true);
});

test('oversized frames are disconnected and plaintext is forbidden on public addresses', async t=>{
  const roomKey=key();
  await assert.rejects(createRelay({host:'0.0.0.0',plaintext:true,roomKey}),/loopback/);
  await assert.rejects(createClient({host:'example.com',plaintext:true,name:'Alice',roomKey}),/VPS/);
  const relay=await createRelay({host:'127.0.0.1',port:0,plaintext:true,roomKey,log:()=>{}});t.after(()=>relay.close());
  const socket=net.connect(relay.address.port,'127.0.0.1');socket.on('error',()=>{});
  await new Promise(resolve=>{socket.on('close',resolve);socket.on('connect',()=>socket.write('x'.repeat(65537)));});
  assert.equal(relay.sessions.size,0);
});

test('rate abuse and replayed sequence numbers are rejected',async t=>{
  const roomKey=key(),relay=await createRelay({host:'127.0.0.1',port:0,plaintext:true,roomKey,log:()=>{}});t.after(()=>relay.close());
  async function authenticated(name){const socket=net.connect(relay.address.port,'127.0.0.1');socket.on('error',()=>{});await new Promise(resolve=>{readLines(socket,m=>{if(m.type==='welcome')resolve();});socket.on('connect',()=>send(socket,{type:'join',protocol:1,name,gameVersion:GAME_VERSION,room:'HeavyMP',roomKey}));});return socket;}
  const a=await authenticated('Replay');let error=null;readLines(a,m=>{if(m.type==='error')error=m.code;});
  send(a,{type:'state',seq:0,state:state(1)});send(a,{type:'state',seq:0,state:state(2)});
  await waitFor(()=>a.destroyed);assert.equal(error,'state_sequence');
  const b=await authenticated('Flood');const closed=new Promise(resolve=>b.on('close',resolve));
  b.write(Array.from({length:150},()=>JSON.stringify({type:'ping',echo:1})+'\n').join(''));
  await closed;
});
