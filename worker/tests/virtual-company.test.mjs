import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { virtualCompanyAdapter } from '../src/virtual-company.mjs';
import { virtualCompanyGateway } from '../src/virtual-company-host.mjs';

const companyId = '04040404-0404-0404-0404-040404040404';
const target = { applicationId: 'virtual-company', baseUrl: 'http://127.0.0.1:5153', expectedBuildVersion: '0.3.1.1',
  expectedUserId: 'owner-guid', expectedCompanyId: companyId, expectedRole: 'owner', isolatedDataConfirmed: true };
const runtime = { version: '0.3.1.1', userId: 'owner-guid', companyId, role: 'owner', isolated: true };

test('Virtual Company refuses wrong build, owner, role, company or isolation before UI actions', async () => {
  for (const change of [{ version: 'wrong' }, { userId: 'personal-user' }, { companyId: 'another-company' }, { role: 'employee' }, { isolated: false }]) {
    let reads = 0;
    const context = { request: { get: async () => { reads++; return { ok: () => true, json: async () => ({ ...runtime, ...change }) }; } } };
    await assert.rejects(virtualCompanyAdapter({}, context, { target }).verify(), /does not match/);
    assert.equal(reads, 1);
  }
  assert.throws(() => virtualCompanyAdapter({}, {}, { target: { ...target, isolatedDataConfirmed: false } }));
  assert.throws(() => virtualCompanyAdapter({}, {}, { target: { ...target, baseUrl: 'https://example.com' } }));
});

test('Virtual Company requires real API membership in addition to runtime attestation', async () => {
  const context = { request: { get: async url => ({ ok: () => true, json: async () => url.endsWith('/runtime') ? runtime :
    { user: { id: 'owner-guid' }, memberships: [{ companyId, membershipRole: 'owner', status: 'active' }] } }) } };
  const adapter = virtualCompanyAdapter({}, context, { target });
  assert.equal(await adapter.verify(), runtime.version);
  assert.equal(adapter.identity.companyId, null);
  assert.equal(adapter.identity.isolationCompanyId, companyId);
  assert.deepEqual(adapter.identity.roles, ['owner']);
});

test('UAT gateway routes fixed API and web upstreams and fails closed on changed runtime', async () => {
  const api = http.createServer((req, res) => res.end('api'));
  const web = http.createServer((req, res) => res.end('web'));
  api.listen(0, '127.0.0.1'); web.listen(0, '127.0.0.1'); await Promise.all([once(api, 'listening'), once(web, 'listening')]);
  let changed = false;
  const gateway = await virtualCompanyGateway({ apiOrigin: `http://127.0.0.1:${api.address().port}`, webOrigin: `http://127.0.0.1:${web.address().port}`,
    runtimeCheck: async () => { if (changed) throw new Error('Changed'); } });
  try {
    assert.equal(await (await fetch(`${gateway.origin}/api/auth/me`)).text(), 'api');
    assert.equal(await (await fetch(`${gateway.origin}/test-companies/new`)).text(), 'web');
    changed = true; assert.equal((await fetch(`${gateway.origin}/_getright/runtime`)).status, 503);
  } finally { await gateway.stop(); await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => web.close(resolve))]); }
});
