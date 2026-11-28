export const DISCOVERY_PATH='/manager/api/public/v1/server';
export const DISCOVERY_SCHEMA=1;
export const OPTIONAL_ALLOWLIST_HEADER='x-heavymp-optional-allowlist';
export const acceptsOptionalAllowlist=headers=>headers?.[OPTIONAL_ALLOWLIST_HEADER]==='1';
export const SERVER_LOGO_PATH='/manager/api/public/v1/logo/';
export const SERVER_LOGO_LIMIT=320*1024;
export const validLogoHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function validLogoPng(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<45||bytes.length>SERVER_LOGO_LIMIT||
    bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.readUInt32BE(8)!==13||
    bytes.toString('ascii',12,16)!=='IHDR'||bytes.subarray(-12).toString('hex')!=='0000000049454e44ae426082')return false;
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
 return width>=1&&height>=1&&width<=256&&height<=256;
}
export const optionalModsEnabled=env=>['true','1'].includes(String(env.ALLOW_OPTIONAL_MODS??'').trim().toLowerCase());
