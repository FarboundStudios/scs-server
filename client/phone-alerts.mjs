import {randomBytes} from 'node:crypto';
// One bounded, local-only packet. The closed phone does not need a browser,
// worker, account token or background DOM to display a new message.
export function createPhoneAlerts({snapshot,getData,now=Date.now}){
 let generation=randomBytes(16),scope=null,sequence=0,items=[];const seen=new Set();
 function push(id,title,text,kind,at,app=null){
  if(typeof id!=='string'||seen.has(id)||!Number.isFinite(at)||now()-at>20000||at-now()>5000)return;
  seen.add(id);if(seen.size>512){seen.clear();for(const n of items)seen.add(n.id);seen.add(id);}
  items.push({id,app:app??(kind===1?'messages':kind===2?'dialer':kind>=4?'chat':'settings'),sequence:++sequence,title:String(title).replace(/[\u0000-\u001f]/g,' ').slice(0,70),text:String(text).replace(/[\u0000-\u001f]/g,' ').slice(0,300),kind,at});items=items.slice(-32);
 }
 return {packet(after=0,format=1){
  const s=snapshot?.()??{},data=getData?.()??{},nextScope=s.available?String(s.scope??'')+':'+s.number:null;
  if(nextScope!==scope){scope=nextScope;generation=randomBytes(16);items=[];seen.clear();sequence=0;}
  if(s.available){for(const e of s.events??[]){if(e.kind==='sms'&&e.message?.recipient===s.number){const m=e.message;push('sms-'+m.id,s.contacts?.find(c=>c.number===m.sender)?.name??m.sender,m.text,1,m.at);}else if(e.kind==='call'&&e.call?.incoming)push('call-'+e.call.id,'Appel entrant',s.contacts?.find(c=>c.number===e.call.peer)?.name??e.call.peer,2,e.call.at);}}
  if(data.connected!==false)for(const n of data.notifications??[])push('local-'+n.id,n.title,n.message,3,n.at,n.app);
  if(data.connected)for(const m of data.chat??[]){if(!m.system&&!m.own&&['global','local','vtc'].includes(m.channel))push('chat-'+m.id+'-'+m.time,m.name,m.text,{local:4,vtc:5,global:6}[m.channel],m.time);}
  items=items.filter(n=>now()-n.at<=20000);const list=items.filter(n=>n.sequence>after).slice(-4),chunks=[];
  const header=Buffer.alloc(32);header.write(format===2?'HMN2':'HMN1');header.writeUInt32LE(sequence>>>0,4);header.writeUInt32LE(list.length,8);header.writeUInt32LE((s.available||data.connected?1:0)|(!s.quiet&&s.call?.incoming&&!s.call.accepted?2:0)|(s.quiet?4:0),12);generation.copy(header,16);chunks.push(header);
  for(const n of list){const title=Buffer.from(n.title),text=Buffer.from(n.text),meta=data.notificationApps?.find(a=>a.id===n.app),appName=Buffer.from(String(meta?.name??({messages:'Messages',dialer:'Phone',chat:'Chat',missions:'Missions',settings:'HeavyMP'}[n.app]??n.app)).slice(0,40)),appId=Buffer.from(n.app),icon=meta?.icon?.startsWith('data:image/png;base64,')?Buffer.from(meta.icon.slice(22),'base64'):Buffer.alloc(0),h=Buffer.alloc(format===2?28:16);h.writeUInt32LE(n.sequence,0);h.writeUInt32LE(n.kind,4);h.writeUInt32LE(title.length,8);h.writeUInt32LE(text.length,12);if(format===2){h.writeUInt32LE(appName.length,16);h.writeUInt32LE(appId.length,20);h.writeUInt32LE(icon.length<=12288?icon.length:0,24);chunks.push(h,title,text,appName,appId,...(icon.length<=12288?[icon]:[]));}else chunks.push(h,title,text);}
  return Buffer.concat(chunks);
 }};
}
