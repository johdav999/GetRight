import { executeRun } from './run-execution.mjs';

// A standalone run owns its browser in this process, including manual review.
// Parent IPC loss ends ownership and closes the browser even after a crash.
const stop = new AbortController();
const shutdown = () => stop.abort(new Error('The owning local worker stopped.'));
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('disconnect', shutdown);
const send = message => new Promise((resolve, reject) => {
  if (!process.connected) { shutdown(); reject(new Error('Run owner disconnected.')); return; }
  process.send(message, error => error ? reject(error) : resolve());
});
let started = false;
let lastOwner = Date.now();
const ownerWatch = setInterval(() => { if (Date.now() - lastOwner > 8000) shutdown(); }, 1000);
ownerWatch.unref();
process.on('message', async message => {
  if (message?.type === 'owner-alive') { lastOwner = Date.now(); return; }
  if (message?.type === 'getright-stop') { shutdown(); return; }
  if (message?.type !== 'start-run' || started) return;
  started = true;
  try {
    const run = await executeRun(message.claim, { ...message.configuration, signal: stop.signal,
      onReviewReady: async ({ run }) => { await send({ type: 'review-ready', run }); } });
    await send({ type: 'run-finished', run });
  } catch (error) { await send({ type: 'run-error', error: String(error.message).slice(0, 2000) }).catch(() => {}); process.exitCode = 1; }
  finally { clearInterval(ownerWatch); if (process.connected) process.disconnect(); }
});
