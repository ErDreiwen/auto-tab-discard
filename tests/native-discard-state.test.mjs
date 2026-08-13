import assert from 'node:assert/strict';
import test from 'node:test';

import {
  invokeNativeDiscard,
  isNativeDiscardSettled,
  nativeDiscardContract
} from '../v3/worker/core/native-discard-state.mjs';

test('uses each browser native discard contract without accepting a live tab', () => {
  const base = {active: false, discarded: true};

  assert.equal(isNativeDiscardSettled({...base, status: 'unloaded'}, {firefox: false}), true);
  assert.equal(isNativeDiscardSettled({...base, status: 'complete'}, {firefox: false}), false);
  assert.equal(isNativeDiscardSettled({...base, status: 'complete'}, {firefox: true}), true);
  assert.equal(isNativeDiscardSettled({...base, status: 'loading'}, {firefox: true}), false);
  assert.equal(isNativeDiscardSettled({...base, active: true, status: 'complete'}, {firefox: true}), false);
  assert.equal(isNativeDiscardSettled({...base, discarded: false, status: 'complete'}, {firefox: true}), false);
});

test('versions native settlement invariants by browser family', () => {
  assert.deepEqual(nativeDiscardContract({firefox: false}), {
    apiStyle: 'callback',
    family: 'chromium',
    invariant: 'discarded-inactive-unloaded-v1'
  });
  assert.deepEqual(nativeDiscardContract({firefox: true}), {
    apiStyle: 'promise',
    family: 'firefox',
    invariant: 'discarded-inactive-complete-v1'
  });
});

for (const [apiStyle, firefox] of [['callback', false], ['promise', true]]) {
  for (const [shape, value] of [
    ['undefined', undefined],
    ['partial-object', {discarded: true}],
    ['tab', {id: 7, discarded: true}]
  ]) {
    test(`normalizes ${apiStyle} native discard with ${shape} provenance`, async () => {
      let calls = 0;
      const tabs = apiStyle === 'callback' ? {
        discard(id, callback) {
          calls += 1;
          callback(value);
        }
      } : {
        discard(id) {
          calls += 1;
          return Promise.resolve(value);
        }
      };
      const result = await invokeNativeDiscard(7, {
        firefox,
        runtime: {lastError: null},
        tabs
      });
      assert.equal(calls, 1);
      assert.equal(result.accepted, true);
      assert.equal(result.apiStyle, apiStyle);
      assert.equal(result.resultShape, shape);
      assert.equal(result.result, value);
    });
  }
}

test('rejects callback lastError and Promise rejection without a second invocation', async () => {
  let callbackCalls = 0;
  const runtime = {lastError: null};
  const callback = await invokeNativeDiscard(1, {
    firefox: false,
    runtime,
    tabs: {
      discard(id, done) {
        callbackCalls += 1;
        runtime.lastError = {message: 'policy denied'};
        done();
        runtime.lastError = null;
      }
    }
  });
  assert.equal(callbackCalls, 1);
  assert.equal(callback.accepted, false);
  assert.match(callback.error, /policy denied/);

  let promiseCalls = 0;
  const promise = await invokeNativeDiscard(2, {
    firefox: true,
    runtime: {lastError: null},
    tabs: {
      discard() {
        promiseCalls += 1;
        return Promise.reject(Error('native rejected'));
      }
    }
  });
  assert.equal(promiseCalls, 1);
  assert.equal(promise.accepted, false);
  assert.match(promise.error, /native rejected/);
});

test('result provenance never weakens the live settlement postcondition', async () => {
  const ambiguous = {active: false, discarded: false, status: 'complete'};
  const accepted = await invokeNativeDiscard(8, {
    firefox: false,
    runtime: {lastError: null},
    tabs: {discard(id, done) { done({id, discarded: true, status: 'unloaded'}); }}
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.resultShape, 'tab');
  assert.equal(isNativeDiscardSettled(ambiguous, {firefox: false}), false);
});
