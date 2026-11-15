export function validServers(value){
 if(!Array.isArray(value)||!value.length||value.length>32)throw Error('The local registry must list between 1 and 32 servers.');
 const ids=new Set();
 return value.map(s=>{
  if(!s||typeof s.id!=='string'||!/^[a-z0-9_-]{1,32}$/.test(s.id)||ids.has(s.id)||typeof s.name!=='string'||!s.name.trim()||s.name.length>80||typeof s.host!=='string'||!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(s.host)||!Number.isInteger(s.port??443)||(s.port??443)<1||(s.port??443)>65535)throw Error('Invalid server or duplicate ID.');
  ids.add(s.id);return {id:s.id,name:s.name.trim(),host:s.host.toLowerCase(),port:s.port??443};
 });
}
export const DEFAULT_SERVERS=[{id:'community',name:'HeavyMP Community Server',host:'localhost',port:443}];

export function communityServer(env=process.env){
 return validServers([{
  id:env.SERVER_ID?.trim()||'community',
  name:env.SERVER_NAME?.trim()||'HeavyMP Community Server',
  host:env.PUBLIC_HOST?.trim()||'localhost',
  port:Number(env.PUBLIC_PORT??443),
 }])[0];
}
