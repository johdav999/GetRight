import { statfs } from 'node:fs/promises';

const gib = 1024 ** 3;
export const buildReserveBytes = applicationId => applicationId === 'getright' ? gib / 4 : 5 * gib;

// Preflight before Git creates a worktree or a build expands its outputs. This
// never removes source, worktrees, caches, evidence or user data.
export async function requireBuildSpace(directories, applicationId, readStats = statfs) {
  const required = buildReserveBytes(applicationId);
  for (const directory of new Set(directories)) {
    const info = await readStats(directory);
    const available = Number(info.bavail) * Number(info.bsize);
    if (!Number.isFinite(available) || available < 0) throw new Error('Cannot verify free space for the isolated test build.');
    if (available < required) throw new Error(`Insufficient free disk space for an isolated ${applicationId} test build at ${directory}: ${(available / gib).toFixed(2)} GiB available; at least ${(required / gib).toFixed(2)} GiB required. Review generated build outputs before retrying. Existing worktrees, evidence and history were retained.`);
  }
}
