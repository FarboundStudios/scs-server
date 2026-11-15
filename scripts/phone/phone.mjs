import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {phoneNumber,phoneText,requestId,iceServers} from './protocol.mjs';

// Persistent identity/contacts/messages; voice packets never pass through the game relay.
export function createPhoneNetwork({database=':memory:',ice,scope='community',now=Date.now,send}){
 const config=iceServers(ice),db=new DatabaseSync(database),online=new Map(),calls=new Map();
 let closed=false;
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS phones(identity TEXT PRIMARY KEY,number TEXT UNIQUE NOT NULL,name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS contacts(owner TEXT,number TEXT,name TEXT,PRIMARY KEY(owner,number));
 CREATE TABLE IF NOT EXISTS sms(id TEXT PRIMARY KEY,request TEXT,owner TEXT,sender TEXT,recipient TEXT,text TEXT,at INTEGER,UNIQUE(owner,request));
 CREATE INDEX IF NOT EXISTS sms_sender ON sms(sender,at); CREATE INDEX IF NOT EXISTS sms_recipient ON sms(recipient,at);
 CREATE TABLE IF NOT EXISTS calls(id TEXT,owner TEXT,peer TEXT,direction TEXT,result TEXT,at INTEGER,PRIMARY KEY(id,owner));
 CREATE INDEX IF NOT EXISTS calls_owner ON calls(owner,at);`);
 const q=sql=>db.prepare(sql),lookup=q('SELECT * FROM phones WHERE number=?'),byIdentity=q('SELECT * FROM phones WHERE identity=?');
 db.prepare('DELETE FROM sms WHERE at<?').run(now()-30*86400000);
 function emit(s,event){if(s?.phone)send(s.socket,{type:'phone_event',event});}
 const current=s=>calls.get(s.phoneCall);
 function finish(c,result){if(!c||!calls.has(c.id))return;calls.delete(c.id);for(const [number,direction,peer]of [[c.from,'outgoing',c.to],[c.to,'incoming',c.from]]){if(c.test&&number===c.from)continue;const p=online.get(number);if(p?.phoneCall===c.id)p.phoneCall=null;q('INSERT OR REPLACE INTO calls VALUES(?,?,?,?,?,?)').run(c.id,number,peer,direction,result,c.at);q('DELETE FROM calls WHERE owner=? AND id NOT IN (SELECT id FROM calls WHERE owner=? ORDER BY at DESC LIMIT 40)').run(number,number);emit(p,{kind:'call-ended',id:c.id,result});}}
 const timer=setInterval(()=>{for(const c of calls.values())if(now()-c.at>(c.test?60000:c.accepted?7200000:30000))finish(c,c.accepted?'ended':'missed');},1000);timer.unref?.();
 function snapshot(s){if(!s.phone)return {available:false};const number=s.phone.number,c=current(s);return {available:true,scope,number,contacts:q('SELECT number,name FROM contacts WHERE owner=? ORDER BY name COLLATE NOCASE').all(number),messages:q('SELECT id,sender,recipient,text,at FROM (SELECT *,rowid AS ordering FROM sms WHERE sender=? OR recipient=? ORDER BY at DESC,rowid DESC LIMIT 80) ORDER BY at,ordering').all(number,number),recent:q('SELECT id,peer,direction,result,at FROM calls WHERE owner=? ORDER BY at DESC LIMIT 40').all(number),call:c?{id:c.id,peer:c.from===number?c.to:c.from,incoming:c.to===number,accepted:c.accepted,at:c.at,...(c.test?{test:true}:{})}:null,iceServers:config};}
 function unavailable(s,message){if(!s.phoneLeft){send(s.socket,{type:'phone_state',state:{available:false}});send(s.socket,{type:'phone_event',event:{kind:'unavailable',message}});}return false;}
 function assign(s,identity,number){
  if(closed||s.phoneLeft)return false;
  const occupant=online.get(number);
  if(occupant&&occupant!==s)return unavailable(s,'This number is already connected.');
  q('INSERT INTO phones VALUES(?,?,?) ON CONFLICT(identity) DO UPDATE SET name=excluded.name').run(identity,number,s.name);
  s.phone={identity,number,name:s.name};online.set(number,s);send(s.socket,{type:'phone_state',state:snapshot(s)});return true;
 }
 function join(s){
  if(!s.supportsPhone)return;s.phoneLeft=false;
  const identity=s.identityHash?'dev:'+s.identityHash:null;
  if(!identity)return unavailable(s,'A persistent identity is required.');
  const record=byIdentity.get(identity);if(record&&phoneNumber(record.number))return assign(s,identity,record.number);
  for(let n=1;n<=9999;n++){const number='555-'+String(n).padStart(4,'0');if(!lookup.get(number))return assign(s,identity,number);}
  return unavailable(s,'No more phone numbers are available.');
 }
 function leave(s){s.phoneLeft=true;if(!s.phone)return;finish(current(s),'disconnected');if(online.get(s.phone.number)===s)online.delete(s.phone.number);s.phone=null;}
 function fakeCall(target=''){
  const players=[...online.values()],query=String(target).trim();
  const matches=query?players.filter(s=>s.phone.number===query||s.steamId===query||s.name.toLowerCase()===query.toLowerCase()):players;
  if(matches.length!==1)return {ok:false,error:matches.length?'Multiple players match. Enter an exact name, SteamID64 or 555-XXXX number.':'No matching player with a connected phone.'};
  return beginTestCall(matches[0]);
 }
 function beginTestCall(s){
  if(!s.supportsPhoneTestCall)return {ok:false,error:'The player needs a client update to receive test calls.'};
  if(current(s))return {ok:false,error:'This player is already on a call.'};
  const c={id:randomUUID(),from:'555-0000',to:s.phone.number,at:now(),accepted:false,signals:0,test:true};
  calls.set(c.id,c);s.phoneCall=c.id;emit(s,{kind:'call',call:{...c,incoming:true,peer:c.from}});
  return {ok:true,player:s.name,number:s.phone.number,id:c.id};
 }
 function handle(s,msg){if(msg.type!=='phone_request')return false;if(!requestId(msg.id))return true;const reply=(ok,result)=>send(s.socket,{type:'phone_reply',id:msg.id,ok,...(ok?{result}:{error:result})});try{
  if(!s.phone)throw Error('Phone unavailable: incompatible identity or server.');
  const t=now();s.phoneRate??={at:t,tokens:100};s.phoneRate.tokens=Math.min(100,s.phoneRate.tokens+(t-s.phoneRate.at)/50);s.phoneRate.at=t;if(s.phoneRate.tokens<1)throw Error('Phone busy.');s.phoneRate.tokens--;
  const a=msg.action,d=msg.data??{},own=s.phone.number;
  if(a==='sync'){reply(true,snapshot(s));return true;}
  if(a==='contact-save'||a==='contact-delete'){
   const n=phoneNumber(d.number);if(!n||n===own||!lookup.get(n))throw Error('Unknown number.');
   if(a==='contact-save'){const name=typeof d.name==='string'?d.name.trim().slice(0,40):'';if(!name||/[\u0000-\u001f]/.test(name))throw Error('Nom de contact requis.');if(!q('SELECT 1 FROM contacts WHERE owner=? AND number=?').get(own,n)&&q('SELECT COUNT(*) n FROM contacts WHERE owner=?').get(own).n>=100)throw Error('100 contacts maximum.');q('INSERT OR REPLACE INTO contacts VALUES(?,?,?)').run(own,n,name);}else q('DELETE FROM contacts WHERE owner=? AND number=?').run(own,n);
   reply(true,snapshot(s));return true;
  }
  if(a==='sms'){
   const n=phoneNumber(d.number),text=phoneText(d.text);if(!n||n===own||!lookup.get(n)||!text)throw Error('Invalid number or message.');
   const existing=q('SELECT * FROM sms WHERE owner=? AND request=?').get(own,msg.id);if(existing){if(existing.recipient!==n||existing.text!==text)throw Error('Identifier already in use.');reply(true,{message:existing});return true;}
   if(t-(s.phoneSmsAt??0)<800)throw Error('Patiente avant un nouveau message.');s.phoneSmsAt=t;
   const m={id:randomUUID(),sender:own,recipient:n,text,at:t};q('INSERT INTO sms VALUES(?,?,?,?,?,?,?)').run(m.id,msg.id,own,own,n,text,t);const count=q('SELECT COUNT(*) n FROM sms').get().n;if(count>100000)q('DELETE FROM sms WHERE rowid IN (SELECT rowid FROM sms ORDER BY at LIMIT 1000)').run();emit(online.get(n),{kind:'sms',message:m});emit(s,{kind:'sms',message:m});reply(true,{message:m});return true;
  }
  if(a==='call'){
   // Reserved test service: trigger the existing simulated incoming call ONLY
   // for the requesting player. Never choose a different connected player.
   if(phoneNumber(d.number)==='555-0000'){
    if(t-(s.phoneCallAt??0)<3000)throw Error('Patiente avant de rappeler.');
    const result=beginTestCall(s);if(!result.ok)throw Error(result.error);
    s.phoneCallAt=t;reply(true,{id:result.id});return true;
   }
   const n=phoneNumber(d.number),peer=online.get(n);if(!n||n===own||!peer)throw Error('Recipient unavailable.');if(current(s)||current(peer))throw Error('Line busy.');if(t-(s.phoneCallAt??0)<3000)throw Error('Patiente avant de rappeler.');s.phoneCallAt=t;
   const c={id:randomUUID(),from:own,to:n,at:t,accepted:false,signals:0};calls.set(c.id,c);s.phoneCall=peer.phoneCall=c.id;emit(s,{kind:'call',call:{...c,incoming:false,peer:n}});emit(peer,{kind:'call',call:{...c,incoming:true,peer:own}});reply(true,{id:c.id});return true;
  }
  const c=current(s);if(!c||c.id!==d.id)throw Error('Call ended.');const peer=online.get(c.from===own?c.to:c.from);
  if(a==='hangup'){finish(c,d.reason==='declined'?'declined':'ended');reply(true,{});return true;}
  if(a==='answer'){if(c.to!==own||c.accepted)throw Error('Appel non recevable.');c.accepted=true;emit(peer,{kind:'accepted',id:c.id});emit(s,{kind:'accepted',id:c.id});reply(true,{});return true;}
  if(a==='signal'){
   if(c.test)throw Error('Simulated call: no remote signal.');
   const v=d.signal;if(!c.accepted||!v||!peer||++c.signals>200)throw Error('Signal rejected.');
   if(v.type==='offer'||v.type==='answer'){if(c[v.type]||(v.type==='answer'&&!c.offer)||(v.type==='offer')!==(c.from===own)||typeof v.sdp!=='string'||v.sdp.length>16000)throw Error('Invalid description.');c[v.type]=true;}
   else if(v.type==='candidate'){if(typeof v.candidate!=='string'||v.candidate.length>1800||v.sdpMid!==null&&typeof v.sdpMid!=='string'||typeof v.sdpMid==='string'&&v.sdpMid.length>30||v.sdpMLineIndex!==null&&(!Number.isInteger(v.sdpMLineIndex)||v.sdpMLineIndex<0||v.sdpMLineIndex>10))throw Error('Invalid candidate.');}
   else throw Error('Invalid signal.');
   const signal=v.type==='candidate'?{type:v.type,candidate:v.candidate,sdpMid:v.sdpMid,sdpMLineIndex:v.sdpMLineIndex}:{type:v.type,sdp:v.sdp};emit(peer,{kind:'signal',id:c.id,signal});reply(true,{});return true;
  }
  throw Error('Action inconnue.');
 }catch(e){reply(false,e.message);}return true;}
 return {join,leave,handle,snapshot,fakeCall,close(){closed=true;clearInterval(timer);for(const c of [...calls.values()])finish(c,'ended');for(const s of online.values())s.phone=null;online.clear();db.close();}};
}
