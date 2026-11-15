import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket,{WebSocketServer} from 'ws';
import {send} from '../server/shared/protocol.mjs';
import {createPhoneHub} from '../scripts/phone/phone-hub.mjs';
import {createPhoneHubClient} from '../scripts/phone/phone-hub-client.mjs';

async function until(read){
  for(let i=0;i<150;i++){
    const value=read();
    if(value)return value;
    await delay(10);
  }
  throw Error('Expected a phone update on the loopback relay.');
}

test('self-hosted phone relay assigns separate numbers and forwards SMS and calls across servers',async t=>{
  const keys={clubA:randomBytes(32).toString('hex'),clubB:randomBytes(32).toString('hex')};
  const hub=await createPhoneHub({port:0,keys,send,WebSocket,WebSocketServer,ice:[]});
  const url='ws://127.0.0.1:'+hub.address.port+'/phone-hub';
  const makeServer=serverId=>createPhoneHubClient({url,serverId,key:keys[serverId],send,WebSocket});
  const first=makeServer('clubA'),second=makeServer('clubB');
  t.after(async()=>{first.close();second.close();await hub.close();});

  const identityHash=randomBytes(32).toString('hex');
  const framesA=[],framesB=[];
  const player=(name,frames)=>({id:randomUUID(),identityHash,name,supportsPhone:true,
    socket:{writable:true,destroyed:false,write:line=>{frames.push(JSON.parse(line));return true;}}});
  const a=player('Driver one',framesA),b=player('Driver two',framesB);
  first.join(a);second.join(b);
  const numberA=await until(()=>a.phone?.number),numberB=await until(()=>b.phone?.number);
  assert.notEqual(numberA,numberB);
  const request=(action,data)=>first.handle(a,{type:'phone_request',id:randomUUID(),action,data});
  request('sms',{number:numberB,text:'On my way'});
  const sms=await until(()=>framesB.find(f=>f.event?.kind==='sms'));
  assert.equal(sms.event.message.sender,numberA);
  assert.equal(sms.event.message.text,'On my way');
  request('call',{number:numberB});
  const call=await until(()=>framesB.find(f=>f.event?.kind==='call'));
  assert.equal(call.event.call.peer,numberA);
  second.leave(b);
  const returning=player('Same driver',[]);
  second.join(returning);
  assert.equal(await until(()=>returning.phone?.number),numberB);
});
