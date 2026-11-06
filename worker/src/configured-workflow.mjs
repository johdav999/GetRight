import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { readRuntimeJson } from './runtime-configuration.mjs';
import { financeActions, financeStep } from './finance-uat.mjs';

export const configuredWorkflowVersion = 2;
const files = ['configured-workflow.mjs', 'configured-runner.mjs', 'runtime-configuration.mjs', 'finance-uat.mjs'];
export async function currentConfiguredWorkflowDigest() {
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update(await readFile(new URL(file, import.meta.url))); }
  return hash.digest('hex');
}
export const configuredWorkflowDigest = await currentConfiguredWorkflowDigest();
const variable = /\{\{([a-zA-Z][a-zA-Z0-9-]{0,39})\}\}/g;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const browserActions = new Set(['click', 'fill', 'check', 'uncheck', 'select', 'expect-visible', 'expect-hidden', 'expect-text', 'expect-value', 'expect-checked', 'expect-enabled']);
const companySteps = new Map([['company-workflow', 'workflow'], ['company-create', 'create'],
  ['company-permissions', 'permissions'], ['company-reopen', 'reopen']]);
const captures = http => http?.capture ? [http.capture] : http?.captures ?? [];

function localPath(path) {
  if (typeof path !== 'string' || path.length > 500 || !/^\/[a-zA-Z0-9_./-]*(?:\?[a-zA-Z0-9_.=&-]+)?$/.test(path) || /\s/.test(path) ||
      path.startsWith('//') || path.split('?')[0].split('/').some(segment => segment === '.' || segment === '..'))
    throw new Error('The workflow path must stay on the isolated application origin.');
  return path;
}

function expand(value, values) {
  if (typeof value !== 'string') return value;
  return value.replace(variable, (_, name) => {
    if (!values.has(name)) throw new Error(`Workflow variable '${name}' is unavailable.`);
    return String(values.get(name));
  });
}

function resolveScalar(value, values) {
  const reference = typeof value === 'string' && /^\{\{([a-zA-Z][a-zA-Z0-9-]{0,39})\}\}$/.exec(value);
  return reference && values.has(reference[1]) ? values.get(reference[1]) : expand(value, values);
}

function validateHttp(http, action, manifest) {
  localPath(http.path.replace(variable, 'value'));
  if (action.kind === 'click') {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(http.method) || http.attempts !== 1 || http.session != null || http.body != null)
      throw new Error('The click response definition is invalid.');
  } else {
    if (!['GET', 'POST'].includes(http.method) || (http.method === 'GET' && http.body != null) ||
        (http.method === 'POST' && (!manifest.workflowPosts?.includes(http.path) || http.attempts !== 1)))
      throw new Error('The API method or POST path is not authorized by the application manifest.');
    if (http.session != null && !manifest.runtime.identities.some(identity => identity.name === http.session))
      throw new Error('The configured API session is unavailable.');
  }
  if (!Number.isInteger(http.attempts) || http.attempts < 1 || http.attempts > 3 || !Number.isInteger(http.status) || http.status < 200 || http.status > 599)
    throw new Error('The API status or retry limit is invalid.');
}

export function validateConfiguredRun(run) {
  const plan = run.testSnapshot.workflow;
  const manifest = run.configuration?.manifest;
  const dashboard = run.configuration?.dashboardBuild != null;
  if (plan?.version !== configuredWorkflowVersion || !manifest || (!dashboard && !manifest.runtime) || !Array.isArray(plan.steps) ||
      plan.steps.length !== run.testSnapshot.steps.length || plan.steps.length < 1 || plan.steps.length > 30)
    throw new Error('A configured run needs a frozen version 2 workflow and isolated runtime.');
  if (manifest.fixtureAdapter === 'configured-v2' && !manifest.runtime.identities?.[0]?.checks?.some(check =>
    check.path === '/_getright/runtime' && check.status === 200 &&
    check.assertions?.some(a => a.field === 'version' && a.binding === 'build') &&
    check.assertions.some(a => a.field === 'userId' && a.binding === 'identity') &&
    check.assertions.some(a => a.field === 'isolated' && a.equalsValue === true)))
    throw new Error('The configured target must attest to its isolated build and account.');
  const known = new Set(['fixtureId', 'unique', 'email', ...(manifest.runtime?.fixtures ?? []).map(fixture => `fixture-${fixture.kind}`)]);
  const pathValues = new Set([...known].filter(name => name !== 'email'));
  const companyPhases = [];
  let count = 0;
  for (const [index, step] of plan.steps.entries()) {
    if (step.stepId !== run.testSnapshot.steps[index].id || !/^[a-z0-9_-]{1,80}$/.test(step.stepId) ||
        !Array.isArray(step.actions) || step.actions.length < 1 || step.actions.length > 30)
      throw new Error('The configured workflow must include every frozen step in order.');
    count += step.actions.length;
    for (const action of step.actions) {
      if ((!browserActions.has(action.kind) && !['goto', 'reload', 'request', 'extension'].includes(action.kind)) ||
          !Number.isInteger(action.timeoutMs) || action.timeoutMs < 100 || action.timeoutMs > 15000)
        throw new Error('Unsupported configured action or timeout.');
      if (dashboard && (action.http || action.kind === 'request' || action.kind === 'extension' ||
        action.kind === 'goto' && action.path !== `${manifest.entryPath}?fixture={{fixtureId}}`))
        throw new Error('A dashboard fixture is limited to browser actions on its registered page.');
      if (action.kind === 'goto') localPath(action.path.replace(variable, 'value'));
      if (action.kind === 'extension') {
        const id = action.extension?.id;
        const writer = manifest.fixtureAdapter === 'writerapp-create-save' && ['writerapp-onboarding', 'writerapp-library'].includes(id);
        const company = manifest.fixtureAdapter === 'virtual-company-test-setup' && companySteps.has(id);
        const finance = manifest.fixtureAdapter === 'virtual-company-test-setup' && step.actions.length === 1 &&
          id === 'finance-agent-step' && financeStep(run.testId, step.stepId);
        if (action.extension?.version !== 1 || (!writer && !company && !finance)) throw new Error('Unknown configured workflow extension.');
        if (company) companyPhases.push(id);
      }
      const http = action.http;
      if (action.kind === 'request' && !http) throw new Error('The configured request is missing its HTTP definition.');
      if (http) validateHttp(http, action, manifest);
      for (const path of [action.path, http?.path]) {
        if (path != null) for (const [, name] of path.matchAll(variable)) if (!pathValues.has(name)) throw new Error('Unsupported path variable.');
      }
      const inputs = [action.value, ...(http?.assertions ?? []).map(a => a.containsText ?? a.equalsValue), ...Object.values(http?.body ?? {})];
      for (const input of inputs) {
        if (typeof input !== 'string') continue;
        for (const [, name] of input.matchAll(variable)) if (!known.has(name)) throw new Error(`Workflow variable '${name}' is unavailable.`);
      }
      if ((http?.capture && http.captures != null) || (http?.captures != null &&
        (!Array.isArray(http.captures) || http.captures.length < 1 || http.captures.length > 4)))
        throw new Error('Unsupported configured response captures.');
      for (const capture of captures(http)) {
        if (known.has(capture.name)) throw new Error('A workflow capture cannot replace an existing variable.');
        known.add(capture.name);
        if (capture.type !== 'text') pathValues.add(capture.name);
      }
    }
  }
  if (companyPhases.length && companyPhases.join() !== [...companySteps.keys()].join())
    throw new Error('The company permission extension requires its four ordered phases.');
  if (count > 120) throw new Error('The configured workflow action limit was exceeded.');
  return plan;
}

function select(page, locator) {
  if (locator.role != null) return page.getByRole(locator.role, locator.name == null ? {} : { name: locator.name, exact: true });
  if (locator.label != null) return page.getByLabel(locator.label, { exact: true });
  if (locator.testId != null) return page.getByTestId(locator.testId);
  return page.locator(locator.css);
}

function field(payload, selector) {
  let value = payload;
  for (const name of selector.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, name)) throw new Error(`Response field '${selector}' is missing.`);
    value = value[name];
  }
  return value;
}

export function configuredActions({ page, origin, run, lifecycle, signal, adapter }) {
  const values = new Map(Object.entries({ fixtureId: run.fixtureId, unique: run.id.slice(0, 12), email: `${run.fixtureId}@example.invalid`, ...lifecycle?.fixtureValues() }));
  const resources = [];
  const target = run.target;
  let executeFinance;

  async function checkResponse(response, http, subject) {
    if (response.status() !== http.status) throw new Error(`Expected HTTP ${http.status}, received ${response.status()}.`);
    if (!captures(http).length && !http.assertions?.length) return;
    const payload = await readRuntimeJson(response);
    const bindings = { build: target.expectedBuildVersion, identity: subject, scope: target.expectedCompanyId, role: target.expectedRole };
    for (const assertion of http.assertions ?? []) {
      if (assertion.containsText != null) {
        const actual = assertion.field === '$' ? payload : field(payload, assertion.field);
        const content = typeof actual === 'string' ? actual : JSON.stringify(actual);
        if (!content.includes(expand(assertion.containsText, values)))
          throw new Error(`Response field '${assertion.field}' did not contain the expected text.`);
        continue;
      }
      const expected = assertion.binding == null ? resolveScalar(assertion.equalsValue, values) : bindings[assertion.binding];
      if (expected == null || field(payload, assertion.field) !== expected) throw new Error(`Response field '${assertion.field}' did not match its assertion.`);
    }
    for (const capture of captures(http)) recordCapture(payload, capture);
  }

  function recordCapture(payload, capture) {
    const value = field(payload, capture.field);
    const valid = (capture.type === 'uuid' && typeof value === 'string' && uuid.test(value)) ||
      (capture.type === 'integer' && Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647) ||
      (capture.type === 'boolean' && typeof value === 'boolean') ||
      (capture.type === 'text' && typeof value === 'string' && value.length <= 500);
    if (!valid || values.has(capture.name)) throw new Error(`Response field '${capture.field}' did not produce the declared capture type.`);
    if (capture.resourceKind) {
      if (value.toLowerCase() === target.expectedCompanyId?.toLowerCase()) throw new Error('The isolation reference cannot be reported as a created resource.');
      resources.push({ kind: capture.resourceKind, id: value, scopeId: target.expectedCompanyId });
    }
    values.set(capture.name, value);
  }

  async function request(action, observations) {
    const http = action.http;
    const path = localPath(expand(http.path, values));
    const { context, subject } = lifecycle.workflowSession(http.session);
    const deadline = Date.now() + action.timeoutMs;
    const body = http.body == null ? undefined : Object.fromEntries(Object.entries(http.body).map(([name, value]) => [name, resolveScalar(value, values)]));
    const observationIndex = observations.length;
    for (let attempt = 1; attempt <= http.attempts; attempt++) {
      signal.throwIfAborted();
      const timeout = deadline - Date.now();
      if (timeout <= 0) throw new Error('The configured API action exceeded its deadline.');
      let response;
      try {
        response = await context.fetch(path, { method: http.method, data: body, maxRedirects: 0, timeout });
        observations[observationIndex] = { method: http.method, path, status: response.status(), session: http.session };
        signal.throwIfAborted();
        await checkResponse(response, http, subject);
        return;
      } catch (error) {
        if (attempt === http.attempts) throw new Error(response ? error.message : 'The configured API request failed or exceeded its deadline.');
        await delay(150, undefined, { signal });
      } finally { await response?.dispose(); }
    }
  }

  async function execute(action, observations, stepId) {
    signal.throwIfAborted();
    const timeout = action.timeoutMs;
    const options = { timeout };
    if (action.kind === 'request') return request(action, observations);
    if (action.kind === 'extension') {
      if (action.extension.id === 'finance-agent-step') {
        executeFinance ??= financeActions({ page, origin, run, signal, resources });
        await executeFinance(stepId);
        return;
      }
      if (companySteps.has(action.extension.id)) {
        await adapter.actions[companySteps.get(action.extension.id)]();
        if (action.extension.id === 'company-reopen')
          resources.push({ kind: 'company', id: adapter.identity.companyId, scopeId: target.expectedCompanyId });
        return;
      }
      if (action.extension.id === 'writerapp-library') {
        const create = page.getByRole('button', { name: 'Create new document', exact: true }).first();
        const tab = page.locator('.landing-tabs').getByRole('button', { name: 'Documents', exact: true });
        await expect(async () => {
          if (!(await create.isVisible()) && await tab.isVisible()) await tab.click({ timeout: 1000 });
          await expect(create).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout, intervals: [100, 250, 500] });
        return;
      }
      const { context } = lifecycle.workflowSession();
      let response;
      try {
        response = await context.post('/api/onboarding/complete', { timeout, maxRedirects: 0 });
        if (!response.ok()) throw new Error('Onboarding response failed.');
      } catch { throw new Error('Could not prepare the isolated WriterApp account.'); }
      finally { await response?.dispose(); }
      return;
    }
    if (action.kind === 'goto') return page.goto(`${origin}${localPath(expand(action.path, values))}`, options);
    if (action.kind === 'reload') return page.reload(options);
    const locator = select(page, action.locator);
    const value = expand(action.value, values);
    switch (action.kind) {
      case 'click': {
        if (!action.http) return locator.click(options);
        const http = action.http;
        const path = localPath(expand(http.path, values));
        const [response] = await Promise.all([
          page.waitForResponse(candidate => candidate.url() === `${origin}${path}` && candidate.request().method() === http.method && candidate.request().frame() === page.mainFrame(), options),
          locator.click(options)
        ]);
        observations.push({ method: http.method, path, status: response.status() });
        return checkResponse(response, http, target.expectedUserId);
      }
      case 'fill': return locator.fill(value, options);
      case 'check': return locator.check(options);
      case 'uncheck': return locator.uncheck(options);
      case 'select': return locator.selectOption(value, options);
      case 'expect-visible': return expect(locator).toBeVisible(options);
      case 'expect-hidden': return expect(locator).toBeHidden(options);
      case 'expect-text': return expect(locator).toContainText(value, options);
      case 'expect-value': return expect(locator).toHaveValue(value, options);
      case 'expect-checked': return expect(locator).toBeChecked(options);
      case 'expect-enabled': return expect(locator).toBeEnabled(options);
      default: throw new Error('Unsupported configured workflow action.');
    }
  }

  return { execute, resources };
}
