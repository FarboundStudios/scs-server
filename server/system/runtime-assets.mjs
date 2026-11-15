import { lstat, readFile } from 'node:fs/promises';

export async function readServerAsset(name, {maxBytes} = {}) {
  const url = new URL(name, import.meta.url);
  if (maxBytes !== undefined) {
    const info = await lstat(url);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw Error('Invalid server asset');
  }
  return readFile(url);
}

