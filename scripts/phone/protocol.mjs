export const phoneNumber=value=>typeof value==='string'&&/^(?=.{2,16}$)\d{2,8}(?:-\d{1,8})?$/.test(value)?value:null;
export const phoneText=value=>typeof value==='string'&&value.trim().length>0&&value.length<=500&&!/[\u0000-\u001f\u007f]/.test(value)?value.normalize('NFC').trim():null;
export const requestId=value=>typeof value==='string'&&/^[a-z0-9-]{16,64}$/i.test(value)?value:null;
export function iceServers(value){
 const list=typeof value==='string'?JSON.parse(value):value??[{urls:'stun:stun.l.google.com:19302'}];
 if(!Array.isArray(list)||list.length>8)throw Error('PHONE_ICE_SERVERS accepts up to 8 servers');
 return list.map(item=>{const urls=Array.isArray(item?.urls)?item.urls:[item?.urls];if(!urls.length||urls.length>4||urls.some(u=>typeof u!=='string'||u.length>240||!/^turns?:[^\s]+$|^stuns?:[^\s]+$/.test(u)))throw Error('Invalid STUN/TURN URL');const result={urls};for(const k of ['username','credential'])if(item[k]!==undefined){if(typeof item[k]!=='string'||item[k].length>512)throw Error('Invalid TURN credentials');result[k]=item[k];}return result;});
}
