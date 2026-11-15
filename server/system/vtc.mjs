import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {send} from '../shared/protocol.mjs';
export const identityHash=token=>typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)?createHash('sha256').update(token).digest('hex'):null;
const hash=token=>createHash('sha256').update(token).digest('hex');
export function createVtc({sessions,initial={version:1,companies:[]},persist=async()=>{},log=console.error,now=Date.now}){
 let companies=new Map(),memberships=new Map(),invitations=new Map(),queue=Promise.resolve(),queued=0;
 const snapshot=()=>({version:1,companies:[...companies.values()].map(c=>({...c,members:[...c.members]}))});
 function restore(data){if(data?.version!==1||!Array.isArray(data.companies)||data.companies.length>5000)throw Error('Invalid VTC registry.');const next=new Map(),owners=new Map(),invites=new Map();let total=0;
  for(const raw of data.companies){if(!raw||typeof raw.id!=='string'||!/^[a-f0-9-]{36}$/.test(raw.id)||next.has(raw.id)||typeof raw.name!=='string'||raw.name.length<1||raw.name.length>40||/[\u0000-\u001f\u007f]/.test(raw.name)||!Array.isArray(raw.members)||!raw.members.length||raw.members.length>10000||!raw.members.includes(raw.owner)||!raw.members.every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))||raw.inviteHash!==null&&(!/^[a-f0-9]{64}$/.test(raw.inviteHash)||!Number.isSafeInteger(raw.inviteExpires)))throw Error('Invalid VTC registry.');
   const c={id:raw.id,name:raw.name,owner:raw.owner,members:new Set(raw.members),inviteHash:raw.inviteHash,inviteExpires:raw.inviteExpires??0};for(const member of c.members){if(owners.has(member))throw Error('Duplicate VTC member.');owners.set(member,c.id);}total+=c.members.size;if(total>50000)throw Error('Registre VTC trop volumineux.');next.set(c.id,c);if(c.inviteHash&&c.inviteExpires>Date.now())invites.set(c.inviteHash,c.id);
  }companies=next;memberships=owners;invitations=invites;
 }
 restore(initial);
 const company=s=>companies.get(memberships.get(s.identityHash))??null;
 const notify=s=>{const c=company(s),value=c?{id:c.id,name:c.name,owner:c.owner===s.identityHash}:null,key=JSON.stringify(value);if(s.vtcStatusKey===key)return;if(send(s.socket,{type:'vtc_status',company:value}))s.vtcStatusKey=key;};
 function run(s,tell,operation){if(!s.identityHash){tell(s,'Update the client to manage a VTC.');return;}if(s.vtcPending||queued>=32){tell(s,'A VTC operation is in progress. Try again shortly.');return;}s.vtcPending=true;queued++;
  queue=queue.then(async()=>{const before=snapshot();try{const result=operation();await persist(snapshot());for(const peer of sessions.values())if(peer.supportsChat)notify(peer);tell(s,result);}catch(error){restore(before);tell(s,error.userMessage??'Could not save the VTC. Try again later.');if(!error.userMessage)log('VTC persistence: '+error.message);}finally{s.vtcPending=false;queued--;}});
 }
 const reject=text=>{throw Object.assign(Error(text),{userMessage:text});};
 return {company,notify,async close(){await queue;},
  handle(s,args,tell){const [raw,...rest]=args,action=(raw??'info').toLowerCase();
   if(action==='info'){const c=company(s);tell(s,c?'VTC : '+c.name+' · '+c.members.size+' membre(s). /v message pour parler.':'Aucune VTC. /vtc create Nom ou /vtc join CODE.');return;}
   if(!['create','invite','join','leave','disband'].includes(action)){tell(s,'/vtc create Nom · /vtc invite · /vtc join CODE · /vtc leave · /vtc disband · /vtc info');return;}
   run(s,tell,()=>{const c=company(s);
    if(action==='create'){const name=rest.join(' ').normalize('NFC').trim();if(c)reject('You already belong to a VTC.');if(!name||name.length>40||Buffer.byteLength(name)>100||/[\u0000-\u001f\u007f]/.test(name))reject('Invalid VTC name (1 to 40 characters).');if(companies.size>=5000||memberships.size>=50000)reject('VTC capacity reached.');if([...companies.values()].some(x=>x.name.toLowerCase()===name.toLowerCase()))reject('This VTC name is already in use.');const record={id:randomUUID(),name,owner:s.identityHash,members:new Set([s.identityHash]),inviteHash:null,inviteExpires:0};companies.set(record.id,record);memberships.set(s.identityHash,record.id);return 'VTC created: '+name+'. Use /vtc invite to generate a private invitation.';}
    if(action==='join'){if(c)reject('Quitte ta VTC actuelle avant de rejoindre une autre.');if(rest.length!==1||!/^[A-Za-z0-9_-]{22}$/.test(rest[0]))reject('Usage: /vtc join CODE.');const key=hash(rest[0]),id=invitations.get(key),target=companies.get(id);if(!target||target.inviteExpires<Date.now())reject('Invalid or expired VTC invitation.');if(target.members.size>=10000||memberships.size>=50000)reject('This VTC is full.');target.members.add(s.identityHash);memberships.set(s.identityHash,target.id);invitations.delete(key);target.inviteHash=null;target.inviteExpires=0;return 'You joined '+target.name+'.';}
    if(!c)reject('You do not belong to a VTC.');if(rest.length)reject('This command takes no arguments.');
    if(action==='invite'){if(c.owner!==s.identityHash)reject('Only the VTC owner can send invitations.');if(c.inviteHash)invitations.delete(c.inviteHash);const token=randomBytes(16).toString('base64url');c.inviteHash=hash(token);c.inviteExpires=Date.now()+15*60*1000;invitations.set(c.inviteHash,c.id);return 'Private single-use invitation, valid for 15 minutes: /vtc join '+token;}
    if(action==='leave'){if(c.owner===s.identityHash&&c.members.size>1)reject('The owner must use /vtc disband to disband the VTC.');c.members.delete(s.identityHash);memberships.delete(s.identityHash);if(!c.members.size){companies.delete(c.id);if(c.inviteHash)invitations.delete(c.inviteHash);}return 'You left the VTC.';}
    if(c.owner!==s.identityHash)reject('Only the owner can disband the VTC.');for(const member of c.members)memberships.delete(member);companies.delete(c.id);if(c.inviteHash)invitations.delete(c.inviteHash);return 'VTC disbanded.';
   });
  }
 };
}
