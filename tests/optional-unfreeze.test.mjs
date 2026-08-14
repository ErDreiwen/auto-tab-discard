import test from 'node:test';
import assert from 'node:assert/strict';

import {invokeOptionalUnfreeze} from '../v3/worker/core/optional-unfreeze.mjs';

test('optional nonactivating unfreeze is absent by default and invoked exactly once when exposed', async () => {
  assert.deepEqual(await invokeOptionalUnfreeze({id: 1, tabs: {}}), {supported: false});

  let calls = 0;
  assert.deepEqual(await invokeOptionalUnfreeze({
    id: 2,
    runtime: {},
    tabs: {
      unfreeze: async id => {
        calls += 1;
        return {id, active: false, frozen: false};
      }
    }
  }), {
    accepted: true,
    apiStyle: 'promise',
    supported: true,
    tab: {id: 2, active: false, frozen: false}
  });
  assert.equal(calls, 1);
});

test('optional callback errors and Promise rejections settle once without retry', async () => {
  let calls = 0;
  const runtime = {lastError: {message: 'not available'}};
  assert.deepEqual(await invokeOptionalUnfreeze({
    id: 3,
    runtime,
    tabs: {
      unfreeze(id, callback) {
        calls += 1;
        callback();
        return Promise.resolve({id});
      }
    }
  }), {
    accepted: false,
    error: 'not available',
    supported: true
  });
  assert.equal(calls, 1);

  calls = 0;
  const rejected = await invokeOptionalUnfreeze({
    id: 4,
    runtime: {},
    tabs: {
      unfreeze() {
        calls += 1;
        return Promise.reject(Error('future API rejected'));
      }
    }
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.error, 'future API rejected');
  assert.equal(calls, 1);
});
