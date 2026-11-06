import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { api, repositoryRoot } from '../src/settings.mjs';
import { executeRun, workerClaim } from '../src/run-execution.mjs';
import { dashboardHost } from './dashboard-host.mjs';
import { createWriterAppContractHost } from './writerapp-contract-host.mjs';

const dataPath = path.join(repositoryRoot, '.local', `application-configuration-${Date.now()}`);
await mkdir(dataPath, { recursive: true });
const workerConfig = path.join(dataPath, 'worker.local.json');
await writeFile(workerConfig, JSON.stringify({ recipes: { 'authorized-node': {
  applicationId: 'writerapp', version: 2, repositoryPath: 'private-source-location', sourceMarker: 'package.json',
  process: { build: { executable: 'node', script: 'tools/build.mjs', args: [] }, launch: { executable: 'node', args: [] }, artifact: 'app.mjs', readyPath: '/ready' },
} } }));
const dashboard = await dashboardHost(dataPath, { environment: { GETRIGHT_WORKER_CONFIG: workerConfig } });
const origin = dashboard.origin;
let checkEntered, resumeCheck;
const app = await createWriterAppContractHost({ async handle({ url }) {
  if (url.pathname === '/api/app/version' && resumeCheck) {
    checkEntered();
    await resumeCheck;
    resumeCheck = null;
  }
  return false;
} });
const appRoute = '/api/applications/writerapp';
const configuration = { dashboardUrl: origin, dataPath, headless: true, keepBrowserOpen: false };
const definition = JSON.parse(await readFile(path.join(repositoryRoot, 'config/examples/writerapp-api-readiness.json'), 'utf8'));
const runRoute = `/api/tests/${definition.id}`;
const profile = { applicationId: 'writerapp', baseUrl: app.origin, expectedBuildVersion: app.state.version,
  expectedUserId: app.state.userId, isolatedDataConfirmed: true, sourceCommit: 'a'.repeat(40) };
const rejected = (route, body, expected) => assert.rejects(api(origin, route, body), expected ?? /400/);
async function executeNext() {
  const claim = await api(origin, '/api/worker/claim', workerClaim);
  assert(claim, 'The worker should claim the queued run.');
  const result = await executeRun(claim, configuration);
  assert.equal(result.status, 'passed', result.error);
  assert.equal(result.acceptance, 'pending');
  assert(result.trace && result.steps.every(step => step.screenshot));
  return result;
}
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto(`${origin}/applications`);
  const binding = page.getByRole('region', { name: 'Target binding' });
  const manifestPanel = page.getByRole('region', { name: 'Application definition' });
  const workflowPanel = page.getByRole('region', { name: 'Workflow definitions' });
  await binding.getByLabel('Application', { exact: true }).selectOption('writerapp');
  await binding.getByLabel('Local application URL').fill(profile.baseUrl);
  await binding.getByLabel('Expected build version').fill(profile.expectedBuildVersion);
  await binding.getByLabel('Dedicated UAT account ID').fill(profile.expectedUserId);
  await binding.getByLabel('Clean source commit from launch receipt').fill(profile.sourceCommit);
  await binding.getByRole('checkbox', { name: /This instance uses isolated/ }).check();
  await binding.getByRole('button', { name: 'Check connection' }).click();
  const preview = binding.getByRole('region', { name: 'Preflight preview' });
  await expect(preview).toContainText('Testing · Ready');
  await expect(preview).toContainText(profile.expectedUserId);
  await expect(preview).toContainText(profile.expectedBuildVersion);
  assert.equal(await api(origin, `${appRoute}/profile`), null, 'Preflight must leave the binding unsaved.');
  assert.equal(app.state.creates, 0);
  assert.equal((await api(origin, '/api/runs')).length, 0);
  await binding.getByRole('button', { name: 'Save setup' }).click();
  await expect(binding.getByRole('status')).toContainText('Setup saved');
  await binding.getByLabel('Expected build version').fill('stale-build');
  await binding.getByRole('button', { name: 'Check connection' }).click();
  await expect(preview).toContainText('Testing · Blocked');
  await expect(preview).toContainText('stale-build');
  assert.equal((await api(origin, `${appRoute}/profile`)).expectedBuildVersion, profile.expectedBuildVersion);

  const initial = await api(origin, `${appRoute}/manifest`);
  const choices = await api(origin, `${appRoute}/recipes`);
  assert.deepEqual(choices.recipes.find(item => item.id === 'authorized-node'), { id: 'authorized-node', version: 2 });
  assert(!JSON.stringify(choices).includes('private-source-location'));
  await rejected(`${appRoute}/manifest`, { revision: initial.revision, definitionJson: JSON.stringify({ ...initial, buildRecipe: { id: 'unapproved', version: 1 } }) }, /authorized/);
  await rejected(`${appRoute}/manifest`, { revision: initial.revision, definitionJson: JSON.stringify({ ...initial, workflowPosts: ['/api/documents'] }) }, /authorized POST/);
  const signIn = structuredClone(initial);
  signIn.runtime.identities.push({ name: 'new-login', subject: 'other', form: { path: '/login', usernameRef: 'GETRIGHT_UAT_OTHER_USER', passwordRef: 'GETRIGHT_UAT_OTHER_PASSWORD' },
    checks: [{ path: '/api/auth/me', assertions: [{ field: 'userId', binding: 'identity' }] }] });
  await rejected(`${appRoute}/manifest`, { revision: initial.revision, definitionJson: JSON.stringify(signIn) }, /Form sign-in/);

  await manifestPanel.getByLabel('Implementation recipe').selectOption('authorized-node@2');
  await expect(manifestPanel.getByLabel('Implementation recipe').locator('option:checked')).toHaveText('authorized-node v2');
  await manifestPanel.getByRole('button', { name: 'Save manifest' }).click();
  await expect(manifestPanel.getByRole('status')).toContainText('Manifest saved');
  const revisedManifest = await api(origin, `${appRoute}/manifest`);
  assert.equal(revisedManifest.revision, initial.revision + 1);
  assert.deepEqual(revisedManifest.buildRecipe, { id: 'authorized-node', version: 2 });
  await rejected(`${appRoute}/manifest`, { revision: initial.revision, definitionJson: JSON.stringify(initial) }, /manifest changed/);

  await workflowPanel.getByText('Edit or import workflow JSON', { exact: true }).click();
  await workflowPanel.getByLabel('Workflow JSON', { exact: true }).fill('{"invalid":true}');
  await workflowPanel.getByRole('button', { name: 'Save workflow' }).click();
  await expect(workflowPanel.getByRole('alert')).toContainText('unsupported schema fields');
  await workflowPanel.getByLabel('Workflow JSON file').setInputFiles({ name: 'workflow.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(definition)) });
  await expect(workflowPanel.getByLabel('Workflow JSON', { exact: true })).toHaveValue(JSON.stringify(definition));
  await workflowPanel.getByRole('button', { name: 'Save workflow' }).click();
  await expect(workflowPanel.getByRole('status')).toContainText('Workflow revision 1 saved');
  await rejected('/api/runs', { testId: definition.id }, /qualification runs/);
  await rejected(`${runRoute}/approve-implementation`, { definitionDigest: 'a'.repeat(64) });
  assert.equal((await fetch(`${origin}/tests/${definition.id}/open`, { redirect: 'manual' })).status, 400);
  const qualification = workflowPanel.getByLabel('Workflow qualification');
  await expect(qualification.getByRole('heading')).toHaveText('Qualification required');
  await qualification.getByRole('button', { name: 'Run qualification' }).click();
  await expect(workflowPanel.getByRole('status')).toContainText('Qualification run queued');
  await rejected(`${runRoute}/qualify`, {}, /in progress/);
  const proof1 = await executeNext();
  assert(proof1.qualificationKey);
  await qualification.getByRole('button', { name: 'Refresh qualification' }).click();
  await expect(qualification.getByRole('link', { name: /Qualification run/ })).toHaveAttribute('href', `/runs/${proof1.id}`);
  await rejected('/api/runs', { testId: definition.id }, /qualification runs/);
  await qualification.getByRole('button', { name: 'Run qualification' }).click();
  await expect(workflowPanel.getByRole('status')).toContainText('Qualification run queued');
  const proof2 = await executeNext();
  assert.equal(proof2.qualificationKey, proof1.qualificationKey);
  assert.notEqual(proof2.fixtureId, proof1.fixtureId);
  await qualification.getByRole('button', { name: 'Refresh qualification' }).click();
  await expect(qualification.getByRole('heading')).toHaveText('Qualified');

  await page.goto(`${origin}/?suite=writerapp-suite`);
  const card = page.locator('.test-card').filter({ has: page.getByRole('button', { name: definition.title, exact: true }) });
  await expect(card.getByRole('button', { name: /^Run UAT test/ })).toBeEnabled();
  await card.getByRole('button', { name: /^Run UAT test/ }).click();
  await expect(page).toHaveURL(/\/runs\/[a-f0-9]{32}\/watch/);
  const normal = await executeNext();
  assert.equal(normal.qualificationKey, undefined);
  assert.equal(normal.definitionRevision, 1);
  assert.equal(normal.configuration.manifest.revision, revisedManifest.revision);
  const feedback = await api(origin, `/api/runs/${normal.id}/feedback`, { stepId: 'build', comment: 'Show the build.', requestedOutcome: 'Show the exact version.' });
  assert(feedback.prompt.includes('Imported workflow revision: 1'));
  assert(feedback.prompt.includes(`Manifest revision: ${revisedManifest.revision}`));
  const accepted = await api(origin, `/api/runs/${normal.id}/review`, { acceptance: 'accepted' });

  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let release;
  resumeCheck = new Promise(resolve => { release = resolve; });
  checkEntered = entered;
  const racing = rejected('/api/runs', { testId: definition.id }, /qualification runs|changed during preflight/);
  await waiting;
  const edited = { ...definition, title: `${definition.title} revised` };
  const saved = await api(origin, `${appRoute}/workflows`, { revision: 1, id: definition.id, definitionJson: JSON.stringify(edited) });
  release(); await racing;
  assert.equal(saved.revision, 2);
  assert.deepEqual(await api(origin, `/api/runs/${normal.id}`), accepted);
  assert.equal((await api(origin, `${runRoute}/qualification`)).qualified, false);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/applications`);
  await expect(page.getByLabel('Workflow qualification').getByRole('heading')).toHaveText('Qualification required');
  await expect(page.getByLabel('Workflow', { exact: true })).toHaveValue(definition.id);
  await page.getByRole('region', { name: 'Workflow definitions' }).getByText('Edit or import workflow JSON', { exact: true }).click();
  await expect(page.getByLabel('Workflow JSON', { exact: true })).toBeVisible();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The mobile configuration editor must fit the viewport.');
  await page.screenshot({ path: path.join(dataPath, 'configuration-mobile.png'), fullPage: true });

  for (let index = 0; index < 2; index++) { await api(origin, `${runRoute}/qualify`, {}); await executeNext(); }
  assert.equal((await api(origin, `${runRoute}/qualification`)).qualified, true);
  await api(origin, `${appRoute}/profile`, { ...profile, sourceCommit: 'b'.repeat(40) });
  assert.equal((await api(origin, `${runRoute}/qualification`)).qualified, false);
  await api(origin, `${appRoute}/profile`, profile);
  assert.equal((await api(origin, `${runRoute}/qualification`)).qualified, true);
  const nextManifest = { ...revisedManifest, capabilities: ['test'], buildRecipe: undefined };
  await api(origin, `${appRoute}/manifest`, { revision: revisedManifest.revision, definitionJson: JSON.stringify(nextManifest) });
  await rejected('/api/runs', { testId: definition.id }, /qualification runs/);

  await dashboard.stop(); await dashboard.start();
  assert.equal((await api(origin, `${appRoute}/manifest`)).revision, revisedManifest.revision + 1);
  assert.equal((await api(origin, `${appRoute}/workflows`))[0].revision, 2);
  assert.deepEqual(await api(origin, `/api/runs/${normal.id}`), accepted);
  console.log(`PASS: configuration editors, read-only preview, recipe authority, two-run qualification, preflight races, mobile layout and historical provenance. Evidence: ${dataPath}`);
} finally {
  await browser?.close(); await dashboard.stop(); await app.close();
}
