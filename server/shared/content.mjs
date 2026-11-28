import {createHash} from 'node:crypto';
import {GAME_VERSION,isLoopback} from './protocol.mjs';
export const MAX_ADDON_BYTES=8*1024**3;
export const MAP_MODULE_PATTERN=/^[a-z0-9_][a-z0-9_-]{0,63}$/;
export function validMapModule(value){return typeof value==='string'&&MAP_MODULE_PATTERN.test(value);}
export function validMapManifest(value){
 if(!value||value.schema!==1||!/^[a-z0-9_-]{1,48}$/.test(value.id??'')||typeof value.version!=='string'||!/^[A-Za-z0-9._-]{1,40}$/.test(value.version)||value.gameVersion!==GAME_VERSION||!validMapModule(value.module)||!Array.isArray(value.files)||!value.files.length||value.files.length>256)throw Error('Invalid or incompatible map manifest.');
 const names=new Set();let total=0;const files=value.files.map(f=>{if(!f||typeof f.name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,90}\.scs$/i.test(f.name)||names.has(f.name.toLowerCase())||!Number.isSafeInteger(f.size)||f.size<22||f.size>MAX_ADDON_BYTES||!/^[a-f0-9]{64}$/.test(f.sha256??''))throw Error('Invalid map file.');names.add(f.name.toLowerCase());total+=f.size;
  if(f.url!==undefined&&(typeof f.url!=='string'||f.url.length>2048))throw Error('Invalid map URL.');return {name:f.name,size:f.size,sha256:f.sha256,...(f.url?{url:f.url}:{})};});
 if(total>32*1024**3)throw Error('Carte trop volumineuse.');const requiredDlcs=value.requiredDlcs??[];if(!Array.isArray(requiredDlcs)||requiredDlcs.length>100||requiredDlcs.some(d=>typeof d!=='string'||!/^dlc_[a-z0-9_]{1,80}$/.test(d)))throw Error('Invalid DLC dependencies.');
 return {schema:1,id:value.id,version:value.version,gameVersion:GAME_VERSION,module:value.module,requiredDlcs:[...new Set(requiredDlcs)].sort(),files};
}
export function mapRevision(value){const m=validMapManifest(value);return createHash('sha256').update(JSON.stringify({...m,files:m.files.map(({name,size,sha256})=>({name,size,sha256}))})).digest('hex');}
export function mapAssetUrl(value,origin){
 const url=new URL(value,origin);
 const local=url.protocol==='http:'&&url.origin===origin&&
  (url.hostname==='localhost'||isLoopback(url.hostname.replace(/^\[(.*)\]$/,'$1')))&&
  url.pathname.startsWith('/content/files/')&&!url.search;
 if((url.protocol!=='https:'&&!local)||url.username||url.password||url.hash)throw Error('Map files must use HTTPS or the local server content endpoint.');
 return url.href;
}
