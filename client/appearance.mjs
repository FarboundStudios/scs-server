import { validAppearance,appearanceHash } from '../server/shared/appearance.mjs';
export function appearancePacket(id,input,trailer=false){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))return null;
 const a=validAppearance(input,trailer);if(!a)return null;
 const plate=Buffer.from(a.plate),header=Buffer.alloc(60),pieces=[header,plate];
 header.write(trailer?'HMC2':'HMC1');Buffer.from(id.replaceAll('-',''),'hex').copy(header,4);Buffer.from(appearanceHash(a),'hex').copy(header,20);
 header.writeUInt32LE(a.accessories.length,52);header.writeUInt16LE(plate.length,56);
 for(const item of a.accessories){
  const path=Buffer.from(item.path),text=Buffer.from(item.text??''),tokens=item.tokens??[],hookups=item.hookups??[];
  const length=item.kind===3?16:item.kind===4?72:item.kind===5?12:item.kind===7?60:0,payload=Buffer.alloc(length),head=Buffer.alloc(12);
  if(item.kind===3){payload.writeUInt32LE(item.flags);item.colors.forEach((v,i)=>payload.writeFloatLE(v,4+i*4));}
  else item.colors?.forEach((v,i)=>payload.writeFloatLE(v,i*4));
  if(item.kind===7){payload.writeBigUInt64LE(BigInt('0x'+item.cargoId));Buffer.from(item.cargoParams,'hex').copy(payload,8);}
  head.writeUInt8(item.kind);head.writeUInt16LE(path.length,2);head.writeUInt16LE(text.length,4);head.writeUInt16LE(tokens.length,6);head.writeUInt16LE(hookups.length,8);head.writeUInt16LE(length,10);
  pieces.push(head,path,text,payload);
  for(const token of tokens){const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt('0x'+token));pieces.push(b);}
  for(const hookup of hookups){const b=Buffer.from(hookup),size=Buffer.alloc(2);size.writeUInt16LE(b.length);pieces.push(size,b);}
 }
 const result=Buffer.concat(pieces);return result.length<=60000?result:null;
}
