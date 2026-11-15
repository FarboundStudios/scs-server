import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {send} from '../shared/protocol.mjs';
import {dispatchSpec,dispatchId,dispatchJob} from '../shared/dispatch.mjs';

export function createDispatcher({database=':memory:',sessions,now=Date.now}){
 const db=new DatabaseSync(database);db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS dispatch_missions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,spec TEXT NOT NULL,visibility TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS dispatch_members(mission TEXT NOT NULL,identity TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL,progress TEXT,PRIMARY KEY(mission,identity));
 CREATE TABLE IF NOT EXISTS dispatch_requests(identity TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,response TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(identity,id));
 CREATE TABLE IF NOT EXISTS dispatch_outbox(id TEXT PRIMARY KEY,mission TEXT NOT NULL,identity TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS dispatch_owner ON dispatch_missions(owner,state);
 CREATE INDEX IF NOT EXISTS dispatch_request_age ON dispatch_requests(at);`);
 // Progress updates do not require a seven-day replay response. Their state is
 // idempotent, and retaining every full participant list would grow the DB fast.
 if(!db.prepare('PRAGMA table_info(dispatch_requests)').all().some(c=>c.name==='expires'))db.exec('ALTER TABLE dispatch_requests ADD COLUMN expires INTEGER');
 db.exec('CREATE INDEX IF NOT EXISTS dispatch_request_expiry ON dispatch_requests(expires)');
 const q=s=>db.prepare(s),identity=s=>s.steamId?'steam:'+s.steamId:s.identityHash?'dev:'+s.identityHash:null;
 const member=(id,who)=>q('SELECT * FROM dispatch_members WHERE mission=? AND identity=?').get(id,who);
 const event=(id,who,kind,payload)=>{if(q('SELECT COUNT(*) n FROM dispatch_outbox').get().n>=100000)throw Error('Mission event storage is full. Contact the server administrator.');return q('INSERT INTO dispatch_outbox VALUES(?,?,?,?,?,?)').run(randomUUID(),id,who,kind,JSON.stringify(payload),now());};
 const online=who=>[...sessions.values()].find(s=>identity(s)===who);
 function emit(who,title,text,id){const s=online(who);if(s?.supportsMissions)send(s.socket,{type:'dispatch_event',event:{id:randomUUID(),app:'missions',title,text,missionId:id,at:now()}});}
 function view(row,who){const members=q('SELECT identity,name,state,updated,progress FROM dispatch_members WHERE mission=? ORDER BY updated LIMIT 32').all(row.id);return {id:row.id,spec:JSON.parse(row.spec),state:row.state,revision:row.revision,createdAt:row.created,isOwner:row.owner===who,membership:members.find(m=>m.identity===who)?.state??null,members:members.map(m=>({name:m.name,state:m.state,own:m.identity===who,updatedAt:m.updated,progress:m.progress?JSON.parse(m.progress):null}))};}
 function visible(row,who){return row&&(row.visibility==='public'||row.owner===who||member(row.id,who));}
 function request(s,action,data={}){
  const who=identity(s);if(!who)throw Error('A persistent player identity is required.');
  if(!data||typeof data!=='object'||Array.isArray(data)||JSON.stringify(data).length>12000)throw Error('Invalid mission request.');
  const at=now();s.dispatchRate??={at,tokens:20};s.dispatchRate.tokens=Math.min(20,s.dispatchRate.tokens+(at-s.dispatchRate.at)/250);s.dispatchRate.at=at;if(s.dispatchRate.tokens<1)throw Error('Please wait before refreshing missions.');s.dispatchRate.tokens--;
  if(action==='list'){
   const rows=q("SELECT DISTINCT d.* FROM dispatch_missions d LEFT JOIN dispatch_members m ON d.id=m.mission AND m.identity=? WHERE d.visibility='public' OR d.owner=? OR m.identity=? ORDER BY CASE WHEN d.owner=? OR m.identity=? THEN 0 ELSE 1 END,d.created DESC LIMIT 20").all(who,who,who,who,who);
   return {available:true,siteSync:false,scope:'game-server',missions:rows.map(r=>view(r,who)),players:[...sessions.values()].filter(p=>p.supportsMissions&&identity(p)!==who).slice(0,100).map(p=>({id:p.id,name:p.name})),outboxPending:q('SELECT COUNT(*) n FROM dispatch_outbox').get().n};
  }
  if(action==='get'){const row=q('SELECT * FROM dispatch_missions WHERE id=?').get(String(data.id));if(!visible(row,who))throw Error('Mission not found.');return view(row,who);}
  if(!dispatchId(data.requestId))throw Error('A unique request ID is required.');
  q('DELETE FROM dispatch_requests WHERE expires<? OR (expires IS NULL AND at<?)').run(at,at-7*86400000);
  const digest=createHash('sha256').update(JSON.stringify({action,data})).digest('hex'),old=q('SELECT hash,response FROM dispatch_requests WHERE identity=? AND id=?').get(who,data.requestId);
  if(old){if(old.hash!==digest)throw Error('Request ID was reused for another operation.');return JSON.parse(old.response);}
  let result,notice;db.exec('BEGIN IMMEDIATE');try{
   if(action==='create'){
    const spec=dispatchSpec(data.spec);if(q("SELECT COUNT(*) n FROM dispatch_missions WHERE owner=? AND state='open'").get(who).n>=20||q('SELECT COUNT(*) n FROM dispatch_missions').get().n>=50000)throw Error('Mission storage limit reached.');
    const id=randomUUID();q('INSERT INTO dispatch_missions VALUES(?,?,?,?,?,?,?)').run(id,who,JSON.stringify(spec),spec.visibility,'open',1,at);q('INSERT INTO dispatch_members VALUES(?,?,?,?,?,NULL)').run(id,who,s.name,'accepted',at);event(id,who,'mission.created',{spec});result=view(q('SELECT * FROM dispatch_missions WHERE id=?').get(id),who);
   }else{
    if(!dispatchId(data.id))throw Error('Invalid mission.');let row=q('SELECT * FROM dispatch_missions WHERE id=?').get(data.id);if(!visible(row,who))throw Error('Mission not found.');
    if(data.revision!==row.revision)throw Error('This mission changed. Refresh and try again.');if(row.state!=='open')throw Error('Mission is closed.');const m=member(row.id,who),spec=JSON.parse(row.spec);
    if(action==='invite'){
     if(row.owner!==who)throw Error('Only the organiser can invite players.');const target=sessions.get(data.playerId),targetWho=target&&identity(target);if(!targetWho||targetWho===who||!target.supportsMissions)throw Error('Player unavailable.');
     if(!member(row.id,targetWho)){if(q('SELECT COUNT(*) n FROM dispatch_members WHERE mission=?').get(row.id).n>=32)throw Error('32 participants maximum.');q('INSERT INTO dispatch_members VALUES(?,?,?,?,?,NULL)').run(row.id,targetWho,target.name,'invited',at);notice=[targetWho,'Mission invitation',s.name+' invited you to '+spec.title,row.id];}
    }else if(action==='join'){
     if(m&&m.state!=='invited'&&m.state!=='left')throw Error('You already joined this mission.');if(!m&&row.visibility!=='public')throw Error('An invitation is required.');
     if(!m&&q('SELECT COUNT(*) n FROM dispatch_members WHERE mission=?').get(row.id).n>=32)throw Error('32 participants maximum.');q('INSERT INTO dispatch_members VALUES(?,?,?,?,?,NULL) ON CONFLICT(mission,identity) DO UPDATE SET state=excluded.state,updated=excluded.updated,name=excluded.name').run(row.id,who,s.name,'accepted',at);
    }else if(action==='leave'){
     if(!m||row.owner===who)throw Error('The organiser must cancel the mission.');q("UPDATE dispatch_members SET state='left',updated=? WHERE mission=? AND identity=?").run(at,row.id,who);
    }else if(action==='cancel'){
     if(row.owner!==who)throw Error('Only the organiser can cancel this mission.');q("UPDATE dispatch_missions SET state='cancelled' WHERE id=?").run(row.id);for(const p of q('SELECT identity FROM dispatch_members WHERE mission=?').all(row.id))event(row.id,p.identity,'mission.cancelled',{});
    }else if(action==='prepared'){
     const proof=data.method==='live'?data.proofHash:data.saveHash;
     if(!m||!['accepted','prepared'].includes(m.state)||typeof proof!=='string'||!/^[a-f0-9]{64}$/.test(proof))throw Error('Join this mission before preparing its delivery.');q("UPDATE dispatch_members SET state='prepared',updated=? WHERE mission=? AND identity=?").run(at,row.id,who);event(row.id,who,'delivery.prepared',{method:data.method==='live'?'live':'legacy-save',proofHash:proof});
    }else if(action==='telemetry'){
     if(!m||!['prepared','driving'].includes(m.state))throw Error('No prepared delivery.');const p=dispatchJob(data.job);
     if(!p.active&&!p.event||p.cargo!==spec.cargo.slice(6)||p.source!==spec.source||p.destination!==spec.destination)throw Error('The ETS2 job does not match this mission.');
     const state=p.event==='job.delivered'?'delivered':p.event==='job.cancelled'?'cancelled':'driving';const progress={state,cargoDamage:Number.isFinite(p.cargoDamage)?Math.max(0,Math.min(1,p.cargoDamage)):null,at};
     q('UPDATE dispatch_members SET state=?,updated=?,progress=? WHERE mission=? AND identity=?').run(state,at,JSON.stringify(progress),row.id,who);if(state!=='driving'||m.state!=='driving')event(row.id,who,'delivery.'+state,{job:p,source:'client-sdk',verifiedByServer:false});
    }else throw Error('Unknown mission action.');
    q('UPDATE dispatch_missions SET revision=revision+1 WHERE id=?').run(row.id);result=view(q('SELECT * FROM dispatch_missions WHERE id=?').get(row.id),who);
   }
   if(q('SELECT COUNT(*) n FROM dispatch_requests').get().n>=50000)throw Error('Mission request storage is full. Please try again later.');
   const progress=action==='telemetry'&&!data.job?.event;
   q('INSERT INTO dispatch_requests(identity,id,hash,response,at,expires) VALUES(?,?,?,?,?,?)').run(who,data.requestId,digest,JSON.stringify(result),at,at+(progress?60000:7*86400000));db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  if(notice)emit(...notice);return result;
 }
 return {request,diagnostics(s){const who=identity(s);return who?{available:true,siteSync:false,scope:'game-server',memberships:q('SELECT COUNT(*) n FROM dispatch_members WHERE identity=?').get(who).n}:null;},handle(s,msg){if(msg.type!=='dispatch_request')return false;if(!s.supportsMissions||!dispatchId(msg.id))return true;try{const result=request(s,msg.action,msg.data);send(s.socket,{type:'dispatch_reply',id:msg.id,ok:true,result});}catch(e){send(s.socket,{type:'dispatch_reply',id:msg.id,ok:false,error:String(e.message).slice(0,250)});}return true;},close(){db.close();}};
}
