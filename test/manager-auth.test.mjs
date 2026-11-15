import test from 'node:test';import assert from 'node:assert/strict';
import {ManagerAuth,sameToken} from '../server/system/manager/auth.mjs';
const ID='76561198000000001',OTHER='76561198000000002',origin='https://club.example.org',provider='https://steamcommunity.com/openid/login';
const profilePage='https://steamcommunity.com/profiles/'+ID+'/',profileUrl=profilePage.slice(0,-1)+'?xml=1',avatar='https://avatars.fastly.steamstatic.com/'+'a'.repeat(40)+'_medium.jpg';
function fixture({allowed=[ID],steamValid=true,unavailable=false,html=()=>new Response('',{status:503}),saved,report,profile=(id)=>new Response(`<profile><steamID64>${id}</steamID64><steamID><![CDATA[Léo & Co]]></steamID><avatarMedium>${avatar}</avatarMedium></profile>`,{headers:{'content-type':'text/xml'}})}={}){let time=Date.parse('2026-11-05T12:00:00Z');const requests=[];const auth=new ManagerAuth({admins:new Set(allowed),getOrigin:()=>origin,now:()=>time,profiles:new Map(saved?[[ID,saved]]:[]),profileLog:report,fetchImpl:async(url,options)=>{requests.push({url,options});if(url===profileUrl)return profile(ID);if(url!==provider)return html(url,options);if(unavailable)throw Error('offline');return new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:'+steamValid+'\n');}});return {auth,requests,advance:ms=>time+=ms};}
function assertion(auth,id=ID){const start=auth.begin(),redirect=new URL(start.url),returnTo=redirect.searchParams.get('openid.return_to'),url=new URL(returnTo);const params={'openid.ns':'http://specs.openid.net/auth/2.0','openid.mode':'id_res','openid.op_endpoint':provider,'openid.claimed_id':'https://steamcommunity.com/openid/id/'+id,'openid.identity':'https://steamcommunity.com/openid/id/'+id,'openid.return_to':returnTo,'openid.response_nonce':'2026-11-05T12:00:00Zunique-nonce','openid.signed':'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle','openid.assoc_handle':'association','openid.sig':'signature'};for(const [k,v]of Object.entries(params))url.searchParams.set(k,v);return {start,url,cookie:start.cookie.split(';')[0]};}
test('Steam sign-in binds origin/state, verifies provider server-to-server and resolves only the confirmed SteamID',async()=>{const {auth,requests}=fixture(),a=assertion(auth);assert.match(a.start.cookie,/__Host-hvmp_login=/);assert.match(a.start.cookie,/HttpOnly; SameSite=Lax/);assert.match(a.start.cookie,/Secure/);const r=await auth.callback(a.url,a.cookie);assert.equal(r.session.profile.steamId,ID);assert.equal(requests[0].url,provider);assert.equal(requests[0].options.redirect,'error');assert.equal(new URLSearchParams(requests[0].options.body).get('openid.mode'),'check_authentication');const cookie=r.cookies[0].split(';')[0];assert.deepEqual((await auth.authenticate(cookie)).profile,{steamId:ID,name:'Léo & Co',avatar});assert.equal(requests[1].url,profileUrl);auth.logout(cookie);assert.equal(await auth.authenticate(cookie),null);await assert.rejects(auth.callback(a.url,a.cookie),/invalid_login/);});
test('arbitrary OpenID endpoint and forged/duplicate identity/state/signed fields fail closed before network calls',async()=>{for(const [key,value]of [['openid.op_endpoint','https://evil.invalid/'],['openid.identity','https://steamcommunity.com/openid/id/'+OTHER],['openid.return_to','https://evil.invalid/callback'],['openid.signed','identity'],['state','x'.repeat(64)]]){const {auth,requests}=fixture(),a=assertion(auth);a.url.searchParams.set(key,value);await assert.rejects(auth.callback(a.url,a.cookie));assert.equal(requests.length,0);}const {auth}=fixture(),a=assertion(auth);a.url.searchParams.append('openid.identity',a.url.searchParams.get('openid.identity'));await assert.rejects(auth.callback(a.url,a.cookie),/invalid_assertion/);});
test('Steam rejection, a foreign allowlist and Steam outage never create a session',async()=>{for(const options of [{steamValid:false},{allowed:[OTHER]},{unavailable:true}]){const {auth}=fixture(options),a=assertion(auth);await assert.rejects(auth.callback(a.url,a.cookie));assert.equal(auth.sessions.size,0);}});
test('reused nonce and expired state/session are refused; revoked allowlist takes effect immediately',async()=>{const f=fixture(),a=assertion(f.auth),first=await f.auth.callback(a.url,a.cookie),b=assertion(f.auth);await assert.rejects(f.auth.callback(b.url,b.cookie),/invalid_nonce/);const cookie=first.cookies[0].split(';')[0];f.auth.admins.clear();assert.equal(await f.auth.authenticate(cookie),null);const g=fixture(),c=assertion(g.auth);g.advance(600001);await assert.rejects(g.auth.callback(c.url,c.cookie));const h=fixture(),d=assertion(h.auth),r=await h.auth.callback(d.url,d.cookie);h.advance(8*3600000+1);assert.equal(await h.auth.authenticate(r.cookies[0].split(';')[0]),null);});
test('sessions work without further provider requests, no plaintext tokens stored and Unicode token comparisons cannot throw',async()=>{const f=fixture(),a=assertion(f.auth),r=await f.auth.callback(a.url,a.cookie),cookie=r.cookies[0].split(';')[0];f.advance(120001);assert(await f.auth.authenticate(cookie));assert.equal(f.requests.length,2);assert(!f.auth.sessions.has(cookie.split('=')[1]));assert.equal(sameToken('é','a'),false);assert.equal(sameToken('token','token'),true);assert.equal(sameToken(null,'token'),false);});
test('an unavailable or mismatched Steam profile does not block sign-in',async()=>{
 for(const profile of [()=>new Response('',{status:503}),()=>{throw Error('timeout');},()=>new Response(`<profile><steamID64>${OTHER}</steamID64><steamID>Other user</steamID></profile>`,{headers:{'content-type':'text/xml'}})]){
  const {auth}=fixture({profile}),a=assertion(auth);
  const {session}=await auth.callback(a.url,a.cookie);
  assert.deepEqual(session.profile,{steamId:ID,name:'Steam user',avatar:null});
 }
});
test('Steam profile names support XML entities and avatars must use the Steam CDN',async()=>{
 const {auth}=fixture({profile:()=>new Response(`<profile><steamID64>${ID}</steamID64><steamID>Driver &amp; co &#x1F69A;</steamID><avatarMedium>https://example.org/mock.jpg</avatarMedium></profile>`,{headers:{'content-type':'text/xml'}})}),a=assertion(auth);
 const {session}=await auth.callback(a.url,a.cookie);
 assert.deepEqual(session.profile,{steamId:ID,name:'Driver & co 🚚',avatar:null});
});
test('a blocked XML response falls back to a matching Steam Community page over its canonical redirect',async()=>{
 const canonical='https://steamcommunity.com/id/truckdriver/';
 const {auth,requests}=fixture({profile:()=>new Response('',{status:403}),html:(url,options)=>{
  assert.equal(options.redirect,'manual');
  if(url===profilePage)return Response.redirect(canonical,302);
  assert.equal(url,canonical);
  return new Response(`<meta property="og:image" content="${avatar}">\n g_rgProfileData = ${JSON.stringify({steamid:ID,personaname:'Truck Driver'})};\n`,{headers:{'content-type':'text/html; charset=utf-8'}});
 }});
 const a=assertion(auth),{session}=await auth.callback(a.url,a.cookie);
 assert.deepEqual(requests.map(r=>r.url),[provider,profileUrl,profilePage,canonical]);
 assert.deepEqual(session.profile,{steamId:ID,name:'Truck Driver',avatar});
});
test('saved display data is used after a Steam outage and external redirects are refused',async()=>{
 const messages=[],saved={name:'Saved driver',avatar};
 const {auth,requests}=fixture({saved,report:line=>messages.push(line),profile:()=>new Response('',{status:429}),html:()=>Response.redirect('https://example.org/id/driver/',302)});
 const a=assertion(auth),{session}=await auth.callback(a.url,a.cookie);
 assert.deepEqual(requests.map(r=>r.url),[provider,profileUrl,profilePage]);
 assert.deepEqual(session.profile,{steamId:ID,...saved});
 assert.deepEqual(messages,['Steam profile using saved display details (XML: HTTP 429; HTML: unexpected redirect).']);
});
test('Steam callback has bounded state capacity and requires a fresh nonce',async()=>{const {auth}=fixture();for(let i=0;i<256;i++)auth.begin();assert.throws(()=>auth.begin(),/auth_busy/);const f=fixture(),a=assertion(f.auth);a.url.searchParams.set('openid.response_nonce','2020-01-01T00:00:00Zold');await assert.rejects(f.auth.callback(a.url,a.cookie),/invalid_nonce/);});
