const clean=(value,max,bytes,allowBrackets=false)=>typeof value==='string'&&value.length>0&&value.length<=max&&Buffer.byteLength(value)<=bytes&&!/[\u0000-\u001f\u007f]/.test(value)&&(allowBrackets||!/[\[\]]/.test(value));
export function vtcColor(value){
 if(typeof value!=='string')return '#6fc690';const text=value.trim().toLowerCase();
 if(/^#[0-9a-f]{6}$/.test(text))return text;
 if(/^#[0-9a-f]{3}$/.test(text))return '#'+[...text.slice(1)].map(c=>c+c).join('');
 if(/^#[0-9a-f]{8}$/.test(text))return text.slice(0,7);
 const rgb=/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(text);
 if(rgb&&rgb.slice(1).every(c=>+c<=255))return '#'+rgb.slice(1).map(c=>(+c).toString(16).padStart(2,'0')).join('');
 return '#6fc690';
}
export function validVtcCompany(value){
 if(!value||typeof value.id!=='string'||!/^[a-zA-Z0-9_-]{1,96}$/.test(value.id)||!clean(value.name,80,160,true))return null;
 const normalized=clean(value.tag,24,60)?value.tag.normalize('NFC').trim():'';
 const tag=clean(normalized,24,60)?normalized:'';
 return {id:value.id,name:value.name,tag,tagColor:vtcColor(value.tagColor),owner:value.owner===true};
}
export function validChatVtc(value){
 if(!value||!clean(value.tag,24,60))return null;
 const tag=value.tag.normalize('NFC').trim();if(!clean(tag,24,60))return null;
 return {tag,color:vtcColor(value.color)};
}
