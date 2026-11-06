import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { api, repositoryRoot } from '../src/settings.mjs';
import { executeRun, workerClaim } from '../src/run-execution.mjs';
import { RunSessions } from '../src/run-sessions.mjs';
import { dashboardHost } from './dashboard-host.mjs';
import { createWriterAppContractHost } from './writerapp-contract-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `runtime-configuration-${Date.now()}`);
const source = process.env.GETRIGHT_DASHBOARD_DLL || path.join(repositoryRoot, 'src/Getright.Dashboard/bin/Release/net10.0/Getright.Dashboard.dll');
const build = path.join(dataPath, 'dashboard-bin');
await cp(path.dirname(source), build, { recursive: true });
const file = path.join(build, 'application-manifests.json');
const manifests = JSON.parse(await readFile(file, 'utf8'));
const manifest = manifests.find(item => item.applicationId === 'writerapp');
const credentials = {};
for (const [name, role] of [['owner', 'editor'], ['guest', 'reader']]) {
  const usernameRef = `GETRIGHT_UAT_SMOKE_${name.toUpperCase()}_NAME`;
  const passwordRef = `GETRIGHT_UAT_SMOKE_${name.toUpperCase()}_PASSWORD`;
  credentials[usernameRef] = name;
  credentials[passwordRef] = `synthetic-${randomUUID()}`;
  manifest.runtime.identities.push({ name, subject: name,
    form: { path: '/uat/sign-in', usernameRef, passwordRef, status: 303 },
    checks: [{ path: '/uat/session', attempts: 2, assertions: [
      { field: 'account.id', binding: 'identity' }, { field: 'roles', contains: [{ field: 'name', equalsValue: role }] },
    ] }, { path: '/uat/denied', status: 403 }] });
}
manifest.runtime.fixtures = [
  { kind: 'workspace', identity: 'owner', values: { name: 'name', email: 'email' } },
  { kind: 'attachment', identity: 'guest' },
];
await writeFile(file, JSON.stringify(manifests));
Object.assign(process.env, credentials);

let isolated = true;
let behavior = 'normal';
let redirected = 0;
let mutations = 0;
let deletes = 0;
let sawPending = false;
const logins = [];
const resources = new Map();
const pending = new Set();
const target = await createWriterAppContractHost({ async handle({ request, response, url, json, state }) {
  const who = /^session=(owner|guest)$/.exec(request.headers.cookie ?? '')?.[1];
  if (url.pathname === '/uat/sign-in') {
    const form = new URLSearchParams(await readBody(request));
    const name = form.get('username');
    logins.push({ name, hadCookie: Boolean(request.headers.cookie) });
    if (!['owner', 'guest'].includes(name) || form.get('password') !== credentials[`GETRIGHT_UAT_SMOKE_${name.toUpperCase()}_PASSWORD`]) {
      response.writeHead(403).end();
    } else {
      pending.add(name);
      response.writeHead(303, { Location: '/uat/redirect', 'Set-Cookie': `session=${name}; Path=/; HttpOnly` }).end();
    }
    return true;
  }
  if (url.pathname === '/uat/redirect') { redirected++; response.writeHead(404).end(); return true; }
  if (url.pathname === '/uat/denied') { response.writeHead(403).end(); return true; }
  if (url.pathname === '/uat/session') {
    if (pending.delete(who)) { sawPending = true; response.writeHead(503).end(); }
    else json({ account: { id: behavior === 'drift' && who === 'guest' ? 'another-user' : who }, roles: [{ name: who === 'owner' ? 'editor' : 'reader' }] });
    return true;
  }
  if (url.pathname.startsWith('/api/sections/') && behavior === 'post-drift') behavior = 'drift';
  if (url.pathname === '/_getright/fixtures') {
    json({ isolated, version: state.version, userId: who });
    return true;
  }
  if (url.pathname === '/api/onboarding/complete' && behavior === 'adapter-fails') {
    response.writeHead(503).end(); return true;
  }
  if (!url.pathname.startsWith('/_getright/fixtures/')) return false;
  const [, , , kind, id] = url.pathname.split('/');
  if (request.method === 'POST') {
    mutations++;
    const data = JSON.parse(await readBody(request));
    const allowed = kind === 'workspace' ? who === 'owner' && data.name === `Getright ${data.fixtureId}` && data.email === `${data.fixtureId}@example.invalid` : who === 'guest';
    if (!allowed || (behavior === 'partial' && kind === 'attachment')) { response.writeHead(503).end(); return true; }
    const receipt = { id: randomUUID(), fixtureId: data.fixtureId };
    resources.set(receipt.id, { ...receipt, who });
    response.statusCode = 201;
    json(receipt);
    return true;
  }
  const resource = resources.get(id);
  if (!resource || who !== resource.who || request.headers['x-getright-fixture'] !== resource.fixtureId) { response.writeHead(403).end(); return true; }
  if (request.method === 'DELETE') {
    deletes++;
    if (behavior === 'adapter-fails') response.writeHead(503).end();
    else { resources.delete(id); response.writeHead(204).end(); }
  } else json({ id, fixtureId: behavior === 'unowned' ? 'another-run' : resource.fixtureId });
  return true;
} });

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const dashboard = await dashboardHost(dataPath, { dllPath: path.join(build, path.basename(source)), environment: credentials });
const origin = dashboard.origin;
const configuration = { dashboardUrl: origin, dataPath, headless: true, keepBrowserOpen: false };
const sessions = new RunSessions(configuration);
const claim = () => api(origin, '/api/worker/claim', workerClaim);
const queue = () => api(origin, '/api/runs', { testId: 'writerapp-create-save' });

try {
  await api(origin, '/api/applications/writerapp/profile', { applicationId: 'writerapp', baseUrl: target.origin,
    expectedUserId: target.state.userId, expectedBuildVersion: target.state.version, isolatedDataConfirmed: true });
  isolated = false;
  assert.equal((await api(origin, '/api/applications/writerapp/readiness')).ready, false);
  assert.equal(mutations, 0);
  isolated = true;

  const queued = await queue();
  assert.equal(await api(origin, '/api/worker/claim', { ...workerClaim, runtimeContractVersion: undefined }), null);
  for (const password of Object.values(credentials).filter(value => value.startsWith('synthetic-'))) assert(!JSON.stringify(queued).includes(password));
  const success = await sessions.execute(await claim());
  assert.equal(success.status, 'passed', success.error);
  assert.equal(success.acceptance, 'pending');
  assert(success.runtime.verifiedAfter);
  assert.deepEqual(success.runtime.fixtures.map(item => item.status), ['deleted', 'deleted']);
  assert.equal(resources.size, 0);
  assert.equal(redirected, 0);
  assert(sawPending && logins.length >= 4 && logins.every(login => !login.hadCookie));

  await queue();
  behavior = 'drift';
  const refused = await executeRun(await claim(), configuration);
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /test identity 'guest'/);
  assert.equal(mutations, 2, 'Identity drift after queueing must block fixture creation.');

  behavior = 'partial';
  await queue();
  const partial = await executeRun(await claim(), configuration);
  assert.equal(partial.status, 'failed');
  assert.match(partial.error, /Fixture setup failed for 'attachment'/);
  assert.deepEqual(partial.runtime.fixtures.map(item => item.status), ['deleted', 'setup-failed']);
  assert.equal(resources.size, 0);

  behavior = 'post-drift';
  await queue();
  const postDrift = await executeRun(await claim(), configuration);
  assert.equal(postDrift.status, 'failed');
  assert.match(postDrift.error, /could not be verified after execution/);
  assert(postDrift.steps.every(step => step.status === 'passed'));
  assert.equal(postDrift.runtime.verifiedAfter, false);

  behavior = 'unowned';
  await queue();
  const priorDeletes = deletes;
  const unowned = await executeRun(await claim(), configuration);
  assert.equal(unowned.status, 'failed');
  assert.deepEqual(unowned.runtime.fixtures.map(item => item.status), ['cleanup-failed', 'cleanup-failed']);
  assert.equal(deletes, priorDeletes, 'A mismatched ownership receipt must prevent DELETE.');

  behavior = 'adapter-fails';
  await queue();
  const failed = await executeRun(await claim(), configuration);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /prepare the isolated WriterApp account/);
  assert.deepEqual(failed.runtime.fixtures.map(item => item.status), ['cleanup-failed', 'cleanup-failed']);
  console.log('PASS: configured checks, polling, separate named logins, isolated capability, ownership, partial setup and cleanup evidence.');
} finally {
  await sessions.stop();
  await dashboard.stop();
  await target.close();
  for (const key of Object.keys(credentials)) delete process.env[key];
}
