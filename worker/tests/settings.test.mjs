import assert from 'node:assert/strict';
import test from 'node:test';
import { localUrl, settings } from '../src/settings.mjs';

test('worker accepts only a local dashboard origin', () => {
  assert.equal(localUrl('http://127.0.0.1:5120'), 'http://127.0.0.1:5120');
  assert.equal(localUrl('http://[::1]:5120'), 'http://[::1]:5120');
  for (const value of ['https://example.com', 'http://192.168.1.1', 'file:///tmp', 'http://user:pass@localhost', 'http://localhost/foo', 'http://localhost/?token=secret']) {
    assert.throws(() => localUrl(value));
  }
});

test('worker uses visible browsers unless headless is explicitly selected', () => {
  assert.equal(settings({}).headless, false);
  assert.equal(settings({ GETRIGHT_HEADLESS: 'true' }).headless, true);
  assert.equal(settings({}).keepBrowserOpen, true);
  assert.equal(settings({ GETRIGHT_KEEP_BROWSER_OPEN: 'false' }).keepBrowserOpen, false);
});
