import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
export async function playerIdentity(directory,name='default'){
 if(!directory)return randomBytes(32).toString('hex');directory=join(directory,'identities',createHash('sha256').update(name.normalize('NFC').toLowerCase()).digest('hex').slice(0,32));await mkdir(directory,{recursive:true});const file=join(directory,'player-identity.json');
 try{const value=JSON.parse(await readFile(file,'utf8'));if(!/^[a-f0-9]{64}$/.test(value.token))throw Error('Invalid local HeavyMP identity.');return value.token;}catch(error){if(error.code!=='ENOENT')throw error;}
 const token=randomBytes(32).toString('hex');try{await writeFile(file,JSON.stringify({token})+'\n',{flag:'wx',mode:0o600});return token;}catch(error){if(error.code!=='EEXIST')throw error;const value=JSON.parse(await readFile(file,'utf8'));if(!/^[a-f0-9]{64}$/.test(value.token))throw Error('Invalid local HeavyMP identity.');return value.token;}
}
