import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {cleanName} from '../server/shared/protocol.mjs';
import {identityHash} from '../server/system/vtc.mjs';
import {playerIdentity} from './identity.mjs';

try {
  const path = resolve(process.argv[2] ?? 'client/config.json');
  const config = JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
  if (!cleanName(config.name)) throw Error('Invalid player name.');
  console.log(identityHash(await playerIdentity(dirname(path),config.name)));
} catch (error) {
  console.error('Could not read the client fingerprint: '+error.message);
  process.exitCode = 1;
}
