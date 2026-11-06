import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage();

// Keep runtime lifecycle policy outside the versioned adapter engine. Only the
// matching result in this asynchronous run can invoke its completion hook.
export function withRunCompletion(origin, route, lease, complete, execute) {
  return scope.run({ origin, route, lease, complete }, execute);
}

export function prepareCompletion(origin, route, body) {
  const active = scope.getStore();
  if (active && origin === active.origin && route === active.route && body?.lease === active.lease) {
    active.result ??= active.complete(body);
    return active.result;
  }
  return body;
}
