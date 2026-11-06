import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { api } from './settings.mjs';
import { boundedLog, cleanEnvironment, stopProcess } from './processes.mjs';
import { runtimeEnvironment } from './runtime-configuration.mjs';

export class RunSessions {
  constructor(configuration, { reviewLimit = 3, changed = () => {} } = {}) {
    if (!Number.isInteger(reviewLimit) || reviewLimit < 1 || reviewLimit > 3) throw new Error('Retain between one and three browser reviews.');
    this.configuration = configuration; this.reviewLimit = reviewLimit; this.changed = changed;
    this.entries = new Map(); this.stopping = false;
  }
  get reviewRunIds() { return [...this.entries.values()].filter(e => e.review).map(e => e.id); }
  async execute(claim) {
    if (this.stopping) return api(this.configuration.dashboardUrl, `/api/runs/${claim.run.id}/complete`, {lease:claim.lease,status:'interrupted',steps:[],error:'The local worker stopped before launching this run.'});
    const { configuration } = this, id = claim.run.id;
    if (!/^[a-f0-9]{32}$/.test(id) || this.entries.has(id)) throw new Error('Invalid or duplicate run session.');
    const root = path.join(configuration.dataPath, 'run-workers', id); await mkdir(root, { recursive: true });
    const stdout = boundedLog(path.join(root, 'stdout.log')), stderr = boundedLog(path.join(root, 'stderr.log'));
    const child = fork(fileURLToPath(new URL('./run-child.mjs', import.meta.url)), [], {
      env: { ...cleanEnvironment(), ...runtimeEnvironment(claim.run), ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}) },
      windowsHide: true, detached: process.platform !== 'win32', execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.on('data', stdout); child.stderr.on('data', stderr);
    let resolve, reject, settled = false;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const finish = (run, error) => { if (settled) return; settled = true; error ? reject(error) : resolve(run); };
    const entry = { id, child, review: false }; this.entries.set(id, entry);
    const ownerPulse = setInterval(() => { if (child.connected) child.send({type:'owner-alive'}, () => {}); }, 2000); ownerPulse.unref();
    entry.done = new Promise(done => child.once('close', async (code, signal) => {
      clearInterval(ownerPulse);
      this.entries.delete(id); this.changed();
      if (!settled) {
        try {
          const stored = await api(configuration.dashboardUrl, `/api/runs/${id}`);
          if (!['queued', 'running'].includes(stored.status)) finish(stored);
          else finish(await api(configuration.dashboardUrl, `/api/runs/${id}/complete`, {
            lease: claim.lease, status: 'interrupted', steps: [], error: `${entry.failureMessage || `The isolated run process exited (${signal || code}).`} See data/run-workers/${id}.`,
          }));
        } catch (error) { finish(null, error); }
      }
      done();
    }));
    child.once('error', error => { entry.failureMessage = error.message; });
    child.on('message', message => {
      if (message?.type === 'run-error') { entry.failureMessage = message.error; return; }
      if (!['review-ready', 'run-finished'].includes(message?.type) || message.run?.id !== id || !['passed', 'failed', 'interrupted', 'cancelled'].includes(message.run.status)) return;
      if (message.type === 'review-ready') {
        if (entry.review) return;
        entry.review = true; this.changed();
        void (async () => {
          while (this.reviewRunIds.length > this.reviewLimit) await this.close(this.reviewRunIds[0], 'capacity');
          finish(message.run);
        })().catch(error => finish(null, error));
      } else finish(message.run);
    });
    const { dashboardUrl, dataPath, headless, keepBrowserOpen, runTimeoutMs, stepPauseTimeoutMs } = configuration;
    try {
      await writeFile(path.join(root,'owner.json'),JSON.stringify({ownerProcessId:process.pid,runProcessId:child.pid,startedAt:new Date().toISOString()}));
      child.send({ type: 'start-run', claim, configuration: { dashboardUrl, dataPath, headless, keepBrowserOpen, runTimeoutMs, stepPauseTimeoutMs } }, error => { if (error) finish(null, error); });
    } catch (error) { await this.close(id); throw error; }
    return result;
  }
  async close(id, reason = 'worker-stopped') {
    const entry = this.entries.get(id); if (!entry) return;
    return entry.closing ??= (async () => {
      if (entry.review) await fetch(`${this.configuration.dashboardUrl}/api/runs/${id}/browser/close?reason=${reason}`, {
        method:'POST',headers:{'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(2000),
      }).catch(() => {});
      if (entry.child.connected) entry.child.send({ type: 'getright-stop' }, () => {});
      let timeout;
      await Promise.race([entry.done, new Promise(resolve => { timeout = setTimeout(resolve, 5000); })]); clearTimeout(timeout);
      await stopProcess(entry.child); await entry.done;
    })();
  }
  async waitForReviews() { await Promise.all([...this.entries.values()].map(entry => entry.done)); }
  async stop(reason = 'worker-stopped') {
    this.stopping = true;
    await Promise.all([...this.entries.keys()].map(id => this.close(id, reason)));
  }
}
