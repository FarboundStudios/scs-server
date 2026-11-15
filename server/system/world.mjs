import {validWorld} from '../shared/world.mjs';
export function createWorldTimeline(settings={},now=()=>Date.now()){
 let epoch=settings.epoch??now(),minutes=settings.minutes??720,mode=settings.weather??'dynamic',weatherEpoch=settings.weatherEpoch??epoch;
 const timeScale=settings.timeScale??19;
 if(!Number.isSafeInteger(epoch)||epoch<0||!Number.isSafeInteger(weatherEpoch)||weatherEpoch<0||!validWorld({minutes,timeScale,weather:0,blend:0})||!['dynamic','clear','rain'].includes(mode))throw Error('Invalid time or weather configuration.');
 const timeline=()=>{
  const elapsed=Math.max(0,now()-epoch)/1000;
  // Every client receives the same smooth 40-minute weather cycle. Pausing,
  // sleeping or travelling in one local career never controls the room clock.
  const phase=Math.max(0,now()-weatherEpoch)/1000%2400;let blend=mode==='rain'?1:0;
  if(mode==='dynamic'){
   if(phase>=1200&&phase<1320)blend=(phase-1200)/120;
   else if(phase>=1320&&phase<1920)blend=1;
   else if(phase>=1920&&phase<2040)blend=1-(phase-1920)/120;
   blend=blend*blend*(3-2*blend);
  }
  return {minutes:minutes+elapsed*timeScale/60,timeScale,weather:blend>0?1:0,blend};
 };
 timeline.setTime=value=>{if(!Number.isInteger(value)||value<0||value>=1440)throw Error('Invalid time');minutes=Math.floor(timeline().minutes/1440)*1440+value;epoch=now();};
 timeline.setWeather=value=>{if(!['clear','rain','dynamic'].includes(value))throw Error('Invalid weather');mode=value;weatherEpoch=now();};
 timeline.settings=()=>({epoch,minutes,timeScale,weather:mode,weatherEpoch});return timeline;
}
