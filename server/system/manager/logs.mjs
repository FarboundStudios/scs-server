import {EventEmitter} from 'node:events';
import {mkdir,readFile,appendFile,stat,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {cleanLog} from '../logger.mjs';
export class ManagerLogs extends EventEmitter {
 constructor({directory=null,limit=1500}={}){super();this.directory=directory;this.limit=limit;this.items=[];this.sequence=0;this.queue=[];this.writing=false;this.bytes=0;this.dropped=0;this.auditQueue=Promise.resolve();this.setMaxListeners(40);}
 async open(){if(!this.directory)return;await mkdir(this.directory,{recursive:true,mode:0o700});this.file=join(this.directory,'console.jsonl');
  try{const size=(await stat(this.file)).size;if(size<=2*1024*1024){for(const line of (await readFile(this.file,'utf8')).split('\n').slice(-this.limit-1)){try{const e=JSON.parse(line);if(typeof e.text==='string'&&Number.isSafeInteger(e.id)){this.items.push(e);this.sequence=Math.max(this.sequence,e.id);}}catch{}}}this.bytes=size;}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 chat(input){if(!input||!['global','local','vtc','system'].includes(input.channel)||typeof input.name!=='string'||typeof input.text!=='string')return;
  const color=v=>/^#[a-f0-9]{6}$/i.test(v??'')?v:null;
  const message={id:input.id,time:input.time,name:cleanLog(input.name).slice(0,80),text:cleanLog(input.system ? input.text.replace(/^\[Annonce\] /,'[Announcement] ') : input.text).slice(0,600),system:input.system===true,channel:input.channel};
  if(input.senderId)message.senderId=String(input.senderId).slice(0,80);
  if(input.vtc?.tag)message.vtc={tag:cleanLog(input.vtc.tag).slice(0,24),color:color(input.vtc.color)};
  if(input.rank)message.rank={label:cleanLog(input.rank.label??'Staff').slice(0,24),color:color(input.rank.color)};
  return this.record('['+message.channel.toUpperCase()+'] '+message.name+': '+message.text,'info','chat',message);
 }
 record(value,level='info',source='game',message=null){
  // Store plain text; the panel styles severity without retaining terminal escapes.
  const raw=String(value).slice(0,8192),plain=cleanLog(raw);
  if(!plain.trim())return;
  if(!message&&!/^\[HeavyMP\] (?:◆|│|└─) /.test(plain)){if(/\b(error|fatal|failed|exception)\b|\[(?:Error|Erreur)\]/i.test(plain))level='error';else if(/\[(?:Warning|Avertissement)\]|\b(?:\w*Warning)\b/i.test(plain))level='warn';else if(/\[Debug\]/.test(plain))level='debug';}
  const entry={id:++this.sequence,at:new Date().toISOString(),level,source,text:plain,...(message?{message}:{})};this.items.push(entry);if(this.items.length>this.limit)this.items.shift();this.emit('entry',entry);
  if(this.directory){if(this.queue.length<500){this.queue.push(JSON.stringify(entry)+'\n');void this.drain();}else this.dropped++;}return entry;
 }
 async drain(){if(this.writing)return;this.writing=true;try{while(this.queue.length){const batch=this.queue.splice(0,100).join('');if(this.bytes+Buffer.byteLength(batch)>2*1024*1024){for(let i=3;i>=1;i--){const from=i===1?this.file:this.file+'.'+(i-1),to=this.file+'.'+i;await unlink(to).catch(e=>{if(e.code!=='ENOENT')throw e;});await rename(from,to).catch(e=>{if(e.code!=='ENOENT')throw e;});}this.bytes=0;}await appendFile(this.file,batch,{mode:0o600});this.bytes+=Buffer.byteLength(batch);}}catch{this.dropped+=this.queue.length;this.queue=[];}finally{this.writing=false;}}
 async audit(actor,action,details={}){
  const entry={at:new Date().toISOString(),actor,action,details};if(!this.directory)return;
  this.auditQueue=this.auditQueue.catch(()=>{}).then(async()=>{const file=join(this.directory,'audit.jsonl');try{if((await stat(file)).size>2*1024*1024){await unlink(file+'.1').catch(e=>{if(e.code!=='ENOENT')throw e;});await rename(file,file+'.1');}}catch(e){if(e.code!=='ENOENT')throw e;}await appendFile(file,JSON.stringify(entry)+'\n',{mode:0o600});});await this.auditQueue;
 }
 since(id=0){return this.items.filter(e=>e.id>id);}
 async close(){while(this.writing||this.queue.length){await this.drain();await new Promise(r=>setTimeout(r,10));}await this.auditQueue.catch(()=>{});}
}
