import { setTimeout as delay } from 'node:timers/promises';
import { settings, api } from './settings.mjs';
import { executeRun } from './runner.mjs';
import { executeCleanup } from './cleanup.mjs';
import { executeJob } from './jobs.mjs';

const configuration = settings();
const once = process.argv.includes('--once');
let stopping = false;
const shutdown = new AbortController();
configuration.signal = shutdown.signal;
const stop = () => { stopping = true; shutdown.abort(new Error('Local worker stopped.')); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(`Getright worker · ${configuration.dashboardUrl} · ${configuration.headless ? 'headless' : 'visible browser'}`);
do {
  try {
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
        const claim = await api(configuration.dashboardUrl, '/api/worker/claim', {});
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
