import {cleanName,validState} from './protocol.mjs';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const validPeerPing=value=>Number.isFinite(value)&&value>=0&&value<=60000?Math.round(value):null;
// UI metadata travels separately from vehicle poses/configurations. No Steam
// identity is fabricated: the reserved SteamID field stays empty during dev.
export function nearbyPlayersPacket(status,sequence){
 const local=validState(status.localState);
 const players=status.connected?status.players.filter(p=>p.id!==status.id&&uuid(p.id)&&cleanName(p.name)&&validState(p.state)&&Number.isFinite(p.ageMs)&&p.ageMs>=0&&p.ageMs<=1500).slice(0,32):[];
 const stride=192,b=Buffer.alloc(16+players.length*stride);b.write('HMP1');b.writeUInt32LE(sequence>>>0,4);b.writeUInt32LE(players.length,8);b.writeUInt32LE(stride,12);
 players.forEach((p,i)=>{const o=16+i*stride;Buffer.from(p.id.replaceAll('-',''),'hex').copy(b,o);b.write(cleanName(p.name),o+16,96,'utf8');b.writeInt32LE(validPeerPing(p.pingMs)??-1,o+136);
  b.writeFloatLE(local?Math.hypot(p.state.x-local.x,p.state.z-local.z):-1,o+140);
  ['x','y','z'].forEach((key,j)=>b.writeDoubleLE(p.state[key],o+144+j*8));
  const identity=JSON.stringify(p.state.truck?.identity??{}),escort=/heavymp\.escort|transporter|t6 escorte/i.test(identity),car=/heavymp.megane|heavymp.sedan|megane|police/i.test(identity);b.writeFloatLE(escort?2.65:car?2.05:4.4,o+168);
 });return b;
}
