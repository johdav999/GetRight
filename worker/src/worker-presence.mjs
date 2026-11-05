import { randomUUID } from 'node:crypto';

// Operational status is ephemeral and independent of run leases/acceptance.
export async function workerPresence(configuration, reviewRunIds) {
  const id = randomUUID().replaceAll('-', ''); let token, kind = 'idle', workIds = [], stopped = false, updating;
  const request = async (route, body) => {
    const r = await fetch(configuration.dashboardUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!r.ok) { token = null; return null; } const text = await r.text(); return text ? JSON.parse(text) : null;
  };
  const update = () => {
    if (updating) return updating;
    updating = (async () => {
      if (!token) token = (await request('/api/worker/presence/connect', { id, processId: process.pid }))?.token;
      if (token) await request(`/api/worker/presence/${id}`, { token, kind, workIds, reviewRunIds: reviewRunIds() });
    })().catch(() => { token = null; }).finally(() => { updating = null; });
    return updating;
  };
  const timer = setInterval(() => { if (!stopped) void update(); }, 4000); timer.unref(); await update();
  return {
    async set(nextKind, nextIds = []) { kind = nextKind; workIds = nextIds; await update(); },
    refresh: update,
    async stop() { stopped = true; clearInterval(timer); await updating; kind = 'stopped'; workIds = []; await update(); },
  };
}
