import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { api, localUrl } from './settings.mjs';
import { writerAppAdapter } from './writerapp.mjs';
import { virtualCompanyAdapter } from './virtual-company.mjs';
import { applicationPath, validateWorkflow } from './workflow-plan.mjs';
import { workflowEngineDigest, currentWorkflowEngineDigest } from './workflow-engine.mjs';

export function workflowAdapter(page, context, run, configuration) {
  const binding = run.testSnapshot.implementation;
  if (!binding || binding.engineDigest !== workflowEngineDigest || createHash('sha256').update(binding.planJson).digest('hex') !== binding.planDigest) throw new Error('The verified workflow/engine digest does not match this worker. Reimplement the case with the current worker.');
  const plan = validateWorkflow(run.testSnapshot, binding.planJson);
  const demo = run.applicationId === 'getright', company = run.applicationId === 'virtual-company';
  const origin = localUrl(demo ? configuration.dashboardUrl : run.target?.baseUrl);
  const base = demo ? null : (company ? virtualCompanyAdapter : writerAppAdapter)(page, context, run);
  const identity = base?.identity ?? { userId: run.fixtureId, documentId: null, evidenceKind: 'demo', roles: [] };
  const values = { fixtureId: run.fixtureId, unique: run.id.slice(0, 12), email: `${run.fixtureId}@example.invalid` };
  const expand = value => value?.replace(/\{\{(.*?)\}\}/g, (_, key) => {
    if (values[key] == null) throw new Error(`The ${key} fixture binding is unavailable.`); return values[key];
  });
  let reference;
  const access = () => context.request.get(`${origin}/api/companies/${run.target.expectedCompanyId}/access`, { headers: { 'X-Company-Id': run.target.expectedCompanyId } }).then(async response => { if (!response.ok()) throw new Error('Cannot verify the isolation reference.'); return response.json(); });
  const verify = async () => {
    if (await currentWorkflowEngineDigest() !== workflowEngineDigest) throw new Error('Worker engine files changed during execution. Restart the worker and reverify the case.');
    return demo ? (await api(origin, '/api/health')).version : base.verify();
  };
  const prepare = async () => {
    if (demo) return;
    if (company) {
      reference = await access();
      await base.actions.workflow(); await base.actions.create();
      values.companyId = identity.companyId;
      const response = await context.request.post(`${origin}/_getright/prepare-company?companyId=${identity.companyId}`);
      if (!response.ok()) throw new Error('Could not prepare the disconnected isolated company fixture.');
    } else {
      await base.actions.library(); await base.actions.create(); await base.actions.save();
      values.documentId = identity.documentId;
    }
  };
  const finish = async () => {
    if (company) expect(await access()).toEqual(reference);
    return verify();
  };
  let entered = false;
  const execute = async action => {
    const value = expand(action.value), selector = expand(action.selector);
    const element = selector ? page.locator(selector) : null;
    switch (action.kind) {
      case 'goto': applicationPath(value); await page.goto(`${origin}${value}`); break;
      case 'reload': await page.reload(); break;
      case 'fill': await element.fill(value); break;
      case 'click': await element.click(); break;
      case 'check': await element.check(); break;
      case 'uncheck': await element.uncheck(); break;
      case 'select': await element.selectOption(value); break;
      case 'expect-visible': await expect(element).toBeVisible(); break;
      case 'expect-hidden': await expect(element).toBeHidden(); break;
      case 'expect-text': await expect(element).toContainText(value); break;
      case 'expect-value': await expect(element).toHaveValue(value); break;
      case 'expect-checked': await expect(element).toBeChecked(); break;
      case 'expect-unchecked': await expect(element).not.toBeChecked(); break;
      case 'expect-enabled': await expect(element).toBeEnabled(); break;
      case 'expect-disabled': await expect(element).toBeDisabled(); break;
      case 'expect-count': await expect(element).toHaveCount(Number(value)); break;
      case 'expect-url': applicationPath(value); await expect(page).toHaveURL(`${origin}${value}`); break;
      default: throw new Error('Unsupported action.');
    }
    if (page.url() !== 'about:blank' && new URL(page.url()).origin !== origin) throw new Error('The workflow left the isolated application origin.');
  };
  const actions = Object.fromEntries(plan.steps.map(step => [step.stepId, async () => {
    if (!entered) { const entry = expand(plan.entryPath); applicationPath(entry); await page.goto(`${origin}${entry}`); entered = true; }
    for (const action of step.actions) { configuration.signal?.throwIfAborted(); await execute(action); }
  }]));
  return { origin, identity, verify, prepare, finish, actions };
}
