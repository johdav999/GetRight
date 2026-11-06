import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';

const digest = value => createHash('sha256').update(value).digest('hex');
export async function caseBuildInputs(prepared) {
  const { job, applicationWorktree: worktree, signal, options } = prepared;
  signal.throwIfAborted();
  const sdkVersion = await options.sdkVersion(worktree, signal);
  if (!/^[0-9A-Za-z.+-]{1,100}$/.test(sdkVersion)) throw new Error('Cannot identify the SDK selected by the approved application source.');
  const { recipeDigest } = options;
  const buildKey = digest(JSON.stringify({ version: 1, application: job.applicationId, source: job.approvedTarget.sourceCommit,
    sdkVersion, recipeDigest, platform: process.platform, architecture: process.arch }));
  return { buildKey, sdkVersion, recipeDigest };
}

async function inventory(build, signal) {
  const roots = new Set(build.artifactRoots ?? [path.dirname(build.assembly), ...(build.web ? [path.dirname(build.web)] : [])]);
  if (!roots.size) throw new Error('The recipe must identify its compiled artifact roots.');
  const manifests = [build.manifest, ...(build.staticManifests ?? [])].filter(Boolean);
  for (const manifest of manifests) {
    const value = JSON.parse(await readFile(manifest, 'utf8'));
    if (!Array.isArray(value.ContentRoots) || value.ContentRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root)))
      throw new Error('The build must identify its static asset content roots.');
    for (const root of value.ContentRoots) roots.add(root);
  }
  const files = new Map();
  async function visit(target) {
    signal?.throwIfAborted();
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error('A shared build cannot contain redirected artifact paths.');
    if (stat.isDirectory()) { for (const entry of await readdir(target)) await visit(path.join(target, entry)); }
    else if (stat.isFile()) {
      if (files.size >= 50000) throw new Error('The shared build exceeds its artifact inventory limit.');
      const actual = await realpath(target); files.set(actual, { path: actual, bytes: stat.size, sha256: digest(await readFile(actual)) });
    } else throw new Error('A shared build artifact must be a plain file or directory.');
  }
  for (const root of roots) await visit(root);
  // Runtime manifests are included even if an adapter locates them outside bin.
  for (const file of manifests) await visit(file);
  return [...files.values()].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function sealCaseBuild(build, signal) {
  const entries = await inventory(build, signal), artifactDigest = digest(JSON.stringify(entries));
  return { artifactDigest, entries,
    async verify(checkSignal) {
      const current = await inventory(build, checkSignal);
      if (digest(JSON.stringify(current)) !== artifactDigest) throw new Error('The shared application build or static assets changed. Remaining cases cannot use it.');
    },
  };
}
