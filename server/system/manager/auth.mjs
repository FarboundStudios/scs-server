import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {steamProfile} from './steam-profile.mjs';
const PROVIDER='https://steamcommunity.com/openid/login',NS='http://specs.openid.net/auth/2.0';
const digest=v=>createHash('sha256').update(v).digest('hex');
const random=()=>randomBytes(32).toString('hex');
export function cookies(header=''){const result={};for(const part of header.split(';')){const at=part.indexOf('=');if(at>0)result[part.slice(0,at).trim()]=part.slice(at+1).trim();}return result;}
export function sameToken(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length>128||b.length>128)return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export class ManagerAuth {
 constructor({admins,members,getOrigin,fetchImpl=fetch,now=Date.now,profiles=new Map(),profileLog,cookieScope=''}){Object.assign(this,{admins,members,getOrigin,fetchImpl,now,profiles,profileLog,cookieScope});this.pending=new Map();this.sessions=new Map();this.nonces=new Map();this.cookieName='hvmp_manager';}
 roleFor(steamId){return this.members?this.members.roleFor(steamId):this.admins.has(steamId)?'owner':null;}
 cookieKey(name){return (this.getOrigin()?.startsWith('https:')?'__Host-':'')+name+(this.cookieScope?'-'+this.cookieScope:'');}
 cookie(name,value,maxAge){return `${this.cookieKey(name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.getOrigin()?.startsWith('https:')?'; Secure':''}`;}
 prune(){const t=this.now();for(const [k,v]of this.pending)if(v.expires<t)this.pending.delete(k);for(const [k,v]of this.sessions)if(v.expires<t||t-v.lastAt>1800000)this.sessions.delete(k);for(const [k,v]of this.nonces)if(v<t)this.nonces.delete(k);}
 begin(){this.prune();if(!this.getOrigin())throw Error('manager_origin_unavailable');if(!this.admins.size)throw Error('manager_admins_missing');if(this.pending.size>=256)throw Error('auth_busy');
  const token=random(),state=random(),returnTo=this.getOrigin()+'/manager/auth/callback?state='+state;
  this.pending.set(digest(token),{state,returnTo,expires:this.now()+600000});const url=new URL(PROVIDER);
  for(const [k,v]of Object.entries({'openid.ns':NS,'openid.mode':'checkid_setup','openid.return_to':returnTo,'openid.realm':this.getOrigin()+'/','openid.identity':NS+'/identifier_select','openid.claimed_id':NS+'/identifier_select'}))url.searchParams.set(k,v);
  return {url:url.href,cookie:this.cookie('hvmp_login',token,600)};
 }
 async callback(url,header){
  this.prune();const token=cookies(header)[this.cookieKey('hvmp_login')];if(!/^[a-f0-9]{64}$/.test(token??''))throw Error('invalid_login');const state=this.pending.get(digest(token));this.pending.delete(digest(token));
  const p=url.searchParams;if(!state||state.expires<this.now()||!sameToken(p.get('state'),state.state))throw Error('invalid_login');
  for(const k of p.keys())if(p.getAll(k).length!==1)throw Error('invalid_assertion');
  const claim=p.get('openid.claimed_id'),identity=p.get('openid.identity'),id=/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claim??'')?.[1];
  const signed=new Set((p.get('openid.signed')??'').split(','));
  if(p.get('openid.ns')!==NS||p.get('openid.mode')!=='id_res'||p.get('openid.op_endpoint')!==PROVIDER||!id||identity!==claim||p.get('openid.return_to')!==state.returnTo||!['op_endpoint','claimed_id','identity','return_to','response_nonce','assoc_handle'].every(k=>signed.has(k)))throw Error('invalid_assertion');
  const nonce=p.get('openid.response_nonce')??'',stamp=Date.parse(nonce.slice(0,20));if(nonce.length>255||!Number.isFinite(stamp)||Math.abs(this.now()-stamp)>600000||this.nonces.has(nonce))throw Error('invalid_nonce');
  const body=new URLSearchParams();for(const [k,v]of p)if(k.startsWith('openid.')){if(v.length>2048)throw Error('invalid_assertion');body.set(k,v);}body.set('openid.mode','check_authentication');if(body.toString().length>16384)throw Error('invalid_assertion');
  const response=await this.fetchImpl(PROVIDER,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString()});
  if(!response.ok){await response.body?.cancel();throw Error('steam_unavailable');}
  let text='';for await(const b of response.body){text+=Buffer.from(b).toString('utf8');if(text.length>4096)throw Error('invalid_assertion');}if(!/^is_valid:true\r?$/m.test(text))throw Error('invalid_assertion');
  if(this.nonces.size>=2048)throw Error('auth_busy');this.nonces.set(nonce,this.now()+600000);
  if(!this.roleFor(id))throw Error('access_denied');if(this.sessions.size>=256)throw Error('auth_busy');
  const profile=await steamProfile(id,this.fetchImpl,{saved:this.profiles.get(id),report:this.profileLog});
  if(!this.roleFor(id))throw Error('access_denied');if(this.sessions.size>=256)throw Error('auth_busy');
  const sessionToken=random(),session={profile,csrf:random(),expires:this.now()+8*3600000,lastAt:this.now()};this.sessions.set(digest(sessionToken),session);
  return {session,cookies:[this.cookie(this.cookieName,sessionToken,8*3600),this.cookie('hvmp_login','',0)]};
 }
 async authenticate(header){this.prune();const token=cookies(header)[this.cookieKey(this.cookieName)];if(!/^[a-f0-9]{64}$/.test(token??''))return null;const id=digest(token),session=this.sessions.get(id);if(!session)return null;if(!this.roleFor(session.profile.steamId)){this.sessions.delete(id);return null;}
  session.lastAt=this.now();return session;
 }
 revoke(steamId){for(const [id,session]of this.sessions)if(session.profile.steamId===steamId)this.sessions.delete(id);}
 logout(header){const token=cookies(header)[this.cookieKey(this.cookieName)];if(token)this.sessions.delete(digest(token));return this.cookie(this.cookieName,'',0);}
}
