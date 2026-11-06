import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { executeCaseImplementation } from './case-implementation.mjs';
import { supervise } from './supervision.mjs';
import { caseBuildInputs, sealCaseBuild } from './case-build.mjs';
import { cleanEnvironment, runCommand } from './processes.mjs';

// A batch is a bounded queue snapshot, not an evergreen cache. Models/plan
// commits are prepared sequentially; one compiler and one validation host run
// at a time. Every claimed case keeps its own renewable lease throughout.
export async function executeCaseImplementationBatch(batch, configuration, adapters = {}) {
  if (!/^[a-f0-9]{32}$/.test(batch?.id) || !Array.isArray(batch.claims) || batch.claims.length < 1 || batch.claims.length > 10 ||
      new Set(batch.claims.map(c => c.job.id)).size !== batch.claims.length || batch.claims.some(c => c.job.batchId !== batch.id))
    throw new Error('Invalid test implementation batch.');
  const ownership = batch.claims.map(claim => supervise({ configuration, heartbeat: `/api/case-implementations/${claim.job.id}/heartbeat`,
    lease: claim.lease, timeoutMs: 3600000, cancellation: true }));
  const prepared = [], outcomes = new Map();
  const settle = async (item, operation) => {
    try { outcomes.set(item.job.id, await operation()); }
    catch (error) { outcomes.set(item.job.id, { id: item.job.id, status: 'interrupted', error: error.message }); }
  };
  try {
    await Promise.all(ownership.map(owner => owner.ready));
    for (let index = 0; index < batch.claims.length; index++) {
      const claim = batch.claims[index];
      try {
        const item = await executeCaseImplementation(claim, configuration, adapters, { deferValidation: true, supervision: ownership[index] });
        if (typeof item?.run === 'function') prepared.push(item); else outcomes.set(claim.job.id, item);
      } catch (error) { outcomes.set(claim.job.id, { id: claim.job.id, status: 'interrupted', error: error.message }); }
    }
    // No application compilation occurs until every captured case has completed
    // its prerequisite check and immutable plan commit (or recorded a failure).
    const groups = new Map();
    for (const item of prepared) {
      if (!item.applicationWorktree) { await settle(item, () => item.run()); continue; }
      try {
        const inputs = await (adapters.buildInputs || caseBuildInputs)(item);
        const group = groups.get(inputs.buildKey) || { inputs, items: [] }; group.items.push(item); groups.set(inputs.buildKey, group);
      } catch (error) { await settle(item, () => item.fail(error)); }
    }
    for (const { inputs, items } of groups.values()) {
      const candidates = items.filter(item => !item.signal.aborted);
      for (const item of items.filter(item => item.signal.aborted)) await settle(item, () => item.fail(item.signal.reason));
      if (!candidates.length) continue;
      let owner = candidates[0]; const buildStop = new AbortController();
      const stopWhenUnused = () => { if (candidates.every(item => item.signal.aborted)) buildStop.abort(new Error('Every case using the shared build stopped.')); };
      for (const item of candidates) item.signal.addEventListener('abort', stopWhenUnused);
      let shared;
      const inform = async (message, extra = {}) => {
        for (const item of candidates) {
          if (outcomes.has(item.job.id)) continue;
          if (item.signal.aborted) { await settle(item, () => item.fail(item.signal.reason)); continue; }
          try { await item.reportBuild(message, extra); }
          catch (error) { if (item.signal.aborted) await settle(item, () => item.fail(error)); else throw error; }
        }
      };
      try {
        await inform(`All batch plans prepared. Building the approved application once for ${candidates.length} compatible cases.`);
        owner = candidates.find(item => !outcomes.has(item.job.id) && !item.signal.aborted);
        if (!owner) continue;
        const build = await owner.compile(buildStop.signal);
        const seal = await (adapters.sealBuild || sealCaseBuild)(build, buildStop.signal);
        const attribution = { ...inputs, ownerJobId: owner.job.id, buildVersion: build.version, artifactDigest: seal.artifactDigest };
        const verify = async signal => {
          signal?.throwIfAborted();
          const current = await (adapters.buildInputs || caseBuildInputs)({ ...owner, signal });
          if (current.buildKey !== inputs.buildKey) throw new Error('The shared build SDK or build recipe changed. Rebuild before validating another case.');
          await seal.verify(signal);
          const status = await runCommand('git', ['-c', 'core.longpaths=true', '-C', build.worktree, 'status', '--porcelain'], { env: cleanEnvironment(), signal });
          const head = await runCommand('git', ['-C', build.worktree, 'rev-parse', 'HEAD'], { env: cleanEnvironment(), signal });
          if (status.output.trim() || head.output.trim() !== owner.job.approvedTarget.sourceCommit) throw new Error('The shared application source or Git identity changed after its approved build.');
        };
        shared = { build, attribution, verify }; await verify(buildStop.signal);
        await writeFile(path.join(owner.root, 'shared-build.json'), JSON.stringify({ batchId: batch.id, ...attribution,
          applicationSourceCommit: owner.job.approvedTarget.sourceCommit, applicationWorktree: build.worktree,
          caseJobIds: candidates.map(item => item.job.id), artifacts: seal.entries }, null, 2));
        await inform(`Shared application build ${build.version} is ready. Each case now gets a fresh isolated host and two validation runs.`, { sharedBuild: attribution });
      } catch (error) {
        shared = null;
        for (const item of candidates) if (!outcomes.has(item.job.id)) await settle(item, () => item.fail(error));
      } finally { for (const item of candidates) item.signal.removeEventListener('abort', stopWhenUnused); }
      if (!shared) continue;
      for (const item of candidates) if (!outcomes.has(item.job.id)) await settle(item, () => item.signal.aborted ? item.fail(item.signal.reason) : item.run(shared));
    }
  } finally {
    // Unexpected coordinator errors cannot strand a prepared case or its lease.
    for (const item of prepared) if (!outcomes.has(item.job.id)) await settle(item, () => item.fail(new Error('The shared-build batch stopped before validation.')));
    await Promise.all(ownership.map(owner => owner.stop()));
  }
  return batch.claims.map(claim => outcomes.get(claim.job.id));
}
