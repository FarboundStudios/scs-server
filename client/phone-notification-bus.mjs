import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const idPattern=/^[a-z0-9-]{1,40}$/;
export function validNotificationIcon(value){
 if(typeof value!=='string'||!value.startsWith('data:image/png;base64,')||value.length>16420)return null;
 const bytes=Buffer.from(value.slice(22),'base64');if(bytes.length<24||bytes.length>12288||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.readUInt32BE(16)<1||bytes.readUInt32BE(16)>128||bytes.readUInt32BE(20)<1||bytes.readUInt32BE(20)>128)return null;
 return 'data:image/png;base64,'+bytes.toString('base64');
}
export function createNotificationBus({directory,now=Date.now}){
 const apps=new Map(),notifications=[],seen=new Set(),rates=new Map();let chain=Promise.resolve();const file=directory?join(directory,'phone-app-presentation.json'):null;
 const ready=(async()=>{
  const defaults=[['messages','Messages','../phone/assets/notifications/messages.png'],['dialer','Phone','../phone/assets/notifications/dialer.png'],['chat','Chat','../phone/assets/notifications/chat.png'],['settings','HeavyMP','../phone/assets/notifications/settings.png'],['missions','Missions','../phone/apps/missions/icon.png']];
  for(const [id,name,path]of defaults){let icon=null;try{icon=validNotificationIcon('data:image/png;base64,'+(await readFile(new URL(path,import.meta.url))).toString('base64'));}catch{}apps.set(id,{id,name,icon});}
  if(file)try{const b=await readFile(file);if(b.length<=1200000)for(const a of JSON.parse(b.toString()).slice(0,64))if(idPattern.test(a?.id)&&typeof a.name==='string')apps.set(a.id,{id:a.id,name:a.name.slice(0,40),icon:validNotificationIcon(a.icon)});}catch{}
 })();
 return {ready,apps,notifications,
  async register(data){await ready;if(!idPattern.test(data?.id)||typeof data.name!=='string'||!data.name.trim()||data.name.length>40)throw Error('Invalid application identity.');const icon=validNotificationIcon(data.icon);if(!icon)throw Error('Invalid notification icon (PNG, 128 px maximum).');if(!apps.has(data.id)&&apps.size>=64)throw Error('Application notification limit reached.');apps.set(data.id,{id:data.id,name:data.name,icon});if(file){const snapshot=JSON.stringify([...apps.values()]);chain=chain.catch(()=>{}).then(async()=>{await mkdir(directory,{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,snapshot,{flag:'wx'});await rename(temporary,file);});await chain;}return {ok:true};},
  async notify(data){await ready;const app=apps.get(data?.app);if(!app||typeof data.title!=='string'||typeof data.message!=='string')throw Error('A registered application is required.');const at=now(),id=typeof data.id==='string'&&/^[a-z0-9-]{1,100}$/i.test(data.id)?data.id:randomUUID();if(seen.has(id))return {ok:true};
   const rate=rates.get(app.id)??{at,count:0};if(at-rate.at>60000){rate.at=at;rate.count=0;}if(++rate.count>30)throw Error('Application notification rate exceeded.');rates.set(app.id,rate);seen.add(id);if(seen.size>512)seen.clear();notifications.push({id,app:app.id,title:data.title.slice(0,80),message:data.message.slice(0,500),at});if(notifications.length>50)notifications.shift();return {ok:true};}
 };
}
