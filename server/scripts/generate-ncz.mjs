import {readFile,writeFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validMapManifest,mapRevision} from '../shared/content.mjs';
import {GAME_VERSION} from '../shared/protocol.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const game=option('--game-dir'),manifestFile=option('--manifest');
if(!game){console.error('Usage: node server/scripts/generate-ncz.mjs --game-dir "ETS2 directory" [--manifest data/addons.json]');process.exitCode=1;}
else try {
 let revision=null,paths=[];
 if(manifestFile){const path=resolve(manifestFile),m=validMapManifest(JSON.parse(await readFile(path,'utf8')));revision=mapRevision(m);for(const f of m.files){const p=join(option('--addons-dir')?resolve(option('--addons-dir')):path===join(root,'data/addons.json')?join(root,'addons'):dirname(path),f.name);if((await stat(p)).size!==f.size)throw Error('Map size mismatch: '+f.name);const hash=createHash('sha256');for await(const b of createReadStream(p))hash.update(b);if(hash.digest('hex')!==f.sha256)throw Error('Map hash mismatch: '+f.name);paths.push(p);}}
 const output=join(root,'server/system/assets/no-collision-zones-'+(revision??'europe')+'.json');
 const code=await new Promise((resolve,reject)=>{const p=spawn(process.env.DOTNET_EXE??'dotnet',['run','--project',join(root,'server/scripts/zone-export/ZoneExport.csproj'),'--',resolveGame(game),output,...paths],{stdio:'inherit',env:{...process.env,DOTNET_CLI_TELEMETRY_OPTOUT:'1',HEAVYMP_EXPORT_GAME_VERSION:GAME_VERSION}});p.once('error',reject);p.once('exit',resolve);});
 if(code!==0)throw Error('Map export failed ('+code+').');
 const result=JSON.parse(await readFile(output,'utf8'));result.contentRevision=revision;await writeFile(output,JSON.stringify(result)+'\n');console.log('Catalogue ready: '+output);
}catch(e){console.error(e.message);process.exitCode=1;}
function resolveGame(game){return resolve(game);}
