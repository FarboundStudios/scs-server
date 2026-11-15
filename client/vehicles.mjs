import {MAX_TRAILER_RECORDS} from '../server/shared/limits.mjs';
import { validState } from '../server/shared/protocol.mjs';
import {trailerSegments,segmentId} from '../server/shared/trailer-chain.mjs';

// HMV2: 16-byte header, followed by up to 32 fixed 448-byte records.
// No room credentials or player names are sent to the game plugin.
export function vehiclePacket(status, sequence) {
  const peers = status.connected ? status.players.filter(player =>
    player.id !== status.id && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(player.id) &&
    validState(player.state) && Number.isFinite(player.ageMs) && player.ageMs <= 1000 && player.ageMs >= 0
  ).slice(0, 32) : [];
  const stride=456, buffer = Buffer.alloc(16 + peers.length * stride);
  buffer.write('HMV3'); buffer.writeUInt32LE(sequence >>> 0, 4);
  buffer.writeUInt32LE(peers.length, 8); buffer.writeUInt32LE(stride, 12);
  peers.forEach((player, index) => {
    const offset = 16 + index * stride;
    Buffer.from(player.id.replaceAll('-', ''), 'hex').copy(buffer, offset);
    ['x', 'y', 'z', 'heading', 'pitch', 'roll'].forEach((key, field) => buffer.writeDoubleLE(player.state[key], offset + 16 + field * 8));
    buffer.writeUInt32LE(Math.floor(player.ageMs), offset + 64);
    buffer.writeDoubleLE(player.state.speed,offset+72);buffer.writeUInt32LE(Math.max(0,Math.min(5000,Math.floor(player.animationAgeMs??0))),offset+448);
    const truck=validState(player.state).truck;
    if(truck){
      buffer.writeUInt32LE(truck.lights,offset+80);buffer.writeUInt32LE(truck.wheels.length,offset+84);
      truck.wheels.forEach((wheel,i)=>['rotation','velocity','steering','suspension','lift'].forEach((key,k)=>buffer.writeFloatLE(wheel[key],offset+88+i*20+k*4)));
      const c=truck.controls;
      buffer.writeUInt32LE((c.engine?1:0)|(c.parkingBrake?2:0)|(c.wipers?4:0)|8,offset+408);
      buffer.writeFloatLE(c.rpm,offset+412);buffer.writeInt32LE(c.gear,offset+416);
      buffer.writeFloatLE(c.brake,offset+420);buffer.writeFloatLE(c.throttle,offset+424);buffer.writeFloatLE(c.steering,offset+428);
      // Reserved HMV2 tail: older DLLs ignore it and keep their existing ABI.
      buffer.writeUInt32LE((truck.horn?.normal?1:0)|(truck.horn?.air?2:0),offset+432);
      if(c.wiperPhase!==undefined){buffer.writeFloatLE(c.wiperPhase,offset+436);buffer.writeFloatLE(c.rearWiperPhase,offset+440);buffer.writeUInt32LE((0x80000000|c.wiperMode)>>>0,offset+444);}
    }
  });
  return buffer;
}

// HMS1 carries the three stock sound references (engine/exhaust/turbo).
export function audioPacket(status,sequence){
 const peers=status.connected?status.players.filter(p=>p.id!==status.id&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(p.id)&&validState(p.state)?.truck?.audio&&Number.isFinite(p.ageMs)&&p.ageMs>=0&&p.ageMs<=1000).slice(0,32):[];
 const stride=784,b=Buffer.alloc(16+peers.length*stride);b.write('HMS1');b.writeUInt32LE(sequence>>>0,4);b.writeUInt32LE(peers.length,8);b.writeUInt32LE(stride,12);
 peers.forEach((p,i)=>{const o=16+i*stride;Buffer.from(p.id.replaceAll('-',''),'hex').copy(b,o);p.state.truck.audio.forEach((s,j)=>b.write(s,o+16+j*256,240,'ascii'));});return b;
}

// HMT1 is independent of HMV2 so older tractor receivers keep working.
// 400-byte records: UUID, independent pose, presence/connection, wheel count,
// 16 wheel states. A full snapshot also removes trailers absent from it.
export function trailerPacket(status,sequence){
 if(status.players?.some(p=>Array.isArray(p.state?.trailers)))return trailerChainPacket(status,sequence);
 const peers=status.connected?status.players.filter(p=>p.id!==status.id&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(p.id)&&validState(p.state)&&p.ageMs>=0&&p.ageMs<=1000).slice(0,32):[];
 const b=Buffer.alloc(16+peers.length*400);b.write('HMT1');b.writeUInt32LE(sequence>>>0,4);b.writeUInt32LE(peers.length,8);b.writeUInt32LE(400,12);
 peers.forEach((p,i)=>{const o=16+i*400;Buffer.from(p.id.replaceAll('-',''),'hex').copy(b,o);const t=validState(p.state).trailer;
   if(!t)return;b.writeUInt32LE(t.connected?3:1,o+64);b.writeUInt32LE(t.wheels.length,o+68);
   ['x','y','z','heading','pitch','roll'].forEach((k,j)=>b.writeDoubleLE(t[k],o+16+j*8));
   t.wheels.forEach((w,j)=>['rotation','velocity','steering','suspension','lift'].forEach((k,l)=>b.writeFloatLE(w[k],o+72+j*20+l*4)));
 });return b;
}
export function trailerChainPacket(status,sequence){
 const records=[],owners=[];
 if(status.connected)for(const p of status.players){if(p.id===status.id||!/^[a-f0-9-]{36}$/i.test(p.id)||!validState(p.state)||p.ageMs<0||p.ageMs>1000)continue;owners.push({p,segments:trailerSegments(validState(p.state))});}
 // Send each owner's first segment before spending the remaining segment budget.
 for(let index=0;index<10&&records.length<MAX_TRAILER_RECORDS;index++)for(const {p,segments} of owners){if(segments[index])records.push({p,trailer:segments[index],index});if(records.length===MAX_TRAILER_RECORDS)break;}
 const kept=records.slice(0,MAX_TRAILER_RECORDS),b=Buffer.alloc(16+kept.length*424);b.write('HMT3');b.writeUInt32LE(sequence>>>0,4);b.writeUInt32LE(kept.length,8);b.writeUInt32LE(424,12);
 kept.forEach(({p,trailer:t,index},i)=>{const o=16+i*424;Buffer.from(segmentId(p.id,index).replaceAll('-',''),'hex').copy(b,o);Buffer.from(p.id.replaceAll('-',''),'hex').copy(b,o+400);
  ['x','y','z','heading','pitch','roll'].forEach((key,n)=>b.writeDoubleLE(t[key],o+16+n*8));b.writeUInt32LE(t.connected?3:1,o+64);b.writeUInt32LE(t.wheels.length,o+68);b.writeUInt32LE(index,o+392);b.writeUInt32LE(Math.max(0,Math.min(5000,Math.floor(p.animationAgeMs??0))),o+416);
  t.wheels.forEach((w,n)=>['rotation','velocity','steering','suspension','lift'].forEach((key,k)=>b.writeFloatLE(w[key],o+72+n*20+k*4)));
 });return b;
}

// Map positions include paused peers and bypass native vehicle creation limits.
export function mapPacket(status,sequence){
 const peers=status.connected?status.players.filter(p=>p.id!==status.id&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(p.id)&&validState(p.state)&&Number.isFinite(p.ageMs)&&p.ageMs>=0&&p.ageMs<=1000).slice(0,32):[];
 const b=Buffer.alloc(16+peers.length*72);b.write('HMM1');b.writeUInt32LE(sequence>>>0,4);b.writeUInt32LE(peers.length,8);b.writeUInt32LE(72,12);
 peers.forEach((p,i)=>{const o=16+i*72;Buffer.from(p.id.replaceAll('-',''),'hex').copy(b,o);['x','y','z','heading','pitch','roll'].forEach((k,j)=>b.writeDoubleLE(p.state[k],o+16+j*8));b.writeUInt32LE(Math.floor(p.ageMs),o+64);});return b;
}
