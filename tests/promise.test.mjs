import test from 'node:test';
import assert from 'node:assert/strict';

import {withTimeout} from '../v3/worker/core/promise.mjs';

test('returns a resolved value before the timeout', async () => {
  assert.equal(await withTimeout(Promise.resolve('metadata'), 100, []), 'metadata');
});

test('allows a slower healthy operation to finish within its bound', async () => {
  const operation = new Promise(resolve => setTimeout(resolve, 20, 'metadata'));

  assert.equal(await withTimeout(operation, 100, []), 'metadata');
});

test('returns the fallback when the operation rejects', async () => {
  assert.deepEqual(await withTimeout(Promise.reject(Error('blocked')), 100, []), []);
});

test('returns the fallback when a frozen-tab operation stays pending', async () => {
  const pending = new Promise(() => {});

  assert.deepEqual(await withTimeout(pending, 10, []), []);
});
