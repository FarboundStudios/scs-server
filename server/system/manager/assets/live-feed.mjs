// Authenticated read-only WebSocket: bypass HTTP stream buffering.
export class LiveFeed extends EventTarget{
 constructor(path){super();this.path=path;this.closed=false;const u=new URL(path,location.href);u.protocol=location.protocol==='https:'?'wss:':'ws:';u.pathname='/manager/live';const ws=this.socket=new WebSocket(u);let opened=false;
  const fallback=()=>{if(this.closed||this.fallback)return;clearTimeout(this.timer);ws.close();const stream=this.fallback=new EventSource(path);stream.onopen=()=>this.onopen?.();stream.onerror=()=>this.onerror?.();for(const type of ['status','log'])stream.addEventListener(type,e=>this.dispatchEvent(new MessageEvent(type,{data:e.data})));};
  this.timer=setTimeout(fallback,2500);ws.onopen=()=>{opened=true;clearTimeout(this.timer);this.onopen?.();};ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(['status','log'].includes(m.type))this.dispatchEvent(new MessageEvent(m.type,{data:JSON.stringify(m.data)}));}catch{}};ws.onerror=()=>{if(!opened)fallback();};ws.onclose=()=>{if(!this.closed){this.onerror?.();fallback();}};
 }
 close(){this.closed=true;clearTimeout(this.timer);this.socket?.close();this.fallback?.close();}
}
