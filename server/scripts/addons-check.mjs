import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadAddonContent} from '../system/content.mjs';

export async function runAddonsCheck(args, {executable='node server/scripts/addons-check.mjs'}={}) {
 if(args.includes('--help')){
  console.log(executable+' [--folder ./addons]\nRead-only check of load order, uninspected archives and overridden files. No API requests.');
  return 0;
 }
 try{
  const at=args.indexOf('--folder');if(at>=0&&!args[at+1])throw Error('Missing path after --folder.');
  let report;await loadAddonContent(resolve(at>=0?args[at+1]:process.env.ADDONS_DIR??'./addons'),{log:s=>console.error(s),onReport:r=>report=r});
  console.log(JSON.stringify(report,null,2));return 0;
 }catch(error){console.error(error.message);return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 process.exitCode=await runAddonsCheck(process.argv.slice(2));
}
