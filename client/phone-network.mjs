import {randomUUID} from 'node:crypto';
export function createPhoneTransport({send,isConnected}){
 let state={available:false,number:null,contacts:[],messages:[],recent:[],call:null,iceServers:[]},events=[],sequence=0,quiet=false,version=0;
 const pending=new Map();
 function message(m){if(!m||typeof m.id!=='string'||typeof m.text!=='string'||m.text.length>500)return;if(!state.messages.some(x=>x.id===m.id)){state.messages=[...state.messages,m].slice(-80);version++;}}
 function receive(m){
  if(m.type==='phone_state'){state=m.state?.available===true?m.state:{available:false,number:null,contacts:[],messages:[],recent:[],call:null,iceServers:[]};events=[];version++;return true;}
  if(m.type==='phone_reply'){const p=pending.get(m.id);if(!p)return true;pending.delete(m.id);clearTimeout(p.timer);if(m.ok){if(m.result?.available){state=m.result;version++;}if(m.result?.message)message(m.result.message);p.resolve(m.result);}else p.reject(Error(m.error??'Phone unavailable.'));return true;}
  if(m.type!=='phone_event')return false;const e=m.event;if(!e||typeof e.kind!=='string')return true;
  if(e.kind==='sms')message(e.message);
  if(e.kind==='call'){state.call=e.call;version++;}
  if(e.kind==='accepted'&&state.call?.id===e.id){state.call={...state.call,accepted:true};version++;}
  if(e.kind==='call-ended'&&state.call?.id===e.id){const c=state.call;state.recent=[{id:c.id,peer:c.peer,direction:c.incoming?'incoming':'outgoing',at:c.at,result:e.result},...state.recent].slice(0,40);state.call=null;version++;}
  events.push({...e,sequence:++sequence});events=events.slice(-128);while(events.length>1&&Buffer.byteLength(JSON.stringify(events))>32768)events.shift();return true;
 }
 function request(action,data={},id=randomUUID()){
  if(action==='quiet'){quiet=data.enabled===true;return Promise.resolve({quiet});}
  if(!isConnected()||!state.available)return Promise.reject(Error('Phone unavailable. Connect to a supported server.'));
  if(pending.has(id))return Promise.reject(Error('A request is already being sent.'));
  if(pending.size>=24)return Promise.reject(Error('Phone busy.'));
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Server did not respond.'));},8000);timer.unref?.();pending.set(id,{resolve,reject,timer});if(!send({type:'phone_request',id,action,data})){clearTimeout(timer);pending.delete(id);reject(Error('Connection unavailable.'));}});
 }
 function disconnect(){for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Connection lost.'));}pending.clear();state={available:false,number:null,contacts:[],messages:[],recent:[],call:null,iceServers:[]};events=[];version++;}
 return {receive,request,disconnect,snapshot:({after=-1,revision=-1}={})=>({...(revision===version?{unchanged:true}:state),version,events:events.filter(e=>e.sequence>after),quiet}),ring:()=>!quiet&&state.call?.incoming===true&&!state.call.accepted};
}
