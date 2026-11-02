import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { workerSourceStamp, workerRoot, reloadExitCode } from './worker-version.mjs';

// Reload only after the child voluntarily reaches an idle queue boundary.
// Other exit codes are never retried: a failed job must not start another paid turn.
export async function launchWorker({ entry = fileURLToPath(new URL('./index.mjs', import.meta.url)), sourceRoot = workerRoot,
  args = process.argv.slice(2), environment = process.env, signal, log = console.log, stdio = ['inherit', 'inherit', 'inherit', 'ipc'] } = {}) {
  while (!signal?.aborted) {
    const stamp = await workerSourceStamp(sourceRoot);
    if (signal?.aborted) return 0;
    const child = fork(entry, args, { env: { ...environment, GETRIGHT_WORKER_SOURCE_STAMP: stamp }, windowsHide: true, stdio });
    const stop = () => { if (child.connected) child.send({ type: 'getright-stop' }, () => {}); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const kill = () => { try { child.kill(); } catch { } };
    let deadline;
    const boundStop = () => { deadline = setTimeout(kill, 15000); deadline.unref(); };
    signal?.addEventListener('abort', boundStop, { once: true });
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    } finally { clearTimeout(deadline); signal?.removeEventListener('abort', stop); signal?.removeEventListener('abort', boundStop); }
    if (signal?.aborted) return 0;
    if (code !== reloadExitCode) return code ?? 1;
    log('Getright worker updated. Reloading before claiming more work.');
    await delay(250, undefined, { signal }).catch(() => {});
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stop = new AbortController();
  process.on('SIGINT', () => stop.abort()); process.on('SIGTERM', () => stop.abort());
  try { process.exitCode = await launchWorker({ signal: stop.signal }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
