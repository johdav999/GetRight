import { api } from './settings.mjs';

// A lease is renewed only while this operation is owned. Loss of dashboard
// contact stops local work; it never authorizes a retry against a different app.
export function supervise({ configuration, heartbeat, lease, timeoutMs, cancellation = false }) {
  const controller = new AbortController(); let cancelled = false, timedOut = false, inFlight;
  const parentAbort = () => controller.abort(configuration.signal.reason);
  configuration.signal?.addEventListener('abort', parentAbort, { once: true });
  if (configuration.signal?.aborted) parentAbort();
  const renew = () => {
    if (inFlight || controller.signal.aborted) return inFlight;
    inFlight = api(configuration.dashboardUrl, heartbeat, { lease }).then(state => {
      if (cancellation && state.cancelRequested) { cancelled = true; controller.abort(new Error('Cancelled by the local user.')); }
    }).catch(error => controller.abort(new Error(`Lost the worker lease or dashboard connection: ${error.message}`))).finally(() => { inFlight = null; });
    return inFlight;
  };
  const ready = renew();
  const timer = setInterval(renew, 5000);
  let remaining = timeoutMs, started = Date.now(), deadline;
  const armDeadline = () => {
    started = Date.now();
    deadline = setTimeout(() => { if (!controller.signal.aborted) { timedOut = true; controller.abort(new Error('The operation exceeded its configured time limit.')); } }, Math.max(0, remaining));
  };
  armDeadline();
  return { signal: controller.signal, ready, get cancelled() { return cancelled; }, get timedOut() { return timedOut; },
    pauseDeadline: () => {
      clearTimeout(deadline); remaining -= Date.now() - started;
      let resumed = false;
      return () => { if (!resumed && !controller.signal.aborted) { resumed = true; armDeadline(); } };
    },
    stop: async () => { clearInterval(timer); clearTimeout(deadline); configuration.signal?.removeEventListener('abort', parentAbort); await inFlight; } };
}
