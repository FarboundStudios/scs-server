import { constants } from 'node:fs';
import { copyFile, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { safeDirectory } from './storage.mjs';

const logNames = /^(?:console\.jsonl(?:\.[1-3])?|audit\.jsonl(?:\.1)?)$/;

export async function prepareLogDirectory(directory, previousDirectory) {
  await safeDirectory(directory);
  const existing = await readdir(directory);
  if (existing.some(name => logNames.test(name))) return directory;

  let previous;
  try {
    const info = await lstat(previousDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) return directory;
    previous = await readdir(previousDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') return directory;
    throw error;
  }

  for (const name of previous.filter(name => logNames.test(name))) {
    const source = join(previousDirectory, name);
    try {
      const info = await lstat(source);
      if (info.isFile() && !info.isSymbolicLink() && info.size <= 3 * 1024 * 1024) {
        await copyFile(source, join(directory, name), constants.COPYFILE_EXCL);
      }
    } catch (error) {
      if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error;
    }
  }
  return directory;
}
