import {loadEnvFile} from 'node:process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readControl} from '../system/console-control.mjs';
import {normalizeAnnouncement} from '../system/announcements.mjs';

export async function runConsoleCommand(args,{directory=process.env.DATA_DIR??'./data',write=console.log}={}){
 const cli='npm run console --';
 const [raw,...words]=args,command=String(raw??'').replace(/^\//,'').toLowerCase();
 if(['help','aide','--help','-h'].includes(command)){write('Commands: '+cli+' announce "Your message" · '+cli+' fake-call [name|555-XXXX] · '+cli+' missions-debug [player]');return 0;}
 const text=normalizeAnnouncement(words.join(' '));
 const debug=command==='missions-debug',fake=command==='fake-call',target=words.join(' ').trim();
 if((fake||debug)&&(target.length>80||/[\u0000-\u001f\u007f]/.test(target))||!fake&&!debug&&(!['annonce','announce'].includes(command)||!text)){write('Usage: '+cli+' announce "Your message" · '+cli+' fake-call [player]');return 2;}
 try{
  const control=await readControl(directory);
  const response=await fetch(`http://127.0.0.1:${control.port}/${debug?'missions-debug':fake?'fake-call':'announce'}`,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+control.token,'content-type':'application/json'},body:JSON.stringify(fake||debug?{target}:{message:text}),signal:AbortSignal.timeout(5000)});
  const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error??'Server unavailable');
  if(debug){write(JSON.stringify(result.diagnostic,null,2));return 0;}
  write(fake?`Test call sent to ${result.player} (${result.number}).`:`Announcement sent to ${result.recipients} player(s).`);return 0;
 }catch(error){write('Command failed. Check that the server is running and uses the same DATA_DIR and container. '+(error.code==='ENOENT'?'Local console not found.':String(error.message).replace(/[\r\n]/g,' ').slice(0,140)));return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{loadEnvFile('.env');}catch(error){if(error.code!=='ENOENT'){console.error('Could not read .env: '+error.message);process.exitCode=1;}}
 if(!process.exitCode)process.exitCode=await runConsoleCommand(process.argv.slice(2));
}
