import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {normalizeAnnouncement} from './announcements.mjs';

const descriptorName='.console-control.json';
export const consoleDescriptor=directory=>join(resolve(directory),descriptorName);
export function validControl(value){return value?.schema===1&&value.host==='127.0.0.1'&&Number.isInteger(value.port)&&value.port>0&&value.port<65536&&/^[a-f0-9]{64}$/.test(value.token??'');}
export async function readControl(directory){const text=await readFile(consoleDescriptor(directory),'utf8');if(text.length>2048)throw Error('Invalid console descriptor');let data;try{data=JSON.parse(text);}catch{throw Error('Invalid console descriptor');}if(!validControl(data))throw Error('Invalid console descriptor');return data;}

// A separate panel command is a shell process, not the game's stdin. This
// authenticated loopback-only bridge lets that process reach the running relay.
export async function createConsoleControl(relay,{directory=process.env.DATA_DIR??'./data'}={}){
 directory=resolve(directory);await mkdir(directory,{recursive:true,mode:0o700});
 try{const previous=await readControl(directory);const r=await fetch(`http://127.0.0.1:${previous.port}/health`,{headers:{authorization:'Bearer '+previous.token},signal:AbortSignal.timeout(800),redirect:'error'});if(r.ok)throw Object.assign(Error('A console is already active in this DATA_DIR.'),{code:'CONSOLE_ACTIVE'});}catch(error){if(error.code==='CONSOLE_ACTIVE')throw error;}
 const token=randomBytes(32).toString('hex'),expected=Buffer.from('Bearer '+token);
 const server=http.createServer(async(req,res)=>{
  const reply=(status,body)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));}};
  const auth=Buffer.from(req.headers.authorization??'');
  if(auth.length!==expected.length||!timingSafeEqual(auth,expected)){reply(401,{ok:false,error:'Unauthorized'});req.resume();return;}
  if(req.method==='GET'&&req.url==='/health'){reply(200,{ok:true});return;}
  if(req.method!=='POST'||!['/announce','/fake-call','/missions-debug'].includes(req.url)){reply(404,{ok:false,error:'Not found'});req.resume();return;}
  try{
   if(Number(req.headers['content-length']??0)>4096){reply(413,{ok:false,error:'Message too large'});req.resume();return;}
   req.setEncoding('utf8');let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096){reply(413,{ok:false,error:'Message too large'});return;}}
   const data=JSON.parse(body);
   if(req.url==='/missions-debug'){const target=data.target??'';if(typeof target!=='string'||target.length>80||/[\u0000-\u001f\u007f]/.test(target)){reply(400,{ok:false,error:'Invalid target.'});return;}const result=relay.missionsDiagnostics?.(target)??{ok:false,error:'Diagnostic Missions non disponible.'};reply(result.ok?200:400,result);return;}
   if(req.url==='/fake-call'){const target=data.target??'';if(typeof target!=='string'||target.length>80||/[\u0000-\u001f\u007f]/.test(target)){reply(400,{ok:false,error:'Invalid target.'});return;}const result=await relay.fakeCall(target);reply(result.ok?200:400,result);return;}
   const text=normalizeAnnouncement(data.message);if(!text){reply(400,{ok:false,error:'Enter a message of 1 to 240 characters without control characters.'});return;}
   const result=relay.announce(text);reply(result.ok?200:503,result);
  }catch{reply(400,{ok:false,error:'Announcement failed or request is invalid.'});}
 });
 server.requestTimeout=3000;server.headersTimeout=5000;
 await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
 const path=consoleDescriptor(directory),temp=path+'.'+token.slice(0,12)+'.tmp';
 try{await writeFile(temp,JSON.stringify({schema:1,host:'127.0.0.1',port:server.address().port,token,pid:process.pid}),{mode:0o600,flag:'wx'});await rename(temp,path);await chmod(path,0o600);}catch(error){await new Promise(r=>server.close(r));await unlink(temp).catch(()=>{});throw error;}
 return {address:server.address(),async close(){const closed=new Promise(r=>server.close(r));server.closeAllConnections();await closed;try{const current=await readControl(directory);if(current.token===token)await unlink(path);}catch{/* Already removed or replaced. */}}};
}
