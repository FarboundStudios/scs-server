import {managerApi,selectedInstance} from './instance-api.mjs';
import {confirmAction} from './admin-ui.mjs';

const inputLimit=8*1024*1024;
const errors={invalid_server_logo:'Choose a valid PNG, JPEG, or WebP image.',logo_too_large:'That image is too large.',logo_png_required:'Choose a PNG, JPEG, or WebP image.'};

export function createServerPageEditor({api}){
 const panel=document.querySelector('#launcher-server-page');
 const form=panel.querySelector('form'),message=form.querySelector('[role="status"]');
 const fields=[...form.elements].filter(field=>field.name);
 let view=0;
 const enable=enabled=>{for(const field of form.elements)field.disabled=!enabled;};
 const show=data=>{for(const field of fields)field.value=data[field.name]??'';};
 const tell=text=>{message.textContent=text;message.hidden=!text;};
 form.onsubmit=async event=>{
  event.preventDefault();
  const generation=view,data=Object.fromEntries(new FormData(form));
  enable(false);
  tell('');
  try{
   const saved=await api('branding/page',data);
   if(generation!==view)return;
   show(saved);
   tell('Server page saved.');
  }catch(error){
   if(generation===view)tell(error.message==='invalid_server_page'
    ?'Use HTTPS links, valid Discord and WhatsApp URLs, and shorter text if a field is full.'
    :'The server page could not be saved.');
  }finally{if(generation===view)enable(true);}
 };
 return async visible=>{
  const instance=selectedInstance??'';
  if(panel.hidden===!visible&&(!visible||panel.dataset.instance===instance))return;
  const generation=++view;
  panel.hidden=!visible;
  if(!visible)return;
  panel.dataset.instance=instance;
  enable(false);
  show({});
  tell('');
  try{
   const data=await api('branding/page');
   if(generation!==view)return;
   show(data);
   enable(true);
  }catch{
   if(generation===view){
    delete panel.dataset.instance;
    tell('The server page could not be loaded. Reopen Settings to try again.');
   }
  }
 };
}

async function pictureCanvas(file,edge,padding=0){
 if(file.size>inputLimit)throw Error('logo_too_large');
 if(!(file.type?['image/png','image/jpeg','image/webp'].includes(file.type):/\.(png|jpe?g|webp)$/i.test(file.name)))throw Error('invalid_server_logo');
 let image;
 try{image=await createImageBitmap(file);}catch{throw Error('invalid_server_logo');}
 try{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=edge;
  const scale=(edge-padding*2)/Math.max(image.width,image.height),w=image.width*scale,h=image.height*scale;
  const context=canvas.getContext('2d');
  context.drawImage(image,(edge-w)/2,(edge-h)/2,w,h);
  return canvas;
 }finally{image.close();}
}

export function createServerPicture({api,getCsrf,write}){
 const panel=document.querySelector('#server-picture');
 const form=panel.querySelector('form'),file=form.querySelector('input'),save=form.querySelector('[type="submit"]');
 const remove=panel.querySelector('[data-remove-picture]'),preview=panel.querySelector('img');
 const placeholder=panel.querySelector('[data-picture-placeholder]'),message=panel.querySelector('[role="status"]');
 let hash=null,view=0,busy=false;
 function showMessage(text,error=false){message.textContent=text;message.classList.toggle('error',error);message.hidden=!text;}
 function reflect(){save.disabled=busy||!file.files.length;file.disabled=busy;remove.disabled=busy||!hash;}
 function showPicture(value){
  hash=value;preview.hidden=!hash;placeholder.hidden=Boolean(hash);
  if(hash)preview.src=managerApi('branding/logo?version='+hash);else preview.removeAttribute('src');
  reflect();
 }
 function savePicture(update,success){
  if(busy)return;
  busy=true;reflect();showMessage('');
  const generation=view;
  return write(async()=>{
   try{
    const {logo}=await update();
    if(generation!==view)return;
    form.reset();showPicture(logo);showMessage(success);
   }catch(error){if(generation===view)showMessage(errors[error.message]??'The picture could not be saved. Try again.',true);}
   finally{busy=false;reflect();}
  });
 }
 file.onchange=()=>{showMessage('');reflect();};
 form.onsubmit=event=>{
  event.preventDefault();const chosen=file.files[0];if(!chosen)return;
  const target=managerApi('branding/logo');
  void savePicture(async()=>{
   const canvas=await pictureCanvas(chosen,256);
   const blob=await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('invalid_server_logo')),'image/png'));
   const reply=await fetch(target,{method:'POST',headers:{'content-type':'image/png','x-hvmp-csrf':getCsrf()},body:blob,signal:AbortSignal.timeout(15000)});
   const value=await reply.json();if(!reply.ok)throw Error(value.error);
   return value;
  },'Profile picture saved.');
 };
 remove.onclick=async()=>{
  const instance=selectedInstance;
  if(await confirmAction('Remove this server’s picture?','The launcher will show the default server icon.',false)&&instance===selectedInstance)
   await savePicture(()=>api('branding/remove',{confirm:true}),'Profile picture removed.');
 };
 return async visible=>{
  if(panel.hidden===!visible&&(!visible||panel.dataset.instance===(selectedInstance??'')))return;
  const generation=++view;
  panel.hidden=!visible;
  if(!visible)return;
  panel.dataset.instance=selectedInstance??'';form.reset();showPicture(null);showMessage('');
  try{const {logo}=await api('branding');if(generation===view)showPicture(logo);}
  catch{if(generation===view)showMessage('The server picture could not be loaded. You can still upload a new one.',true);}
 };
}

export function createDealerPicture({api,getCsrf,write}){
 const panel=document.querySelector('#dealer-picture'),form=panel.querySelector('form');
 const name=form.elements.name,file=form.elements.icon,remove=form.elements.removeIcon;
 const note=panel.querySelector('[role="status"]');
 let view=0,hasIcon=false,busy=false,supported=false;
 function tell(text,error=false){note.textContent=text;note.classList.toggle('error',error);note.hidden=!text;}
 function reflect(){
  name.disabled=file.disabled=form.querySelector('button').disabled=busy||!supported;
  remove.disabled=busy||!supported||!hasIcon||Boolean(file.files.length);
 }
 function show(data){
  supported=data.supported;
  hasIcon=data.hasIcon;
  form.reset();
  name.value=data.name;
  panel.querySelector('[data-dealer-icon-state]').textContent=hasIcon?'Custom icon saved.':'Using the HeavyMP icon.';
  reflect();
 }
 file.onchange=()=>{if(file.files.length)remove.checked=false;reflect();};
 form.onsubmit=event=>{
  event.preventDefault();
  if(!supported||busy)return;
  const icon=file.files[0],label=name.value.trim()||'HeavyMP';
  const target=managerApi('branding/dealer?'+new URLSearchParams({name:label,icon:icon?'replace':remove.checked?'remove':'keep'}));
  const generation=view;
  busy=true;reflect();tell('');
  void write(async()=>{
   try{
    let pixels;
    if(icon){
     const canvas=await pictureCanvas(icon,512,32);
     pixels=canvas.getContext('2d').getImageData(0,0,512,512).data;
    }
    const reply=await fetch(target,{method:'POST',headers:{'content-type':'application/octet-stream','x-hvmp-csrf':getCsrf()},body:pixels,signal:AbortSignal.timeout(15000)});
    const data=await reply.json();
    if(!reply.ok)throw Error(data.error);
    if(generation===view){show(data);tell('Dealer branding saved. Restart the server to publish it.');}
   }catch(error){
    if(generation===view)tell(errors[error.message]??(error.message==='invalid_dealer_name'?'Use up to 24 letters, numbers, spaces or common punctuation. Start with a letter or number.':'Dealer branding could not be saved.'),true);
   }finally{busy=false;reflect();}
  });
 };
 return async visible=>{
  if(panel.hidden===!visible&&(!visible||panel.dataset.instance===(selectedInstance??'')))return;
  const generation=++view;
  panel.hidden=!visible;
  if(!visible)return;
  panel.dataset.instance=selectedInstance??'';
  show({name:'HeavyMP',hasIcon:false,supported:false});tell('');
  try{
   const data=await api('branding/dealer');
   if(generation===view){
    show(data);
    if(!data.supported)tell('Requires the supported ETS2 build and the automatic addon library.');
   }
  }catch{if(generation===view)tell('Dealer branding could not be loaded.',true);}
 };
}
