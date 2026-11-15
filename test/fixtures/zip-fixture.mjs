import {deflateRawSync} from 'node:zlib';
function crc32(bytes){let c=0xffffffff;for(const byte of bytes){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
export function mapZip(entries){
 const local=[],central=[];let offset=0;
 for(const [name,input,method=0] of entries){const data=Buffer.from(input),path=Buffer.from(name),bytes=method===8?deflateRawSync(data):data,crc=crc32(data);
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(method,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(path.length,26);
  const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(method,10);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(bytes.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(path.length,28);entry.writeUInt32LE(offset,42);
  local.push(header,path,bytes);central.push(entry,path);offset+=header.length+path.length+bytes.length;
 }
 const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,index,end]);
}
