import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { cleanEnvironment, runCommand } from './processes.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export async function caseBuildInputs(prepared) {
  const { job, applicationWorktree: worktree, signal } = prepared;
  signal.throwIfAborted();
  const sdkVersion = (await runCommand('dotnet', ['--version'], { cwd: worktree, env: cleanEnvironment(), signal })).output.trim();
  if (!/^[0-9A-Za-z.+-]{1,100}$/.test(sdkVersion)) throw new Error('Cannot identify the SDK selected by the approved application source.');
  const recipeFiles = ['case-build.mjs', 'case-batch.mjs', 'case-implementation.mjs', 'writerapp-host.mjs', 'processes.mjs', '../package-lock.json',
    ...(job.applicationId === 'virtual-company' ? ['virtual-company-host.mjs', 'dotnet-build.mjs', '../hosts/virtual-company/Program.cs', '../hosts/virtual-company/Host.csproj.template'] : [])];
  const recipe = createHash('sha256');
  for (const file of recipeFiles) { recipe.update(file); recipe.update(await readFile(new URL(file, import.meta.url))); }
  const recipeDigest = recipe.digest('hex');
  const buildKey = digest(JSON.stringify({ version: 1, application: job.applicationId, source: job.approvedTarget.sourceCommit,
    sdkVersion, recipeDigest, platform: process.platform, architecture: process.arch }));
  return { buildKey, sdkVersion, recipeDigest };
}

async function inventory(build, signal) {
  const roots = new Set([path.dirname(build.assembly), ...(build.web ? [path.dirname(build.web)] : [])]);
  const manifests = [build.manifest, ...(build.web ? [path.join(path.dirname(build.web), 'VirtualCompany.Web.staticwebassets.runtime.json')] : [])].filter(Boolean);
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
