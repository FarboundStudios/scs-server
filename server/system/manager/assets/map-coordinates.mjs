// Public ETS2 1.61 tile export used by ets2.online/map/ets2, checked 2026-11-05.
// World x/z and image pixels share the same east/right, south/down axes.
export const DEFAULT_MAP=Object.freeze({schema:1,name:'ETS2 1.61',tiles:'https://ets2.online/map/ets2map_161/{z}/{x}/{y}.png',tileSize:256,minZoom:2,maxZoom:8,imageSize:65536,bounds:{minX:-113177.313,maxX:97925.625,minZ:-122648.086,maxZ:88454.85},attribution:'Road map: ETS2.online · game data: SCS Software',attributionUrl:'https://ets2.online/map/ets2',cities:true});
export function validateMap(input={}){const c={...DEFAULT_MAP,...input,bounds:{...DEFAULT_MAP.bounds,...input.bounds}};
 if(c.schema!==1||typeof c.name!=='string'||c.name.length>80||typeof c.tiles!=='string'||c.tiles.length>2048)throw Error('invalid_map_config');
 for(const key of ['z','x','y'])if(c.tiles.split('{'+key+'}').length!==2)throw Error('invalid_map_config');
 const url=new URL(c.tiles.replace(/\{[zxy]\}/g,'0'));if(url.protocol!=='https:'||url.username||url.password||url.hash)throw Error('invalid_map_config');
 if(![256,512].includes(c.tileSize)||!Number.isInteger(c.minZoom)||!Number.isInteger(c.maxZoom)||c.minZoom<0||c.maxZoom>12||c.minZoom>c.maxZoom||c.imageSize!==c.tileSize*2**c.maxZoom)throw Error('invalid_map_config');
 const b=c.bounds;if(![b.minX,b.maxX,b.minZ,b.maxZ].every(n=>Number.isFinite(n)&&Math.abs(n)<=1e7)||b.minX>=b.maxX||b.minZ>=b.maxZ)throw Error('invalid_map_config');
 if(typeof c.attribution!=='string'||c.attribution.length>160||typeof c.cities!=='boolean')throw Error('invalid_map_config');const a=new URL(c.attributionUrl);if(a.protocol!=='https:'||a.username||a.password)throw Error('invalid_map_config');
 return {schema:1,name:c.name,tiles:c.tiles,tileSize:c.tileSize,minZoom:c.minZoom,maxZoom:c.maxZoom,imageSize:c.imageSize,bounds:{minX:b.minX,maxX:b.maxX,minZ:b.minZ,maxZ:b.maxZ},attribution:c.attribution,attributionUrl:a.href,cities:c.cities};
}
export function worldToImage(x,z,c=DEFAULT_MAP){return [(x-c.bounds.minX)/(c.bounds.maxX-c.bounds.minX)*c.imageSize,(z-c.bounds.minZ)/(c.bounds.maxZ-c.bounds.minZ)*c.imageSize];}
export function imageToWorld(u,v,c=DEFAULT_MAP){return [c.bounds.minX+u/c.imageSize*(c.bounds.maxX-c.bounds.minX),c.bounds.minZ+v/c.imageSize*(c.bounds.maxZ-c.bounds.minZ)];}
export function tilePlan(view,width,height,c=DEFAULT_MAP){if(![view.x,view.z,view.scale,width,height].every(Number.isFinite)||view.scale<=0||width<=0||height<=0)return [];
 const base=c.imageSize/(c.bounds.maxX-c.bounds.minX);let zoom=Math.min(c.maxZoom,Math.max(c.minZoom,Math.ceil(c.maxZoom+Math.log2(view.scale/base))));let list=[];
 for(;;){list=[];const factor=2**(c.maxZoom-zoom),extent=c.tileSize*factor,n=2**zoom,[left,top]=worldToImage(view.x-width/2/view.scale,view.z-height/2/view.scale,c),[right,bottom]=worldToImage(view.x+width/2/view.scale,view.z+height/2/view.scale,c);
  for(let y=Math.max(0,Math.floor(top/extent));y<=Math.min(n-1,Math.floor(bottom/extent));y++)for(let x=Math.max(0,Math.floor(left/extent));x<=Math.min(n-1,Math.floor(right/extent));x++){
   const [wx,wz]=imageToWorld(x*extent,y*extent,c),[ex,ez]=imageToWorld((x+1)*extent,(y+1)*extent,c);const dx=(wx-view.x)*view.scale+width/2,dy=(wz-view.z)*view.scale+height/2,w=(ex-wx)*view.scale,h=(ez-wz)*view.scale;
   list.push({key:zoom+'/'+x+'/'+y,url:c.tiles.replace('{z}',zoom).replace('{x}',x).replace('{y}',y),x:dx,y:dy,w,h,distance:Math.hypot(dx+w/2-width/2,dy+h/2-height/2)});
  }if(list.length<=64||zoom===c.minZoom)break;zoom--;
 }return list.sort((a,b)=>a.distance-b.distance).slice(0,64);
}
