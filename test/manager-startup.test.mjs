import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startServerManager} from '../server/system/manager/main.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(f){for(let i=0;i<300;i++){if(f())return;await pause(20);}throw Error('Manager startup check timed out');}
async function fixture(t,overrides={}){const directory=await mkdtemp(join(tmpdir(),'hvmp-manual-start-'));t.after(()=>rm(directory,{recursive:true,force:true}));const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;return {directory,origin,env:{...process.env,SERVER_ID:'eu1',DATA_DIR:directory,LOG_DIR:join(directory,'logs'),ADDONS_DIR:join(directory,'addons'),MAP_MANIFEST:'none',HOST:'127.0.0.1',PORT:String(port),PUBLIC_HOST:'eu1.example.org',PUBLIC_PORT:'443',MAX_PLAYERS:'32',PHONE_HUB_URL:'',TRAFFIC_ENABLED:'false',NO_COLLISION_ZONES_ENABLED:'false',LOG_COLORS:'false',MANAGER_ENABLED:'true',MANAGER_ADMIN_STEAM_IDS:'76561198000000001',MANAGER_PUBLIC_URL:origin,...overrides}};}
test('full Manager restart stays stopped even after a previously running game; explicit Start remains operational',async t=>{const f=await fixture(t);let manager=await startServerManager(f.env);t.after(()=>manager.close());assert.equal(manager.supervisor.state,'stopped');assert.equal(manager.supervisor.child,null);assert.equal((await fetch(f.origin+'/manager/')).status,200);assert.equal((await fetch(f.origin+'/health')).status,503);const login=await fetch(f.origin+'/manager/auth/steam',{redirect:'manual'});assert.equal(login.status,303);assert.equal(new URL(login.headers.get('location')).hostname,'steamcommunity.com');await pause(150);assert.equal(manager.supervisor.child,null);
 await manager.supervisor.power('start');await wait(()=>manager.supervisor.state==='running');assert(manager.supervisor.child.pid);assert.equal((await fetch(f.origin+'/health')).status,200);await manager.close();manager=await startServerManager(f.env);assert.equal(manager.supervisor.state,'stopped');await pause(150);assert.equal(manager.supervisor.child,null);assert.equal((await fetch(f.origin+'/manager/')).status,200);
});
test('Steam callback uses the configured host while the game is stopped',async t=>{
 const f=await fixture(t,{MANAGER_PUBLIC_URL:'',PUBLIC_HOST:'club.example.org'});
 let calls=0;
 const manager=await startServerManager(f.env,{steamFetch:async()=>{calls++;throw Error('unexpected request');}});
 t.after(()=>manager.close());
 assert.equal((await fetch(f.origin+'/manager/')).status,200);
 assert.equal(manager.auth.getOrigin(),'https://club.example.org');
 assert.equal(new URL(manager.auth.begin().url).searchParams.get('openid.realm'),'https://club.example.org/');
 assert.equal(manager.supervisor.state,'stopped');
 assert.equal(calls,0);
});
test('local Manager works without a public domain',async t=>{
 const f=await fixture(t,{MANAGER_PUBLIC_URL:'',PUBLIC_HOST:''});
 const manager=await startServerManager(f.env);
 t.after(()=>manager.close());
 assert.equal((await fetch(f.origin+'/manager/')).status,200);
 assert.equal(manager.auth.getOrigin(),f.origin);
 assert.equal(manager.supervisor.child,null);
});

test.after(()=>{if(!process.stdin.listenerCount('data'))process.stdin.pause();});
