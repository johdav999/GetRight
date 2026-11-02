import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../src/settings.mjs';
import { removeWorktree, removeEvidence } from '../src/cleanup.mjs';
await mkdir(path.join(repositoryRoot, '.local'), { recursive: true });

test('worktree cleanup refuses an unrelated directory even when a commit is supplied', async () => {
  const root = await mkdtemp(path.join(repositoryRoot, '.local/cleanup-boundary-'));
  const trees = path.join(root, 'trees'), outside = path.join(root, 'outside'); await mkdir(trees); await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'Keep unrelated files');
  const configuration = { dataPath: root, jobOptions: { repositoryPath: root, worktreeRoot: trees } };
  await assert.rejects(removeWorktree({ applicationId: 'writerapp', resourceId: 'a'.repeat(32), commit: 'b'.repeat(40), worktreePath: outside }, configuration), /outside/);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'Keep unrelated files');
});

test('evidence cleanup refuses a redirected run directory before reading or deleting files', async () => {
  const root = await mkdtemp(path.join(repositoryRoot, '.local/evidence-boundary-'));
  const evidence = path.join(root, 'evidence'), outside = path.join(root, 'outside'); await mkdir(evidence); await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'Keep unrelated evidence');
  await symlink(outside, path.join(evidence, 'a'.repeat(32)), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeEvidence({ resourceId: 'a'.repeat(32) }, { dataPath: root }), /linked|redirected/);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'Keep unrelated evidence');
});
