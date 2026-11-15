import {readdir,lstat,appendFile,unlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {safeDirectory} from './storage.mjs';
const DAY=86400000,MAX_DAY=8*1024*1024;
export class ChatArchive{
 constructor({directory,now=Date.now}){Object.assign(this,{directory,now});this.pending=0;this.dropped=0;this.tail=Promise.resolve();this.sizes=new Map();}
 async open(){await safeDirectory(this.directory);await this.prune();this.schedulePrune();}
 schedulePrune(){clearTimeout(this.timer);const next=Math.floor(this.now()/DAY)*DAY+DAY;this.timer=setTimeout(()=>{void this.prune().catch(()=>{this.dropped++;}).finally(()=>this.schedulePrune());},Math.max(1000,next-this.now()+25));this.timer.unref?.();}
 async prune(){const cutoff=new Date(this.now()-6*DAY).toISOString().slice(0,10);for(const name of await readdir(this.directory))if(/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)&&name.slice(0,10)<cutoff){await unlink(join(this.directory,name));this.sizes.delete(name);}this.lastPrune=this.now();}
 record(entry){if(!entry.message||this.pending>=250){if(entry.message)this.dropped++;return;}this.pending++;
  const item={...entry,id:randomUUID()},name=new Date(this.now()).toISOString().slice(0,10)+'.jsonl',text=JSON.stringify(item)+'\n';
  this.tail=this.tail.catch(()=>{}).then(async()=>{if(this.now()-(this.lastPrune??0)>3600000)await this.prune();let bytes=this.sizes.get(name);if(bytes===undefined){try{const s=await lstat(join(this.directory,name));if(!s.isFile()||s.isSymbolicLink())throw Error('unsafe_file');bytes=s.size;}catch(e){if(e.code!=='ENOENT')throw e;bytes=0;}}if(bytes+Buffer.byteLength(text)>MAX_DAY){this.dropped++;return;}await appendFile(join(this.directory,name),text,{mode:0o600});this.sizes.set(name,bytes+Buffer.byteLength(text));}).catch(()=>{this.dropped++;}).finally(()=>this.pending--);
 }
 async query({day,channel='all',search='',before='',limit=100}={}){
  const today=new Date(this.now()).toISOString().slice(0,10),minimum=new Date(this.now()-6*DAY).toISOString().slice(0,10);day=day??today;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||day<minimum||day>today||!['all','global','local','vtc','system'].includes(channel)||typeof search!=='string'||search.length>100||typeof before!=='string'||before.length>100)throw Error('invalid_query');
  limit=Math.min(200,Math.max(1,Number(limit)||100));await this.tail;let lines=[];
  try{const file=join(this.directory,day+'.jsonl'),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>MAX_DAY)throw Error('unsafe_file');lines=(await readFile(file,'utf8')).split('\n');}catch(e){if(e.code!=='ENOENT')throw e;}
  const entries=[];let start=!before,more=false;for(let i=lines.length-1;i>=0;i--){if(i%500===0)await yieldIO();let e;try{e=JSON.parse(lines[i]);}catch{continue;}if(!start){if(e.id===before)start=true;continue;}if(!e.message||channel!=='all'&&e.message.channel!==channel||!(e.text+' '+(e.message.senderId??'')).toLowerCase().includes(search.toLowerCase()))continue;if(entries.length===limit){more=true;break;}entries.push(e);}
  return {entries,next:more?entries.at(-1).id:null,day,retentionDays:7,dropped:this.dropped};
 }
 close(){clearTimeout(this.timer);return this.tail;}
}
