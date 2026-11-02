import { setTimeout as delay } from 'node:timers/promises';
import { settings, api } from './settings.mjs';
import { executeRun } from './runner.mjs';
import { executeCleanup } from './cleanup.mjs';
import { executeJob } from './jobs.mjs';
import { executeCaseImplementation } from './case-implementation.mjs';
import { workflowEngineDigest } from './workflow-engine.mjs';
import { workerSourceStamp, reloadExitCode } from './worker-version.mjs';

const configuration = settings();
if (process.argv.includes('--auto-close')) configuration.keepBrowserOpen = false;
const once = process.argv.includes('--once');
const loadedSourceStamp = process.env.GETRIGHT_WORKER_SOURCE_STAMP || await workerSourceStamp();
let stopping = false;
const shutdown = new AbortController();
configuration.signal = shutdown.signal;
const stop = () => { stopping = true; shutdown.abort(new Error('Local worker stopped.')); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (process.connected) {
  process.on('disconnect', stop);
  process.on('message', message => { if (message?.type === 'getright-stop') stop(); });
}
console.log(`Getright worker · ${configuration.dashboardUrl} · ${configuration.headless ? 'headless' : 'visible browser'}`);
do {
  try {
    if (await workerSourceStamp() !== loadedSourceStamp) {
      console.log('Worker source changed. Releasing this idle worker for reload.');
      process.exitCode = reloadExitCode;
      break;
    }
    const implementation = await api(configuration.dashboardUrl, '/api/worker/case-implementations/claim', {});
    if (implementation) {
      console.log(`Implementing test case ${implementation.job.testId} (${implementation.job.id}).`);
      const result = await executeCaseImplementation(implementation, configuration);
      console.log(`Test implementation: ${result.status}. Application acceptance remains separate.`);
      if (once && result.status !== 'verified') process.exitCode = 1;
      if (!once && !stopping) await delay(2000);
      continue;
    }
    const job = await api(configuration.dashboardUrl, '/api/worker/jobs/claim', {});
    if (job) {
      console.log(`Implementing ${job.job.id} in a dedicated worktree.`);
      const result = await executeJob(job, configuration);
      console.log(`Implementation result: ${result.status}.`);
      if (once && result.status !== 'awaiting-review') process.exitCode = 1;
    } else {
      const cleanup = await api(configuration.dashboardUrl, '/api/worker/cleanup/claim', {});
      if (cleanup) {
        const result = await executeCleanup(cleanup, configuration);
        console.log(`Cleanup ${cleanup.task.id}: ${result.status}.`);
        if (once && result.status !== 'completed') process.exitCode = 1;
      } else {
        const claim = await api(configuration.dashboardUrl, '/api/worker/claim', { workflowEngineDigest });
        if (claim) {
          console.log(`Running ${claim.run.testId} (${claim.run.id})`);
          const completed = await executeRun(claim, configuration);
          console.log(`Result: ${completed.status}. Human acceptance: ${completed.acceptance}.`);
          if (once && completed.status !== 'passed') process.exitCode = 1;
        } else if (once) console.log('No queued tests, implementation jobs or cleanup tasks.');
      }
    }
  } catch (error) {
    console.error(error.message);
    if (once) process.exitCode = 1;
  }
  if (!once && !stopping) await delay(2000);
} while (!once && !stopping);
// The supervisor's IPC listener must not keep an idle/--once worker alive after
// its queue loop exits, including an intentional source-update handoff.
if (process.connected) process.disconnect();
