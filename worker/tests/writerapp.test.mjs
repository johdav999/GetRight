import assert from 'node:assert/strict';
import test from 'node:test';
import { writerAppAdapter } from '../src/writerapp.mjs';

function fixture(overrides = {}, responses = {}) {
  const calls = [];
  const target = { applicationId: 'writerapp', baseUrl: 'http://localhost:5387', expectedBuildVersion: '0.1.1.42', expectedUserId: 'dedicated-uat', isolatedDataConfirmed: true, ...overrides };
  const context = { request: { get: async url => {
    calls.push(url);
    return { ok: () => true, json: async () => url.endsWith('/version') ? { version: responses.version ?? '0.1.1.42' } : { isAuthenticated: true, userId: responses.userId ?? 'dedicated-uat' } };
  } } };
  return { target, context, calls };
}

test('WriterApp adapter refuses missing isolation and nonlocal targets', () => {
  for (const overrides of [{ isolatedDataConfirmed: false }, { baseUrl: 'http://example.com' }, { baseUrl: 'http://localhost/?token=secret' }]) {
    const f = fixture(overrides);
    assert.throws(() => writerAppAdapter({}, f.context, { target: f.target }));
  }
});
test('runtime version mismatch stops before checking account or creating data', async () => {
  const f = fixture({}, { version: 'wrong-build' });
  await assert.rejects(writerAppAdapter({}, f.context, { target: f.target }).verify(), /build does not match/);
  assert.equal(f.calls.length, 1);
});
test('a different account cannot run the persistence workflow', async () => {
  const f = fixture({}, { userId: 'personal-account' });
  await assert.rejects(writerAppAdapter({}, f.context, { target: f.target }).verify(), /dedicated UAT account/);
});
test('verified identity is attached to the adapter evidence', async () => {
  const f = fixture(); const adapter = writerAppAdapter({}, f.context, { target: f.target });
  assert.equal(await adapter.verify(), f.target.expectedBuildVersion);
  assert.equal(adapter.identity.userId, f.target.expectedUserId);
});
