import {randomUUID} from 'node:crypto';
export function createDispatchTransport({send,isConnected,notify=()=>{}}){
 let supported=false;const pending=new Map();
 return {available:()=>supported&&isConnected(),capabilities:c=>supported=c?.missions===1,
  receive(m){if(m.type==='dispatch_event'){if(supported&&m.event?.app==='missions')notify(m.event);return true;}if(m.type!=='dispatch_reply')return false;const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.ok?p.resolve(m.result):p.reject(Object.assign(Error(m.error??'Mission service unavailable.'),{code:m.code,retryable:m.retryable===true,retryAfterMs:m.retryAfterMs??0}));}return true;},
  request(action,data={}){if(!supported||!isConnected())return Promise.reject(Object.assign(Error('Update/connect the HeavyMP server to use Missions.'),{retryable:true}));if(pending.size>=8)return Promise.reject(Object.assign(Error('Mission service busy.'),{retryable:true}));return new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(Error('Mission server timed out.'),{retryable:true}));},20000);pending.set(id,{resolve,reject,timer});if(!send({type:'dispatch_request',id,action,data})){clearTimeout(timer);pending.delete(id);reject(Object.assign(Error('Mission connection unavailable.'),{retryable:true}));}});},
  disconnect(){supported=false;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Object.assign(Error('Mission server disconnected.'),{retryable:true}));}pending.clear();}};
}
