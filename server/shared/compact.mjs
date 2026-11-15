import {validState} from './protocol.mjs';
// Quantized binary payload inside the existing TLS/WebSocket JSON envelopes.
// Positions: 1 cm; angles: 1e-6 turns. The game datagrams retain their existing ABI.
const poseBytes=24,wheelBytes=9;
function writePose(b,o,s){b.writeInt32LE(Math.round(s.x*100),o);b.writeInt32LE(Math.round(s.y*100),o+4);b.writeInt32LE(Math.round(s.z*100),o+8);b.writeInt32LE(Math.round(s.heading*1e6),o+12);b.writeInt32LE(Math.round(s.pitch*1e6),o+16);b.writeInt32LE(Math.round(s.roll*1e6),o+20);return o+poseBytes;}
function readPose(b,o){return {x:b.readInt32LE(o)/100,y:b.readInt32LE(o+4)/100,z:b.readInt32LE(o+8)/100,heading:b.readInt32LE(o+12)/1e6,pitch:b.readInt32LE(o+16)/1e6,roll:b.readInt32LE(o+20)/1e6};}
function writeWheels(b,o,wheels){b[o++]=wheels.length;for(const w of wheels){b.writeUInt16LE(Math.round(w.rotation*65535),o);b.writeInt16LE(Math.round(w.velocity*100),o+2);b.writeInt16LE(Math.round(w.steering*1e5),o+4);b.writeInt16LE(Math.round(w.suspension*1000),o+6);b[o+8]=Math.round(w.lift*255);o+=wheelBytes;}return o;}
function readWheels(b,o){const count=b[o++];if(count>16||o+count*wheelBytes>b.length)throw Error('Invalid wheel block');const wheels=[];for(let i=0;i<count;i++,o+=wheelBytes)wheels.push({rotation:b.readUInt16LE(o)/65535,velocity:b.readInt16LE(o+2)/100,steering:b.readInt16LE(o+4)/1e5,suspension:b.readInt16LE(o+6)/1000,lift:b[o+8]/255});return {wheels,next:o};}
export function encodeCompact(s,full=true){
 const truck=full?s.truck:null,hasTrailers=s.trailers!==undefined||s.trailer!==undefined,trailers=s.trailers??(s.trailer?[s.trailer]:[]);
 const size=29+(truck?19+truck.wheels.length*wheelBytes:0)+(hasTrailers?1+trailers.reduce((n,t)=>n+25+(full?1+t.wheels.length*wheelBytes:0),0):0),b=Buffer.alloc(size);b[0]=1;b[1]=(full?1:0)|(truck?2:0)|(hasTrailers?4:0);let o=writePose(b,2,s);b.writeInt16LE(Math.round(s.speed*100),o);o+=2;b[o++]=s.paused?1:0;
 if(truck){const c=truck.controls;b.writeUInt32LE(truck.lights,o);o+=4;b[o++]=(c.engine?1:0)|(c.parkingBrake?2:0)|(c.wipers?4:0)|(c.wiperPhase!==undefined?8:0);b.writeUInt16LE(Math.round(c.rpm),o);o+=2;b.writeInt8(c.gear,o++);b[o++]=Math.round(c.brake*255);b[o++]=Math.round(c.throttle*255);b.writeInt16LE(Math.round(c.steering*32767),o);o+=2;b.writeUInt16LE(Math.round((c.wiperPhase??0)*65535),o);o+=2;b.writeUInt16LE(Math.round((c.rearWiperPhase??0)*65535),o);o+=2;b[o++]=c.wiperMode??0;b[o++]=(truck.horn?.normal?1:0)|(truck.horn?.air?2:0);o=writeWheels(b,o,truck.wheels);}
 if(hasTrailers){b[o++]=trailers.length;for(const t of trailers){o=writePose(b,o,t);b[o++]=t.connected?1:0;if(full)o=writeWheels(b,o,t.wheels);}}
 if(o!==size)throw Error('Compact size mismatch');return b.toString('base64');
}
export function decodeCompact(value,previous=null){
 if(typeof value!=='string'||value.length<40||value.length>4096||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))return null;
 try{const b=Buffer.from(value,'base64');if(b.length<29||b[0]!==1||b[1]>7)return null;const flags=b[1],full=!!(flags&1),state=readPose(b,2);let o=26;state.speed=b.readInt16LE(o)/100;o+=2;if(b[o]>1)return null;state.paused=b[o++]===1;
  if(flags&2){if(!full)return null;const lights=b.readUInt32LE(o);o+=4;const c=b[o++];if(c>15)return null;const controls={engine:!!(c&1),parkingBrake:!!(c&2),wipers:!!(c&4),rpm:b.readUInt16LE(o),gear:b.readInt8(o+2),brake:b[o+3]/255,throttle:b[o+4]/255,steering:b.readInt16LE(o+5)/32767};o+=7;const phase=b.readUInt16LE(o)/65535,rear=b.readUInt16LE(o+2)/65535,mode=b[o+4],horn=b[o+5];o+=6;if(horn>3)return null;if(c&8){controls.wiperPhase=phase;controls.rearWiperPhase=rear;controls.wiperMode=mode;}const read=readWheels(b,o);o=read.next;state.truck={lights,controls,wheels:read.wheels,horn:{normal:!!(horn&1),air:!!(horn&2)},identity:previous?.truck?.identity??{brand:'',model:'',plate:''},...(previous?.truck?.audio?{audio:previous.truck.audio}:{})};
  }else if(previous?.truck)state.truck=previous.truck;
  if(flags&4){const count=b[o++];if(count>10)return null;state.trailers=[];for(let i=0;i<count;i++){const t=readPose(b,o);o+=24;if(b[o]>1)return null;t.connected=b[o++]===1;if(full){const read=readWheels(b,o);o=read.next;t.wheels=read.wheels;}else t.wheels=previous?.trailers?.[i]?.wheels??previous?.trailer?.wheels??[];state.trailers.push(t);}state.trailer=state.trailers[0]??null;}else if(previous?.trailers){state.trailers=previous.trailers;state.trailer=previous.trailer;}
  return o===b.length?validState(state):null;
 }catch{return null;}
}

export const compactHasAnimation=value=>typeof value==='string'&&value.length>=4&&!!(Buffer.from(value.slice(0,4),'base64')[1]&1);
