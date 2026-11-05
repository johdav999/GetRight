import { setTimeout as delay } from 'node:timers/promises';
import { settings, api } from './settings.mjs';
import { RunSessions } from './run-sessions.mjs';
import { workerPresence } from './worker-presence.mjs';
import { executeCleanup } from './cleanup.mjs';
import { executeJob } from './jobs.mjs';
import { executeCaseImplementation } from './case-implementation.mjs';
import { executeCaseImplementationBatch } from './case-batch.mjs';
import { workflowEngineDigest } from './workflow-engine.mjs';
import { workerSourceStamp, reloadExitCode } from './worker-version.mjs';

const configuration = settings();
if (process.argv.includes('--auto-close')) configuration.keepBrowserOpen = false;
const once = process.argv.includes('--once');
const loadedSourceStamp = process.env.GETRIGHT_WORKER_SOURCE_STAMP || await workerSourceStamp();
let stopping = false;
const shutdown = new AbortController();
configuration.signal = shutdown.signal;
let presence;
const sessions = new RunSessions(configuration, { changed: () => { void presence?.refresh(); } });
const stop = () => { stopping = true; shutdown.abort(new Error('Local worker stopped.')); void sessions.stop().catch(error => console.error(error.message)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (process.connected) {
  process.on('disconnect', stop);
  process.on('message', message => { if (message?.type === 'getright-stop') stop(); });
}
console.log(`Getright worker · ${configuration.dashboardUrl} · ${configuration.headless ? 'headless' : 'visible browser'}`);
try {
do {
  try {
    if (await workerSourceStamp() !== loadedSourceStamp) {
      console.log('Worker source changed. Releasing this idle worker for reload.');
      await sessions.stop('worker-updated');
      process.exitCode = reloadExitCode;
      break;
    }
    presence ??= await workerPresence(configuration, () => sessions.reviewRunIds);
    let implementation;
    try { implementation = await api(configuration.dashboardUrl, `/api/worker/case-implementations/${once ? 'claim' : 'claim-batch'}`, {}); }
    catch (error) {
      // An updated worker can still service an older local dashboard while its
      // next guarded upgrade is pending. Older servers retain single-case builds.
      if (!once && error.message.startsWith('Getright API 404:')) implementation = await api(configuration.dashboardUrl, '/api/worker/case-implementations/claim', {});
      else throw error;
    }
    if (implementation) {
      await presence.set('case-implementation', implementation.claims ? implementation.claims.map(c => c.job.id) : [implementation.job.id]);
      if (implementation.claims) console.log(`Preparing ${implementation.claims.length} queued test cases in shared-build batch ${implementation.id}.`);
      else console.log(`Implementing test case ${implementation.job.testId} (${implementation.job.id}).`);
      const results = implementation.claims ? await executeCaseImplementationBatch(implementation, configuration) : [await executeCaseImplementation(implementation, configuration)];
      for (const result of results) {
      console.log(`Test implementation: ${result.status}. Application acceptance remains separate.`);
      if (result.status !== 'verified') {
        console.error(`Reason: ${result.error || 'No failure reason was recorded. Review the attempt details.'}`);
        console.log(`Details: ${new URL(`/case-implementations/${result.id}`, configuration.dashboardUrl).href}`);
        if (result.error?.startsWith('Implementation blocked:')) console.log('Fix the listed fixture or application prerequisites before retrying. Installing Chromium does not supply those prerequisites.');
      }
      if (once && result.status !== 'verified') process.exitCode = 1;
      }
      await presence.set('idle');
      if (!once && !stopping) await delay(2000);
      continue;
    }
    const job = await api(configuration.dashboardUrl, '/api/worker/jobs/claim', {});
    if (job) {
      await presence.set('improvement', [job.job.id]);
      console.log(`Implementing ${job.job.id} in a dedicated worktree.`);
      const result = await executeJob(job, configuration);
      console.log(`Implementation result: ${result.status}.`);
      if (once && result.status !== 'awaiting-review') process.exitCode = 1;
    } else {
      const cleanup = await api(configuration.dashboardUrl, '/api/worker/cleanup/claim', {});
      if (cleanup) {
        await presence.set('cleanup', [cleanup.task.id]);
        const result = await executeCleanup(cleanup, configuration);
        console.log(`Cleanup ${cleanup.task.id}: ${result.status}.`);
        if (once && result.status !== 'completed') process.exitCode = 1;
      } else {
        const claim = await api(configuration.dashboardUrl, '/api/worker/claim', { workflowEngineDigest, supportsStepControl: true });
        if (claim) {
          await presence.set('run', [claim.run.id]);
          console.log(`Running ${claim.run.testId} (${claim.run.id})`);
          const completed = await sessions.execute(claim);
          console.log(`Result: ${completed.status}. Human acceptance: ${completed.acceptance}.`);
          if (sessions.reviewRunIds.includes(claim.run.id)) console.log(`Browser retained independently for review: ${configuration.dashboardUrl}/runs/${claim.run.id}/live. The queue is available for the next test.`);
          if (once && completed.status !== 'passed') process.exitCode = 1;
        } else if (once) console.log('No queued tests, implementation jobs or cleanup tasks.');
      }
    }
  } catch (error) {
    console.error(error.message);
    if (once) process.exitCode = 1;
  }
  await presence.set('idle');
  if (!once && !stopping) await delay(2000);
} while (!once && !stopping);
if (once && !stopping) await sessions.waitForReviews();
} finally { await sessions.stop(); await presence?.stop(); }
// The supervisor's IPC listener must not keep an idle/--once worker alive after
// its queue loop exits, including an intentional source-update handoff.
if (process.connected) process.disconnect();
