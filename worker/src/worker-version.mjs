import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const reloadExitCode = 75;
export const workerRoot = fileURLToPath(new URL('../', import.meta.url));
export async function workerSourceStamp(root = workerRoot) {
  const files = (await readdir(path.join(root, 'src'))).filter(name => name.endsWith('.mjs')).sort().map(name => `src/${name}`);
  files.push('package-lock.json');
  const hash = createHash('sha256');
  for (const file of files) { hash.update(`${file}\0`); hash.update(await readFile(path.join(root, file))); hash.update('\0'); }
  return hash.digest('hex');
}
