import { createHash } from 'node:crypto';
export const MAX_APPEARANCE_BYTES=192000;
export const assetPath=s=>typeof s==='string'&&s.length<=256&&/^\/def\/vehicle\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.sii$/i.test(s)&&!s.includes('..');
const text=(s,max=2048)=>typeof s==='string'&&Buffer.byteLength(s,'utf8')<=max&&!/[\u0000-\u001f\u007f]/.test(s);
const colors=(s,n)=>Array.isArray(s)&&s.length===n&&s.every(v=>Number.isFinite(v)&&v>=-1&&v<=16);
export function validCargoParams(s){
 if(typeof s!=='string'||!/^[0-9a-f]{104}$/i.test(s))return false;
 const b=Buffer.from(s,'hex');
 for(const offset of [8,12,16])if(b.readUInt32LE(offset)>32)return false;
 if(b.readUInt32LE(36)>4096)return false;
 return [20,24,28,32,40,44,48].every(offset=>Number.isFinite(b.readFloatLE(offset))&&Math.abs(b.readFloatLE(offset))<=10000);
}
export function validAppearance(a,trailer=false){
 const dolly=trailer&&Array.isArray(a?.accessories)&&a.accessories.some(x=>typeof x?.path==='string'&&/\/dolly[^/]*\/data\.sii$|\/scs\.dolly[^/]*\/data\.sii$|\/chassis\/dolly[^/]*\.sii$/.test(x.path));
 if(!a||!text(a.plate)||!Array.isArray(a.accessories)||a.accessories.length<(dolly?2:7)||a.accessories.length>256)return null;
 const accessories=[];
 const coachBodies=a.accessories.filter(x=>typeof x?.path==='string'&&/^\/def\/vehicle\/bus\/[^/]+\/data\.sii$/.test(x.path));
 if(coachBodies.length>1||trailer&&coachBodies.length)return null;
 const coachRoot=coachBodies[0]?.path.slice(0,-'data.sii'.length);
 const lightCar=['megane','escort','ambulance','sedan'].find(car=>a.accessories.some(x=>x?.path===`/def/vehicle/truck/heavymp.${car}/data.sii`))??null;
 for(const x of a.accessories){
  if(!x||!Number.isInteger(x.kind)||x.kind<1||x.kind>7||!assetPath(x.path))return null;
  if(coachRoot&&(/^\/def\/vehicle\/truck\//.test(x.path)||
     x.path.startsWith('/def/vehicle/bus/')&&!x.path.startsWith(coachRoot)))return null;
  if(lightCar&&/^\/def\/vehicle\/[fr]_(?:wheel|tire|disc|hub|nuts|cover)\//.test(x.path)&&!x.path.endsWith('/heavymp_'+lightCar+'.sii'))return null;
  const item={kind:x.kind,path:x.path};
  if(x.kind===2){if(!text(x.text))return null;item.text=x.text;}
  if(x.kind===3){if(!Number.isInteger(x.flags)||x.flags<0||x.flags>0xffffffff||!colors(x.colors,3))return null;item.flags=x.flags;item.colors=[...x.colors];}
  if(x.kind===4){if(!colors(x.colors,18))return null;item.colors=[...x.colors];}
  if(x.kind===5){
   if(!colors(x.colors,3)||!Array.isArray(x.tokens)||!Array.isArray(x.hookups)||x.tokens.length>256||x.tokens.length!==x.hookups.length)return null;
   if(!x.tokens.every(v=>typeof v==='string'&&/^[0-9a-f]{16}$/i.test(v))||!x.hookups.every(v=>text(v,128)&&/^[a-z0-9_.-]*$/i.test(v)))return null;
   item.colors=[...x.colors];item.tokens=x.tokens.map(v=>v.toLowerCase());item.hookups=[...x.hookups];
  }
  if(x.kind===7){
   if(!trailer||!x.path.startsWith('/def/vehicle/cargo/')||typeof x.cargoId!=='string'||!/^[0-9a-f]{16}$/i.test(x.cargoId)||/^0{16}$/.test(x.cargoId)||!validCargoParams(x.cargoParams))return null;
   item.cargoId=x.cargoId.toLowerCase();item.cargoParams=x.cargoParams.toLowerCase();
  }
  accessories.push(item);
 }
 // Refuse incomplete tractors before native model construction.
 for(const tail of dolly?['/data.sii','/chassis/']:trailer?['/data.sii','/chassis/','/body/','/paint_job/']:['/data.sii','/chassis/','/cabin/','/interior/','/engine/','/transmission/','/paint_job/'])
  if(!accessories.some(x=>coachRoot?x.path.startsWith(coachRoot+tail.slice(1)):x.path.includes(tail)))return null;
 if(dolly?accessories.filter(x=>x.kind===4).length>1:accessories.filter(x=>x.kind===4).length!==1)return null;
 if(accessories.filter(x=>x.kind===7).length>1)return null;
 const result={plate:a.plate,accessories};
 if(a.children!==undefined){
  if(!trailer||!Array.isArray(a.children)||a.children.length>9)return null;
  result.children=[];for(const child of a.children){if(!child||child.children!==undefined)return null;const v=validAppearance(child,true);if(!v)return null;result.children.push(v);}
 }
 return Buffer.byteLength(JSON.stringify(result),'utf8')<=MAX_APPEARANCE_BYTES?result:null;
}
// Old clients and servers keep receiving their original trailer schema and hash.
export const trailerForPeer=(a,cargoSupported)=>cargoSupported?a:validAppearance({...a,accessories:a.accessories.filter(x=>x.kind!==7),...(a.children?{children:a.children.map(x=>trailerForPeer(x,false))}:{})},true);
export const appearanceHash=a=>createHash('sha256').update(JSON.stringify(a)).digest('hex');
// Keep server ingress below 8 KiB; send appearance only when it changes.
export function appearanceChunks(a,trailer=false){
 const appearance=validAppearance(a,trailer);if(!appearance)return [];
 const bytes=Buffer.from(JSON.stringify(appearance)),revision=appearanceHash(appearance),total=Math.ceil(bytes.length/3000),result=[];
 for(let index=0;index<total;index++)result.push({type:trailer?'trailer_config_part':'vehicle_config_part',revision,index,total,data:bytes.subarray(index*3000,(index+1)*3000).toString('base64')});
 return result;
}
export function acceptAppearancePart(previous,msg,now,trailer=false,maxAge=5000){
 if(!/^[a-f0-9]{64}$/.test(msg.revision)||!Number.isInteger(msg.total)||msg.total<1||msg.total>64||!Number.isInteger(msg.index)||msg.index<0||msg.index>=msg.total||typeof msg.data!=='string'||msg.data.length>4000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(msg.data))return null;
 let pending=previous;
 if(msg.index===0)pending={revision:msg.revision,total:msg.total,at:now,parts:[],bytes:0};
 if(!pending||pending.revision!==msg.revision||pending.total!==msg.total||pending.parts.length!==msg.index||now-pending.at>maxAge)return null;
 const part=Buffer.from(msg.data,'base64');pending.bytes+=part.length;if(pending.bytes>MAX_APPEARANCE_BYTES)return null;
 pending.parts.push(part);
 if(pending.parts.length===pending.total){
  let appearance;try{appearance=validAppearance(JSON.parse(Buffer.concat(pending.parts).toString('utf8')),trailer);}catch{return null;}
  if(!appearance||appearanceHash(appearance)!==pending.revision)return null;
  return {pending:null,appearance,revision:pending.revision};
 }
 return {pending};
}
