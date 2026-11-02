import assert from 'node:assert/strict';
import test from 'node:test';
import { requireBuildSpace, buildReserveBytes } from '../src/storage.mjs';

test('test build space preflight checks both worktree and evidence volumes before expansion', async () => {
  const checked = [];
  await assert.rejects(requireBuildSpace(['worktrees', 'evidence'], 'virtual-company', async directory => {
    checked.push(directory); return { bsize: 1024, bavail: directory === 'worktrees' ? 10 * 1024 ** 2 : 1024 };
  }), /Insufficient free disk space.*evidence.*Existing worktrees/);
  assert.deepEqual(checked, ['worktrees', 'evidence']);
  assert.equal(buildReserveBytes('virtual-company'), 5 * 1024 ** 3);
  await requireBuildSpace(['same', 'same'], 'writerapp', async () => ({ bsize: 1024, bavail: 6 * 1024 ** 2 }));
});
test('test build space preflight rejects unknown capacity and allows the smaller local demo reserve', async () => {
  await assert.rejects(requireBuildSpace(['build'], 'writerapp', async () => ({ bsize: NaN, bavail: 1 })), /Cannot verify free space/);
  await requireBuildSpace(['build'], 'getright', async () => ({ bsize: 1024, bavail: 512 * 1024 }));
});
