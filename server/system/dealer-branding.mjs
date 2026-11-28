import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {crc32,deflateRawSync} from 'node:zlib';
import {readJson} from './manager/storage.mjs';
import {GAME_VERSION} from '../shared/protocol.mjs';

export const DEALER_ICON_SIZE=512;
export const DEALER_ICON_BYTES=DEALER_ICON_SIZE**2*4;
export const DEFAULT_DEALER_NAME='HeavyMP';
export const dealerBrandingSupported=env=>GAME_VERSION==='1.62.3.3s'&&!env.MAP_MANIFEST;
export const dealerBrandingFile=directory=>join(directory,'manager','dealer-branding.json');
const namePattern=/^[\p{L}\p{N}][\p{L}\p{N} ._&()'\-]{0,23}$/u;

export function dealerName(value){
 if(typeof value!=='string'||!namePattern.test(value.trim()))throw Error('invalid_dealer_name');
 return value.trim();
}

export async function readDealerBranding(directory){
 const entry=await readJson(dealerBrandingFile(directory),{schema:1,name:DEFAULT_DEALER_NAME,icon:null},Math.ceil(DEALER_ICON_BYTES/3)*4+256);
 if(entry?.schema!==1||entry.icon!==null&&typeof entry.icon!=='string')throw Error('invalid_dealer_branding');
 const icon=entry.icon===null?null:Buffer.from(entry.icon,'base64');
 if(icon&&icon.length!==DEALER_ICON_BYTES)throw Error('invalid_dealer_branding');
 return {name:dealerName(entry.name),icon};
}

const category=(id,icon,name,links,extra='')=>[
 `ui_desktop_menu_bar_category : .${id} {`,` icon: "${icon}"`,` name: "${name}"`,
 ` column_count: ${id==='heavymp'?1:2}`,
 ...links.map(link=>` screen_links[]: "${link}"`),extra,'}', '',
].join('\n');

// ETS2 1.62's full desktop categories. Keep the stock localization keys and
// screen links when replacing the HeavyMP tile in the two full menu layouts.
const stock=[
 ['jobs','job_market','jobs',['jobs.company','jobs.online','jobs.cargo.market','jobs.external.market.online','jobs.quick'],' screen_link_actions[]: "cancel_job"\n'.repeat(5).trimEnd()],
 ['maps','navigation','map',['screen.map','screen.quick.travel']],
 ['online','community','social',['convoy.selector','convoy.current.session']],
 ['personal','personal','personal',['screen.skills','career.progress']],
 ['fleet','fleet','company',['screen.truckman','screen.trailerman','screen.driverman','screen.garageman','screen.mail']],
 ['services','services','services',['truck.dealer_map','trailer.eshop','truck.eshop.used_trucks','screen.real_estate','screen.bank','screen.recruit_map','truck.diag']],
 ['browsers','content_browser','content_browsers',['company.browser','screen.trailers','truck.browser','trailer.browser','truck.upgrades','trailer.upgrades','profile.dlc_browser.selector']],
 ['media','photo_music','media',['screen.photo_album','lscr.browser','screen.scrshot_cam','misc.radio'],
  ' screen_link_actions[]: ""\n screen_link_action_params[]: ""\n'.repeat(2)+' screen_link_actions[]: "photo_mode"\n screen_link_action_params[]: "0"'],
].map(([id,icon,name,links,extra])=>category(id,icon,'@@desktop_menu_category_'+name+'@@',links,extra)).join('\n');

const include='@include "hvmp_dealer_full_menu.sui"\n@include "ui_quit_config.sui"\n';
const burger='SiiNunit\n{\n'+include+'}\n';
const desktop='SiiNunit\n{\n'+
 // SII includes must start at column zero, even inside a category.
 'ui_desktop_menu_bar_category : .vehicle_desk {\n type: menu\n alignment: left\n icon: switch_truck\n name: "@@truck_mode@@"\n tooltip_location: right\n column_count: 1\n@include "ui_desktop_vehicle_mode_links.sui"\n}\n'+
 'ui_desktop_menu_bar_category : .drive {\n type: no_menu\n icon: drive\n name: "@@drive@@"\n action_ivalue: 100\n tooltip: "@@drive_tooltip@@"\n}\n'+
 'ui_desktop_menu_bar_category : .separator1 {\n type: separator\n}\n@include "hvmp_dealer_full_menu.sui"\n'+
 'ui_desktop_menu_bar_category : .separator2 {\n type: separator\n}\n@include "ui_quit_config.sui"\n}\n';

function fitDealerIcon(rgba){
 const edge=DEALER_ICON_SIZE;
 let left=edge,top=edge,right=-1,bottom=-1;
 for(let y=0;y<edge;y++)for(let x=0;x<edge;x++){
  if(rgba[(y*edge+x)*4+3]<=24)continue;
  left=Math.min(left,x);top=Math.min(top,y);
  right=Math.max(right,x);bottom=Math.max(bottom,y);
 }
 if(right<0)return rgba;
 // Keep the antialiased fringe while ignoring stray, almost transparent pixels.
 left=Math.max(0,left-1);top=Math.max(0,top-1);
 right=Math.min(edge-1,right+1);bottom=Math.min(edge-1,bottom+1);
 const width=right-left+1,height=bottom-top+1,scale=(edge-8)/Math.max(width,height);
 const fittedWidth=Math.round(width*scale),fittedHeight=Math.round(height*scale);
 const xOffset=Math.floor((edge-fittedWidth)/2),yOffset=Math.floor((edge-fittedHeight)/2);
 const result=Buffer.alloc(rgba.length);
 for(let y=0;y<fittedHeight;y++){
  const sourceY=Math.max(top,Math.min(bottom,top+(y+0.5)*height/fittedHeight-0.5));
  const y0=Math.floor(sourceY),y1=Math.min(bottom,y0+1),dy=sourceY-y0;
  for(let x=0;x<fittedWidth;x++){
   const sourceX=Math.max(left,Math.min(right,left+(x+0.5)*width/fittedWidth-0.5));
   const x0=Math.floor(sourceX),x1=Math.min(right,x0+1),dx=sourceX-x0;
   const p00=(y0*edge+x0)*4,p10=(y0*edge+x1)*4,p01=(y1*edge+x0)*4,p11=(y1*edge+x1)*4;
   // Interpolate premultiplied color so transparent edges retain their original color.
   const w00=(1-dx)*(1-dy)*rgba[p00+3],w10=dx*(1-dy)*rgba[p10+3];
   const w01=(1-dx)*dy*rgba[p01+3],w11=dx*dy*rgba[p11+3];
   const alpha=w00+w10+w01+w11;
   if(alpha<0.5)continue;
   const target=((y+yOffset)*edge+x+xOffset)*4;
   result[target+3]=Math.round(alpha);
   for(let channel=0;channel<3;channel++){
    result[target+channel]=Math.round((w00*rgba[p00+channel]+w10*rgba[p10+channel]+w01*rgba[p01+channel]+w11*rgba[p11+channel])/alpha);
   }
  }
 }
 return result;
}

function dealerDds(rgba){
 const texture=Buffer.alloc(128+rgba.length);
 texture.write('DDS ');
 for(const [offset,value] of [[4,124],[8,0x100f],[12,DEALER_ICON_SIZE],[16,DEALER_ICON_SIZE],[20,DEALER_ICON_SIZE*4],
  [76,32],[80,0x41],[88,32],[92,0xff0000],[96,0xff00],[100,0xff],[104,0xff000000],[108,0x1000]])texture.writeUInt32LE(value,offset);
 for(let i=0;i<rgba.length;i+=4){
  texture[i+128]=rgba[i+2];
  texture[i+129]=rgba[i+1];
  texture[i+130]=rgba[i];
  texture[i+131]=rgba[i+3];
 }
 return texture;
}

function zip(entries){
 const records=[],index=[];
 let offset=0;
 for(const [filename,content] of entries){
  const name=Buffer.from(filename),data=Buffer.from(content),compressed=deflateRawSync(data);
  const local=Buffer.alloc(30),central=Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);
  local.writeUInt32LE(crc32(data),14);local.writeUInt32LE(compressed.length,18);
  local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);local.copy(central,6,4);
  central.writeUInt32LE(offset,42);
  records.push(local,name,compressed);index.push(central,name);
  offset+=local.length+name.length+compressed.length;
 }
 const directory=Buffer.concat(index),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
 end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...records,directory,end]);
}

export function dealerBrandingArchive({name,icon}){
 name=dealerName(name);
 if(name===DEFAULT_DEALER_NAME&&!icon)return null;
 if(icon&&(!Buffer.isBuffer(icon)||icon.length!==DEALER_ICON_BYTES))throw Error('invalid_dealer_branding');
 const iconId=icon?'hvmp_dealer_brand':'heavymp';
 const entries=[
  ['def/ui_desktop_ind_full.sii',desktop],
  ['def/ui_desktop_burger_menu_ind_full.sii',burger],
  ['def/hvmp_dealer_full_menu.sui',category('heavymp',iconId,name,['truck.mod_dealer'])+stock],
 ];
 if(icon){
  const texturePath=Buffer.from('/material/ui/hvmp_dealer_brand.dds');
  const tobj=Buffer.from('010ab1700000000000000000000000000000000001000000020003030300020200000000000100000000000000000000','hex');
  tobj.writeUInt32LE(texturePath.length,40);
  const material='effect : "ui.rfx" {\n texture : "texture" {\n source : "/material/ui/hvmp_dealer_brand.tobj"\n u_address : clamp\n v_address : clamp\n mip_filter : none\n }\n}\n';
  entries.push(
   ['material/ui/desktop/'+iconId+'.mat',material],
   ['material/ui/link/'+iconId+'.mat',material],
   ['material/ui/hvmp_dealer_brand.tobj',Buffer.concat([tobj,texturePath])],
   ['material/ui/hvmp_dealer_brand.dds',dealerDds(fitDealerIcon(icon))],
  );
 }
 const bytes=zip(entries),sha256=createHash('sha256').update(bytes).digest('hex');
 return {name:'hvmp-dealer-'+sha256.slice(0,24)+'.scs',sha256,size:bytes.length,bytes};
}
