import {pathToFileURL} from 'node:url';
let relay,timer,lastCpu=process.cpuUsage(),lastAt=performance.now();
const watchdog=setTimeout(()=>process.exit(2),180000);watchdog.unref();
process.on('message',async message=>{
 try{
  if(message.type==='start'){
   const {createRelay}=await import(pathToFileURL(message.module).href);
   const {loadAddonContent}=await import(pathToFileURL(message.module.replace(/server\.mjs$/,'content.mjs')).href);
   const content=await loadAddonContent(message.contentFolder);
   relay=await createRelay({host:'127.0.0.1',port:0,maxPlayers:Math.max(100,message.players+50),trafficEnabled:true,trafficLimit:32,trafficMaxActors:128,
    content,log:()=>{}});
   lastCpu=process.cpuUsage();lastAt=performance.now();
   timer=setInterval(async()=>{try{const now=performance.now(),cpu=process.cpuUsage(),usage=(cpu.user-lastCpu.user+cpu.system-lastCpu.system)/1000;
    const health=await(await fetch('http://127.0.0.1:'+relay.address.port+'/health',{signal:AbortSignal.timeout(3000)})).json();
    process.send?.({type:'metrics',rss:process.memoryUsage().rss,heap:process.memoryUsage().heapUsed,cpuOneCorePercent:usage/(now-lastAt)*100,players:relay.sessions.size,health});lastCpu=cpu;lastAt=now;
   }catch(error){process.send?.({type:'metric_error',message:error.message});}},500);
   process.send({type:'ready',port:relay.address.port,revision:content?.revision,assetUrl:[...content.assets.keys()][0]});
  }else if(message.type==='stop'){clearInterval(timer);await relay?.close();process.send?.({type:'stopped'},()=>process.disconnect());}
 }catch(error){process.send?.({type:'failure',message:error.message});process.exitCode=1;}
});
process.on('disconnect',()=>{clearInterval(timer);void relay?.close().finally(()=>process.exit());});
