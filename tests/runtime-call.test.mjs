import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boundedBrowserCall,
  boundedRuntimeMessage,
  withDeadline
} from '../v3/data/common/runtime-call.mjs';

test('bounded browser calls settle callback and Promise APIs exactly once', async () => {
  assert.equal(await boundedBrowserCall({
    contains(permission, callback) {
      callback(permission.allowed === true);
      return Promise.resolve(false);
    }
  }, 'contains', [{allowed: true}], {runtime: {}, timeoutMs: 20}), true);

  assert.equal(await boundedBrowserCall({
    request() {
      return Promise.resolve(true);
    }
  }, 'request', [{}], {runtime: {}, timeoutMs: 20}), true);

  await assert.rejects(() => boundedBrowserCall({
    remove(permission, callback) {
      callback(undefined, Error('permission bridge rejected'));
    }
  }, 'remove', [{}], {runtime: {}, timeoutMs: 20}), /permission bridge rejected/);
});

test('bounded runtime messaging supports callback, compatibility-error, and promise APIs', async () => {
  assert.deepEqual(await boundedRuntimeMessage({
    lastError: undefined,
    sendMessage(request, callback) {
      callback({ok: true, value: request.value});
    }
  }, {value: 7}, {timeoutMs: 20}), {ok: true, value: 7});

  assert.deepEqual(await boundedRuntimeMessage({
    lastError: undefined,
    sendMessage(request, callback) {
      callback(undefined, Error('compatibility bridge rejected'));
    }
  }, {}, {timeoutMs: 20}), {ok: false, error: 'compatibility bridge rejected'});

  assert.deepEqual(await boundedRuntimeMessage({
    sendMessage() {
      return Promise.resolve({ok: true, value: 9});
    }
  }, {}, {timeoutMs: 20}), {ok: true, value: 9});
});

test('runtime messaging and generic optional work have deterministic hard deadlines', async () => {
  let lateCallback;
  const result = await boundedRuntimeMessage({
    sendMessage(request, callback) {
      lateCallback = callback;
    }
  }, {}, {timeoutMs: 10});
  assert.deepEqual(result, {ok: false, error: 'Runtime message timed out'});
  lateCallback({ok: true, value: 'late'});
  assert.deepEqual(result, {ok: false, error: 'Runtime message timed out'},
    'a late browser callback must not replace the terminal timeout result');

  await assert.rejects(() => withDeadline(() => new Promise(() => {}), {
    timeoutMessage: 'clipboard timed out',
    timeoutMs: 10
  }), /clipboard timed out/);

  let latePermissionCallback;
  const hung = boundedBrowserCall({
    request(permission, callback) {
      latePermissionCallback = callback;
    }
  }, 'request', [{permissions: ['management']}], {runtime: {}, timeoutMs: 10});
  await assert.rejects(hung, error => error?.code === 'BROWSER_CALL_TIMEOUT');
  latePermissionCallback(true);
});
