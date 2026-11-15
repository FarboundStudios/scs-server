import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
export function createChat({sessions,world,persistWorld=()=>{},index=null,vtc=null,localRadius=500,globalRate=6,moderation=null,commands=null,modules=null,messages,sendSerialized}){
 const history=[],companyHistory=new Map();let persistence=Promise.resolve(),worldAt=0;
 const traffic=new Map();let deliveryTokens=10000,deliveryAt=performance.now();
 const deliveries=count=>{const now=performance.now(),rate=Math.max(1000,sessions.size*8);deliveryTokens=Math.min(rate*2,deliveryTokens+(now-deliveryAt)*rate/1000);deliveryAt=now;if(deliveryTokens<count)return false;deliveryTokens-=count;return true;};
 const admit=(channel,rate=12)=>{const now=performance.now();let b=traffic.get(channel);if(!b){if(traffic.size>=1024)traffic.delete(traffic.keys().next().value);traffic.set(channel,b={tokens:rate*2,at:now});}b.tokens=Math.min(rate*2,b.tokens+(now-b.at)*rate/1000);b.at=now;if(b.tokens<1)return false;b.tokens--;return true;};
 // The badge retains the displayed staff role's color; its name is metadata only.
 const rankOf=s=>s.staff?{label:'Staff',color:'#84dfaa'}:null;
 const keep=(list,m)=>{list.push(m);if(list.length>40)list.shift();};
 const {tell,enqueue,broadcast:sendMessage}=messages;
 function broadcast(recipients,name,text,system,channel,rank,company,senderId){
  const message=sendMessage(recipients,name,text,system,channel,rank,company,senderId);
  if(channel==='global')keep(history,message);
  return message;
 }
 const announce=text=>messages.announce(text);
 const staff=commands?commands({tell,announce}):null;
 const save=()=>{const settings=world.settings();persistence=persistence.then(()=>persistWorld(settings)).catch(error=>console.error('Could not save time or weather:',error.message));};
 return {tell,
  announce,
  join(s){if(!s.supportsChat)return;const c=vtc?.company(s);const messages=[...history,...(c?companyHistory.get(c.id)??[]:[])].sort((a,b)=>a.time-b.time).slice(s.supportsChannels?-80:-40);enqueue(s,JSON.stringify({type:'chat_history',messages}));vtc?.notify(s);},
  handle(s,msg){
   if(messages.handle(s,msg))return true;
   if(msg.type!=='chat')return false;if(!s.supportsChat)return true;if(typeof msg.text!=='string'||msg.text.length>280||Buffer.byteLength(msg.text)>850||/[\u0000-\u001f\u007f]/.test(msg.text))return true;
   let text=msg.text.normalize('NFC').trim();if(!text)return true;if(Date.now()-(s.chatAt??0)<800)return true;s.chatAt=Date.now();
   if((s.managerMutedUntil??0)>Date.now()){tell(s,'Chat muted by this server administrator.');return true;}
   let channel=['global','local','vtc'].includes(msg.channel)?msg.channel:s.chatChannel??'global';
   if(text.startsWith('/')){const [raw,...args]=text.slice(1).split(/\s+/),command=raw.toLowerCase();
    if(['g','l','v'].includes(command)){channel={g:'global',l:'local',v:'vtc'}[command];text=args.join(' ').trim();if(!text){tell(s,'Enter a message after /'+command+'.');return true;}}
    else if(command==='vtc'){if(vtc)vtc.handle(s,args,tell);else tell(s,'VTCs are unavailable on this server.');return true;}
    else if(command==='help'){tell(s,'/g message · /l message · /v message · /vtc info · /time HH:MM · /weather clear|rain|dynamic · /fix');const extra=staff?staff.available(s):[];if(extra.length)tell(s,'Moderation: '+extra.join(' · '));const scripts=modules?.commands()??[];for(let i=0;i<scripts.length;i+=5)tell(s,'Scripts : '+scripts.slice(i,i+5).join(' · '));return true;}
    else if(command==='time'){if(Date.now()-worldAt<2000){tell(s,'Time or weather was just changed. Wait a moment and try again.');return true;}const match=/^(\d{1,2}):(\d{2})$/.exec(args[0]??'');if(args.length!==1||!match||+match[1]>23||+match[2]>59){tell(s,'Usage: /time HH:MM.');return true;}worldAt=Date.now();world.setTime(+match[1]*60+ +match[2]);save();broadcast(sessions.values(),'HeavyMP',s.name+' sets the time to '+match[1].padStart(2,'0')+':'+match[2]+'.',true,'system');return true;}
    else if(command==='weather'){if(Date.now()-worldAt<2000){tell(s,'Time or weather was just changed. Wait a moment and try again.');return true;}const mode=new Map([['clear','clear'],['sun','clear'],['soleil','clear'],['rain','rain'],['pluie','rain'],['dynamic','dynamic']]).get(args[0]?.toLowerCase());if(args.length!==1||!mode){tell(s,'Usage: /weather clear|rain|dynamic.');return true;}worldAt=Date.now();world.setWeather(mode);save();broadcast(sessions.values(),'HeavyMP',s.name+' sets the weather to '+{clear:'clear',rain:'rain',dynamic:'automatic cycle'}[mode]+'.',true,'system');return true;}
    else if(command==='fix'&&!args.length){if(!s.lastState||performance.now()-s.stateAt>3000){tell(s,'Enter driving mode to repair your truck.');return true;}if(s.repairId&&Date.now()-s.repairAt<15000){tell(s,'A repair is already in progress.');return true;}s.repairId=randomUUID();s.repairAt=Date.now();sendSerialized(s.socket,JSON.stringify({type:'action',action:'repair',id:s.repairId}));tell(s,'Repair requested…');return true;}
    else if(command==='script'&&modules){
      const [id,...parameters]=args;
      modules.command(id,parameters,s,text=>tell(s,text),announce,()=>sessions.get(s.id)===s);
      return true;
    }
    else if(staff&&staff.handle(s,command,args,text.slice(1+raw.length).trim()))return true;
    else{tell(s,'Unknown command. Use /help to list available commands.');return true;}
   }
   if(channel==='local'){if(!admit('local:'+Math.floor((s.lastState?.x??0)/500)+':'+Math.floor((s.lastState?.z??0)/500))){tell(s,'The nearby channel is busy. Try again shortly.');return true;}if(!s.lastState||performance.now()-s.stateAt>3000){tell(s,'Enter driving mode to use nearby chat.');return true;}const recipients=index?index.within(s.lastState,localRadius,performance.now(),3000):[...sessions.values()].filter(p=>p.lastState&&performance.now()-p.stateAt<=3000&&(p.lastState.x-s.lastState.x)**2+(p.lastState.z-s.lastState.z)**2<=localRadius**2);if(!deliveries(recipients.length)){tell(s,'Nearby chat is busy. Try again shortly.');return true;}broadcast(recipients,s.name,text,false,'local',rankOf(s),vtc?.company(s),s.steamId??s.id);return true;}
   if(channel==='vtc'){const c=vtc?.company(s);if(!c||s.vtcPending){tell(s,'Join a VTC on this server before using this channel.');return true;}if(!admit('vtc:'+c.id)){tell(s,'The VTC channel is busy. Try again shortly.');return true;}const recipients=[...sessions.values()].filter(p=>vtc.company(p)?.id===c.id);if(!deliveries(recipients.length)){tell(s,'Chat is busy. Try again shortly.');return true;}const m=broadcast(recipients,s.name,text,false,'vtc',rankOf(s),c,s.steamId??s.id);if(!companyHistory.has(c.id)){if(companyHistory.size>=5000)companyHistory.delete(companyHistory.keys().next().value);companyHistory.set(c.id,[]);}keep(companyHistory.get(c.id),m);return true;}
   if(!admit('global',globalRate)||!deliveries(sessions.size)){tell(s,'Global chat is busy. Try the Nearby or VTC channel.');return true;}broadcast(sessions.values(),s.name,text,false,'global',rankOf(s),vtc?.company(s),s.steamId??s.id);return true;
  },async close(){await persistence;}
 };
}
