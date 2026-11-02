import { setTimeout as delay } from 'node:timers/promises';
import { settings, api } from './settings.mjs';
import { executeRun } from './runner.mjs';

const configuration = settings();
const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
console.log(`Getright worker · ${configuration.dashboardUrl} · ${configuration.headless ? 'headless' : 'visible browser'}`);
do {
  try {
    const claim = await api(configuration.dashboardUrl, '/api/worker/claim', {});
    if (claim) {
      console.log(`Running ${claim.run.testId} (${claim.run.id})`);
      const completed = await executeRun(claim, configuration);
      console.log(`Result: ${completed.status}. Human acceptance: ${completed.acceptance}.`);
      if (once && completed.status !== 'passed') process.exitCode = 1;
    } else if (once) console.log('No queued tests.');
  } catch (error) {
    console.error(error.message);
    if (once) process.exitCode = 1;
  }
  if (!once && !stopping) await delay(2000);
} while (!once && !stopping);
