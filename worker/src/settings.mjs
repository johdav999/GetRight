import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The dashboard URL must be a loopback HTTP origin, such as http://127.0.0.1:5120.');
  }
  return url.origin;
}

export function settings(env = process.env) {
  const runTimeoutMs = Number(env.GETRIGHT_RUN_TIMEOUT_MS || 180000);
  if (!Number.isInteger(runTimeoutMs) || runTimeoutMs < 1000 || runTimeoutMs > 600000) throw new Error('Run timeout must be between 1000 and 600000 milliseconds.');
  return {
    runTimeoutMs,
    dashboardUrl: localUrl(env.GETRIGHT_DASHBOARD_URL || 'http://127.0.0.1:5120'),
    dataPath: path.resolve(env.GETRIGHT_DATA_PATH || path.join(repositoryRoot, 'data')),
    headless: env.GETRIGHT_HEADLESS === 'true',
  };
}

export async function api(origin, route, body) {
  const response = await fetch(`${origin}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Getright API ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  const value = await response.text();
  return value ? JSON.parse(value) : null;
}
