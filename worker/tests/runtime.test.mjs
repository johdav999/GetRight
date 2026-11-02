import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { verifyRuntime } from '../src/writerapp-host.mjs';

async function runtime(handler) {
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
test('runtime readiness uses the actual Fetch response and exact reported build', async () => {
  let requests = 0;
  const host = await runtime((request, response) => {
    requests++;
    if (requests === 1) { response.statusCode = 503; response.end(); return; }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ version: '0.2.1.42' }));
  });
  try { await verifyRuntime(host.origin, '0.2.1.42', { timeoutMs: 3000 }); assert(requests >= 2); await assert.rejects(verifyRuntime(host.origin, 'old-build'), /different build version/); }
  finally { await host.close(); }
});
test('readiness failure is bounded and cancellation propagates', async () => {
  const host = await runtime((request, response) => { response.statusCode = 503; response.end(); });
  try {
    await assert.rejects(verifyRuntime(host.origin, '0.2.1.42', { timeoutMs: 100 }), /HTTP 503/);
    await assert.rejects(verifyRuntime(host.origin, '0.2.1.42', { signal: AbortSignal.timeout(50) }), /timeout|aborted/i);
  } finally { await host.close(); }
});
