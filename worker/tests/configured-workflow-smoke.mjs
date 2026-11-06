import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api, repositoryRoot } from '../src/settings.mjs';
import { executeRun, workerClaim } from '../src/run-execution.mjs';
import { RunSessions } from '../src/run-sessions.mjs';
import { dashboardHost } from './dashboard-host.mjs';
import { createWriterAppContractHost } from './writerapp-contract-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `configured-workflow-${Date.now()}`);
const source = process.env.GETRIGHT_DASHBOARD_DLL || path.join(repositoryRoot, 'src/Getright.Dashboard/bin/Release/net10.0/Getright.Dashboard.dll');
const build = path.join(dataPath, 'dashboard-bin');
await cp(path.dirname(source), build, { recursive: true });
const catalogFile = path.join(build, 'catalog.json');
const manifestFile = path.join(build, 'application-manifests.json');
const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
const manifests = JSON.parse(await readFile(manifestFile, 'utf8'));
const manifest = manifests.find(item => item.applicationId === 'writerapp');
manifest.workflowPosts = ['/uat/probe'];
const credentials = { GETRIGHT_UAT_WORKFLOW_NAME: 'workflow-guest', GETRIGHT_UAT_WORKFLOW_PASSWORD: randomUUID() };
manifest.runtime.identities.push({ name: 'guest', subject: 'workflow-guest',
  form: { path: '/uat/login', usernameRef: 'GETRIGHT_UAT_WORKFLOW_NAME', passwordRef: 'GETRIGHT_UAT_WORKFLOW_PASSWORD' },
  checks: [{ path: '/uat/whoami', assertions: [{ field: 'user', binding: 'identity' }] }] });
await writeFile(manifestFile, JSON.stringify(manifests));
Object.assign(process.env, credentials);

const body = 'Content for {{fixtureId}}';
const button = name => ({ role: 'button', name });
const editor = { css: '.ProseMirror[contenteditable=true]' };
const makeTest = (id, steps) => ({ id, applicationId: 'writerapp', title: id, purpose: 'Disposable workflow test',
  readiness: 'setup-required', adapter: 'configured-v2', reviewQuestion: 'Is the evidence clear?',
  steps: steps.map(step => ({ id: step.stepId, title: step.stepId, expected: 'The configured assertions pass.' })),
  workflow: { version: 2, reviewPath: '/app/documents', steps } });
const mixed = makeTest('configured-persistence', [
  { stepId: 'open', actions: [
    { kind: 'extension', extension: { id: 'writerapp-onboarding', version: 1 } },
    { kind: 'goto', path: '/app/documents' }, { kind: 'expect-visible', locator: button('Create new document') }
  ] },
  { stepId: 'create', actions: [
    { kind: 'click', locator: button('Create new document'), http: { method: 'POST', path: '/api/documents',
      capture: { name: 'documentId', field: 'document.id', type: 'uuid', resourceKind: 'document' } } },
    { kind: 'request', http: { path: '/api/documents/{{documentId}}', assertions: [{ field: 'id', equalsValue: '{{documentId}}' }],
      capture: { name: 'sectionId', field: 'sectionId', type: 'uuid' } } },
    { kind: 'fill', locator: editor, value: body }, { kind: 'expect-text', locator: editor, value: body }
  ] },
  { stepId: 'save', actions: [
    { kind: 'click', locator: button('Document actions') }, { kind: 'click', locator: button('Save now') },
    { kind: 'request', http: { path: '/api/sections/{{sectionId}}/pages', attempts: 3, assertions: [{ field: '0.content', equalsValue: body }] } }
  ] },
  { stepId: 'reopen', actions: [{ kind: 'reload' }, { kind: 'expect-text', locator: editor, value: body }] }
]);
const apiOnly = makeTest('configured-api-only', [{ stepId: 'guest', actions: [
  { kind: 'request', http: { path: '/uat/probe', method: 'POST', status: 201, session: 'guest', body: { name: '{{fixtureId}}' },
    assertions: [{ field: 'name', equalsValue: '{{fixtureId}}' }, { field: 'actor', binding: 'identity' }] } }
] }]);
const missing = makeTest('configured-missing', [{ stepId: 'wait', actions: [
  { kind: 'goto', path: '/app/documents' }, { kind: 'expect-visible', locator: { testId: 'never-exists' }, timeoutMs: 400 }
] }]);
const slow = structuredClone(missing);
slow.id = 'configured-slow'; slow.workflow.steps[0].actions[1].timeoutMs = 15000;
const redirect = makeTest('configured-redirect', [{ stepId: 'open', actions: [
  { kind: 'goto', path: '/uat/redirect' }, { kind: 'expect-visible', locator: { css: 'body' } }
] }]);
const example = JSON.parse(await readFile(path.join(repositoryRoot, 'config/examples/writerapp-api-readiness.json'), 'utf8'));
catalog.tests.push(mixed, apiOnly, missing, slow, redirect, example);
await writeFile(catalogFile, JSON.stringify(catalog));

let escaped = 0;
let posts = 0;
let failPersistence = false;
const other = createServer((_, res) => { escaped++; res.end('Outside the tested origin'); });
other.listen(0, '127.0.0.1'); await once(other, 'listening');
const app = await createWriterAppContractHost({ async handle({ request, response, url, json }) {
  const guest = request.headers.cookie === 'workflow=guest';
  if (url.pathname === '/uat/login') {
    const form = new URLSearchParams(await readBody(request));
    if (form.get('username') !== credentials.GETRIGHT_UAT_WORKFLOW_NAME || form.get('password') !== credentials.GETRIGHT_UAT_WORKFLOW_PASSWORD || request.headers.cookie)
      response.writeHead(403).end();
    else response.writeHead(204, { 'Set-Cookie': 'workflow=guest; Path=/; HttpOnly' }).end();
    return true;
  }
  if (url.pathname === '/uat/whoami') { json({ user: guest ? 'workflow-guest' : 'unexpected-user' }); return true; }
  if (url.pathname === '/uat/probe' && request.method === 'POST') {
    posts++;
    if (!guest) response.writeHead(403).end();
    else { response.statusCode = 201; json({ name: JSON.parse(await readBody(request)).name, actor: 'workflow-guest' }); }
    return true;
  }
  if (url.pathname === '/uat/redirect') { response.writeHead(302, { Location: `http://127.0.0.1:${other.address().port}/escape` }).end(); return true; }
  if (failPersistence && url.pathname.startsWith('/api/sections/')) { json([{ content: 'missing persistence' }]); return true; }
  return false;
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
const reviews = new RunSessions({ ...configuration, keepBrowserOpen: true });
const queue = testId => api(origin, '/api/runs', { testId });
const claim = () => api(origin, '/api/worker/claim', workerClaim);
const run = async (testId, overrides = {}) => { await queue(testId); return executeRun(await claim(), { ...configuration, ...overrides }); };

try {
  await api(origin, '/api/applications/writerapp/profile', { applicationId: 'writerapp', baseUrl: app.origin,
    expectedBuildVersion: app.state.version, expectedUserId: app.state.userId, isolatedDataConfirmed: true });
  const queued = await queue(mixed.id);
  assert.equal(await api(origin, '/api/worker/claim', { ...workerClaim, configuredWorkflowVersion: undefined }), null);
  const passed = await sessions.execute(await claim());
  assert.equal(passed.id, queued.id);
  assert.equal(passed.status, 'passed', passed.error);
  assert.equal(passed.acceptance, 'pending');
  assert(passed.runtime.verifiedAfter);
  assert.equal(app.state.creates, 1, 'The response observer must capture the single click-created resource.');
  assert.equal(passed.identity.resources[0].kind, 'document');
  assert.equal(app.state.documents.get(passed.identity.resources[0].id).content, `Content for ${queued.fixtureId}`);
  assert.deepEqual(passed.steps.map(step => step.stepId), ['open', 'create', 'save', 'reopen']);
  assert.equal(passed.steps[1].apiObservations[0].method, 'POST');
  for (const evidence of [...passed.steps.map(step => step.screenshot), passed.trace]) assert.equal((await fetch(`${origin}/api/evidence/${evidence}`)).status, 200);
  const feedback = await api(origin, `/api/runs/${passed.id}/feedback`, { stepId: 'save', comment: 'Show status.', requestedOutcome: 'Keep saved status visible.' });
  assert(feedback.prompt.includes(passed.fixtureId));
  assert(feedback.prompt.includes(passed.configuration.workflowDigest));
  const apiResult = await run(apiOnly.id);
  assert.equal(apiResult.status, 'passed', apiResult.error);
  assert.deepEqual(apiResult.steps[0].apiObservations, [{ method: 'POST', path: '/uat/probe', status: 201, session: 'guest' }]);
  assert.equal(posts, 1);
  const stepped = await api(origin, '/api/runs', { testId: example.id, docked: true, stepByStep: true });
  const stepRun = reviews.execute(await claim());
  for (const definition of example.steps) {
    const deadline = Date.now() + 10000;
    let status;
    do {
      status = await api(origin, `/api/runs/${stepped.id}/browser`);
      if (status.canAdvance && status.stepId === definition.id) break;
      await delay(100);
    } while (Date.now() < deadline);
    assert(status.canAdvance && status.stepId === definition.id, 'The dock must wait for the exact configured step.');
    await api(origin, `/api/runs/${stepped.id}/browser/advance`, { stepId: definition.id });
  }
  const steppedResult = await stepRun;
  assert.equal(steppedResult.status, 'passed', steppedResult.error);
  assert.equal(steppedResult.acceptance, 'pending');
  const reviewDeadline = Date.now() + 5000;
  let phase;
  do {
    phase = (await api(origin, `/api/runs/${stepped.id}/browser`)).phase;
    if (phase === 'review') break;
    await delay(100);
  } while (Date.now() < reviewDeadline);
  assert.equal(phase, 'review');
  await api(origin, `/api/runs/${stepped.id}/browser/close`, {});
  await reviews.waitForReviews();
  assert.deepEqual(await api(origin, `/api/runs/${stepped.id}`), steppedResult);

  failPersistence = true;
  const persistence = await run(mixed.id);
  assert.equal(persistence.status, 'failed');
  assert.equal(persistence.steps.at(-1).stepId, 'save');
  assert.match(persistence.error, /did not match its assertion/);
  failPersistence = false;
  const absent = await run(missing.id);
  assert.equal(absent.status, 'failed');
  assert(absent.steps[0].screenshot);
  const forbidden = await run(redirect.id);
  assert.equal(forbidden.status, 'failed');
  assert.equal(escaped, 0);
  const timeout = await run(slow.id, { runTimeoutMs: 1500 });
  assert.equal(timeout.status, 'failed');
  assert.match(timeout.error, /configured time limit/);
  const toCancel = await queue(slow.id);
  const running = executeRun(await claim(), configuration);
  await delay(400);
  await api(origin, `/api/runs/${toCancel.id}/cancel`, {});
  assert.equal((await running).status, 'cancelled');

  await dashboard.stop();
  mixed.workflow.steps[0].actions[1].path = '/app/{{futureValue}}';
  await writeFile(catalogFile, JSON.stringify(catalog));
  await assert.rejects(dashboard.start(), /Unsupported action, input or variable/);
  await dashboard.stop();
  mixed.workflow.steps[0].actions[1].path = '//outside.invalid/test';
  await writeFile(catalogFile, JSON.stringify(catalog));
  await assert.rejects(dashboard.start(), /Unsupported action, input or variable/);
  await dashboard.stop();
  mixed.workflow.steps[0].actions[1].path = '/app/documents';
  apiOnly.workflow.steps[0].actions[0].http.path = '/api/documents';
  await writeFile(catalogFile, JSON.stringify(catalog));
  await assert.rejects(dashboard.start(), /Unsupported action, input or variable in test 'configured-api-only'/);
  console.log(`PASS: authored browser/API workflow, named session, observed creation, readback, evidence, timeout, cancellation and validation. Evidence: ${dataPath}`);
} finally {
  await sessions.stop();
  await reviews.stop();
  await dashboard.stop();
  await app.close();
  await new Promise(resolve => other.close(resolve));
  for (const key of Object.keys(credentials)) delete process.env[key];
}
