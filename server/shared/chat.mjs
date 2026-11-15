import {CHANNELS} from './limits.mjs';
import {validChatVtc} from './vtc-profile.mjs';
export function validChatMessage(m){
 if(!m||!Number.isSafeInteger(m.id)||m.id<0||m.id>0xffffffff||!Number.isSafeInteger(m.time)||m.time<0||typeof m.system!=='boolean'||typeof m.name!=='string'||Buffer.byteLength(m.name)>96||typeof m.text!=='string'||m.text.length>280||Buffer.byteLength(m.text)>850||/[\u0000-\u001f\u007f]/.test(m.name+m.text))return null;
 const channel=m.channel??(m.system?'system':'global');if(!CHANNELS.includes(channel))return null;
 // Grade (staff) affiché devant le pseudo : { label, color } ; invalide = ignoré (le message reste affiché, sans grade).
 const r=m.rank,rank=r&&typeof r==='object'&&typeof r.label==='string'&&r.label.length>=1&&r.label.length<=24&&!/[\u0000-\u001f\u007f\[\]]/.test(r.label)&&typeof r.color==='string'&&/^#[0-9a-f]{6}$/i.test(r.color)?{label:r.label,color:r.color.toLowerCase()}:null;
 const vtc=!m.system?validChatVtc(m.vtc):null;
 const senderId=typeof m.senderId==='string'&&/^(?:\d{17}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(m.senderId)?m.senderId:null;
 return {id:m.id,time:m.time,name:m.name,text:m.text,system:m.system,channel,...(!m.system&&senderId?{senderId}:{}),...(!m.system&&m.own===true?{own:true}:{}),...(rank&&!m.system?{rank}:{}),...(vtc?{vtc}:{})};
}
export function chatForViewer(raw,viewer){const m=validChatMessage(raw);if(!m)return null;return {...m,own:!m.system&&Boolean(m.senderId)&&(m.senderId===viewer.steamId||m.senderId===viewer.id)};}
export function chatPacket(messages,sequence){
 const list=messages.map(validChatMessage).filter(Boolean).slice(-40),stride=1152,b=Buffer.alloc(16+list.length*stride);
 b.write('HMX3');b.writeUInt32LE(sequence>>>0,4);b.writeUInt32LE(list.length,8);b.writeUInt32LE(stride,12);
 list.forEach((m,i)=>{const o=16+i*stride;b.writeUInt32LE(m.id,o);b.writeUInt32LE((m.system?1:0)|(CHANNELS.indexOf(m.channel)<<1),o+4);b.writeBigUInt64LE(BigInt(m.time),o+8);
  // HMX3 separates identity, staff badge and website VTC tag. No grade text
  // is injected into the player's name; metadata has bounded UTF-8 fields.
  b.write(m.name,o+16,127,'utf8');b.writeUInt32LE((m.rank?1:0)|(m.vtc?2:0)|(m.own?4:0),o+1024);
  const color=(hex,at)=>{for(let k=0;k<3;k++)b[at+k]=parseInt(hex.slice(1+k*2,3+k*2),16);};
  if(m.rank){color(m.rank.color,o+1028);b.write(m.rank.label,o+1104,47,'utf8');}
  if(m.vtc){color(m.vtc.color,o+1032);b.write(m.vtc.tag,o+1040,63,'utf8');}
  b.write(m.text,o+144,880,'utf8');});return b;
}
export function repairPacket(id){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))return null;
 const b=Buffer.alloc(32);b.write('HMR1');b.writeUInt32LE(1,4);Buffer.from(id.replaceAll('-',''),'hex').copy(b,16);return b;
}
