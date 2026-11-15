// The server owns this switch. Older servers/clients keep their no-collision mode.
export function collisionPacket(status, sequence) {
 const b=Buffer.alloc(16);b.write('HMCL');b.writeUInt32LE(sequence>>>0,4);
 b.writeUInt32LE(status.connected===true&&status.collisions===true?1:0,8);
 return b;
}
export function collisionSetting(value) {
 if(value===undefined)return true;
 if(typeof value==='boolean')return value;
 if(typeof value==='string'){
  const v=value.trim().toLowerCase();
  if(v==='true'||v==='1')return true;
  if(v==='false'||v==='0')return false;
 }
 throw new Error('PLAYER_COLLISIONS must be true or false (1 or 0).');
}
