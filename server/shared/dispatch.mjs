export const dispatchToken=v=>typeof v==='string'&&/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(v)&&v.length<=120;
export const dispatchId=v=>typeof v==='string'&&/^[a-z0-9-]{16,64}$/i.test(v);
// Whitelist the SDK fields before recording any client-supplied data. Telemetry
// remains untrusted: these bounds are validation, never proof of a real delivery.
export function dispatchJob(input){
 if(!input||typeof input!=='object')throw Error('Invalid job telemetry.');
 const job={supported:input.supported===true,active:input.active!==false,liveCreation:input.liveCreation===true};
 for(const key of ['cargo','source','destination']){
  const value=input[key];if(typeof value!=='string'||value.length>120||value&&!dispatchToken(value))throw Error('Invalid job telemetry.');job[key]=value;
 }
 const event=input.event??'';if(!['','job.delivered','job.cancelled'].includes(event))throw Error('Invalid job event.');job.event=event;
 const eventId=input.eventId??'';if(typeof eventId!=='string'||eventId.length>80||!/^[a-zA-Z0-9-]*$/.test(eventId))throw Error('Invalid job event identity.');job.eventId=eventId;
 for(const [key,max] of Object.entries({massKg:10000000,income:1e12,distanceKm:100000,cargoDamage:1,revenue:1e12,xp:1e9,drivenKm:100000})){
  const value=input[key];if(value===undefined)continue;if(!Number.isFinite(value)||value<0||value>max)throw Error('Invalid job measurement.');job[key]=value;
 }
 if(input.vehicle&&typeof input.vehicle==='object'){
  job.vehicle={};for(const key of ['brand','model','plate']){const value=input.vehicle[key]??'';if(typeof value!=='string'||value.length>64||/[\u0000-\u001f]/.test(value))throw Error('Invalid job vehicle.');job.vehicle[key]=value;}
 }
 return job;
}
export function dispatchSpec(input){
 if(!input||!['source','destination'].every(k=>typeof input[k]==='string'&&/^[a-z0-9_]+\.[a-z0-9_]+$/.test(input[k])&&input[k].length<=100)||input.source===input.destination||!dispatchToken(input.cargo)||!input.cargo.startsWith('cargo.'))throw Error('Invalid departure, destination or cargo.');
 const title=String(input.title??'').trim();if(!title||title.length>80||/[\u0000-\u001f]/.test(title))throw Error('A mission title is required (80 characters maximum).');
 const distanceKm=Number(input.distanceKm);if(!Number.isInteger(distanceKm)||distanceKm<1||distanceKm>15000)throw Error('Route distance must be between 1 and 15000 km.');
 if(!dispatchToken(input.trailerDefinition)||!input.trailerDefinition.startsWith('trailer_def.')||!Number.isInteger(input.unitsCount)||input.unitsCount<1||input.unitsCount>10000)throw Error('Choose a verified cargo and trailer configuration.');
 return {title,source:input.source,destination:input.destination,cargo:input.cargo,trailerDefinition:input.trailerDefinition,unitsCount:input.unitsCount,distanceKm,visibility:input.visibility==='private'?'private':'public'};
}
