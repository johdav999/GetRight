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
  return {
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
  return response.status === 204 ? null : response.json();
}
