
export const PROTOCOL = 1;
export const GAME_VERSION = '1.62.3.3s';
// Snapshots contain up to 32 truck/trailer pairs; ingress stays below 8 KiB.
export const MAX_LINE = 262144;
export const isLoopback = host => ['127.0.0.1', '::1'].includes(host);

export function port(value, fallback, allowZero = false) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > 65535) throw new Error('Invalid port');
  return n;
}


export function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 24 && /^[\p{L}\p{N} _.-]+$/u.test(name) ? name : null;
}

// Fixed layouts avoid allocating maps/closures for each wheel at high ingress rates.
const bounded=(v,min,max)=>Number.isFinite(v)&&v>=min&&v<=max;
const validPose=s=>s&&bounded(s.x,-1e7,1e7)&&bounded(s.y,-1e5,1e5)&&bounded(s.z,-1e7,1e7)&&bounded(s.heading,-10,10)&&bounded(s.pitch,-10,10)&&bounded(s.roll,-10,10);
function readWheels(input){if(!Array.isArray(input)||input.length>16)return null;const result=[];for(const w of input){if(!w||!bounded(w.rotation,0,1)||!bounded(w.velocity,-100,100)||!bounded(w.steering,-.25,.25)||!bounded(w.suspension,-2,2)||!bounded(w.lift,0,1))return null;result.push({rotation:w.rotation,velocity:w.velocity,steering:w.steering,suspension:w.suspension,lift:w.lift});}return result;}
function validTrailer(t){if(!validPose(t)||typeof t.connected!=='boolean')return null;const wheels=readWheels(t.wheels);return wheels?{x:t.x,y:t.y,z:t.z,heading:t.heading,pitch:t.pitch,roll:t.roll,connected:t.connected,wheels}:null;}
export function validState(s){
 if(!validPose(s)||typeof s.paused!=='boolean'||!bounded(s.speed,-150,150))return null;
 const state={x:s.x,y:s.y,z:s.z,heading:s.heading,pitch:s.pitch,roll:s.roll,speed:s.speed,paused:s.paused};
 if(s.truck!==undefined){const truck=validTruck(s.truck);if(!truck)return null;state.truck=truck;}
 if(s.trailer!==undefined){state.trailer=s.trailer===null?null:validTrailer(s.trailer);if(s.trailer!==null&&!state.trailer)return null;}
 if(s.trailers!==undefined){if(!Array.isArray(s.trailers)||s.trailers.length>10)return null;state.trailers=[];for(const t of s.trailers){const trailer=validTrailer(t);if(!trailer)return null;state.trailers.push(trailer);}state.trailer=state.trailers[0]??null;}return state;
}
export function validTruck(t){
 if(!t||typeof t!=='object'||Array.isArray(t)||!Number.isInteger(t.lights)||t.lights<0||t.lights>0xffffffff)return null;const wheels=readWheels(t.wheels),c=t.controls;
 if(!wheels||!c||typeof c.engine!=='boolean'||typeof c.parkingBrake!=='boolean'||typeof c.wipers!=='boolean'||!bounded(c.rpm,0,10000)||!Number.isInteger(c.gear)||c.gear< -30||c.gear>30||!bounded(c.brake,0,1)||!bounded(c.throttle,0,1)||!bounded(c.steering,-1,1))return null;
 const controls={engine:c.engine,parkingBrake:c.parkingBrake,wipers:c.wipers,rpm:c.rpm,gear:c.gear,brake:c.brake,throttle:c.throttle,steering:c.steering};
 if(c.wiperPhase!==undefined){if(!bounded(c.wiperPhase,0,1)||!bounded(c.rearWiperPhase,0,1)||!Number.isInteger(c.wiperMode)||c.wiperMode<0||c.wiperMode>16)return null;controls.wiperPhase=c.wiperPhase;controls.rearWiperPhase=c.rearWiperPhase;controls.wiperMode=c.wiperMode;}
 const identity={brand:t.identity?.brand??'',model:t.identity?.model??'',plate:t.identity?.plate??''};for(const v of [identity.brand,identity.model,identity.plate])if(typeof v!=='string'||v.length>64||/[\u0000-\u001f]/.test(v))return null;
 const result={wheels,lights:t.lights,controls,identity};
 if(t.audio!==undefined){if(!Array.isArray(t.audio)||t.audio.length!==3)return null;for(const v of t.audio)if(typeof v!=='string'||v!==''&&(v.length>240||!/^\/def\/vehicle\/truck\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.soundref$/i.test(v)||v.includes('..')))return null;result.audio=[...t.audio];}
 if(t.horn!==undefined){if(!t.horn||typeof t.horn.normal!=='boolean'||typeof t.horn.air!=='boolean')return null;result.horn={normal:t.horn.normal,air:t.horn.air};}return result;
}

export function sendSerialized(socket,line) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  if (Math.max(socket.writableLength??0,socket.transportBuffered??0) > 262144) { socket.destroy(); return false; }
  if (Math.max(socket.writableLength??0,socket.transportBuffered??0) > 65536) return false;
  socket.write(line + "\n"); return true;
}

export function send(socket, message) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  if (Math.max(socket.writableLength??0,socket.transportBuffered??0) > 262144) { socket.destroy(); return false; }
  if (Math.max(socket.writableLength??0,socket.transportBuffered??0) > 65536) return false;
  socket.write(JSON.stringify(message) + '\n');
  return true;
}

// Length is counted in bytes, including incomplete frames and UTF-8 sequences.
export function readLines(socket, onMessage, maxBytes = MAX_LINE) {
  let pending = Buffer.alloc(0);
  socket.on('data', chunk => {
    let start = 0;
    while (start < chunk.length && !socket.destroyed) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (pending.length + end - start > maxBytes) { socket.destroy(); return; }
      const part = chunk.subarray(start, end);
      pending = pending.length ? Buffer.concat([pending, part]) : Buffer.from(part);
      if (newline < 0) return;
      let value;
      try { value = JSON.parse(pending.toString('utf8')); }
      catch { socket.destroy(); return; }
      pending = Buffer.alloc(0);
      if (!value || Array.isArray(value) || typeof value !== 'object') { socket.destroy(); return; }
      onMessage(value);
      start = newline + 1;
    }
  });
}
