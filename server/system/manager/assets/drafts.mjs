// Safe UI state only. Never accepts a raw .env, tokens, file bytes or private messages.
export class LocalDrafts{
 constructor(scope,storage=globalThis.localStorage){this.scope='hvmp-manager:'+scope+':';this.storage=storage;}
 read(kind){try{const text=this.storage.getItem(this.scope+kind);if(!text||text.length>65536)return null;const data=JSON.parse(text);if(data.schema!==1||!Number.isFinite(data.at)||Date.now()-data.at>7*86400000||!this.valid(kind,data.value)){this.clear(kind);return null;}return data;}catch{return null;}}
 valid(kind,value){if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.revision!=='string'||value.revision.length>128)return false;
  if(kind==='settings')return value.changes&&typeof value.changes==='object'&&!Array.isArray(value.changes)&&Object.entries(value.changes).length<=64&&Object.entries(value.changes).every(([key,v])=>/^[A-Z][A-Z0-9_]{0,63}$/.test(key)&&!/(KEY|TOKEN|SECRET|PASSWORD|SESSION|AUTH|CERT)/.test(key)&&typeof v==='string'&&v.length<=128);
  if(kind==='addons')return ['order','disabled'].every(k=>Array.isArray(value[k])&&value[k].length<=512&&value[k].every(v=>typeof v==='string'&&v.length<=180&&/\.(scs|zip)$/i.test(v)&&!/[\\/\u0000-\u001f]/.test(v)))&&(value.optional===undefined||Array.isArray(value.optional)&&value.optional.length<=100&&value.optional.every(slot=>slot&&['local','workshop'].includes(slot.source)&&typeof slot.match==='string'&&slot.match.length<=184&&typeof slot.name==='string'&&slot.name.length<=100&&(slot.after===null||typeof slot.after==='string'&&slot.after.length<=184)));
  if(kind==='usage')return value.visits&&typeof value.visits==='object'&&Object.entries(value.visits).length<=30&&Object.entries(value.visits).every(([key,v])=>/^[a-z]{1,24}$/.test(key)&&Number.isInteger(v)&&v>=0&&v<=10000);
  return false;
 }
 write(kind,value){if(!this.valid(kind,value))return false;try{const text=JSON.stringify({schema:1,at:Date.now(),value});if(text.length>65536)return false;this.storage.setItem(this.scope+kind,text);return true;}catch{return false;}}
 clear(kind){try{this.storage.removeItem(this.scope+kind);}catch{}}
 visit(page){const value=this.read('usage')?.value??{revision:'local',visits:{}};value.visits[page]=Math.min(10000,(value.visits[page]??0)+1);this.write('usage',value);}
 frequent(){return Object.entries(this.read('usage')?.value.visits??{}).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([page])=>page);}
}
