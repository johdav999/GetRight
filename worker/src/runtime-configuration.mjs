import { request } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { api, localUrl } from './settings.mjs';
import { writerAppAdapter } from './writerapp.mjs';
import { virtualCompanyAdapter } from './virtual-company.mjs';

export const runtimeContractVersion = 1;
const secretRef = /^GETRIGHT_UAT_[A-Z0-9_]{1,64}$/;
const safePath = /^(?:\/[a-zA-Z0-9_-]+)+$/;
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const capabilityPath = '/_getright/fixtures';
const runtimeAdapters = new Map([['writerapp-create-save', writerAppAdapter], ['virtual-company-test-setup', virtualCompanyAdapter]]);

export function registeredRuntimeAdapter(fixtureAdapter) { return runtimeAdapters.get(fixtureAdapter); }

export function runtimeEnvironment(run, environment = process.env) {
  const names = run.configuration?.manifest.runtime?.identities.flatMap(({ form }) => form ? [form.usernameRef, form.passwordRef] : []) ?? [];
  return Object.fromEntries(names.filter(name => secretRef.test(name) && environment[name]).map(name => [name, environment[name]]));
}

function matches(json, assertion, bindings) {
  let value = json;
  for (const name of assertion.field.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, name)) return false;
    value = value[name];
  }
  if (assertion.contains != null)
    return Array.isArray(value) && value.some(item => assertion.contains.every(member => matches(item, member, bindings)));
  if (assertion.binding != null) return typeof value === 'string' && value === bindings[assertion.binding];
  return value === assertion.equalsValue;
}

function timeLeft(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('The configured runtime operation exceeded its deadline.');
  return Math.min(remaining, 3000);
}

async function send(session, path, deadline, options = {}) {
  if (path.length > 220 || !safePath.test(path) || /\s/.test(path)) throw new Error('Invalid local runtime path.');
  try { return await session.fetch(path, { ...options, maxRedirects: 0, timeout: timeLeft(deadline) }); }
  catch { throw new Error('The isolated runtime request failed.'); }
}

export async function readRuntimeJson(response) {
  const body = await response.body();
  if (body.length > 65536) throw new Error('The runtime response exceeds 64 KiB.');
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw new Error('The runtime response is not valid JSON.'); }
}

export function runtimeLifecycle(claim, configuration) {
  const { run, lease } = claim;
  const { runtime, fixtureAdapter } = run.configuration.manifest;
  const target = run.target;
  if (!target?.isolatedDataConfirmed || target.applicationId !== run.applicationId) throw new Error('An isolated runtime target is required.');
  const origin = localUrl(target.baseUrl);
  const sessions = new Map();
  const recipes = runtime.fixtures ?? [];
  const fixtures = [];
  const ownedIds = new Set();
  let closed = false;
  let prepared = false;

  async function session(identity, deadline) {
    if (sessions.has(identity.name)) return sessions.get(identity.name);
    const context = await request.newContext({ baseURL: origin });
    sessions.set(identity.name, context);
    if (identity.form) {
      const { path, usernameRef, passwordRef, usernameField, passwordField, status } = identity.form;
      const username = secretRef.test(usernameRef) && process.env[usernameRef];
      const password = secretRef.test(passwordRef) && process.env[passwordRef];
      if (!username || !password) throw new Error(`Set the local credential references for test identity '${identity.name}'.`);
      const response = await send(context, path, deadline, { method: 'POST', form: { [usernameField]: username, [passwordField]: password } });
      if (status == null ? !response.ok() : response.status() !== status)
        throw new Error(`Form sign-in failed for test identity '${identity.name}'.`);
    }
    return context;
  }

  async function verify(deadline) {
    for (const identity of runtime.identities) {
      const context = await session(identity, deadline);
      const bindings = { build: target.expectedBuildVersion, identity: identity.subject ?? target.expectedUserId, scope: target.expectedCompanyId, role: target.expectedRole };
      for (const check of identity.checks) {
        let matched = false;
        for (let attempt = 0; attempt < check.attempts && !matched; attempt++) {
          if (attempt) await delay(150);
          try {
            const response = await send(context, check.path, deadline);
            if (response.status() === check.status) {
              const assertions = check.assertions ?? [];
              if (!assertions.length) matched = true;
              else {
                const payload = await readRuntimeJson(response);
                matched = assertions.every(assertion => matches(payload, assertion, bindings));
              }
            }
          } catch { matched = false; }
        }
        if (!matched) throw new Error(`Runtime check ${check.path} failed for test identity '${identity.name}'.`);
      }
      if (recipes.some(recipe => recipe.identity === identity.name)) {
        const response = await send(context, capabilityPath, deadline);
        const receipt = response.ok() && await readRuntimeJson(response);
        if (!receipt || receipt.isolated !== true || receipt.version !== bindings.build || receipt.userId !== bindings.identity ||
            (bindings.scope != null && receipt.companyId !== bindings.scope))
          throw new Error(`The isolated fixture capability could not be verified for test identity '${identity.name}'.`);
      }
    }
  }

  async function verifyAdapterTarget(deadline) {
    const adapter = registeredRuntimeAdapter(fixtureAdapter);
    if (!adapter) return;
    const context = await request.newContext({ baseURL: origin });
    try {
      await adapter(null, { request: { get: (url, options) => context.get(url, { ...options, timeout: timeLeft(deadline), maxRedirects: 0 }) } }, run).verify();
    } finally { await context.dispose(); }
  }

  async function setup() {
    const deadline = Date.now() + 12000;
    if (recipes.length || runtime.identities.some(identity => identity.form)) await verifyAdapterTarget(deadline);
    await verify(deadline);
    prepared = true;
    for (const recipe of recipes) {
      configuration.signal?.throwIfAborted();
      const state = await api(configuration.dashboardUrl, `/api/runs/${run.id}/heartbeat`, { lease });
      if (state.cancelRequested) throw new Error('Cancelled before fixture creation.');
      const fixture = { kind: recipe.kind, id: null, status: 'setup-failed' };
      fixtures.push(fixture);
      const values = { 'fixture-id': run.fixtureId, name: `Getright ${run.fixtureId}`, email: `${run.fixtureId}@example.invalid` };
      const data = Object.fromEntries(Object.entries(recipe.values ?? {}).map(([name, value]) => [name, values[value]]));
      try {
        const response = await send(sessions.get(recipe.identity), `${capabilityPath}/${recipe.kind}`, deadline,
          { method: 'POST', data: { ...data, fixtureId: run.fixtureId } });
        const receipt = response.status() === 201 && await readRuntimeJson(response);
        if (!receipt || receipt.fixtureId !== run.fixtureId || typeof receipt.id !== 'string' || !guid.test(receipt.id) ||
            ownedIds.has(receipt.id.toLowerCase()) || receipt.id.toLowerCase() === target.expectedCompanyId?.toLowerCase())
          throw new Error('Ownership receipt missing.');
        ownedIds.add(receipt.id.toLowerCase());
        fixture.id = receipt.id;
        fixture.status = 'cleanup-failed';
      } catch { throw new Error(`Fixture setup failed for '${recipe.kind}'. A resource without a verified ownership receipt cannot be removed automatically.`); }
    }
  }

  async function finish(result) {
    const deadline = Date.now() + 12000;
    let verifiedAfter = false;
    let runtimeError;
    try {
      if (prepared) {
        await verify(deadline);
        if (fixtures.length) await verifyAdapterTarget(deadline);
        verifiedAfter = true;
      }
    } catch { runtimeError = 'The configured runtime or test identity could not be verified after execution.'; }
    if (verifiedAfter) {
      for (const fixture of [...fixtures].reverse()) {
        if (fixture.id === null) continue;
        const recipe = recipes.find(candidate => candidate.kind === fixture.kind);
        const context = sessions.get(recipe.identity);
        const path = `${capabilityPath}/${fixture.kind}/${fixture.id}`;
        const headers = { 'X-Getright-Fixture': run.fixtureId };
        try {
          const response = await send(context, path, deadline, { headers });
          const receipt = response.ok() && await readRuntimeJson(response);
          if (!receipt || receipt.id !== fixture.id || receipt.fixtureId !== run.fixtureId) continue;
          const deletion = await send(context, path, deadline, { method: 'DELETE', headers });
          if (deletion.status() === recipe.deleteStatus) fixture.status = 'deleted';
        } catch { /* Retain the typed cleanup failure and continue with other owned resources. */ }
      }
    }
    if (fixtures.some(fixture => fixture.status === 'cleanup-failed')) runtimeError ??= 'One or more owned fixtures could not be removed.';
    return { ...result, runtime: { verifiedAfter, fixtures },
      ...(runtimeError ? { status: result.status === 'passed' ? 'failed' : result.status, error: result.error ?? runtimeError } : {}) };
  }

  async function close() {
    if (closed) return;
    closed = true;
    await Promise.allSettled([...sessions.values()].map(context => context.dispose()));
  }

  function workflowSession(name) {
    const identity = name == null ? runtime.identities[0] : runtime.identities.find(candidate => candidate.name === name);
    const context = sessions.get(identity?.name);
    if (!prepared || !context || closed) throw new Error('The configured test session is unavailable.');
    return { context, subject: identity.subject ?? target.expectedUserId };
  }

  const fixtureValues = () => Object.fromEntries(fixtures.filter(fixture => fixture.id).map(fixture => [`fixture-${fixture.kind}`, fixture.id]));
  return { setup, finish, close, workflowSession, fixtureValues };
}
