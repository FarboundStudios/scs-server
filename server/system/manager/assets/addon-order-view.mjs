const slotKey = ({source, match}) => source + ':' + match.toLowerCase();
export const optionalDownloadUrlLimit=512;

export function validateOptionalDownloadLink(value){
 const text=value.trim();
 if(!text)return '';
 const url=URL.parse(text);
 if(url?.protocol!=='https:'||url.username||url.password||url.href.length>optionalDownloadUrlLimit)throw Error('Enter an HTTPS link without credentials.');
 return url.href;
}

export function mixedOrder({order, optional = []}) {
 const names = new Set(order);
 const below = optional.filter(slot=>!names.has(slot.after));
 const after = name=>optional.filter(slot=>slot.after===name);
 const rows = slots=>slots.map(slot=>({key:'optional:'+slotKey(slot),slot}));
 // The game mounts low priority first. Display the same top-first priority as SCS Mod Manager.
 return [...rows(below),...order.flatMap(name=>[{key:'shared:'+name,name},...rows(after(name))])].reverse();
}

export function storeMixedOrder(draft, rows) {
 let previous = null;
 draft.order = [];
 draft.optional = [];
 for(const row of [...rows].reverse()){
  if(row.slot)draft.optional.push({...row.slot,after:previous});
  else{previous=row.name;draft.order.push(previous);}
 }
}

export function optionalRow(row, {esc, editable, index, total}) {
 const {name,source,match,downloadUrl}=row.slot;
 const actions=editable?'<div class="row-actions">'+
  '<button type="button" class="button small" data-move-row="'+esc(row.key)+'" data-dir="-1" aria-label="Move '+esc(name)+' up" '+(index===0?'disabled':'')+'>↑</button>'+
  '<button type="button" class="button small" data-move-row="'+esc(row.key)+'" data-dir="1" aria-label="Move '+esc(name)+' down" '+(index===total-1?'disabled':'')+'>↓</button>'+
  (source==='local'?'<button type="button" class="button small" data-edit-slot-link="'+esc(row.key)+'">'+(downloadUrl?'Edit download link':'Add download link')+'</button>':'')+
  '<button type="button" class="button small" data-remove-slot="'+esc(row.key)+'">Remove slot</button></div>':'';
 return '<tr data-order-row="'+esc(row.key)+'" draggable="'+editable+'"><td><strong>'+esc(name)+'</strong><small>'+
  esc(source==='workshop'?'Steam Workshop '+match:match)+'</small></td><td>Player copy</td>'+
  '<td><span class="badge">OPTIONAL SLOT</span></td><td>'+actions+'</td></tr>';
}

export function newSlotForm(editable) {
 if(!editable)return '';
 return '<form id="optional-slot-form" class="panel-body backup-create-form">'+
  '<label>Display name (label only)<input name="name" maxlength="100" required placeholder="Example Paint Pack"></label>'+
  '<label>Source<select name="source"><option value="local">Local archive or folder</option><option value="workshop">Steam Workshop</option></select></label>'+
  '<label>Exact filename, folder name, or Workshop ID<input name="match" maxlength="184" required placeholder="For a file, include .scs or .zip"></label>'+
  '<label data-optional-download>Download link (optional)<input name="downloadUrl" type="url" maxlength="'+optionalDownloadUrlLimit+'" placeholder="https://"></label>'+
  '<button class="button primary">Add optional slot</button></form>'+
  '<form id="optional-bulk-form" class="panel-body backup-create-form">'+
  '<label class="file-drop">Choose archives for optional slots<input id="optional-files" type="file" accept=".scs,.zip" multiple required></label>'+
  '<p>Only filenames are used. Players supply their own copies.</p>'+
  '<button class="button">Add optional slots</button></form>';
}

export function addOptionalSlot(rows, slot, index = rows.length) {
 const key='optional:'+slotKey(slot);
 if(rows.some(row=>row.key===key))return false;
 rows.splice(index,0,{key,slot});
 return true;
}

export function addLocalArchiveSlots(rows, filenames) {
 let added=0;
 const skipped=[];
 let count=rows.filter(row=>row.slot).length;
 for(const match of filenames){
  const valid=match.length<=184&&/^[\p{L}\p{N}][^/\\:\u0000-\u001f\u007f]*\.(?:scs|zip)$/iu.test(match);
  const name=match.slice(0,-4).trim().slice(0,100);
  if(valid&&count<100&&addOptionalSlot(rows,{name,source:'local',match})){
   count++;
   added++;
  }else skipped.push(match);
 }
 return {added,skipped};
}

const skippableUploadErrors=new Set(['invalid_addon_name','addon_exists','upload_too_large','invalid_archive']);

export async function uploadAddonBatch(files, initialData, send, report) {
 let data=initialData;
 const uploaded=[],failed=[];
 const total=files.reduce((sum,file)=>sum+file.size,0);
 let complete=0;
 for(const [index,file] of files.entries()){
  const progress=(loaded,checking=false)=>report({
   file,index,totalFiles:files.length,percent:total?100*(complete+loaded)/total:0,checking,
  });
  progress(0);
  try{
   if(file.size>data.maxUpload)throw Error('upload_too_large');
   data=await send(file,data.revision,progress);
   uploaded.push(file.name);
  }catch(error){
   failed.push({name:file.name,code:error.message});
   if(!skippableUploadErrors.has(error.message))break;
  }
  complete+=file.size;
 }
 return {data,uploaded,failed,remaining:files.length-uploaded.length-failed.length};
}
