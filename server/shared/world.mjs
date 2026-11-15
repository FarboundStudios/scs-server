export function validWorld(w){
 if(!w||!Number.isFinite(w.minutes)||w.minutes<0||w.minutes>1e9||!Number.isFinite(w.timeScale)||w.timeScale<1||w.timeScale>60||![0,1].includes(w.weather)||!Number.isFinite(w.blend)||w.blend<0||w.blend>1)return null;
 return {minutes:w.minutes,timeScale:w.timeScale,weather:w.weather,blend:w.blend};
}
// Independent packet: an unknown world update cannot invalidate truck snapshots.
export function worldPacket(status,sequence){
 const w=status.connected&&status.worldCompatible?validWorld(status.world):null,b=Buffer.alloc(40);
 b.write('HMW1');b.writeUInt32LE(sequence>>>0,4);b.writeUInt32LE(w?1:0,8);
 if(w){b.writeDoubleLE(w.minutes,16);b.writeDoubleLE(w.timeScale,24);b.writeFloatLE(w.blend,32);b.writeUInt32LE(w.weather,36);}return b;
}
