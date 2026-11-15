export function staffOnlySetting(value=false){
 if(typeof value==='boolean')return value;
 if(typeof value==='string'){
  const normalized=value.trim().toLowerCase();
  if(normalized==='true'||normalized==='1')return true;
  if(normalized==='false'||normalized==='0')return false;
 }
 throw Error('STAFF_ONLY must be true or false (1 or 0).');
}

export function staffIdentities(value=''){
 const list=value.split(',').map(token=>token.trim().toLowerCase()).filter(Boolean);
 if(list.length>100||list.some(token=>!/^[a-f0-9]{64}$/.test(token)))throw Error('STAFF_IDENTITIES must contain up to 100 client fingerprints.');
 return [...new Set(list)];
}
