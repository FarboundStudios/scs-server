import {DEFAULT_MAP,validateMap,tilePlan} from './map-coordinates.mjs';
export class TileCache{
 constructor({limit=96,parallel=6,makeImage=()=>new Image(),redraw=()=>{},now=Date.now}={}){Object.assign(this,{limit,parallel,makeImage,redraw,now});this.items=new Map();this.queue=[];this.loading=0;this.active=true;}
 setActive(active){this.active=active;if(!active){for(const e of this.queue)e.state='idle';this.queue=[];}else this.pump();}
 image(key,url){let item=this.items.get(key);if(item){this.items.delete(key);this.items.set(key,item);if(item.state==='ready')return item.image;if(item.state==='error'&&this.now()<item.retryAt)return null;if(['queued','loading'].includes(item.state))return null;}
  else{if(this.items.size>=this.limit){const oldest=[...this.items].find(([,e])=>e.state!=='loading');if(!oldest)return null;this.items.delete(oldest[0]);this.queue=this.queue.filter(e=>e!==oldest[1]);}item={key,url,state:'idle'};this.items.set(key,item);}
  if(this.active){item.state='queued';this.queue.push(item);this.pump();}return null;
 }
 pump(){while(this.active&&this.loading<this.parallel&&this.queue.length){const e=this.queue.shift();if(this.items.get(e.key)!==e)continue;const image=e.image=this.makeImage();e.state='loading';this.loading++;let done=false;
  const finish=ok=>{if(done)return;done=true;clearTimeout(timer);image.onload=null;image.onerror=null;this.loading--;e.state=ok?'ready':'error';e.retryAt=this.now()+30000;if(this.active)this.redraw();this.pump();};
  image.referrerPolicy='no-referrer';image.decoding='async';image.onload=()=>finish(true);image.onerror=()=>finish(false);const timer=setTimeout(()=>{finish(false);image.src='';},12000);timer.unref?.();image.src=e.url;
 }}
 retry(){for(const [k,e]of this.items)if(e.state==='error')this.items.delete(k);this.redraw();}
}
const safePlayers=players=>players.filter(p=>p.position&&[p.position.x,p.position.z].every(Number.isFinite));
export class RoadMap{
 constructor(){this.view={x:0,z:0,scale:.08};this.selected=null;this.initialized=false;this.config=null;this.players=[];this.cities=[];this.frame=0;this.cache=new TileCache({redraw:()=>this.drawSoon()});}
 async bind(root){this.root=root;this.canvas=root.querySelector('canvas');this.cache.setActive(true);this.bindControls();
  try{if(!this.config){const response=await fetch('/manager/api/map',{cache:'no-store'});if(!response.ok)throw Error('Map configuration unavailable');this.config=validateMap(await response.json());if(this.config.cities){try{const r=await fetch('/manager/map-cities.json');const data=await r.json();this.cities=Array.isArray(data)?data.filter(p=>typeof p.name==='string'&&Number.isFinite(p.x)&&Number.isFinite(p.z)).slice(0,2000):[];}catch{this.cities=[];}}}
   if(!this.canvas.isConnected)return;const link=root.querySelector('[data-map-attribution]');link.textContent=this.config.attribution;link.href=this.config.attributionUrl;if(!this.initialized)this.fit();this.drawSoon();
  }catch{this.message('Map configuration unavailable. Check data/manager-map.json.',true);}
 }
 pause(){this.cache.setActive(false);if(this.frame)cancelAnimationFrame(this.frame);this.frame=0;}
 update(players){const had=this.players.length;this.players=safePlayers(players??[]);if(this.canvas?.isConnected){if(!had&&this.players.length)this.fit();this.drawSoon();}}
 select(id){this.selected=id;this.initialized=false;if(this.canvas?.isConnected)this.fit();}
 fit(world=false){if(!this.canvas||!this.config)return;const c=this.config,selected=this.players.find(p=>p.id===this.selected),list=world?[]:selected?[selected]:this.players;
  let minX=c.bounds.minX,maxX=c.bounds.maxX,minZ=c.bounds.minZ,maxZ=c.bounds.maxZ;if(list.length){const xs=list.map(p=>p.position.x),zs=list.map(p=>p.position.z);minX=Math.min(...xs);maxX=Math.max(...xs);minZ=Math.min(...zs);maxZ=Math.max(...zs);}
  this.view.x=(minX+maxX)/2;this.view.z=(minZ+maxZ)/2;this.view.scale=Math.max(.0005,Math.min(2,Math.min((this.canvas.clientWidth-110)/Math.max(1800,maxX-minX),(this.canvas.clientHeight-100)/Math.max(1800,maxZ-minZ))));this.initialized=true;this.drawSoon();
 }
 message(text,error=false){const n=this.root?.querySelector('[data-map-status]');if(n){n.textContent=text;n.classList.toggle('map-failed',error);}}
 bindControls(){const canvas=this.canvas;let drag=null;
  canvas.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY,...this.view,moved:false,startX:e.clientX,startY:e.clientY};canvas.setPointerCapture(e.pointerId);};
  canvas.onpointermove=e=>{if(!drag)return;const dx=e.clientX-drag.startX,dy=e.clientY-drag.startY;drag.moved||=Math.abs(dx)+Math.abs(dy)>3;this.view.x=drag.x-dx/this.view.scale;this.view.z=drag.z-dy/this.view.scale;this.drawSoon();};
  canvas.onpointerup=e=>{if(drag&&!drag.moved){const rect=canvas.getBoundingClientRect(),x=this.view.x+(e.clientX-rect.left-canvas.clientWidth/2)/this.view.scale,z=this.view.z+(e.clientY-rect.top-canvas.clientHeight/2)/this.view.scale;let best=null,distance=24;for(const p of this.players){const d=Math.hypot(p.position.x-x,p.position.z-z)*this.view.scale;if(d<distance){distance=d;best=p;}}this.selected=best?.id??null;}drag=null;this.drawSoon();};canvas.onpointercancel=()=>{drag=null;};
  const zoom=(factor,x=canvas.clientWidth/2,y=canvas.clientHeight/2)=>{const before=this.view.scale,next=Math.min(2,Math.max(.0005,before*factor));this.view.x+=(x-canvas.clientWidth/2)*(1/before-1/next);this.view.z+=(y-canvas.clientHeight/2)*(1/before-1/next);this.view.scale=next;this.drawSoon();};
  canvas.onwheel=e=>{e.preventDefault();const r=canvas.getBoundingClientRect();zoom(e.deltaY<0?1.25:.8,e.clientX-r.left,e.clientY-r.top);};
  this.root.querySelector('#fit-map').onclick=()=>{this.selected=null;this.fit();};this.root.querySelector('#world-map-fit').onclick=()=>{this.selected=null;this.fit(true);};this.root.querySelector('#map-in').onclick=()=>zoom(1.4);this.root.querySelector('#map-out').onclick=()=>zoom(1/1.4);this.root.querySelector('#map-retry').onclick=()=>{this.cache.retry();if(!this.config)void this.bind(this.root);};
 }
 drawSoon(){if(this.frame||!this.canvas?.isConnected||!this.cache.active||document.hidden)return;this.frame=requestAnimationFrame(()=>{this.frame=0;this.draw();});}
 draw(){if(!this.config||!this.canvas?.isConnected)return;const canvas=this.canvas,w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;const dpr=Math.min(2,devicePixelRatio||1);if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#303030';ctx.fillRect(0,0,w,h);
  const plan=tilePlan(this.view,w,h,this.config);let ready=0,failed=0;for(const tile of plan){const image=this.cache.image(tile.key,tile.url);if(image){ctx.drawImage(image,tile.x,tile.y,tile.w+.5,tile.h+.5);ready++;}else if(this.cache.items.get(tile.key)?.state==='error')failed++;}
  if(!plan.length)this.message('Outside map coverage. Use World map to return.',true);else if(failed)this.message('Some road tiles are unavailable. Positions remain live. Use Retry.',true);else this.message(ready<plan.length?'Loading road map…':this.config.name+' · road map');
  const screen=p=>[(p.x-this.view.x)*this.view.scale+w/2,(p.z-this.view.z)*this.view.scale+h/2];const occupied=[];
  if(this.view.scale>=.008){ctx.font='11px Arial';ctx.textAlign='center';ctx.lineWidth=3;ctx.strokeStyle='#242424';ctx.fillStyle='#f1f0df';for(const city of this.cities){const [x,y]=screen(city);if(x<20||y<25||x>w-20||y>h-20)continue;const size=ctx.measureText(city.name).width+14;if(occupied.some(r=>Math.abs(x-r.x)<(size+r.w)/2&&Math.abs(y-r.y)<22))continue;occupied.push({x,y,w:size});ctx.strokeText(city.name,x,y);ctx.fillText(city.name,x,y);if(occupied.length>100)break;}ctx.textAlign='left';}
  for(const p of this.players){const [x,y]=screen(p.position);if(x<-20||y<-20||x>w+20||y>h+20)continue;const selected=p.id===this.selected;ctx.beginPath();ctx.arc(x,y,selected?7:5,0,Math.PI*2);ctx.fillStyle=selected?'#e8bf6a':'#65c796';ctx.strokeStyle='#151a19';ctx.lineWidth=2;ctx.fill();ctx.stroke();ctx.font='600 11px Arial';const labelWidth=ctx.measureText(p.name).width+12,labelX=x+11+labelWidth/2;if(selected||!occupied.some(r=>Math.abs(labelX-r.x)<(labelWidth+r.w)/2&&Math.abs(y-r.y)<19)){occupied.push({x:labelX,y,w:labelWidth});ctx.strokeStyle='#242424';ctx.lineWidth=3;ctx.strokeText(p.name,x+11,y+4);ctx.fillStyle='#fff';ctx.fillText(p.name,x+11,y+4);}}
  const box=this.root.querySelector('#map-info');const selected=this.players.find(p=>p.id===this.selected);box.replaceChildren();const title=document.createElement('strong');title.textContent=selected?.name??this.config.name;box.append(title);for(const text of selected?[selected.steamId??selected.id,'X '+selected.position.x.toFixed(1)+' · Z '+selected.position.z.toFixed(1),'Ping '+(selected.pingMs??'—')+' ms']:['Select a player to inspect their position.']){const line=document.createElement('span');line.textContent=text;box.append(line);}this.root.querySelector('#map-count').textContent=this.players.length+' players with a live position';
 }
}
