import path from 'node:path';
import { lstat, realpath, readdir, unlink, rmdir } from 'node:fs/promises';
import { api } from './settings.mjs';
import { jobConfiguration } from './jobs.mjs';
import { runCommand, cleanEnvironment } from './processes.mjs';
import { supervise } from './supervision.mjs';

const same = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
async function plainDirectory(folder) {
  const stat = await lstat(folder); if (!stat.isDirectory() || stat.isSymbolicLink() || !same(await realpath(folder), folder)) throw new Error('Cleanup refuses linked or redirected directories.');
}
export async function removeEvidence(task, configuration) {
  if (!/^[a-f0-9]{32}$/.test(task.resourceId)) throw new Error('Invalid evidence resource.');
  const root = path.join(configuration.dataPath, 'evidence'); await plainDirectory(root);
  const folder = path.join(root, task.resourceId);
  try { await plainDirectory(folder); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const run = await api(configuration.dashboardUrl, `/api/runs/${task.resourceId}`);
  if (!run.evidenceRetiredAt || run.acceptance !== 'accepted' || ['running', 'queued'].includes(run.status)) throw new Error('Evidence is not retired from a completed accepted run.');
  const allowed = new Set([run.trace, ...run.steps.map(s => s.screenshot)].filter(Boolean).map(file => file.split('/')[1]));
  const files = await readdir(folder);
  // Inspect the entire selection before deleting any file. No recursive delete.
  for (const file of files) {
    const stat = await lstat(path.join(folder, file));
    if (!allowed.has(file) || !stat.isFile() || stat.isSymbolicLink()) throw new Error('Evidence cleanup found an unregistered file, directory or link. Nothing was removed.');
  }
  for (const file of files) { configuration.signal?.throwIfAborted(); await unlink(path.join(folder, file)); }
  await rmdir(folder);
}
export async function removeWorktree(task, configuration) {
  if (!/^[a-f0-9]{32}$/.test(task.resourceId)) throw new Error('Invalid worktree resource.');
  const options = await jobConfiguration(configuration, task.applicationId);
  const root = await realpath(options.worktreeRoot);
  const expected = path.join(root, task.resourceId.slice(0, 12));
  if (!task.worktreePath || !same(expected, task.worktreePath) || !/^[a-f0-9]{40,64}$/i.test(task.commit || '')) throw new Error('The recorded worktree is outside the configured job directory or has no retained commit.');
  await plainDirectory(root);
  const git = (cwd, args) => runCommand('git', ['-c', 'core.longpaths=true', '-c', `core.hooksPath=${path.join(configuration.dataPath, 'jobs', task.resourceId, 'empty-hooks')}`, '-C', cwd, ...args], { signal: configuration.signal, env: cleanEnvironment() });
  const listing = (await git(options.repositoryPath, ['worktree', 'list', '--porcelain', '-z'])).output.split('\0\0');
  const registered = listing.find(entry => entry.split('\0').some(line => line.startsWith('worktree ') && same(line.slice(9), expected)));
  if (!registered) {
    try { await lstat(expected); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error('The recorded directory is not a registered worktree.');
  }
  await plainDirectory(expected);
  const branch = (await git(expected, ['symbolic-ref', '--short', 'HEAD'])).output.trim();
  const head = (await git(expected, ['rev-parse', 'HEAD'])).output.trim();
  if (branch !== `getright/job-${task.resourceId}` || head !== task.commit) throw new Error('The branch or commit changed after the job. Keep this worktree for manual review.');
  if ((await git(expected, ['status', '--porcelain', '--untracked-files=all'])).output.trim()) throw new Error('The worktree has uncommitted or untracked changes. It will not be removed.');
  // Git removes only this registered clean worktree; no --force, branch deletion,
  // repository-wide prune or shell-composed recursive filesystem command exists.
  await git(options.repositoryPath, ['worktree', 'remove', expected]);
}
export async function executeCleanup(claim, configuration) {
  const { task, lease } = claim; const route = `/api/maintenance/tasks/${task.id}`;
  const supervisor = supervise({ configuration, heartbeat: `${route}/heartbeat`, lease, timeoutMs: 300000 });
  let status = 'completed', error = null;
  try {
    await supervisor.ready; supervisor.signal.throwIfAborted();
    const action = task.kind === 'evidence' ? removeEvidence : task.kind === 'worktree' ? removeWorktree : null;
    if (!action) throw new Error('Unknown cleanup kind.');
    await action(task, { ...configuration, signal: supervisor.signal });
  } catch (failure) { status = supervisor.signal.aborted ? 'interrupted' : 'failed'; error = failure.message; }
  finally { await supervisor.stop(); }
  return api(configuration.dashboardUrl, `${route}/finish`, { lease, status, error });
}
