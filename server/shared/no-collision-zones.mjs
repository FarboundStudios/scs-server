import {trailerSegments} from './trailer-chain.mjs';
const finite=(v,max=1e7)=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=max;
export const zoneUuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
export function zoneSetting(value){if(value===undefined)return true;if(value===true||value==='true'||value==='1')return true;if(value===false||value==='false'||value==='0')return false;throw Error('NO_COLLISION_ZONES_ENABLED must be true or false.');}
export function validZonePolicy(raw){
 if(!raw||raw.enabled!==true||typeof raw.inside!=='boolean'||!Array.isArray(raw.blocked)||raw.blocked.length>32||!raw.blocked.every(zoneUuid))return null;
 return {enabled:true,inside:raw.inside,blocked:[...new Set(raw.blocked)]};
}
// HNC1 is a separate, bounded packet: old HMCL clients are never reinterpreted.
export function zonePacket(policy,sequence,{enabled=false,fresh=false}={}){
 const p=enabled&&fresh?validZonePolicy(policy):null,blocked=p?.blocked??[],b=Buffer.alloc(16+blocked.length*16);b.write('HNC1');b.writeUInt32LE(sequence>>>0,4);b.writeUInt32LE((enabled?1:0)|(p?.inside?2:0)|(p?4:0),8);b.writeUInt32LE(blocked.length,12);blocked.forEach((id,i)=>Buffer.from(id.replaceAll('-',''),'hex').copy(b,16+i*16));return b;
}
export function validateZones(input){
 if(input?.schema!==1||!Array.isArray(input.zones)||input.zones.length>50000)throw Error('Invalid no-collision zone catalogue.');
 const ids=new Set();return input.zones.map(z=>{
  if(!z||typeof z.id!=='string'||!/^[a-zA-Z0-9_.:-]{1,96}$/.test(z.id)||ids.has(z.id)||!finite(z.y)||!finite(z.height,40)||z.height<2)throw Error('Invalid or duplicate no-collision zone.');ids.add(z.id);
  if(z.shape==='circle'&&finite(z.x)&&finite(z.z)&&finite(z.radius,300)&&z.radius>=5)return {...z};
  if(z.shape==='polygon'&&Array.isArray(z.points)&&z.points.length>=3&&z.points.length<=128&&z.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(v=>finite(v)))){
   const xs=z.points.map(p=>p[0]),zs=z.points.map(p=>p[1]);if(Math.max(...xs)-Math.min(...xs)>600||Math.max(...zs)-Math.min(...zs)>600)throw Error('No-collision polygon too large.');return {...z};
  }throw Error('Invalid no-collision zone geometry.');
 });
}
export function vehicleBodies(state){
 if(!state||![state.x,state.y,state.z,state.heading].every(v=>finite(v)))return [];
 return [state,...trailerSegments(state).slice(0,10)].filter(p=>[p?.x,p?.y,p?.z,p?.heading].every(v=>finite(v))).map((p,i)=>{const angle=p.heading*Math.PI*2,half=i?10:7,radius=3;return {x:p.x,y:p.y,z:p.z,ax:p.x-Math.sin(angle)*half,az:p.z-Math.cos(angle)*half,bx:p.x+Math.sin(angle)*half,bz:p.z+Math.cos(angle)*half,radius};});
}
export function pointSegment2(x,z,a,b,c,d){const dx=c-a,dz=d-b,t=Math.max(0,Math.min(1,((x-a)*dx+(z-b)*dz)/(dx*dx+dz*dz||1)));return (x-a-t*dx)**2+(z-b-t*dz)**2;}
function crosses(a,b,c,d,e,f,g,h){const cross=(x,z,u,v)=>x*v-z*u;const x=c-a,z=d-b,u=g-e,v=h-f,den=cross(x,z,u,v);if(Math.abs(den)<1e-9)return false;const t=cross(e-a,f-b,u,v)/den,s=cross(e-a,f-b,x,z)/den;return t>=0&&t<=1&&s>=0&&s<=1;}
function segmentDistance(a,b){if(crosses(a.ax,a.az,a.bx,a.bz,b.ax,b.az,b.bx,b.bz))return 0;return Math.min(pointSegment2(a.ax,a.az,b.ax,b.az,b.bx,b.bz),pointSegment2(a.bx,a.bz,b.ax,b.az,b.bx,b.bz),pointSegment2(b.ax,b.az,a.ax,a.az,a.bx,a.bz),pointSegment2(b.bx,b.bz,a.ax,a.az,a.bx,a.bz));}
export function bodiesOverlap(a,b,margin=2){return a.some(x=>b.some(y=>Math.abs(x.y-y.y)<6&&segmentDistance(x,y)<(x.radius+y.radius+margin)**2));}
function polygonContains(points,x,z){let inside=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const [a,b]=points[i],[c,d]=points[j];if((b>z)!==(d>z)&&x<(c-a)*(z-b)/(d-b)+a)inside=!inside;}return inside;}
export function bodyInZone(body,zone,margin=0){
 if(Math.abs(body.y-zone.y)>zone.height/2+2)return false;
 const radius=body.radius+margin;
 if(zone.shape==='circle')return pointSegment2(zone.x,zone.z,body.ax,body.az,body.bx,body.bz)<=(zone.radius+radius)**2;
 if(polygonContains(zone.points,body.ax,body.az)||polygonContains(zone.points,body.bx,body.bz))return true;
 return zone.points.some(([x,z],i)=>{const [x2,z2]=zone.points[(i+1)%zone.points.length];return segmentDistance(body,{ax:x,az:z,bx:x2,bz:z2})<=radius*radius;});
}
